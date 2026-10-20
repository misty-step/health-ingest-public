#!/usr/bin/env python3
"""sync_hevy.py — Pull Hevy workouts into health-ingest. Strictly read-only.

The Hevy API key is account-wide read/write with no scopes, so read-only is
enforced here: HevyClient can only issue GET, only to an allowlist of read
paths, only to api.hevyapp.com, and never follows redirects (the key would
travel with them).

The key comes from the environment (HEVY_API_KEY), never from a file. Run it
through the pass store:

  pass-env run -f /private/hevy.env.pass -- python3 scripts/sync_hevy.py --env-file /private/hevy.env --backfill
  pass-env run -f /private/hevy.env.pass -- python3 scripts/sync_hevy.py --env-file /private/hevy.env --poll

  --backfill  page through GET /v1/workouts, post every workout, record the
              cursor. Safe to re-run (re-posts everything; raw store appends).
  --poll      GET /v1/workouts/events?since=<cursor>, post updates/deletes,
              advance the cursor. Requires a prior --backfill.

Cursor: explicit --state or HEALTH_INGEST_STATE_FILE, with
{"since": "<ISO-8601 UTC>"}. It is the time the last successful run *started*,
so events landing mid-run are re-read next
time instead of lost. It only advances after every post succeeded.
"""

import argparse
import ipaddress
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HEVY_BASE = "https://api.hevyapp.com"
PAGE_SIZE = 10  # documented maximum for /v1/workouts and /v1/workouts/events
# The only paths this client can ever request. Both are GET-only reads.
ALLOWED_PATHS = frozenset({"/v1/workouts", "/v1/workouts/events"})
TIMEOUT = 30


class ReadOnlyViolation(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # surfaces as HTTPError without forwarding credentials


class HevyClient:
    """GET-only Hevy client. There is deliberately no method that sends a body."""

    def __init__(self, api_key: str, base_url: str = HEVY_BASE):
        if not api_key:
            raise ValueError("HEVY_API_KEY is empty")
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._opener = urllib.request.build_opener(_NoRedirect)

    def get(self, path: str, params: dict | None = None) -> dict:
        if path not in ALLOWED_PATHS:
            raise ReadOnlyViolation(f"path not on the read allowlist: {path!r}")
        query = urllib.parse.urlencode(params or {})
        req = urllib.request.Request(
            f"{self._base}{path}" + (f"?{query}" if query else ""),
            headers={"api-key": self._key, "Accept": "application/json"},
            method="GET",
        )
        with self._opener.open(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def pages(self, path: str, items_key: str, params: dict | None = None):
        """Yield (page, page_count, items) for every page."""
        page = 1
        while True:
            body = self.get(path, {**(params or {}), "page": page, "pageSize": PAGE_SIZE})
            page_count = int(body.get("page_count", page))
            yield page, page_count, body.get(items_key, [])
            if page >= page_count:
                return
            page += 1


def load_env(env_path: Path) -> dict:
    env = {}
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_state(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text())


def write_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    os.replace(tmp, path)


def validate_ingest_url(url: str) -> None:
    try:
        target = urllib.parse.urlsplit(url)
        if (not target.hostname or target.username is not None or target.password is not None
                or "?" in url or "#" in url or any(c.isspace() or ord(c) < 32 for c in url)
                or target.port is not None and not 1 <= target.port <= 65535):
            raise ValueError()
        if target.scheme == "https":
            return
        address = ipaddress.ip_address(target.hostname)
        if target.scheme == "http" and (
                address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10")):
            return
    except ValueError:
        pass
    raise ValueError("--ingest-url or HEALTH_INGEST_URL must use HTTPS, or HTTP to a literal loopback or tailnet IP; no userinfo, query or fragment")


def post_to_ingest(payload: dict, ingest_url: str, bearer_token: str) -> dict:
    validate_ingest_url(ingest_url)
    req = urllib.request.Request(
        f"{ingest_url.rstrip('/')}/ingest/hevy",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {bearer_token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.build_opener(_NoRedirect()).open(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def backfill(client: HevyClient, post, state_path: Path) -> int:
    started = utc_now_iso()
    total = 0
    for page, page_count, workouts in client.pages("/v1/workouts", "workouts"):
        if workouts:
            post({"kind": "backfill", "page": page, "page_count": page_count, "workouts": workouts})
        total += len(workouts)
        print(f"backfill page {page}/{page_count}: {len(workouts)} workouts")
    write_state(state_path, {"since": started})
    return total


def poll(client: HevyClient, post, state_path: Path) -> int:
    state = read_state(state_path)
    if not state or not state.get("since"):
        raise SystemExit("no cursor: run --backfill first")
    started = utc_now_iso()
    since = state["since"]
    total = 0
    for page, page_count, events in client.pages("/v1/workouts/events", "events", {"since": since}):
        if events:
            post({"kind": "events", "since": since, "page": page, "page_count": page_count, "events": events})
        total += len(events)
    write_state(state_path, {"since": started})
    print(f"poll since {since}: {total} events")
    return total


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Hevy read-only puller for health-ingest")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--backfill", action="store_true", help="fetch every workout")
    mode.add_argument("--poll", action="store_true", help="fetch workout events since last run")
    parser.add_argument("--env-file", type=Path, default=os.environ.get("HEALTH_INGEST_ENV_FILE"),
                        help="Explicit external settings file; process environment wins")
    parser.add_argument("--state", type=Path, help="Cursor path or HEALTH_INGEST_STATE_FILE")
    parser.add_argument("--ingest-url", help="Receiver URL or HEALTH_INGEST_URL")
    args = parser.parse_args(argv)

    try:
        settings = load_env(args.env_file) if args.env_file else {}
    except (OSError, UnicodeError):
        parser.error("--env-file or HEALTH_INGEST_ENV_FILE must name a readable settings file")
    env = {**settings, **os.environ}
    state = args.state or env.get("HEALTH_INGEST_STATE_FILE")
    ingest_url = args.ingest_url or env.get("HEALTH_INGEST_URL")
    if not state:
        parser.error("--state or HEALTH_INGEST_STATE_FILE is required")
    if not ingest_url:
        parser.error("--ingest-url or HEALTH_INGEST_URL is required")
    try:
        validate_ingest_url(ingest_url)
    except ValueError as error:
        parser.error(str(error))
    api_key = os.environ.get("HEVY_API_KEY", "")  # process env only, never .env
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", api_key):
        sys.exit("HEVY_API_KEY missing or not a UUID; run via `pass-env run -f .env.pass -- ...`")
    ingest_token = env.get("HEALTH_INGEST_TOKEN")
    if not ingest_token:
        sys.exit("HEALTH_INGEST_TOKEN not set in environment or explicit settings file")

    client = HevyClient(api_key)
    post = lambda payload: post_to_ingest(payload, ingest_url, ingest_token)
    try:
        (backfill if args.backfill else poll)(client, post, Path(state))
    except urllib.error.URLError as e:
        if isinstance(e, urllib.error.HTTPError):
            e.close()
        sys.exit("hevy sync failed: receiver or upstream request refused")
    return 0


if __name__ == "__main__":
    sys.exit(main())
