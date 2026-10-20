---
name: verify-health-ingest
description: Drive health-ingest's public, generic tools end to end with synthetic data only. Covers the native HTTP receiver, Artoo archive delivery, the read-only Hevy sync, and the Cloudflare Worker behind an emulated Access edge, including owner sign-in, the hourly poller and native-store audit. Reach for it to prove a change to server.py, scripts/, cloudflare/ or the configuration contract works the way a caller uses it, or when a check fails and you need to see the real behavior.
---

# Verify health-ingest (public generic tools)

This repository ships tools, not a hosted service. Its users are callers: Health Auto Export-style JSON clients posting to the native receiver, the Artoo exporter, the Hevy sync and the hourly Cloudflare poller. Operators deploy it themselves. Every journey here runs on loopback, or on this host's own tailnet IP, against disposable stores, fictional identities and a fictional Hevy API. Nothing reads, prints or commits a real health record or credential.

The deployed product (the `health-ingest.mistystep.io` Worker, the installed native receiver and owner sign-in as phaedrus) lives in the private repo misty-step/health-ingest, which has its own `verify-health-ingest` skill. Owner sign-in here is the local Access emulation in [features/sign-in.md](features/sign-in.md), never the real owner.

Read [features/README.md](features/README.md) before driving, then use the matching feature file as the recipe.

## Launch

From the repository root, once per checkout:

    cd cloudflare && npm ci --ignore-scripts && npm run build && cd ..

Rebuild after any change to `cloudflare/*.mjs`; `verify up edge` refuses a stale `build/worker.js`. Python 3.14.7 and Node 26 are required (`cloudflare/.node-version` pins 26.8.1; any 26.x runs the harness, with an engine warning from npm).

Then, per run:

    V=.agents/skills/verify-health-ingest/scripts/verify
    $V new                 # creates ~/.cache/tmp/verify-health-ingest/<run-id>/ and makes it current
    $V up --tailnet        # native receiver + fictional Hevy + local Worker edge
    eval "$($V env)"       # NATIVE_URL, EDGE_URL, ORIGIN_URL, HEVY_URL, synthetic tokens, EVIDENCE ...

`up` prints one `ready` line per component and returns only when each answers: the receiver's `/healthz` says `ok`, the fictional Hevy answers `/__mode`, and the Worker edge logs `local-edge ready`. It starts from an empty store every time. Name components to start a subset (`$V up native hevy`). Without `--tailnet`, the receiver binds 127.0.0.1 and the Artoo route is unreachable, because it requires a 100.64.0.0/10 peer.

What `up` starts:

- **native**: a copy of `server.py` in `<run>/native/`, so its source-local `data/` store is disposable. It uses the bearer `synthetic-native-token`, a synthetic Artoo token in `.artoo-token`, and a random port that is never 8789.
- **hevy**: `scripts/fake_hevy.py`, a fictional Hevy API that accepts only the synthetic UUID key and logs every request to `<run>/hevy/requests.jsonl`.
- **edge**: `scripts/local-edge.mjs`, the built Worker in real local workerd (Miniflare) with a persistent local R2 under `<run>/edge/r2`. In front of it is an emulated Cloudflare Access edge that turns synthetic service tokens and a login cookie into signed assertions. Its outbound Hevy calls go to the fictional API.

Concurrent runs are safe: each run has its own directory and random ports. Never point a drive at port 8789 or at an installed receiver; that store holds real records.

## Doctor

    $V doctor

Read-only. Checks Python 3.14 and Node 26, the repository HEAD, and that each started component is still the process this run started (pid plus start time). It also checks that the receiver answers `ok` from a store inside the run directory and that the edge redirects anonymous callers to `/cdn-cgi/access/login`. Finally it checks that the Worker's `/healthz` reports this checkout's revision (`verify-<short sha>`). Run it before the first drive, after any failed drive and whenever something looks off. Exit 0 and `doctor: ok` mean the run is worth driving.

## Drive

Harnesses are the CLIs themselves, `curl`, and three helpers:

- `$V fixtures artoo` writes a fictional Artoo workspace, labs file, credential and scratch dir, and prints `export` lines.
- `$V fixtures poller-headers` writes the poller's 0600 header file with the synthetic poll-only token and prints its `export` line.
- `$V hevy-mode normal|empty|partial|malformed|transient|redirect|down` switches the fictional Hevy API.
- `$V r2 [prefix]` is the second view of the local Worker's storage: keys, bytes and SHA256 of every stored object.
- `scripts/sync_hevy_stubbed.py --hevy-url "$HEVY_URL" -- <sync_hevy args>` runs the real `scripts/sync_hevy.py` main with only its upstream base URL swapped to the loopback stub. The production boundary is the Hevy API, and the stub replaces only that.

Feature recipes give exact commands and the observable result for each step.

## Evidence

Wrap every proving command in `verify rec`. It runs the command and writes `<run>/evidence/<label>.txt` with the command line, start time, exit code, stdout and stderr:

    $V rec native-ingest-ok -- curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $NATIVE_TOKEN" -d '{"fictional":1}' "$NATIVE_URL/ingest/synthetic"

Proof standards:

- Drive the caller's real path: the shipped CLI or the HTTP route the real client uses. Never call internal functions, except the one documented upstream URL swap in `sync_hevy_stubbed.py`.
- Capture the action and the resulting state. Every write gets a second view: the receiver's files under `$NATIVE_DATA`, `$V r2` for the Worker, the cursor file, and `<run>/hevy/requests.jsonl` for what was asked of Hevy.
- A refusal is proven by its status or exit code and by the absence of a new record.
- Only synthetic values appear in evidence. Before committing evidence, grep it for anything that looks like a real token, email or path outside the run directory.

Committed proof goes under `docs/evidence/verify-health-ingest/<YYYY-MM-DD>/`.

## Cleanup

    $V down

It stops only the processes this run started, matched by pid and start time and killed by process group, never by name. It copies their logs into `evidence/` and deletes everything else in the run directory: stores, R2, fixtures, keys. Evidence survives at `~/.cache/tmp/verify-health-ingest/<run-id>/evidence/`; `down` prints the path. Run `down` after every failed iteration too. `cloudflare/build/` and `cloudflare/node_modules/` are git-ignored build outputs; leave them.

## Helpers

All under `.agents/skills/verify-health-ingest/scripts/` and executable:

| Helper | Invocation |
| --- | --- |
| `verify` | `verify new`, `up [native] [hevy] [edge] [--tailnet]`, `env`, `doctor`, `fixtures artoo\|poller-headers`, `hevy-mode MODE`, `r2 [PREFIX]`, `rec LABEL -- CMD...`, `stop COMPONENT`, `down` |
| `fake_hevy.py` | started by `verify up hevy`; directly: `fake_hevy.py --port N --log FILE` |
| `local-edge.mjs` | started by `verify up edge`; directly: `node local-edge.mjs --state DIR --edge-port N --origin-port N --control-port N --hevy-url URL` |
| `sync_hevy_stubbed.py` | `sync_hevy_stubbed.py --hevy-url "$HEVY_URL" -- --backfill\|--poll --state FILE --ingest-url "$NATIVE_URL"` |

Keep the map honest as the code changes with `~/.agents/skills/maintain-verification-skill/SKILL.md`.
