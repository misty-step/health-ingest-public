# Source provenance

`export-manifest.json` records the source snapshot and each output file's Git
mode and SHA256. It excludes its own digest. Hash it separately when recording
custody. Excluded input paths and hashes describe provenance; their contents
and Git history are absent from this tree.

[source-custody.json](source-custody.json) records the original imported
snapshot. Those hashes describe the original bytes. The export manifest
records the current generic source, including modifications since that import.
No first-party license is added or inferred. Dependency license metadata remains
in the lockfile.

Repository-local verification files are maintained in this repository, not exported, and so are absent from the manifest: `.agents/skills/verify-health-ingest/`, its `.claude/skills/verify-health-ingest` link and `docs/evidence/verify-health-ingest/`.

The source contains synthetic configuration and local tests. Deployment,
resource provisioning and service installation are operator responsibilities.
