#!/usr/bin/env python3
"""Fictional Hevy API on loopback for verification runs. No real account, key or record.

    fake_hevy.py --port PORT --log FILE

Serves GET /v1/workouts and /v1/workouts/events with eleven fictional items
(page size 10, so two pages). It accepts only the synthetic api-key below and
logs every request's method, path and query (never the key) as JSON lines.
POST /__mode/<mode> switches behavior for later requests:

  normal     eleven items over two pages (default)
  empty      complete empty feed, page_count 0
  partial    page 2 answers 503
  malformed  {"page_count": 1} with no items key
  transient  the next two requests answer 503, then normal
  redirect   302 to /__redirected on this stub; any request there is logged, so a follow is visible
  down       every request answers 503
"""
import argparse
import json
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SYNTHETIC_KEY = "00000000-0000-4000-8000-000000000000"
MODES = {"normal", "empty", "partial", "malformed", "transient", "redirect", "down"}
ITEMS = 11


class State:
    mode = "normal"
    transient_left = 0
    lock = threading.Lock()


def build_handler(log_path):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _send(self, code, payload=None, headers=None):
            body = b"" if payload is None else json.dumps(payload).encode()
            self.send_response(code)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _record(self, status):
            url = urllib.parse.urlsplit(self.path)
            entry = {"method": self.command, "path": url.path,
                     "query": dict(urllib.parse.parse_qsl(url.query)),
                     "api_key_ok": self.headers.get("api-key") == SYNTHETIC_KEY,
                     "mode": State.mode, "status": status}
            with State.lock, open(log_path, "a", encoding="utf-8") as log:
                log.write(json.dumps(entry) + "\n")

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            mode = self.path.removeprefix("/__mode/")
            if self.path.startswith("/__mode/") and mode in MODES:
                with State.lock:
                    State.mode = mode
                    State.transient_left = 2 if mode == "transient" else 0
                self._send(200, {"ok": True, "mode": mode})
                return
            self._record(405)
            self._send(405, {"error": "fictional Hevy is read-only"})

        do_PUT = do_PATCH = do_DELETE = do_POST

        def do_GET(self):  # noqa: N802
            url = urllib.parse.urlsplit(self.path)
            query = dict(urllib.parse.parse_qsl(url.query))
            if url.path == "/__mode":
                self._send(200, {"mode": State.mode})
                return
            if url.path == "/__redirected":
                self._record(410)
                self._send(410, {"error": "redirect was followed"})
                return
            if url.path not in ("/v1/workouts", "/v1/workouts/events"):
                self._record(404)
                self._send(404, {"error": "not found"})
                return
            if self.headers.get("api-key") != SYNTHETIC_KEY:
                self._record(401)
                self._send(401, {"error": "unauthorized"})
                return
            with State.lock:
                mode = State.mode
                if mode == "transient" and State.transient_left > 0:
                    State.transient_left -= 1
                    mode = "down"
            page = int(query.get("page", "1"))
            size = int(query.get("pageSize", "10"))
            key = "events" if url.path.endswith("/events") else "workouts"
            if mode == "down" or (mode == "partial" and page == 2):
                self._record(503)
                self._send(503, {"error": "fictional outage"})
                return
            if mode == "redirect":
                self._record(302)
                port = self.server.server_address[1]
                self._send(302, None, {"Location": f"http://127.0.0.1:{port}/__redirected"})
                return
            if mode == "malformed":
                self._record(200)
                self._send(200, {"page_count": 1})
                return
            if mode == "empty":
                self._record(200)
                self._send(200, {"page": 1, "page_count": 0, key: []})
                return
            items = [{"id": f"fictional-{n}", "title": f"Fictional workout {n}"} if key == "workouts"
                     else {"type": "updated", "workout": {"id": f"fictional-{n}", "title": f"Fictional workout {n}"}}
                     for n in range(ITEMS)]
            pages = max(1, -(-ITEMS // size))
            self._record(200)
            self._send(200, {"page": page, "page_count": pages, key: items[(page - 1) * size:page * size]})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--log", required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), build_handler(args.log))
    server.daemon_threads = True
    print(f"fake-hevy listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
