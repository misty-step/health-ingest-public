# health-ingest verification map

This directory is the maintained source for verifying what callers of the public health-ingest tools actually do. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- `cloudflare/node_modules` is installed and `cloudflare/build/` is fresh (SKILL.md "Launch").
- A run exists and is up: `.agents/skills/verify-health-ingest/scripts/verify new`, then `... up --tailnet`.
- Every tool call starts with `export VERIFY_RUN=<the run dir verify new printed>` and `eval "$(.agents/skills/verify-health-ingest/scripts/verify env)"`, because each call is a fresh shell. All `$NAME` values below come from it.
- `$V doctor` ends with `doctor: ok`.
- Commands run from the repository root with `python3.14`.
- Never drive an instance this run did not start, port 8789, or any installed receiver or deployed Worker.

## Driving conventions

- Each recipe starts from the baseline state unless its preconditions say otherwise. Recipes may share one run; a recipe that needs an untouched store says so.
- Wrap each proving command in `$V rec <feature>-<step> -- <command>`. Use `sh -c '...'` for pipelines.
- Treat commands as literal. The `$NAME` values come from `verify env` and are all synthetic. Variables a recipe defines itself live only for that call.
- Switch the fictional Hevy API back to `normal` after any failure mode.
- The second view of a write is the receiver's files under `$NATIVE_DATA`, `$V r2` for the Worker, the cursor file, or `$VERIFY_RUN/hevy/requests.jsonl`.

## Proof and skip reporting

- CLI proof is the command, stdout, stderr and exit code, all of which `verify rec` captures.
- HTTP proof includes the status code and body. Add `-w '\n%{http_code}\n'` to curl.
- A write's proof includes the second view; a refusal's proof includes the unchanged second view.
- Record the feature ID with every artifact. Report an unreachable path with the attempted command and the unmet precondition, never as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph of caller-visible behavior. It then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>` (opening with `Preconditions:`), and `Gotchas`.

## Features

- [Synthetic checks](./synthetic-checks.md) covers the documented offline suites a contributor runs first.
- [Native ingest](./native-ingest.md) covers health probe, authenticated JSON ingest, replay, refusals and the corrupt-day side file.
- [Artoo delivery](./artoo-delivery.md) covers the exporter's archive delivery, receipt check, identical replay and refusals.
- [Hevy sync](./hevy-sync.md) covers backfill, poll, cursor rules, empty and failed polls, and configuration refusals.
- [Sign-in](./sign-in.md) covers the owner's Access session on the Worker and the identity states that break: signed out, wrong identity, expired session, logout, forged assertion and unpinned token.
- [Cloudflare ingest](./cloudflare-ingest.md) covers machine JSON and archive writes, immutable replay, source authority and input refusals.
- [Hevy poll](./hevy-poll.md) covers the hourly poller CLI, Worker health freshness, deduplication and failure modes.
- [Native migration audit](./native-migration.md) covers auditing a native store before import, and the import refusal without credentials.
