#!/usr/bin/env python3
"""health-ingest — tiny local HTTP ingest service for health data.

Receives JSON payloads (first client: the iOS app "Health Auto Export", which
POSTs JSON) and stores them as dated JSON files. Pure Python stdlib, no
external network calls outbound.

Endpoints
---------
GET  /healthz
     -> 200 "ok"   (no auth; liveness probe)

POST /ingest/healthautoexport
     -> 200 {"status":"ok","stored":...,"bytes":N}
     400 invalid/absent JSON body
     403 missing or wrong bearer token
     411 missing Content-Length
     413 body larger than HEALTH_INGEST_MAX_BODY

Storage (append-safe)
---------------------
data/raw/healthautoexport/YYYY-MM-DD.json

The day's file is a JSON *array* of records:

    [
      {"received_at": "2026-09-14T12:34:56.789-05:00",
       "remote": "192.0.2.1",
       "payload": { ...raw JSON from the client... }},
      ...
    ]

* If the day's file does not exist it is created with one record.
* If it exists and parses as a JSON list, the new record is appended.
* If it exists but does NOT parse as a JSON list (corrupt / hand-edited),
  the new record goes into a timestamped side file
  YYYY-MM-DD.HHMMSS.json instead — nothing is discarded, nothing is
  overwritten.

Writes are atomic (temp file + os.replace) and serialized per process with a
lock, so concurrent POSTs cannot interleave.

Configuration (environment, optionally via .env next to this file)
-----------------------------------------------------------------
HEALTH_INGEST_TOKEN      required; bearer token clients must send
HEALTH_INGEST_BIND       default 0.0.0.0
HEALTH_INGEST_PORT       default 8789
HEALTH_INGEST_MAX_BODY   default 67108864 (64 MiB)

The .env file is gitignored and must be chmod 600 (it holds the token).
"""

from __future__ import annotations

import hashlib
import ipaddress
import hmac
import json
import os
import sys
import shutil
import socket
import threading
import tempfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_RAW = ROOT / "data" / "raw"

BIND = os.environ.get("HEALTH_INGEST_BIND", "0.0.0.0")
PORT = int(os.environ.get("HEALTH_INGEST_PORT", "8789"))
MAX_BODY = int(os.environ.get("HEALTH_INGEST_MAX_BODY", str(64 * 1024 * 1024)))

ARTOO_TOKEN = ""
ARTOO_MAX_BODY = 1024 * 1024 * 1024
TOKEN = ""
_write_lock = threading.Lock()


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
def load_env_file(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, '#' comments. Does not override
    variables already present in the real environment."""
    try:
        text = path.read_text()
    except FileNotFoundError:
        return
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_token() -> str:
    token = os.environ.get("HEALTH_INGEST_TOKEN", "").strip()
    if not token:
        sys.stderr.write(
            "FATAL: HEALTH_INGEST_TOKEN is not set (env or .env in %s)\n" % ROOT
        )
        sys.exit(2)
    return token


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------
def store(source: str, payload: object, remote: str) -> Path:
    """Append-safe store; returns the path written."""
    now = datetime.now().astimezone()
    day = now.strftime("%Y-%m-%d")
    outdir = DATA_RAW / source
    record = {
        "received_at": now.isoformat(timespec="seconds"),
        "remote": remote,
        "payload": payload,
    }

    with _write_lock:
        outdir.mkdir(parents=True, exist_ok=True)
        target = outdir / f"{day}.json"
        records = None  # None = start fresh; list = append to this

        if target.exists():
            try:
                existing = json.loads(target.read_text())
                if isinstance(existing, list):
                    records = existing
            except (json.JSONDecodeError, OSError, UnicodeDecodeError):
                records = None
            if records is None:
                # Unreadable or not a list: never overwrite — use a side file.
                target = outdir / f"{day}.{now.strftime('%H%M%S')}.json"
                sys.stdout.write(
                    "WARN: %s was not a JSON list; writing side file %s instead\n"
                    % (target.name, target)
                )

        if records is None:
            records = []

        records.append(record)
        tmp = outdir / (".%s.tmp" % target.name)
        tmp.write_text(
            json.dumps(records, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, target)

    return target


def sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "health-ingest/1.0"
    protocol_version = "HTTP/1.1"

    # ---- plumbing ----
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.close_connection = True

    def _text(self, code: int, text: str) -> None:
        self._send(code, (text + "\n").encode(), "text/plain; charset=utf-8")

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def log_message(self, fmt: str, *args) -> None:  # -> stdout -> journald
        sys.stdout.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()

    # ---- auth ----
    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        supplied = header[len(prefix):].strip()
        return hmac.compare_digest(supplied.encode(), TOKEN.encode())

    def _artoo_snapshot(self) -> None:
        """Land an opaque archive; never unpack or interpret personal data."""
        peer = ipaddress.ip_address(self.client_address[0])
        if peer not in ipaddress.ip_network("100.64.0.0/10"):
            self._text(403, "tailnet required")
            return
        if not ARTOO_TOKEN:
            self._text(503, "Artoo delivery is not configured")
            return
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(
            supplied.encode(), ("Bearer " + ARTOO_TOKEN).encode()
        ):
            self._text(403, "forbidden")
            return
        if self.headers.get("Transfer-Encoding"):
            self._text(400, "chunked uploads are not supported")
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._text(411, "Content-Length required")
            return
        if not 0 < length <= ARTOO_MAX_BODY:
            self._text(413 if length > ARTOO_MAX_BODY else 400, "invalid body size")
            return
        if self.headers.get("Content-Type") != "application/gzip":
            self._text(415, "application/gzip required")
            return

        now = datetime.now().astimezone()
        day = DATA_RAW / "artoo" / now.strftime("%Y-%m-%d")
        stage = None
        try:
            day.mkdir(parents=True, exist_ok=True, mode=0o700)
            stage = Path(tempfile.mkdtemp(prefix=".upload-", dir=day))
            digest = hashlib.sha256()
            remaining = length
            self.connection.settimeout(300)
            archive = stage / "snapshot.tar.gz"
            with archive.open("xb") as out:
                os.chmod(archive, 0o600)
                while remaining:
                    chunk = self.rfile.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        self._text(400, "incomplete body")
                        return
                    out.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                out.flush()
                os.fsync(out.fileno())
            sha = digest.hexdigest()
            target = day / sha
            receipt = {
                "status": "ok",
                "source": "artoo",
                "received_at": now.isoformat(timespec="seconds"),
                "remote": str(peer),
                "stored": str((target / "snapshot.tar.gz").relative_to(ROOT)),
                "bytes": length,
                "sha256": sha,
            }
            receipt_path = stage / "receipt.json"
            with receipt_path.open("x", encoding="utf-8") as out:
                os.chmod(receipt_path, 0o600)
                json.dump(receipt, out, indent=2)
                out.write("\n")
                out.flush()
                os.fsync(out.fileno())
            with _write_lock:
                if target.exists():
                    receipt = json.loads((target / "receipt.json").read_text())
                else:
                    sync_directory(stage)
                    os.rename(stage, target)
                    stage = None
                sync_directory(day)
                # Persist every parent entry a first delivery may have created.
                for directory in (day.parent, DATA_RAW, DATA_RAW.parent, ROOT):
                    sync_directory(directory)
            self._json(200, receipt)
        except (socket.timeout, TimeoutError):
            self._text(408, "upload timed out")
        except OSError:
            self.log_message("Artoo storage failure")
            self._text(500, "storage failure")
        finally:
            if stage is not None:
                shutil.rmtree(stage, ignore_errors=True)

    # ---- routes ----
    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/healthz":
            self._text(200, "ok")
        else:
            self._text(404, "not found")

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/artoo/snapshot":
            self._artoo_snapshot()
            return
        # Support /ingest/<source> e.g. healthautoexport, strava, withings, hevy
        if not path.startswith("/ingest/"):
            self._text(404, "not found")
            return
        source = path[len("/ingest/"):].strip()
        if not source or "/" in source or not source.replace("-", "").isalnum():
            self._text(400, "invalid source name")
            return
        if not self._authorized():
            self._text(403, "forbidden")
            return

        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._text(411, "Content-Length required")
            return
        if length <= 0:
            self._text(400, "empty body")
            return
        if length > MAX_BODY:
            self._text(413, "payload too large")
            return

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            self._text(400, "invalid JSON: %s" % exc)
            return

        written = store(source, payload, self.client_address[0])
        rel = written.relative_to(ROOT)
        self._json(200, {"status": "ok", "source": source, "stored": str(rel), "bytes": length})


def main() -> None:
    global TOKEN, ARTOO_TOKEN
    load_env_file(ROOT / ".env")
    TOKEN = resolve_token()
    token_path = ROOT / ".artoo-token"
    if token_path.exists():
        ARTOO_TOKEN = token_path.read_text().strip()

    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    httpd.daemon_threads = True
    sys.stdout.write(
        "health-ingest listening on %s:%d (storage=%s)\n" % (BIND, PORT, DATA_RAW)
    )
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
