---
name: verify-health-ingest
description: Drive health-ingest's public, generic tools end to end with synthetic data only. Covers the native HTTP receiver, Artoo archive delivery, the read-only Hevy sync, and the Cloudflare Worker behind an emulated Access edge, including owner sign-in states, the hourly poller and native-store audit. Reach for it to prove a change to server.py, scripts/, cloudflare/ or the configuration contract works the way a caller uses it, or when a check fails and you need to see the real behavior.
---

# Verify health-ingest (public generic tools)

This repository ships tools, not a hosted service. Its users are callers: JSON clients posting to the native receiver, the Artoo exporter, the Hevy sync and the hourly Cloudflare poller. Operators deploy it themselves, with their own Access policy and identities. Every journey here runs on loopback, or on this host's own tailnet IP, against disposable stores, fictional identities and a fictional Hevy API. Nothing reads, prints or commits a real health record or credential.

There is no deployment in this repository, so there is no real owner to sign in. [features/sign-in.md](features/sign-in.md) drives the Worker's own identity checks with a fictional owner behind a local Access emulation. Verifying a real deployment's owner sign-in belongs with that deployment's configuration, not with this export.

Read [features/README.md](features/README.md) before driving, then use the matching feature file as the recipe.

## Launch

From the repository root, once per checkout and again after any change under `cloudflare/`:

    cd cloudflare && npm ci --ignore-scripts && WRANGLER_SEND_METRICS=false npm run build && cd ..

`verify up edge` and `verify doctor` refuse a `build/` older than any bundled source. Python 3.14.7 and Node 26 are required. `cloudflare/.node-version` pins 26.8.1; any 26.x runs the harness, with an engine warning from npm.

Then, per run:

    .agents/skills/verify-health-ingest/scripts/verify new          # prints the run dir and an export VERIFY_RUN=... line
    export VERIFY_RUN=<the run dir it printed>                       # first line of every later call
    .agents/skills/verify-health-ingest/scripts/verify up --tailnet # native receiver + fictional Hevy + local Worker edge
    eval "$(.agents/skills/verify-health-ingest/scripts/verify env)"

`up` prints one `ready` line per component and returns only when each answers. The receiver's `/healthz` says `ok`, the fictional Hevy answers `/__mode`, and the Worker edge logs `local-edge ready`. A new run starts from empty stores; restarting a component inside a run keeps its store. Name components to start a subset (`$V up native hevy`). Without `--tailnet`, the receiver binds 127.0.0.1 and the Artoo route is unreachable, because it requires a 100.64.0.0/10 peer.

**Each agent tool call is a fresh shell.** `verify new` prints the run directory and an `export VERIFY_RUN=...` line. Start every later call with that `export VERIFY_RUN=...` and then `eval "$(.agents/skills/verify-health-ingest/scripts/verify env)"`. It defines `$V` (this helper), the URLs, the run's random receiver tokens, `$D` (today, UTC), `$ST`, `$J`, `$SYNC`, `$FIXED_GZ` and the curl configs `$WRITER_CURL`, `$POLLER_CURL` and `$UNPINNED_CURL`. It also defines every environment variable the shipped CLIs read: `HEVY_API_KEY`, `HEALTH_INGEST_TOKEN`, `HEALTH_INGEST_POLL_URL`, `HEALTH_INGEST_POLLER_HEADERS_FILE` and `ARTOO_*`. All values are synthetic.

What `up` starts:

- **native**: a copy of `server.py` in `<run>/native/`, so its source-local `data/` store is disposable. It runs under `TZ=UTC`, with a random per-run bearer and Artoo token and a random port that is never 8789.
- **hevy**: `scripts/fake_hevy.py`, a fictional Hevy API that accepts only the synthetic UUID key and logs every request to `<run>/hevy/requests.jsonl`.
- **edge**: `scripts/local-edge.mjs`, the built Worker in real local workerd (Miniflare) with a persistent local R2 under `<run>/edge/r2`. In front of it is an emulated Cloudflare Access edge that turns synthetic service tokens and a login cookie into assertions signed with a per-run key. The bare Worker is reachable at `$ORIGIN_URL`, and its outbound Hevy calls go to the fictional API.

Pinning `VERIFY_RUN` is what keeps runs apart. Without it, commands fall back to the checkout's current-run pointer, which the latest `verify new` in that checkout moves. Agents in separate worktrees have separate pointers. Agents sharing a checkout are safe only if every one of them pins its own `VERIFY_RUN`. `verify new` refuses while `VERIFY_RUN` is set, so unset it to start another run. Never point a drive at port 8789 or at an installed receiver; that store holds real records. With `--tailnet` the receiver is reachable by other tailnet devices for as long as the run is up, so keep tailnet runs short and stop them with `down`.

## Doctor

    $V doctor

Read-only. It checks:

- Python 3.14 and Node 26, the repository HEAD, and that `cloudflare/build/` is newer than every bundled source.
- That each started component is still the process this run started, matched by pid plus start time.
- That the receiver answers `ok` from a store inside the run directory.
- That the edge redirects anonymous callers to `/cdn-cgi/access/login`.
- That the Worker's `/healthz` reports `verify-<HEAD>`, and that the edge runs the current `build/worker.js`. A Worker started before the checkout moved or before a rebuild fails this; `verify up` restarts such an edge.

Run it before the first drive, after any failed drive and whenever something looks off. Exit 0 and `doctor: ok` mean the run is worth driving.

## Drive

Harnesses are the CLIs themselves, `curl`, and these helpers:

- `$V fixtures artoo` writes a fictional Artoo workspace, labs file, credential and scratch dir at the `ARTOO_*` paths `env` already exports.
- `$V fixtures poller-headers` writes the poller's 0600 header file with the synthetic poll-only token.
- `$V hevy-mode normal|empty|partial|malformed|transient|redirect|down` switches the fictional Hevy API.
- `$V r2 [prefix]` is the second view of the local Worker's storage: keys, bytes and SHA256 of every stored object.
- `$V assertion (--email E | --client-id C) [--issuer U] [--audience A] [--ttl S] [--iat-offset S]` prints an assertion signed with the run's edge key. It is for driving the Worker's own issuer, audience and time checks at `$ORIGIN_URL`.
- `curl -K "$WRITER_CURL"` (or `$POLLER_CURL`, `$UNPINNED_CURL`) sends a synthetic machine's two Access headers.
- `python3.14 $SYNC <sync_hevy args>` runs the real `scripts/sync_hevy.py` main with only its upstream base URL swapped to the loopback stub. The production boundary is the Hevy API, and the stub replaces only that.

Feature recipes give exact commands and the observable result for each step.

## Evidence

Wrap every proving command in `verify rec`. It runs the command and writes `<run>/evidence/<label>.txt` with the shell-quoted command line, start time, exit code, stdout and stderr:

    $V rec native-ingest -- curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $NATIVE_TOKEN" -d '{"fictional":1}' "$NATIVE_URL/ingest/synthetic"

Proof standards:

- Drive the caller's real path: the shipped CLI or the HTTP route the real client uses. Never call internal functions, except the one documented upstream URL swap behind `$SYNC`.
- Capture the action and the resulting state. Every write gets a second view: the receiver's files under `$NATIVE_DATA`, `$V r2` for the Worker, the cursor file `$ST`, and `<run>/hevy/requests.jsonl` for what was asked of Hevy.
- A refusal is proven by its status or exit code and by the absence of a new record.
- `rec` and `down` redact before writing: the home directory becomes `~` and this host's tailnet IP becomes `100.x.y.z`. The receiver runs in UTC so receipts carry no host timezone. Commit only files those two commands wrote, and read each one first. The only identities in evidence should be `example.invalid` and the synthetic tokens.

Committed proof goes under `docs/evidence/verify-health-ingest/<YYYY-MM-DD>/`, with a `README.md` index.

## Cleanup

    $V down

It stops only the processes this run started, matched by pid and start time and killed by process group, never by name. If a leader already died, it also kills its leftover group, such as `workerd`. It writes redacted copies of their logs into `evidence/` and deletes everything else in the run directory: stores, R2, fixtures, keys, tokens. Evidence survives at `~/.cache/tmp/verify-health-ingest/<run-id>/evidence/`; `down` prints the path. Run `down` after every failed iteration too. `cloudflare/build/` and `cloudflare/node_modules/` are git-ignored build outputs; leave them.

## Helpers

All under `.agents/skills/verify-health-ingest/scripts/` and executable:

| Helper | Invocation |
| --- | --- |
| `verify` | `verify new`, `up [native] [hevy] [edge] [--tailnet]`, `env`, `doctor`, `fixtures artoo\|poller-headers`, `hevy-mode MODE`, `r2 [PREFIX]`, `assertion ...`, `rec LABEL -- CMD...`, `stop COMPONENT`, `down` |
| `fake_hevy.py` | started by `verify up hevy`; directly: `fake_hevy.py --port N --log FILE` |
| `local-edge.mjs` | started by `verify up edge`; directly: `node local-edge.mjs --state DIR --edge-port N --origin-port N --control-port N --hevy-url URL` |
| `sync_hevy_stubbed.py` | through `$SYNC`; directly: `sync_hevy_stubbed.py --hevy-url "$HEVY_URL" -- --backfill\|--poll --state FILE --ingest-url "$NATIVE_URL"` |

This skill and its evidence (`.agents/skills/verify-health-ingest/`, the `.claude/skills/verify-health-ingest` link and `docs/evidence/verify-health-ingest/`) are maintained in this repository. They are not export outputs, so `export-manifest.json` does not list them.

Keep the map honest as the code changes with `~/.agents/skills/maintain-verification-skill/SKILL.md`.
