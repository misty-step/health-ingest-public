#!/usr/bin/env python3
"""Run the repository's scripts/sync_hevy.py unchanged, with Hevy pointed at the fictional stub.

    sync_hevy_stubbed.py --hevy-url http://127.0.0.1:PORT -- --poll --state ... --ingest-url ...

The real CLI hard-codes https://api.hevyapp.com. This wrapper swaps only the
upstream base URL (loopback only) and then calls the real main(argv), so
argument parsing, URL policy, cursor handling and delivery run as shipped.
"""
import argparse
import importlib.util
import ipaddress
import sys
import urllib.parse
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--hevy-url", required=True)
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    host = urllib.parse.urlsplit(args.hevy_url).hostname or ""
    try:
        if not ipaddress.ip_address(host).is_loopback:
            raise ValueError
    except ValueError:
        parser.error("--hevy-url must be a literal loopback URL; the real Hevy API is never contacted")
    spec = importlib.util.spec_from_file_location("sync_hevy", REPO / "scripts" / "sync_hevy.py")
    sync_hevy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync_hevy)
    original = sync_hevy.HevyClient

    class StubbedClient(original):
        def __init__(self, api_key, base_url=None):
            super().__init__(api_key, args.hevy_url)

    sync_hevy.HevyClient = StubbedClient
    rest = args.rest[1:] if args.rest[:1] == ["--"] else args.rest
    return sync_hevy.main(rest)


if __name__ == "__main__":
    sys.exit(main())
