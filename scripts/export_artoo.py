#!/usr/bin/env python3
"""Push an explicitly configured Artoo archive to a tailnet receiver (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import ipaddress
import json
import os
import tarfile
import tempfile
from pathlib import Path

MAX_BODY = 1024 * 1024 * 1024


def export_files(workspace: Path, labs: Path) -> list[tuple[Path, str]]:
    required = [
        workspace / "health-data" / f"{name}.jsonl"
        for name in ("metrics_daily", "sleep", "workouts")
    ] + [
        workspace / "finance-data" / f"{name}.jsonl"
        for name in ("accounts", "transactions", "investments", "liabilities")
    ] + [labs]
    for path in required:
        if not path.is_file():
            raise ValueError(f"Missing required export: {path}")
    files = []
    for directory in ("health-data", "finance-data"):
        for path in sorted((workspace / directory).rglob("*.jsonl")):
            if path.is_file():
                files.append((path, path.relative_to(workspace).as_posix()))
    inbox = workspace / "finance-data" / "inbox"
    if not inbox.is_dir():
        raise ValueError(f"Missing lender statement inbox: {inbox}")
    for path in sorted(inbox.rglob("*.eml")):
        if path.is_file():
            files.append((path, path.relative_to(workspace).as_posix()))
    files.append((labs, "lab_results.jsonl"))
    return files


def configuration(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for flag, variable, kind in (
        ("workspace", "ARTOO_WORKSPACE", Path), ("labs", "ARTOO_LABS", Path),
        ("credential", "ARTOO_CREDENTIAL_FILE", Path), ("scratch", "ARTOO_SCRATCH", Path),
        ("host", "ARTOO_HOST", str),
    ):
        value = os.environ.get(variable)
        parser.add_argument(f"--{flag}", type=kind, default=value,
                            required=not value, help=f"Explicit value or {variable}")
    parser.add_argument("--port", type=int, default=os.environ.get("ARTOO_PORT", "8789"))
    args = parser.parse_args(argv)
    try:
        address = ipaddress.ip_address(args.host)
        if not (address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10")):
            raise ValueError()
    except ValueError:
        parser.error("host must be a literal tailnet or loopback IP; DNS is refused")
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    return parser, args


def main(argv=None) -> None:
    parser, args = configuration(argv)
    try:
        files = export_files(args.workspace, args.labs)
        credential = args.credential.read_text().strip()
        if not credential:
            raise ValueError("Empty Artoo credential")
        scratch = args.scratch
        scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix="export-", dir=scratch) as directory:
            archive = Path(directory) / "snapshot.tar.gz"
            with tarfile.open(archive, "w:gz", dereference=True, compresslevel=3) as bundle:
                for path, name in files:
                    bundle.add(path, arcname=name, recursive=False)
            size = archive.stat().st_size
            if size > MAX_BODY:
                raise ValueError("Snapshot exceeds receiver's 1 GiB compressed limit")
            digest = hashlib.sha256()
            with archive.open("rb") as body:
                for chunk in iter(lambda: body.read(1024 * 1024), b""):
                    digest.update(chunk)
            connection = http.client.HTTPConnection(args.host, args.port, timeout=300)
            try:
                with archive.open("rb") as body:
                    connection.request("POST", "/artoo/snapshot", body=body, headers={
                        "Authorization": "Bearer " + credential,
                        "Content-Type": "application/gzip",
                        "Content-Length": str(size),
                    })
                response = connection.getresponse()
                reply = response.read()
                if response.status != 200:
                    raise ValueError(f"Delivery failed: HTTP {response.status}")
                receipt = json.loads(reply)
                if (receipt.get("status") != "ok"
                        or receipt.get("sha256") != digest.hexdigest()
                        or receipt.get("bytes") != size):
                    raise ValueError("Receiver receipt does not match the uploaded snapshot")
                print(json.dumps(receipt, indent=2))
            finally:
                connection.close()
    except (OSError, ValueError, http.client.HTTPException) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
