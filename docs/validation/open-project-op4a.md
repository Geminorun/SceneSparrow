# OP4-A native file-graph validation

Date: 2026-11-19. Base: `ba8e0b8` on `feat/open-project-format`.
Status: independently reviewed on Linux for OP4-T01–T03. OP4-B and OP5/OP6 remain
separate gates; this checkpoint does not expose an unrestricted graph API.
Specification: [OP4-A](../specs/open-project-op4a.md) and
[parent OP4](../specs/open-project-op4.md).

## Resulting behavior

Explicit registration captures an immutable creative inventory without approval
or a history entry. Accepted Markdown, manifest, media, dependencies and ordinary
creative files share one graph, writer, receipt/SQL boundary and five-transition
history. Graph sidecars use stable entry IDs; older history restores its retained
manuscript while preserving current non-manuscript files. Media/name changes
advance project/history revisions without bumping untouched prose revisions.

Intent v3 separates accepted-before/after graphs from physical-before/after
members. Checked additions, retained deletions and displaced replacements precede
one short SQL commit. Known interruption restores or finishes the complete checked
scope; unknown bytes remain preserved and fence that operation. Scoped explicit
preservation records path/role/hash/size evidence and a definite original outcome.
Existing v1/v2 source intents remain readable and tested.

Ordinary source/name and proved source/name-only history validate their exact
recorded physical members. They retain unchanged immutable graph references and
leave unrelated live media pending. Full graph inspection/acceptance validates
the complete allowed inventory. Required manifest identity/path checks still
protect source persistence; normal rename refuses a changed live manifest.
Backup reconstructs the accepted manifest/media with the saved manuscript.

Captured live observations are distinct from accepted state. Native preparation
binds new Markdown IDs before inspection is acknowledged; acceptance applies the
prepared bytes without fresh random rebinding. B must bind scope, original raw
digest, preparation, observation and candidate disposition through the same writer.

Approved/downstream graph pins capture once by stable owner. Pre-registration
owners explicitly record registration provenance, preserving original approved
raw evidence rather than claiming historical media approval. Reopen, collection
and backup verify retained graph/business/source/owner correspondence.

Only migration 013 is added; delivered 001–012 are unchanged. Large creative
members use fixed-buffer streams through capture, verification, retention and
backup/restore. No generated transport contract or frontend implementation changed.

## Independent review and corrections

Root reviewed journal/recovery, graph preparation, shared receipt/SQL coordination
and history changes. A separate read-only implementation reviewer examined storage,
backup, retention and owner provenance. All implementation writers stopped before
root checks and staging. A managed environment restart retained every frozen
checksum; no implementation was reapplied.

Review and integration corrected these concrete problems:

- Full graph verification originally reread media on ordinary text autosave.
  Explicit checked-member scope now covers source/name operations and recovery;
  measured tests prove no unchanged binary reads on those paths.
- Equal business before/after hashes in media/name history were double-counted
  by the old verifier. Verification now follows transition sides and graph/source
  correspondence.
- Untrusted malformed manifest/audio-plan JSON incorrectly became a storage error.
  It now produces replayable `FORMAT_INVALID`; trusted corruption remains a
  storage failure.
- Object publication could promote a substituted staging pathname under the
  original content hash. Deterministic RED tests proved both the helper failure
  and actual registration of a corrupt binary reference. Publication now retains
  the writer descriptor and verifies named inode, bytes/hash and size before/after
  promotion. Failure cleanup preserves unverified slots.
- Recovery download selected only path/role although retained versions also use
  a hash. Native authorization now includes the exact expected hash, and both
  same-path/role versions round-trip independently.

The last two fixes added five regressions. Root independently reread the corrected
code and the read-only reviewer confirmed those findings resolved. No remaining
concrete blocker was identified within this native checkpoint.

## Actual evidence

Every shell sourced `scripts/cloud-env.sh`; Rust-invoking commands/wrappers set
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
Cargo checks were sequential. All provider fixtures were local counted servers.

| Owner | Check                                          | Result                                                    |
| ----- | ---------------------------------------------- | --------------------------------------------------------- |
| Root  | Domain suite                                   | 29 passed; unchanged by the localized storage corrections |
| Root  | Final corrected `open_source` suite            | 76 passed, including all 30 graph cases                   |
| Root  | Rebuilt-service HTTP integrations              | 21 passed, including nine source flows; no skips          |
| Agent | Final Rust workspace suite                     | 295 passed: 29 domain, 261 infrastructure, five service   |
| Agent | Workspace/all-target Clippy with `-D warnings` | passed                                                    |
| Agent | Service build, contracts, types and formatting | passed                                                    |
| Agent | Node unit suite                                | 424 passed; JavaScript/protocol unchanged by corrections  |

Root logs: `.artifacts/op4a/root-domain.log`, `root-source-corrected.log`,
`root-http-corrected.log` and `root-corrections-checksums.log`. Agent commands,
RED/GREEN logs and frozen checksums are indexed by `.artifacts/op4a/HANDOFF.md`.
Root also checked the final staged whitespace and relevant documentation formatting.

Native evidence includes actual mixed add/replace/delete, source/name/media history,
middle-cursor reopen, lock A/edit B, approved/downstream retention beyond five
transitions, original receipt/rejection replay, per-member/SQL/cleanup cut points,
real SQL trigger failure, ancestor/file races, stale live observations, physical-only
restoration, unknown staged evidence, invalid scope, corruption refusal and streamed
backup/restore. Registered planning applies a retained counted SDK artifact once.

The real binary fixture is about 5 MiB. Source/name/three history operations read
zero unchanged media bytes (one debug sample about 121 ms). Full explicit batch
verification counted 89,128,960 bytes for that binary across its verification
passes. Maximum output chunk was 65,536 bytes, with an additional three-byte buffer
test. These are correctness/read-count probes, not full-size latency/RSS acceptance.

## Concrete remaining limits

Linux native access/promotion is implemented. macOS/Windows implementation, native
CI, persistent session-root identity and recovery-only startup are OP6 work.
File/directory prefix transitions (`a` versus `a/child`) explicitly refuse before
live/SQL/history changes, including live acceptance whose Undo would require them.
Ordinary safe per-file/subtree renames remain supported.

Inventory limits are 20,000 files, 4 GiB/file and 16 GiB aggregate; small source/
manifest/media control is 4 MiB and graph/intent control is 16 MiB. Directory
traversal is separately bounded. Large-project interaction and native GUI/RSS
acceptance remain unverified. Existing CRLF empty-quote/nested marker-placement
refusal remains documented by OP3-B.

B still owns recorded grants/work copies, production-file locks, exact action DTOs,
atomic candidate disposition, paginated authenticated downloads/reader leases and
Changes UI. Its normal registered rename must use ProjectSession because names now
own graph/history revisions. ZIP/migration, default-format lifecycle, production
audio/video editors, real providers and arbitrary project-code execution were not
introduced here. No merge, deployment, tag or cloud environment publication occurred.
