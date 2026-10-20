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

- `native` is up and `$V doctor` passes. `$NATIVE_URL`, `$NATIVE_TOKEN` and `$NATIVE_DATA` are set.
- Daily files are named in the receiver's local timezone: `D=$(date +%F)`.

- **Health probe.** Run `$V rec native-health -- curl -sS -w '\n%{http_code}\n' "$NATIVE_URL/healthz"`. The body is `ok` and the status is `200`.
- **Refuse without bearer.** Run `$V rec native-no-bearer -- curl -sS -w '\n%{http_code}\n' -H 'Content-Type: application/json' -d '{"fictional":1}' "$NATIVE_URL/ingest/synthetic"`. The body is `forbidden`, the status is `403`, and on a fresh store `ls "$NATIVE_DATA/raw/synthetic"` fails because nothing was written.
- **Ingest.** Run `$V rec native-ingest -- curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $NATIVE_TOKEN" -d '{"fictional":1}' "$NATIVE_URL/ingest/synthetic"`. The status is `200` and the body is `{"status": "ok", "source": "synthetic", "stored": "data/raw/synthetic/<D>.json", "bytes": 15}`.
- **Replay appends.** Repeat the same POST as `native-replay`. Then run `$V rec native-replay-store -- python3.14 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d), [r["payload"] for r in d])' "$NATIVE_DATA/raw/synthetic/$D.json"`. It prints `2 [{'fictional': 1}, {'fictional': 1}]`.
- **Refusals.** For each case, record the status and confirm the record count stays `2`:
  - `native-bad-json`: `-d '{bad'` gives `400 invalid JSON: ...`.
  - `native-chunked`: `-H 'Transfer-Encoding: chunked' -d '{}'` gives `411 Content-Length required`.
  - `native-too-large`: `-H 'Content-Length: 67108865' -d '{}'` gives `413 payload too large`.
  - `native-bad-source`: POST to `/ingest/bad_name` gives `400 invalid source name`.
  - `native-unknown-route`: `GET /nope` gives `404 not found`.
- **Side file.** Run `printf 'hand edited' > "$NATIVE_DATA/raw/sidecar/$D.json"` after `mkdir -p "$NATIVE_DATA/raw/sidecar"`. Then POST `{"fictional":2}` to `/ingest/sidecar` as `native-side-file`. The `stored` path ends `<D>.HHMMSS.json`, the original still reads `hand edited`, and `ls "$NATIVE_DATA/raw/sidecar"` shows both files.

## Gotchas

- Storage sits next to `server.py`. Only `verify up native`'s copy is safe to drive; a checkout's own `data/` or an installed receiver holds real records.
- With `--tailnet` the receiver listens only on the tailnet IP, so `127.0.0.1:<port>` refuses connections. Use `$NATIVE_URL`.
- The day boundary is local time while `received_at` carries an offset. Compute `D` on the same host.
- `curl -d` strips newlines and sets `application/x-www-form-urlencoded`. The receiver ignores content type, so the proof is the stored payload, not the header.
- The receiver's log in `evidence/native.log` records peer IPs and paths only, never bodies.
