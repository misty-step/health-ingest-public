# Native migration audit

Before moving a native store into the Worker's R2, an operator audits the quiesced native `data/` directory with `native-store-cli.mjs audit`. The audit reads every file and prints one JSON summary: file count, bytes, JSON records, opaque files and two digests. Reconciliation later compares those digests. An unsafe store, with hidden files, nonempty placeholders or paths outside `raw/` and the cursor, is refused with a fixed message. Import and restore take the provider token on stdin and refuse to start without one.

## Sub-features

- `audit-summary` reports `files`, `bytes`, `json_records`, `opaque_files`, `canonical_sha256` and `bytes_sha256` for a store the native receiver wrote.
- `audit-stable` returns identical digests for an unchanged store on a second audit.
- `audit-refusal` refuses a hidden file in the store: exit 1 and `Native store operation failed; no completed migration/restore claimed.`
- `import-no-token` refuses `import` with an empty stdin token the same way, before any network call.

## How to get to it (user POV)

- Run `node native-store-cli.mjs audit --directory <native data dir>`, or the bundled `build/native-store-cli.mjs` from CI.
- Run `import` and `restore` with `--account` and `--bucket`, piping the narrow token on stdin.

## Driving it with node

Preconditions:

- The [native ingest](./native-ingest.md), [Artoo delivery](./artoo-delivery.md) and [Hevy sync](./hevy-sync.md) recipes have run, so `$NATIVE_DATA` holds synthetic JSON days and Artoo archives. Copy in the Hevy cursor with `mkdir -p "$NATIVE_DATA/state" && cp "$ST" "$NATIVE_DATA/state/hevy.json"`.
- Remove the side-file case's `raw/sidecar/` first if its hand-edited file should not count. The audit treats it as opaque, which is also valid.
- `cloudflare/build/native-store-cli.mjs` is fresh; `$V doctor` checks it.
- The store is quiesced: run `$V stop native` first. The store stays in place for the audit, and `$V up native` brings the receiver back on it.

- **Audit.** Run `$V rec audit-summary -- node cloudflare/build/native-store-cli.mjs audit --directory "$NATIVE_DATA"`. The exit code is `0` and stdout is one JSON line with `"operation":"audit"` and all six fields. `files` equals `find "$NATIVE_DATA" -type f | wc -l`.
- **Stable digests.** Repeat as `audit-again`. The digests are identical.
- **Refusal.** Run `touch "$NATIVE_DATA/raw/.hidden"`, then the audit as `audit-hidden-refused`. The exit code is `1` with the fixed message. Run `rm "$NATIVE_DATA/raw/.hidden"`.
- **Import without a token.** The empty stdin line is refused before any network call; a non-empty line would be sent to the Cloudflare token-verify API, so never pipe anything else here. Run `$V rec import-no-token -- sh -c 'echo | node cloudflare/build/native-store-cli.mjs import --directory "$NATIVE_DATA" --account 00000000000000000000000000000000 --bucket synthetic-records'`. The exit code is `1` with the fixed message.

## Gotchas

- A real `import` or `restore` needs a Cloudflare account, a disposable R2 bucket and a narrow token. This skill has none, so report those journeys as `verified-unreachable: needs a disposable R2 bucket and token`. `npm test` covers them against isolated synthetic buckets.
- Audit only a quiesced copy. A store that a running receiver writes during the audit can produce digests that match nothing.
- `.gitkeep` leaf files of zero bytes are allowed; every other dot-path is refused.
