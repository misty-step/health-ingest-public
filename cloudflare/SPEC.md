# Isolated Cloudflare ingest candidate

1. Only the exact authorized human and individually pinned, kind-tagged
   machine identities may reach any route. Verify signed Access assertion,
   issuer, audience and time at the origin. Unknown or untagged empty-sub
   assertions fail. Source authority is explicit per machine.
2. An authorized POST to `/ingest/<source>` stores exact valid UTF-8 JSON
   bytes in private durable storage. An authorized POST to `/artoo/snapshot`
   stores opaque `application/gzip` bytes without unpacking them. Neither
   endpoint returns content or a download URL. A receipt names source, key,
   SHA256, bytes and the original receipt time. No content is logged.
3. Each request has a positive explicit Content-Length strictly below
   100,000,000 bytes. No client chunking protocol exists. Invalid size,
   malformed JSON/UTF-8, invalid/missing auth and unsupported methods/types
   refuse without a published record. Partial uploads never publish.
   JSON may nest at most 128 object/array containers (a root container counts
   as one; a primitive as zero). Deeper JSON returns 400 with error
   `JSON nesting exceeds 128 containers`, without a record or leftover stage.
4. Exact byte replay for a source returns the original receipt and keeps
   one immutable record, including simultaneous posts and later retries.
   Different bytes remain separate records. Accepted records are not deleted
   by code deployment, failure recovery or code-compatible rollback.
5. Health Auto Export has a separate receiver. `/hae` and
   `/ingest/healthautoexport` are absent; this app does not dual-write.
6. A pinned `poll-only` machine may POST `/internal/hevy-poll`, and may use no
   other route. Writers and humans cannot poll. GET refuses with 405. The
   request awaits durable cursor commit before returning 200; failures return
   non-200 with an empty body. An operator-configured scheduler calls
   this route hourly at :17, not :00; no Worker scheduled handler or Cron Trigger exists.
   A committed success is silent; rejected, redirected, timed-out or unverified
   responses fail the job and deliver a fixed, content-free failure to its configured failure sink.
   The poll reads only the two allowlisted Hevy workout endpoints
   over HTTPS without redirects. First use backfills; subsequent runs poll
   events since the last completely successful run's start. All pages are
   validated, raw item fields preserved, repeated items deduplicated.
   Complete empty responses with page_count 0 or 1 advance the cursor without
   adding records. Malformed/partial/failed responses do not advance it. Transient
   server/network failures have three attempts; rate limits wait for the
   next hourly invocation. Overlapping runs cannot overwrite each other's
   checkpoint. The HTTP caller observes failure, without upstream data or tokens.
7. Private GET `/healthz` reports health and immutable candidate revision.
   Before the first committed poll it returns 503 with reason
   `hevy_never_polled`; a cursor older than two hours, invalid or in the future
   returns 503 with reason `hevy_stale`. A fresh cursor returns 200. Failed
   polls never refresh health. Poll-only identities cannot read health.
   There is no UI. Native old service, data, clients and schedules remain
   unchanged until separate hosted/custody/cutover acceptance is complete.
8. Hosted preview infrastructure is out of scope for this source tree.
   Operators deploy and isolate any hosted preview and supply its identities
   and resource bindings. Local synthetic tests use a fictional Hevy binding.
9. Migration preserves every original native data file byte-for-byte, including
   duplicate JSON receipts, opaque/corrupt historical files and unextracted
   Artoo archives. Reconciliation compares file hashes and canonical JSON
   records with multiplicity, not incompatible storage-container hashes.
   Empty `.gitkeep` leaf files are preserved too; other hidden paths, nonempty
   placeholders and placeholder directories are refused.
   Historical JSON too deep to canonicalize is counted as opaque and reconciled
   by its original byte hash instead; it must not prevent recovery.
   A native cursor is seeded before polling, never silently replaced by a
   backfill. A changed source, symlink, incomplete upload, mismatched destination
   or interrupted copy cannot publish a completed migration.
10. Before cutover, a restore into an unused native directory must recover the
    imported history plus every later accepted Cloudflare JSON/Hevy/archive
    write and the latest cursor. Recovered JSON payload bytes retain their
    accepted receipt SHA256, including numeric spelling, duplicate keys and
    whitespace. It never overwrites an existing directory or
    restores an older snapshot over live writes. Corrupt/missing objects and
    unsafe paths fail without a published restore. An interrupted import or
    restore can be retried without deleting accepted data.
11. Operational failures report only fixed reason codes, environment, release
    and SDK metadata to Sentry. Telemetry never includes request or upstream bodies, URLs, headers,
    identities, record keys, hashes or exception text. Authentication and input
    refusals are not operational incidents. An unavailable telemetry sink must
    not change an ingest receipt or poll result, or hold the product response.
    Abandoned `staging/` objects expire after one day; accepted records, imported
    history and checkpoints have no automatic deletion policy.
12. Production promotion is out of scope for this source tree. Operators
    deploy the service and own revision ordering and recovery policy.
