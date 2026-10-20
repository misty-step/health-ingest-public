# Cloudflare ingest

A pinned writer machine POSTs JSON to `/ingest/<source>` or a gzip archive to `/artoo/snapshot`. The Worker streams the exact bytes into private storage keyed by SHA256 and returns a receipt naming source, key, bytes, SHA256 and receipt time. An exact replay returns the original receipt and keeps one record. Invalid input is refused with nothing published and no leftover staging object. Health Auto Export's routes are absent.

## Sub-features

- `cf-json` stores valid JSON byte-for-byte and returns a receipt.
- `cf-replay` returns the original receipt, including `received_at`, for identical bytes. Different bytes make a new record.
- `cf-archive` stores `application/gzip` bytes opaquely at `raw/artoo/<sha256>`.
- `cf-source-authority` gives a writer 403 for a source it is not pinned to.
- `cf-refusals` covers malformed JSON (400), nesting past 128 containers (400), length of 100,000,000 or more (413), wrong archive media (415) and GET on a write route (405).
- `cf-hae-absent` returns 404 for `/hae` and `/ingest/healthautoexport`, even for the owner.

## How to get to it (user POV)

- A writer client, the Artoo exporter's Cloudflare successor, sends its two Access headers and a `Content-Length` body to `https://<host>/ingest/<source>` or `/artoo/snapshot`.
- Locally that host is `$EDGE_URL`, and the writer is `$WRITER_ID`/`$WRITER_SECRET`, pinned to sources `artoo` and `synthetic`.

## Driving it with curl

Preconditions:

- `hevy` and `edge` are up and `$V doctor` passes.
- `WR=(-H "CF-Access-Client-Id: $WRITER_ID" -H "CF-Access-Client-Secret: $WRITER_SECRET")` in bash.

- **JSON write.** Run `$V rec cf-json -- curl -sS -w '\n%{http_code}\n' "${WR[@]}" -H 'Content-Type: application/json' -d '{"fictional":true,"n":1}' "$EDGE_URL/ingest/synthetic"`. The status is `200` and the receipt has `"source":"synthetic"`, `"stored":"raw/synthetic/<sha256>"`, `"bytes":24` and `received_at`.
- **Exact replay.** Repeat the identical command as `cf-replay`. The receipt is byte-identical, including `received_at`.
- **Different bytes.** POST `{"fictional":true,"n":2}` as `cf-json-2`. The receipt has a new `sha256`.
- **Second view.** Run `$V rec cf-store -- $V r2 raw/`. It lists exactly one object per distinct body, with matching `bytes` and `sha256`, and `$V r2 staging/` is empty.
- **Archive.** Run `printf 'fictional archive' | gzip -n > "$VERIFY_RUN/fixed.tar.gz"`, then `$V rec cf-archive -- curl -sS -w '\n%{http_code}\n' "${WR[@]}" -H 'Content-Type: application/gzip' --data-binary @"$VERIFY_RUN/fixed.tar.gz" "$EDGE_URL/artoo/snapshot"`. The status is `200` with `"source":"artoo"`, and `sha256sum "$VERIFY_RUN/fixed.tar.gz"` equals the receipt's `sha256`.
- **Refusals.** Record each and confirm `$V r2 raw/` and `$V r2 staging/` are unchanged:
  - `cf-bad-json`: `-d '{"bad'` gives `400 {"error":"invalid JSON"}`.
  - `cf-too-deep`: `python3 -c "print('['*129+']'*129,end='')" > "$VERIFY_RUN/deep.json"` sent with `--data-binary @"$VERIFY_RUN/deep.json"` gives `400 {"error":"JSON nesting exceeds 128 containers"}`.
  - `cf-too-large`: `-H 'Content-Length: 100000000' -d '{}'` gives `413 {"error":"batch must be under 100 MB"}`.
  - `cf-wrong-media`: the archive sent with `-H 'Content-Type: application/json'` gives `415`.
  - `cf-unpinned-source`: POST `{}` to `/ingest/hevy` gives `403 {"error":"forbidden"}`.
  - `cf-get-write-route`: GET `/ingest/synthetic` gives `405`.
- **HAE absent.** Signed in as the owner (see [sign-in.md](./sign-in.md)), POST `{}` to `/ingest/healthautoexport` as `cf-hae-absent`. The status is `404`.
- **Persistence across restart.** Run `$V stop edge`, `$V up edge` and `eval "$($V env)"`, because the ports change. Then repeat the `cf-json` POST as `cf-replay-after-restart`. The original receipt, with its original `received_at`, comes back because R2 persists in `<run>/edge/r2`.

## Gotchas

- `received_at` comes from the first accepted write. A changed `received_at` on replay means a second record was published, which is a product bug.
- curl recomputes `Content-Length` unless you pass the header yourself. The 413 case relies on the manual header and is refused before any body is read.
- The control port behind `$V r2` is verification-only, not a product route. The product exposes no read or download endpoint.
- The emulated edge forwards bodies unchanged but buffers responses. It is not a performance proxy; the 99,999,999-byte streaming case is covered by `npm test` ([synthetic-checks.md](./synthetic-checks.md)).
