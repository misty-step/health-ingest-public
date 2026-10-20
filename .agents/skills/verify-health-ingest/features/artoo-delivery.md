# Artoo delivery

The Artoo exporter bundles a complete health and finance export plus a labs file into one gzip archive. It delivers the archive to the receiver's `/artoo/snapshot` over the tailnet and prints the receipt only if the receiver's SHA256 and byte count match what was sent. The receiver lands the opaque bytes beside a receipt, never unpacks them, and answers a same-day identical replay with the original receipt.

## Sub-features

- `artoo-export` runs `scripts/export_artoo.py`, delivers, verifies the receipt and prints it.
- `artoo-replay` re-posts identical bytes and gets the original receipt back, with no second copy.
- `artoo-refusals` covers a DNS host refused before any connection (exit 2), a missing required export (exit 1, no delivery), a wrong credential (`Delivery failed: HTTP 403`), and wrong media type (415).

## How to get to it (user POV)

- Run `python3.14 scripts/export_artoo.py` with `--host`, `--port`, `--workspace`, `--labs`, `--credential` and `--scratch`, or their `ARTOO_*` environment equivalents.
- The receiver accepts only a peer in 100.64.0.0/10 that presents its separate Artoo bearer.

## Driving it with the exporter and curl

Preconditions:

- `native` was started with `$V up native --tailnet`, so `$NATIVE_URL` is `http://100.x.y.z:<port>`.
- `$V fixtures artoo` has run. `verify env` already exports `ARTOO_HOST`, `ARTOO_PORT`, `ARTOO_WORKSPACE`, `ARTOO_LABS`, `ARTOO_CREDENTIAL_FILE`, `ARTOO_SCRATCH` and `$FIXED_GZ`.

- **Export and deliver.** Run `$V rec artoo-export -- python3.14 scripts/export_artoo.py`. The exit code is `0` and stdout is a receipt with `"status": "ok"`, `"source": "artoo"`, `"remote"` equal to `$ARTOO_HOST`, and `bytes` and `sha256`. The `stored` path is `data/raw/artoo/<D>/<sha256>/snapshot.tar.gz`.
- **Second view.** Run `$V rec artoo-store -- sh -c 'cd "$NATIVE_DATA" && find raw/artoo -type f | sort && sha256sum raw/artoo/*/*/snapshot.tar.gz'`. The file hash equals the receipt's `sha256` and its directory name, and `receipt.json` sits beside it.
- **Identical replay.** Run `printf 'fictional archive' | gzip -n > "$FIXED_GZ"`. Then run the same `curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $ARTOO_TOKEN" -H 'Content-Type: application/gzip' --data-binary @"$FIXED_GZ" "$NATIVE_URL/artoo/snapshot"` twice, as `artoo-replay-1` and `artoo-replay-2`. Both answer `200` with byte-identical receipts, including `received_at`, and only one directory for that hash exists.
- **DNS refused.** Run `$V rec artoo-dns-refused -- python3.14 scripts/export_artoo.py --host ingest.example.invalid`. The exit code is `2`, stderr says `host must be a literal tailnet or loopback IP; DNS is refused`, and no new archive appears.
- **Missing export.** Run `mv "$ARTOO_WORKSPACE/health-data/sleep.jsonl" "$VERIFY_RUN/"`, then `$V rec artoo-missing -- python3.14 scripts/export_artoo.py`. The exit code is `1` and stderr says `Missing required export: .../sleep.jsonl`. Move the file back with `mv "$VERIFY_RUN/sleep.jsonl" "$ARTOO_WORKSPACE/health-data/"`.
- **Wrong credential.** Run `echo wrong > "$VERIFY_RUN/private/wrong.token"`, then `$V rec artoo-wrong-token -- python3.14 scripts/export_artoo.py --credential "$VERIFY_RUN/private/wrong.token"`. The exit code is `1` and stderr says `Delivery failed: HTTP 403`.
- **Wrong media.** POST the fixed archive with `-H 'Content-Type: application/json'` as `artoo-wrong-media`. The status is `415` and the body is `application/gzip required`.

## Gotchas

- Without `--tailnet` the route is unreachable: a loopback peer gets `403 tailnet required`. Report `verified-unreachable` with that precondition rather than skipping silently.
- Each exporter run produces new archive bytes, because gzip and tar record times. Two exporter runs make two archives, so prove replay with the fixed `gzip -n` file.
- The receiver accepts up to 1 GiB here, the historical native bound. The Cloudflare contract is under 100 MB; see [cloudflare-ingest.md](./cloudflare-ingest.md).
- A missing `.artoo-token` beside the receiver answers 503. `verify up native` writes the synthetic one.
