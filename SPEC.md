# Native receiver contract

This describes the imported native unit, not the planned Cloudflare adapter.
All QA below uses loopback, synthetic bytes and disposable directories.

1. A caller can GET `/healthz` without credentials and receive HTTP 200 with
   exactly `ok\n`. No private state is exposed.
2. A caller POSTing JSON to `/ingest/<source>` needs the receiver bearer.
   Missing/wrong bearer returns 403 and writes nothing. Invalid JSON returns
   400. Missing length returns 411; empty returns 400; over-limit returns 413.
   Invalid source names return 400 and unknown routes return 404.
3. A valid JSON POST returns 200 with `status=ok`, its source, relative stored
   path and received byte count. Each call appends one record, including an
   identical replay. Records are source-partitioned; writes are serialized.
   An existing non-list daily file is preserved and a side file is written.
4. An Artoo upload requires a tailnet peer, its separate bearer, a positive
   explicit length, no transfer encoding and `application/gzip`. Wrong
   peer/bearer is 403, missing configuration 503, bad length 411, empty 400,
   above the retained native 1 GiB bound 413, wrong media 415, chunking 400.
   Accepted opaque bytes receive a digest/length receipt. They are never
   unpacked. Incomplete uploads publish nothing. A same-day identical replay
   returns the original receipt and does not replace accepted bytes.
5. Hevy backfill reads every page using GET only, an API-key header and a page
   size of 10. Only the workouts/events paths are allowed and redirects are
   refused. Polling requires a cursor; the cursor advances only after all
   ingest posts succeed. Failed posts retain the prior cursor. An empty poll
   writes no records and advances the cursor. Raw retry can append duplicates.

Known gaps, not passing claims: the imported Hevy pagination accepts a missing
items key as empty, and partial-post retry can duplicate events. The migration
must test/fix those before cutover. The native 1 GiB route is historical
behavior; the accepted Cloudflare client contract is under-100-MB batches.

## Source/release boundary

Source custody includes no private store, credentials, original history or
original operations observations. The provenance manifest joins the imported
files to the original source commit, not to loaded Python memory. Native tests
never contact an upstream account or an installed receiver. Releasing source
is not a deployment. The running service and its poll timer remain unchanged
until the migration's own parity, privacy, single-writer and recovery proof.

Missing stories to resolve in the release slice: generated version/notes,
installed immutable revision reporting, stale/failed/skipped candidate refusal,
and accepted-write-preserving isolated prior-code recovery. This source import
and test gate do not claim those outcomes.
