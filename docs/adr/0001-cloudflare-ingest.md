# 0001: Streaming Worker with immutable R2 records

Status: architecture retained in the generic source export.

One JavaScript Worker and one private R2 bucket hold accepted raw bytes and the
Hevy checkpoint. The origin verifies signed Access assertions, exact issuer and
audience, and explicit human or kind-tagged machine allowlists. Each machine has
one role and a source allowlist. All real identities and deployment resources
are external configuration.

Uploads are strictly below 100,000,000 bytes. A streaming UTF-8/JSON verifier and
SHA256 stage bytes privately before a conditional immutable publish at
`raw/<source>/<sha256>`. Exact replay returns the original receipt; different
bytes remain separate. Rejected uploads are removed. The deployment operator
must expire only `staging/` after one day. Accepted history and checkpoints
have no automatic expiry. Archives are opaque and never unpacked.

Hevy uses only allowlisted GET endpoints without redirects. Items use native
compatible envelopes and canonical keys. The checkpoint advances by ETag
compare-and-set only after every page and immutable write succeeds. A failed
race or partial request leaves the previous checkpoint available for retry.
An externally configured scheduler calls the poll-only HTTP route.

Migration stores content-addressed immutable `legacy/` blobs and one private
commit manifest. It preserves duplicate receipts, corrupt historical bytes and
archive receipts. Reverse recovery writes verified history and every later
accepted write into a fresh native directory. JSON payload bytes are spliced
into native envelopes to retain numeric spelling, duplicate keys and whitespace.
Writers must be quiesced for final import and recovery. Stable scans detect
change; they do not replace single-writer acceptance.

R2 S3 conditional writes are required. Provider REST upload semantics must not
be assumed to implement compare-and-set. The migration tool derives the S3
form of an existing scoped token in memory and does not create a credential.

Telemetry reconstructs fixed reason-code events through an allowlist. Bodies,
URLs, headers, identities, hashes and exception text never enter events.
Automatic collection is disabled. Explicit empty Geo and SDK inference settings
prevent inferred identity; sink readback is still required for hosted acceptance.
A failed telemetry sink does not change ingest receipts or poll outcomes.

The generic export contains no production deployment automation. The existing
private pipeline, installed service, clients, credentials and data remain under
their current owner. This architecture decision records source behavior and
grants no license.
