# health-ingest

A native HTTP receiver, read-only Hevy poller, Artoo archive exporter and
Cloudflare adapter. Receipts preserve accepted bytes. The native and
Cloudflare storage contracts are documented separately in [SPEC.md](SPEC.md)
and [cloudflare/SPEC.md](cloudflare/SPEC.md).

## Verify with synthetic inputs

Use Python 3.14.7. The native code needs no third-party dependencies:

    python3.14 -m unittest discover -s tests -v

Tests use loopback and disposable synthetic stores. For the Cloudflare local
runtime checks, follow [cloudflare/README.md](cloudflare/README.md).

## Configure native callers

Caller destinations and store paths have no personal defaults. Supply flags or
process environment variables. [config/synthetic.env.example](config/synthetic.env.example)
contains fictional paths and identities; it is never loaded automatically.
Keep real settings outside the source checkout. Use mode 0700 for private
configuration directories and 0600 for files. Credentials remain in the existing
secret store or private credential files, never in examples or the export.

- `scripts/export_artoo.py` requires `--host`, `--workspace`, `--labs`,
  `--credential` and `--scratch`, or their `ARTOO_*` environment equivalents.
  `--port` or `ARTOO_PORT` defaults to 8789. Host must be a literal tailnet or
  loopback IP; public DNS is refused. Delivery still verifies receipt digest
  and length and preserves the native 1 GiB compressed limit.
- `scripts/sync_hevy.py --poll` requires `--state` or
  `HEALTH_INGEST_STATE_FILE`, `--ingest-url` or `HEALTH_INGEST_URL`, and the
  receiver's `HEALTH_INGEST_TOKEN`. An optional explicit `--env-file` or
  `HEALTH_INGEST_ENV_FILE` loads settings; process environment wins. An explicitly
  named missing or unreadable file exits with code 2. Receiver URLs require HTTPS,
  or HTTP to a literal loopback or `100.64.0.0/10` IP. Userinfo, queries,
  fragments and redirects are refused before delivery; failed delivery keeps the cursor.
  `HEVY_API_KEY` is accepted only from the process environment, through the
  existing secret-store runner. No source-local `.env` or cursor is selected.
- `scripts/poll_cloudflare_hevy.py` requires `HEALTH_INGEST_POLL_URL` and
  `HEALTH_INGEST_POLLER_HEADERS_FILE`. The latter is an owned regular file
  with mode 0600 and exactly the two Access headers. HTTPS is required except
  for loopback synthetic checks. Redirects are refused.
- `systemd/health-ingest-hevy.service` is an uninstalled user-unit example.
  Its generic install directory is `%h/.local/share/health-ingest`; its external
  settings file is `%h/.config/health-ingest/hevy.env`. Keep the existing
  secret-store reference in `%h/.config/health-ingest/hevy.env.pass`. This source change
  does not install units, change an existing schedule or move private data.

The native receiver retains its existing environment and source-local storage
contract. Run it only from a disposable copy for synthetic QA. No bundled
records, credentials, sample exports or fallback data are supplied.

## Source provenance

[docs/source-custody.json](docs/source-custody.json) identifies the original
imported snapshot. Its hashes describe those original bytes, not today's
modified generic source or the running interpreter. No omitted original history,
stores, credentials or uncertified samples are imported. See
[docs/public-export.md](docs/public-export.md) for the manifest format.
