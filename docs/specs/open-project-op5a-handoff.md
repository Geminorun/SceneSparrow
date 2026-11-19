# OP5-A accepted-code and operation handoff

Status: root-frozen after `77c0044cb0e6aa34e7d9dd1e0e6b758020ff0855`,
2026-11-19. Read [OP5](open-project-op5.md), [A](open-project-op5a.md),
[OP4-B validation](../validation/open-project-op4b.md), architecture and workflow.
One fresh gpt-6.1-sol/high code writer. Root owns all docs/design/Git and independent
review. This checkpoint is conversion backend + named operations, not ZIP exchange,
visible package flows, default creation or host activation/session switching.

## Accepted native ownership

The repository has delivered schema014 and the single project writer in
`crates/infrastructure/src/manuscript.rs`. Source/graph owners are `open_source.rs`
and `open_source/graph{,/work/*}`. Legacy canonical business roots and version-aware
reads are in `documents.rs`/`history.rs`; approvals are in `finalization.rs`.
`storage/retention.rs`, backup.rs and AI execution ownership are shared seams.
Do not edit migrations001–014. Append015 and later only if required, update the one
supported-schema ledger/inspect/backup readers consistently, and cover every legacy
schema from001 through the latest supported version, including an appended version
that normal legacy startup can also apply. Format version1 is separate from SQL.

Native B methods include `register_work_file_graph`, `file_graph_view`,
`create_work_item`, `inspect_work_item`, `work_operation`, `accept_work_candidate`,
`discard_work_item`, `control_work_item`, recovery pages/readers and production locks.
These are not migration shortcuts. Registration is initial capture, not approval.
A source-aware target may retain old history entries without graph sidecars: their
Undo/Redo restores derived manuscript only and preserves the new manifest/media.

Expose a trusted native read-only inspection/conversion library that can inspect an
unopened legacy source path. Public initial service routes operate on the currently
owned source only. Neither path calls normal mutable repository open merely to
inspect. A selected `.scenesparrow` management folder or authored-source SQL row is
not a legacy source; refuse wrong-level selection. Known corrupt/missing metadata
never becomes a fresh unlocked project.

## Snapshot, upgrade and conversion implementation

Existing `backup::snapshot` computes `portable_inventory` on a different live read
before Backup. Do not reuse it unchanged for this guarantee. Begin a read transaction,
materialize the source snapshot with a SELECT, and take a SQLite backup while that
same snapshot is held. Derive inventory from that snapshot/completed backup DB,
not a later live connection. Include committed WAL pages with a still-open producer;
SQLite `immutable=1` must not be used to ignore WAL. Required read locks/SHM handling
are distinct from authored byte/business mutations. Never create a source core lock.

Copy/hash the complete required object/export closure with bounded streams from
that backed-up inventory. Concurrent source collection can cause a missing member;
fail the new target without substituting newer state. Completion inventory/checksum
marker is flushed last. Preserve this verified original backup outside the source
and failed target; do not include recursive backup trees.

Split schema-only upgrade and verified byte-copy from normal repository startup.
`restore_verified_copy` currently returns a normally opened repository; it cannot
be used over half-converted state to run startup jobs/collection. Construct target
schema in private staging, preserve existing IDs/tokens/receipts/history identity,
then augment source, graph and metadata before normal verification/Ready. Schema1
can legitimately have no manuscript yet: initialize only missing target structures,
preserve the project UUID and allocate only identities that never existed.

Use a trusted marker-aware adapter around the pinned `mdast-util-to-markdown`
legacy writer, not native `render_blocks` as a universal serializer. The latter
refuses many valid multiline/code/link shapes. `packages/manuscript-format/src/index.ts`
is the existing public export; `workers/document/src/export-entry.mjs` imports it
under bare Node. Keep its output/import behavior intact. A new pure `./migration`
subpath plus a trusted `workers/document/src/migration-entry.mjs` is the preferred
seam. Avoid eager imports of source modules with incompatible .js/.ts resolution
in the old public entry. Reuse `worker_process::document_command` with cleared env
and known app entry; never execute project scripts or load project dependencies.

Worker envelopes are bounded independently from actual source4 MiB because JSON
escaping can expand them. Keep the existing trusted worker process/cancellation
limits. Node may be required only for conversion; missing Node/serializer is a clear
refusal with backup/source preserved. Ordinary native create/open/save remains
Node-independent and retains its regression.

Every current/history/approved state derives deterministic marked Markdown with
its original block IDs. Explicit empty root paragraphs and empty/nested list items
must survive. Preserve order/kinds/attrs/runs/marks, Unicode, whitespace and breaks;
use native parsing/projection and exact normalized canonical equality for each
state before accepting it. Test representable multiline/nested/empty states and
an actual unsupported/refused state. Do not trim trailing text, allocate replacement
IDs or weaken proof. Record serializer/version and normalized-origin provenance;
original Markdown spelling never existed in legacy storage.

Add source hashes to target current/history business roots without changing stable
entry IDs/cursor, working/block high-water revisions or original receipt digests /
outcomes. Original and derived objects remain correctly pinned. Use generic object
pins or a typed provenance root expansion for old business/approval objects; do not
mislabel arbitrary JSON as raw Markdown source pins. Keep the verified legacy backup
independent of future target collection.

Approved manifests derive from their actual ordered immutable block payloads, even
when different from current prose. Augment source evidence while preserving baseline
IDs/sequences, original locks and approval meaning. Current and historical verification
and five-step Undo/Redo must pass. Keep migration-time retained baseline IDs and
sequences. Existing text-changing replay restores content with monotonic block
tokens and may derive a new exact-revision baseline binding. Do not reset revisions
or overwrite an old immutable manifest to force ID reuse. Identical-token/source
lock-only replay can reuse its baseline; historical evidence remains retained
under the existing bounded-reference policy. Original downstream/export input hashes retain
their original normalized/capture meaning; new graph association is registration
provenance, never historical media approval. Source/evidence/review quote identities
and pending candidate applicability remain intact.

## Runtime and shared AI boundary

Planning dependencies/review contexts use canonical IDs/revision tokens. Preserve
context/input/artifact hashes and paid-run identities. Source representation is not
an AI integration redesign. Exercise a retained succeeded planning output and pending
review candidate through actual application owners after conversion with counted
mock SDK calls; no new inference is caused by conversion or reusing a result.

Fence copied nonterminal AI/document/export/downstream work before Ready. Existing
`ai/execution.rs` already establishes execution origin using an application-data
file identity and monotonic watermark. Do not call initialize_ai_origin on copied
SQL first: it could overwrite the original origin record and incorrectly trust the
copy. Reuse/refine recovered-origin fencing only on the coherent staged target,
create its new origin safely and preserve the original source's global origin record.
No normal startup worker may run before that fence and verification complete.

B work tables are empty in genuine legacy projects (no authored source/graph), but
shared recovered-copy helpers must not infer that copied queued work can resume.
Mutable copy roots, reader/preparation handles and cleanup authority are not portable.
Do not rewrite a terminal original operation into a claim it never succeeded. The
native package restore checkpoint will add truthful current copy-unavailability /
authority revocation for such native records; preserve this distinction in reusable
helpers now, without expanding A into package/external-work UI redesign.

## Global lifecycle operation owner

Implement an infrastructure `ProjectTransferStore` under the existing application
data resolver's `project-transfers/`. It uses durable atomic JSON records and bounded
operation ownership, not a second project database/writer or AI run. Directory
resolution can be shared without opening global AI settings. Public paths stay opaque.
Bind source-root locator/identity as well as project UUID; a converted same-UUID root
cannot execute the old root's command just by matching the UUID.

Use a short cross-process journal update lock separate from the long operation lease.
Status/cancel must remain responsive during copy/serialization. Bound active queue
at five and one active transfer worker; compact terminal records do not require a
full scan on every status lookup. Individual original records plus a bounded active
index are sufficient. Only the current source context can dispatch its operations;
sharing app data does not grant permission to claim other roots' queue entries.

Managed target capabilities are durable UUIDs for a future absent directory under
persisted app-data `project-roots/`. Issuance does not create a complete-looking target.
Store exact original issuance outcome/digest. The native library can accept trusted
explicit filesystem paths for tests/CLI; main-process destination chooser issuance
is a later private-token seam. No browser path field or title-derived target. Check
source/target distinction and safe parent containment before staging. Staging is a
private sibling on the target filesystem for no-clobber publication; no unchecked
cross-volume/overwrite fallback. Never remove an unknown target to retry.

Containment applies to actual I/O, not only a preflight canonical comparison.
Bind backup/stage/target to captured canonical parent identities and keep their
parent handles through preparation/publication. Never validate a resolved location
then pass the original mutable alias to backup, SQLite staging or rename. Either
use the captured descriptor-relative location or refuse changed/unsupported parent
identity before writing; no write may follow a changed alias into the source.
Linux may use held directory descriptors for the native-only preparation seam;
OP6 must implement corresponding target-platform behavior. Deterministic phase
callbacks swap backup and target aliases after preflight, as well as replacing a
plain canonical parent: source bytes remain untouched and unknown targets survive.

Original full DTO lookup precedes fresh source/base/target validation. A stable
contentBase hashes project/title/schema and saved business/history identity, not
connection-local data_version. Original job progress can change without invalidating
prose base; actual conversion captures one consistent current snapshot after base
validation and records that backup/closure identity as provenance. Later source edits
remain outside it. Queue-full/invalid-target/base rejection keeps its original outcome.

Progress records are bounded by phase/time rather than an fsync per64 KiB. Track
workers/cancellation across source quiesce/close; no old operation is retargeted to
a later root. Restart marks old-owner incomplete attempts interrupted, never resumes
filesystem copying automatically. Explicit retry has a new control/request identity
linked to the original, with its same source/base/target; it does not recapture a
newer base silently. A stale base needs a fresh explicit inspection/start instead.

Cancellation before promotion preserves original and verified backup. Unknown
staging bytes stay preserved; no pathname-based destructive replay/cleanup authority
is reconstructed. Target Ready/identity and original journal reconcile interruption
after no-clobber promotion but before result acknowledgment. Already promoted work
cannot be reported as an undone cancellation. Same-ID replay creates no second target.
Completed ready/backup closure has deliberate retention; no silent collection before
its recorded result/capability expires. Actual activation remains a guarded OP6 host
operation, not an App path assignment or automatic switch.

## Frozen generated transport names

Add closed `packages/contracts/schema/project-transfer.schema.json` through the
existing generator. Family names from A are fixed: `LegacyMigrationInspection`,
`MigrationTargetRequest`, `MigrationTarget`, `LegacyMigrationRequest`,
`MigrationOperationView`, `MigrationControlRequest`. Use canonical UUIDv4 IDs,
lowercase SHA256 hashes and safe integral revisions/counters. An explicit
`MigrationStartResponse` may separate immutable original start facts from its current
`MigrationOperationView`; the view must never silently relabel a start acknowledgment
as the terminal result. Safe bounded extra display facts are implementation choices.

Operation state is queued/running/succeeded/failed/cancelled/interrupted. Phases are
queued/backup/upgrade/serialize/verify/promote/ready (terminal failure retains its
last phase). Include original request/source project/target identities, contentBase,
operation revision, bounded byte/count progress, safe failure, verified backup and
ready result identity, and the normalized-origin notice. No absolute locations,
source text, provider keys or opaque raw JSON result blobs.

Use these routes and matching named optional PlatformClient/HTTP/desktop/preload
methods with the same exact-origin/private-core boundary:

- GET `/v1/project/migration`: read-only currently owned legacy inspection.
- POST `/v1/project/migration-targets`: issue managed target capability.
- POST `/v1/project/migrations`: original conversion request.
- GET `/v1/project/migrations/{requestId}`: scoped current status/original facts.
- POST `/v1/project/migrations/{requestId}/control`: explicit cancel/retry.

Public currently owned inspection does not require a source picker. The native
library still proves unopened legacy-schema/WAL behavior. Native main exposes only
named operations, never generic filesystem/SQL invocation. Add localized error keys
where surfaced; focused visible operation/chooser controls remain OP5-B/OP6.
No transfer/activation route can bypass global exact-origin/auth checks.

## Required gates and handoff

Use sanitized fixtures only. Cover every supported legacy schema (through any new
append-only target version), live WAL producer, unchanged source bytes/business,
IDs/high-water tokens, five real transitions/cursor/entry IDs, current and historical
approvals, locks/reviews/pending candidates, original success/rejection receipts.
Prove missing closure/unsupported serializer/source expansion refusal, stale content
base, reused ID/different payload, queue/worker responsiveness, phase/promotion crash
cuts and existing target. Reopen/verify/backup the finished target independently;
count zero copied dispatch and no extra SDK call for retained succeeded results.

Run affected Rust/serializer/contract/client/HTTP tests, Clippy, types/format/build.
Use bare-Node old export regression and Node-absent ordinary-native authoring proof.
Do not repeat unrelated broad browser suites that have no A UI changes. Root owns
independent review and material reruns, then commit/push. Keep exact RED/GREEN logs,
commands/counts/capability limits and all intended file hashes in
`.artifacts/op5a/HANDOFF.md`, `INTENDED_FILES.txt`, `FROZEN.sha256`. Stop all owned
writes/checks/processes before review. Root docs/specs/.agents are not code scope.
Every shell sources scripts/cloud-env.sh; Rust wrappers set both zero-debug profiles
and CARGO_BUILD_JOBS=4. No parallel Cargo, children/Git/worktrees/providers/real
project conversion/deploy/tag/environment publication.
