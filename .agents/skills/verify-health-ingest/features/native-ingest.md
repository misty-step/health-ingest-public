# Native ingest

The native receiver is what a JSON client such as Health Auto Export, or the Hevy sync, posts to. It answers an unauthenticated liveness probe with exactly `ok`. It appends each authenticated JSON POST to a per-source daily file, replays included. It refuses bad requests without writing. It never overwrites a daily file that is not a JSON list; it writes a side file instead.

## Sub-features

- `native-health` returns `200` and exactly `ok\n` from `GET /healthz` without credentials.
- `native-ingest` accepts a bearer-authenticated JSON POST to `/ingest/<source>` and returns `status`, `source`, `stored` and `bytes`.
- `native-replay` appends an identical second POST as a second record.
- `native-refusals` covers missing or wrong bearer (403), invalid JSON (400), chunked or no length (411), empty body (400), over-limit (413), invalid source name (400) and unknown route (404), each without a write.
- `native-side-file` keeps a hand-edited, non-list daily file and writes `YYYY-MM-DD.HHMMSS.json` beside it.

## How to get to it (user POV)

- A client POSTs JSON to `http://<receiver>:<port>/ingest/<source>` with `Authorization: Bearer <HEALTH_INGEST_TOKEN>`.
- A monitor GETs `/healthz`.
- An operator starts `python3.14 server.py` with `HEALTH_INGEST_TOKEN`, `HEALTH_INGEST_BIND` and `HEALTH_INGEST_PORT`. `verify up native` does this from a disposable copy.

## Driving it with curl

Preconditions:

- `native` is up and `$V doctor` passes. `$NATIVE_URL`, `$NATIVE_TOKEN`, `$NATIVE_DATA` and `$D` (the UTC day the receiver files under) come from `verify env`.

- **Health probe.** Run `$V rec native-health -- curl -sS -w '\n%{http_code}\n' "$NATIVE_URL/healthz"`. The body is `ok` and the status is `200`.
- **Refuse without bearer.** Run `$V rec native-no-bearer -- curl -sS -w '\n%{http_code}\n' -H 'Content-Type: application/json' -d '{"fictional":1}' "$NATIVE_URL/ingest/synthetic"`. The body is `forbidden`, the status is `403`, and on a fresh store `ls "$NATIVE_DATA/raw/synthetic"` fails because nothing was written.
- **Ingest.** Run `$V rec native-ingest -- curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $NATIVE_TOKEN" -d '{"fictional":1}' "$NATIVE_URL/ingest/synthetic"`. The status is `200` and the body is `{"status": "ok", "source": "synthetic", "stored": "data/raw/synthetic/<D>.json", "bytes": 15}`.
- **Replay appends.** Repeat the same POST as `native-replay`. Then run `$V rec native-replay-store -- python3.14 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d), [r["payload"] for r in d])' "$NATIVE_DATA/raw/synthetic/$D.json"`. It prints `2 [{'fictional': 1}, {'fictional': 1}]`.
- **Wrong bearer.** Run the ingest POST with `-H "Authorization: Bearer wrong"` as `native-wrong-bearer`. The status is `403 forbidden`.
- **Refusals.** Each of these keeps the valid `-H "Authorization: Bearer $NATIVE_TOKEN"`; without it every case is `403`. Record the status for each and confirm the record count stays `2`:
  - `native-bad-json`: `-d '{bad'` gives `400 invalid JSON: ...`.
  - `native-empty`: `-X POST -H 'Content-Length: 0'` with no body gives `400 empty body`.
  - `native-chunked`: `-H 'Transfer-Encoding: chunked' -d '{}'` gives `411 Content-Length required`.
  - `native-too-large`: `-H 'Content-Length: 67108865' -d '{}'` gives `413 payload too large`.
  - `native-bad-source`: POST to `/ingest/bad_name` gives `400 invalid source name`.
  - `native-unknown-route`: `GET /nope` with no bearer gives `404 not found`.
- **Side file.** Run `mkdir -p "$NATIVE_DATA/raw/sidecar" && printf 'hand edited' > "$NATIVE_DATA/raw/sidecar/$D.json"`. Then POST `{"fictional":2}` to `/ingest/sidecar` as `native-side-file`. The `stored` path ends `<D>.HHMMSS.json`, the original still reads `hand edited`, and `ls "$NATIVE_DATA/raw/sidecar"` shows both files.

## Gotchas

- Storage sits next to `server.py`. Only `verify up native`'s copy is safe to drive; a checkout's own `data/` or an installed receiver holds real records.
- With `--tailnet` the receiver listens only on the tailnet IP, so `127.0.0.1:<port>` refuses connections. Use `$NATIVE_URL`.
- The receiver files by its local day. `verify up native` runs it with `TZ=UTC`, so `$D` is the UTC date and `received_at` ends `+00:00`. A run spanning UTC midnight splits across two day files.
- `curl -d` strips newlines and sets `application/x-www-form-urlencoded`. The receiver ignores content type, so the proof is the stored payload, not the header.
- The receiver's log in `evidence/native.log` records peer IPs and paths only, never bodies.
