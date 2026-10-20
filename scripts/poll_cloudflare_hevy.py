"""Poll an explicitly configured endpoint using a private 0600 header file."""
import json
import os
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.request
import urllib.parse
import ipaddress

FAILURE = "[CRON_FAILURE] health-ingest Hevy poll failed; inspect the native run, not response content."


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def run(private, url):
    target = urllib.parse.urlsplit(url)
    try:
        loopback = ipaddress.ip_address(target.hostname).is_loopback
    except (ValueError, TypeError):
        loopback = False
    if (target.scheme != "https" and not (target.scheme == "http" and loopback)
            or not target.hostname or target.username or target.password
            or target.query or target.fragment or target.path != "/internal/hevy-poll"):
        raise ValueError("poll URL refused")
    with open(private, "r", opener=lambda name, flags: os.open(name, flags | os.O_NOFOLLOW)) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise ValueError("private configuration refused")
        headers = json.load(stream)
    if set(headers) != {"CF-Access-Client-Id", "CF-Access-Client-Secret"} or not all(
        isinstance(value, str) and value and not any(c in value for c in "\r\n")
        for value in headers.values()
    ):
        raise ValueError("private configuration refused")
    request = urllib.request.Request(url, data=b"", method="POST",
        headers={**headers, "User-Agent": "health-ingest-poller/1"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=150) as response:
        if response.status != 200 or response.read(64) != b'{"ok":true}':
            raise ValueError("poll unverified")


def main(private=None, url=None):
    if private is None:
        private = os.environ.get("HEALTH_INGEST_POLLER_HEADERS_FILE")
    url = url or os.environ.get("HEALTH_INGEST_POLL_URL")
    for name, value in (("HEALTH_INGEST_POLLER_HEADERS_FILE", private),
                        ("HEALTH_INGEST_POLL_URL", url)):
        if not value:
            print(f"{name} is required", file=sys.stderr)
            return 2
    try:
        run(private, url)
        return 0
    except Exception as error:
        if isinstance(error, urllib.error.HTTPError):
            error.close()
        print(FAILURE)
        return 1


if __name__ == "__main__":
    sys.exit(main())
