# Hevy poll

An external scheduler runs `scripts/poll_cloudflare_hevy.py` hourly. The script POSTs to the Worker's `/internal/hevy-poll` with a pinned poll-only service token read from a private 0600 header file. The Worker backfills on first use, then reads events since the last fully successful run, deduplicates items, and commits the cursor before answering `{"ok":true}`. A failure answers non-200 with an empty body, and the script prints one fixed, content-free line. The Worker's `/healthz` turns `200` only after a fresh committed poll.

## Sub-features

- `poll-first-backfill` makes `/healthz` go from `503 hevy_never_polled` to `200` after one successful run, with 11 Hevy records and a cursor stored.
- `poll-dedupe` stores 11 new event records on the first events poll, and nothing new on a repeat with identical items.
- `poll-empty` handles a complete empty feed: exit 0, no records, cursor advanced.
- `poll-failure` covers a partial or malformed upstream: exit 1, the fixed `[CRON_FAILURE]` line, and an unchanged cursor.
- `poll-file-refusals` refuses a header file that is not mode 0600, and a poll URL that is not HTTPS or loopback or whose path is not `/internal/hevy-poll`. Exit 1 with the fixed line and no request. A missing variable exits 2.
- `poll-scope` gives a writer that POSTs the poll route 403, and GET with the poller 405.

## How to get to it (user POV)

- A scheduler runs `python3.14 scripts/poll_cloudflare_hevy.py` with `HEALTH_INGEST_POLL_URL` and `HEALTH_INGEST_POLLER_HEADERS_FILE`. The file holds exactly `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- The operator reads freshness from the Worker's private `/healthz`.

## Driving it with the poller CLI and curl

Preconditions:

- `hevy` and `edge` are up, `$V doctor` passes and `$V hevy-mode normal` is set. No poll has run in this run's edge: `$V r2 state/` lists nothing.
- `eval "$($V fixtures poller-headers)"; export HEALTH_INGEST_POLL_URL=$EDGE_URL/internal/hevy-poll`.
- `WR=(-H "CF-Access-Client-Id: $WRITER_ID" -H "CF-Access-Client-Secret: $WRITER_SECRET")` reads health.

- **Never polled.** Run `$V rec poll-health-before -- curl -sS -w '\n%{http_code}\n' "${WR[@]}" "$EDGE_URL/healthz"`. The status is `503` with `"reason":"hevy_never_polled"`.
- **First poll.** Run `$V rec poll-first -- python3.14 scripts/poll_cloudflare_hevy.py`. The exit code is `0` with no output.
- **Fresh health.** Repeat the health GET as `poll-health-after`. The status is `200` with `{"ok":true,"revision":"$RELEASE"}`.
- **Second view.** Run `$V rec poll-store -- sh -c '"$SKILL/scripts/verify" r2 state/; "$SKILL/scripts/verify" r2 raw/hevy/ | grep -c "\"key\""'`. It shows `state/hevy.json` and `11` records. `requests.jsonl` shows two GETs to `/v1/workouts`.
- **Events, then dedupe.** Run the poller twice, as `poll-events` and `poll-repeat`. After the first, `raw/hevy/` holds `22` records and the events GETs carry `since=<previous cursor>`. After the second it still holds `22`.
- **Empty feed.** Run `$V hevy-mode empty`, then the poller as `poll-empty`. The exit code is `0`, there are still `22` records, and the `state/hevy.json` SHA256 changed.
- **Failure keeps the cursor.** Note the `state/hevy.json` SHA256 from `$V r2 state/`. Run `$V hevy-mode partial`, then the poller as `poll-partial`. The exit code is `1`, stdout is `[CRON_FAILURE] health-ingest Hevy poll failed; inspect the native run, not response content.`, and `state/hevy.json` has the same SHA256. Repeat with `malformed` as `poll-malformed`. Then run `$V hevy-mode normal`.
- **File and URL refusals.** Record each:
  - `poll-file-mode`: after `chmod 644 "$HEALTH_INGEST_POLLER_HEADERS_FILE"` the run exits `1` with the fixed line. Run `chmod 600` afterwards.
  - `poll-public-http`: `HEALTH_INGEST_POLL_URL=http://example.com/internal/hevy-poll` exits `1` with the fixed line.
  - `poll-wrong-path`: `HEALTH_INGEST_POLL_URL=$EDGE_URL/healthz` exits `1` with the fixed line.
  - `poll-no-url`: `HEALTH_INGEST_POLL_URL=` exits `2` with `HEALTH_INGEST_POLL_URL is required`.
- **Scope.** Record `curl -sS -w '\n%{http_code}\n' "${WR[@]}" -X POST -d '' "$HEALTH_INGEST_POLL_URL"` as `poll-writer-refused`, which gives `403`. Record a GET with the poller's two headers as `poll-get-refused`, which gives `405` with an empty body.

## Gotchas

- Stale health needs a cursor older than two hours, and this harness has no clock control. `hevy_stale` is covered by `npm test`; here, only `hevy_never_polled` and fresh `200` are observable.
- The transient mode answers 503 twice and then succeeds, inside the Worker's three attempts, so the poll passes. Use it to prove retry, not failure.
- The emulated edge accepts the poller token. In production the Access policy and the Worker's `ACCESS_MACHINES` pin must both name the same client ID; the private repo's skill checks the deployed side.
- The fixed failure line is the whole contract. It carries no status, body or identity by design. Diagnose with `evidence/edge.log` and `requests.jsonl`, never by adding output.
