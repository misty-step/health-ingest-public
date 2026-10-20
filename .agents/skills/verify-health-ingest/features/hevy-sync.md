# Hevy sync

`scripts/sync_hevy.py` pulls Hevy workouts into the native receiver, and it is strictly read-only upstream: GET only, two allowlisted paths, page size 10, no redirects. `--backfill` posts every workout page and records a cursor. `--poll` posts workout events since the cursor. The cursor advances only after every post succeeds, so a failed run is retried from the same point.

## Sub-features

- `hevy-backfill` reads every page and posts each non-empty page as `kind: backfill`, then writes `{"since": <run start>}`.
- `hevy-poll` reads `/v1/workouts/events?since=<cursor>` across pages, posts `kind: events`, and advances the cursor.
- `hevy-empty` handles a complete empty feed: nothing is posted, `0 events` is printed and the cursor advances.
- `hevy-failure-keeps-cursor` covers an upstream outage, a receiver that is down or a redirect: exit 1 with a fixed message and an unchanged cursor.
- `hevy-config-refusals` covers poll without a cursor, a missing state or URL, a non-UUID key and a public HTTP URL, each refused before any post.

## How to get to it (user POV)

- An operator runs `pass-env run ... -- python3.14 scripts/sync_hevy.py --backfill|--poll --state <file> --ingest-url <url>`, with `HEVY_API_KEY` and `HEALTH_INGEST_TOKEN` in the process environment.
- In production, the systemd timer example `systemd/health-ingest-hevy.timer` runs `--poll` hourly.

## Driving it with sync_hevy_stubbed.py

Preconditions:

- `native` and `hevy` are up and `$V hevy-mode normal` is set.
- `verify env` exports `HEVY_API_KEY` (the synthetic UUID), `HEALTH_INGEST_TOKEN` (this run's receiver bearer), the cursor path `$ST` and `$SYNC`. `$SYNC` is the real CLI with the stubbed upstream, used as `python3.14 $SYNC <args>`.
- No cursor exists at `$ST`.

- **Poll needs a cursor.** Run `$V rec hevy-no-cursor -- python3.14 $SYNC --poll --state "$ST" --ingest-url "$NATIVE_URL"`. The exit code is `1`, stderr says `no cursor: run --backfill first`, and `requests.jsonl` has no new line.
- **Backfill.** Run `$V rec hevy-backfill -- python3.14 $SYNC --backfill --state "$ST" --ingest-url "$NATIVE_URL"`. The exit code is `0` and stdout shows `backfill page 1/2: 10 workouts` and `backfill page 2/2: 1 workouts`. `$ST` holds `{"since": "<UTC start>"}` and `$NATIVE_DATA/raw/hevy/<D>.json` holds two `backfill` records.
- **Upstream was read-only.** Run `$V rec hevy-requests -- cat "$VERIFY_RUN/hevy/requests.jsonl"`. Every line is `"method": "GET"` on `/v1/workouts` or `/v1/workouts/events` with `"pageSize": "10"` and `"api_key_ok": true`.
- **Poll.** Run `$V rec hevy-poll -- python3.14 $SYNC --poll --state "$ST" --ingest-url "$NATIVE_URL"`. Stdout is `poll since <cursor>: 11 events`, the events requests carry `since=<previous cursor>`, and `$ST` holds a newer `since`.
- **Empty poll advances.** Run `$V hevy-mode empty`, wait one second, then poll as `hevy-empty`. Stdout is `0 events`, no record is added, and `$ST` advances.
- **Outage keeps the cursor.** Run `cp "$ST" "$ST.before"` and `$V hevy-mode partial`, wait one second, then poll as `hevy-partial`. The exit code is `1`, stderr says `hevy sync failed: receiver or upstream request refused`, and `cmp "$ST" "$ST.before"` succeeds.
- **Receiver down keeps the cursor.** Run `$V hevy-mode normal`, then poll with `--ingest-url http://127.0.0.1:1` as `hevy-receiver-down`. The exit code is `1` with the same message, and the cursor is unchanged.
- **Redirect refused.** Run `$V hevy-mode redirect`, poll as `hevy-redirect`, then `$V hevy-mode normal`. The exit code is `1` and the cursor is unchanged. The stub redirects to its own `/__redirected`, so `grep -c __redirected "$VERIFY_RUN/hevy/requests.jsonl"` printing `0` (exit 1) proves the redirect was not followed.
- **Configuration refusals.** Record each:
  - `hevy-public-http`: `--ingest-url http://example.com` exits `2` with the HTTPS-or-loopback/tailnet message.
  - `hevy-bad-key`: `env HEVY_API_KEY=nope python3.14 $SYNC --poll ...` exits `1` with `HEVY_API_KEY missing or not a UUID`.
  - `hevy-no-state`: omitting `--state` exits `2` with `--state or HEALTH_INGEST_STATE_FILE is required`.

## Gotchas

- The cursor's resolution is one second, and the stub answers instantly. Wait a second between polls, or an "advanced" cursor can read the same as before.
- Partial failure is a known, specified gap (SPEC.md, "Known gaps"). Pages posted before the failure stay in the store, so the retry appends them again. Expect `events` records to exceed the event count after a partial run. That is not a harness fault.
- `sync_hevy_stubbed.py` swaps only the upstream base URL and refuses non-loopback values. It never contacts api.hevyapp.com. Never run plain `scripts/sync_hevy.py` with a real key for verification.
- `HEVY_API_KEY` is read only from the process environment, never from `--env-file`.
- The self-redirect proves this CLI does not follow redirects. The Worker's own no-redirect rule cannot be observed here, because a followed redirect would come back through the edge and fail with 502 before reaching the stub; `npm test` covers it.
