# Cloudflare adapter

The Worker accepts authenticated opaque archives and JSON, preserves immutable
receipts and advances a Hevy cursor only after durable writes. The default
configuration has no route, provider URL or identity and refuses requests until
the operator supplies an Access policy. [SPEC.md](SPEC.md) owns the contract.

## Verify locally

Use Node 26.8.1 and the committed lockfile:

    cd cloudflare
    npm ci --ignore-scripts
    npm test

These checks build the Worker and use an isolated synthetic workerd/R2 store,
generated signing keys and a fictional upstream API. They need no production
credentials or records. The public workflow runs only on GitHub-hosted runners.
No public PR deploys a preview or reaches a persistent shared runner.

## External configuration

Keep account IDs, zone IDs, resource names, deployment URLs, owner allowlists
and secret bindings outside source. The exported `wrangler.json` uses the
fictional `synthetic-records` bucket, disabled provider URLs and empty identity
lists. It is local test configuration, not a deployable production manifest.

- `ACCESS_ISSUER`: exact HTTPS Access team origin.
- `ACCESS_AUD`: exact application audience.
- `ACCESS_HUMAN_EMAILS`: explicit JSON array of allowed human identities.
- `ACCESS_MACHINES`: explicit JSON array of kind-tagged machine identities,
  each with `client_id`, `role` and `sources`. A `poll-only` identity may call
  only POST `/internal/hevy-poll`. A writer cannot poll. A `preview-verifier`
  is accepted only in `PREVIEW=synthetic`.
- `HEVY_API_KEY`: existing secret binding, outbound GET only. The HTTP poll
  caller receives only its Access credentials, never the upstream key.
- `SENTRY_DSN`: optional existing telemetry binding. No value is bundled.
- `RELEASE`: immutable tested revision.

Use an external scheduler to invoke `scripts/poll_cloudflare_hevy.py` with the
explicit endpoint and private header-file reference. Persist the two headers
`CF-Access-Client-Id` and `CF-Access-Client-Secret` through the existing private
credential path, never through logs. Keep a single writer during migration.
No unit, scheduler, credential, deployment or production state is installed by
the generic export. The existing private deployment pipeline remains private.

## Migrate and recover native data

The generic migration tool preserves raw files, receipts and cursor state.
Run it only against an authorized consistent snapshot. Quiesce all writers
before a final delta or recovery and prove a private backup restore first.

    node native-store-cli.mjs audit --directory /isolated/native-data

For import, pipe the existing narrow provider token on stdin through the
approved credential path. Supply your own account and bucket explicitly:

    node native-store-cli.mjs import --directory /isolated/native-data --account ACCOUNT_ID --bucket BUCKET_NAME

For recovery, use a fresh directory whose parent exists:

    node native-store-cli.mjs restore --directory /isolated/recovered-data --account ACCOUNT_ID --bucket BUCKET_NAME

Reconcile the byte/hash receipt before switching clients. Neither a source
export nor a passing local test authorizes production reads, migration or cutover.
