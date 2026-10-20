# Synthetic checks

A contributor's first step, per the README, is to run the two offline suites. The native unit tests run under Python 3.14.7. The Worker suite builds the real Worker and runs it in local workerd with synthetic R2, generated signing keys and a fictional Hevy API. Neither suite contacts an account, a receiver or production.

## Sub-features

- `native-unittest` passes the native receiver, Artoo, Hevy sync, poller and configuration tests.
- `worker-suite` builds the Worker and passes the workerd, native-store and telemetry tests.

## How to get to it (user POV)

- Run `python3.14 -m unittest discover -s tests -v` from the repository root, as README "Verify with synthetic inputs" says.
- Run `npm ci --ignore-scripts && npm test` in `cloudflare/`, as cloudflare/README "Verify locally" says.
- CI runs the native job on pull requests (advisory) and both jobs on the schedule and on manual dispatch.

## Driving it with the shell

Preconditions:

- A run exists (`$V new`); no components need to be up.
- `TMPDIR` points at disk, e.g. `export TMPDIR=~/.cache/tmp`, because the Worker suite writes about 100 MB of synthetic objects.

- **Native suite.** Run `$V rec synthetic-native -- python3.14 -m unittest discover -s tests -v`. The exit code is `0` and stderr ends with `OK`.
- **Worker suite.** Run `$V rec synthetic-worker -- sh -c 'cd cloudflare && npm test'`. The exit code is `0` and the node test summary shows `ℹ fail 0`.

## Gotchas

- `npm test` rebuilds `cloudflare/build/`. That is the same bundle `verify up edge` runs, so restart the edge afterwards if it was up.
- The Worker suite's 99,999,999-byte streaming test fills a RAM-backed `/tmp` unless `TMPDIR` is moved to disk.
- Node newer than 26.8.1 prints an `EBADENGINE` warning from `npm ci`; the suite still runs. CI uses the pinned version.
- Passing suites are not caller proof. Drive the other features for that.
