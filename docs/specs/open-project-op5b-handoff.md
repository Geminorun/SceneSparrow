# OP5-B exact package backend handoff

Status: root-frozen after independently reviewed OP5-A `b516736`, 2026-11-19.
Read OP5, OP5-B, the common format, architecture/workflow and A/B validation.
One fresh gpt-6.1-sol/high code writer; root owns all planning/docs/Git. This
checkpoint supplies package backend and typed adapters, no new UI/default/host
activation or arbitrary code execution. OP5-C follows only after root acceptance.

## Reuse and preserve

Delivered SQL001–014 is immutable. Append015+ only as required for trusted export
bases and current copy availability, updating every supported-version/backup/
inspection reader and old-version fixture consistently. Preserve all A journal
formats, original target/start/control outcomes, source ownership and fault gates.

A owns `project_transfer::{inspect_legacy,migrate_legacy,ProjectTransferStore}`,
`backup::{snapshot_controlled,copy_verified_storage}` and
`open_storage_mode(..., startup=false)`. Its snapshot helper currently verifies/
copies the closure before returning: do not hold the live project mutex over that
bulk work for export. Split a consistent captured SQL/retention pin boundary from
outside-writer inventory verification/copy. Its byte-only copy helper is initially
strict legacy backup preparation, not a ready-made native complete-package loader.
Refactor safely or add a typed native seam instead of normal-opening half state.

Use held native `Parent` bindings for actual preparation/extraction/publication,
not canonical-check-then-use aliases. `bound_directory_path` is process-local
Linux-only and must not enter durable JSON/SQL, public DTOs or workers. Descriptor-
relative no-clobber promotion is required. Unsupported platforms remain explicit
until OP6, never gain an unchecked fallback.

## Fixed export and trusted local base

Add a small consistent `readPackageBase` returning project working/history
revision, source hash/generation and graph hash/generation. Export's original
request includes that captured base. Under the existing project writer, validate
the saved base, register the export identity/immutable graph and retention pins,
and establish the exact consistent SQL capture. Complete the durable SQL capture
before successful start acknowledgment; copy/hash/compress the complete captured
closure outside the writer. Concurrent later edits stay out and cannot make an
already captured export stale. Do not asynchronously choose a new saved generation
after acknowledging the button action.

The start/journal/SQL-capture crash boundary needs explicit durable recovery:
original full DTO lookup precedes fresh current-state checks, a recorded capture
is reused, and interrupted incomplete capture requires explicit retry against its
original base. Never silently recapture newer content. Queue-full/stale outcomes
are stable. Retain original export/base record and original management inventory
before Ready. A terminal archive record may be newer than the SQL inside its own
capture; avoid circular self-hashes or unverifiable missing roots.

A whole-project collection fence is transient, not a retained failed-capture
policy. Derive explicit original roots from the captured SQL and bounded graph/
control objects without hashing/copying every payload, persist capture-owned pins
and release the coarse fence. Interrupted/canceled captures retain their own
closure for retry, never all unrelated future objects. Startup recovery narrows
any interrupted coarse fence before normal collection. Corrupt original control
evidence fails that capture explicitly rather than silently disabling collection
forever. Test collection of later unrelated objects while original retry roots
remain available.

Use existing global app-data lifecycle journal/short lock/long worker lease, not
another database or AI runtime. Bound the combined migration/package active
admissions at five and run one transfer worker. Preserve old journal readers and
atomic original outcomes when adding package operations. Keep direct original-ID
status and bounded progress; no full terminal scan per poll or fsync per 64 KiB.
Quiesce/cancel/restart handling includes package workers and active readers.

## Closed descriptor and ZIP

Complete archive: `project.json` at root, exact captured creative graph and verified
management closure, `.scenesparrow/transfer.json` descriptor. Version1 fields are
`version`, `kind: project`, project/export UUIDs, `capture` (working/history revision,
source hash/generation, graph hash/generation) and `members` (sorted regular-file
path/hash/size inventory). Inventory excludes only the descriptor. Explicit
directories are structural, counted, and cannot collide with files or prefixes.
Descriptor is integrity/provenance, never authentication/approval/target authority.

Work-copy exchange uses root `transfer.json`, kind `work-copy`, project/export/work
UUIDs, trusted base graph hash/generation and exact `project/` + `context/` members.
Bind it to the existing OP4 work record; original context/grants remain authority.
Provide a named recorded-work-copy package export as well as complete-project
export, so Web can exchange an ordinary work folder without a server path field.
Capture a coherent private copy with its leases and original base; refuse unsafe
unproved changes rather than mix a concurrently changing tree. No management DB
is granted to a work copy. No wrapper search/heuristic envelope detection.

Keep OP5-B's exact exclusions and budgets, including 32 MiB central-directory
preflight before ZIP index allocation; Store/Deflate, bounded ZIP64 and ordinary
data descriptors, actual CRC/hash/size/ratio counters, 20,000 entries, 4 GiB/file,
16 GiB expanded total, 8 GiB compressed archive, 64 KiB buffers and checked math.
Initial Store export is acceptable and must pass its own ratio inspector even
for repetitive data/silence. Keep the 4 MiB public control bound distinct from
private graph16 MiB. No omitted closure to fit. No install/render/provider calls.

## Named protocol families and routes

Add `project-package.schema.json` as generated source. Required families:

- `ProjectPackageBase`, `ProjectPackageExportRequest`,
  `WorkCopyPackageExportRequest`, `PackageArchiveView`.
- `PackageIntakeRequest`, `PackageIntakeView`, `PackageChunkRequest`,
  `PackageChunkAck`, `PackageIntakeControlRequest`.
- `PackageInspectionRequest`, `PackageInspectionView`,
  `PackageRestoreTargetRequest`, `PackageRestoreTarget`,
  `PackageRestoreRequest`, `PackageReturnRequest`.
- `PackageOperationView`, `PackageStartResponse`, `PackageControlRequest`.

Use UUIDv4 IDs, lowercase SHA256, safe integers, closed objects and bounded pages.
Public operations carry the active owner project's identity separately from any
inspected/restored result project. Views contain safe filename/kind/count/generation,
operation revision/state/phase/progress/failure, immutable archive identity or
inspection/ready-target facts. No host paths, prose/raw provider output, keys or
generic method names. Add structured fields when necessary; preserve closed
validation and explain material deviations to root before consumers depend on them.

Named routes:

- GET `/v1/project/packages/base`.
- POST `/v1/project/packages/exports` and
  `/v1/project/work-items/{id}/package`.
- GET `/v1/project/packages/operations/{id}`; POST same `/control`.
- GET `/v1/project/packages/archives/{id}` for an authorized immutable attachment.
- POST `/v1/project/package-intakes`; GET same `/{id}`;
  PUT same `/{id}/chunks`; POST same `/{id}/control`.
- POST `/v1/project/packages/inspections`; GET same `/{id}`.
- POST `/v1/project/packages/restore-targets`, `/restores`, `/returns`.

Matching optional typed PlatformClient/HTTP/preload capabilities are part of B;
chooser/stream UI adapters are C. Preserve auth/exact origin/private native token.
Do not return imported result metadata in a field that App treats as current project.

Chunk route receives bounded raw binary, with exact offset/length/hash headers
represented by `PackageChunkRequest`; no JSON/base64 payload. `PackageChunkAck`
contains that chunk's stable acknowledged end, not a changing later total. Repeated
committed offsets verify the bounded stored range and replay without appending;
changed bytes conflict. Do not store an unbounded per-chunk UUID array in the small
journal. Data-flush-before-ack cuts reconcile exact known bytes, never blindly
truncate/overwrite unknown data or append again. Status reports current extent.
The maximum binary HTTP chunk is 1 MiB, independently of the 64 KiB native I/O
buffer. A bounded chunk buffer is acceptable; a whole-archive buffer is not.
Use a route-specific body limit and check actual length/hash without increasing
the global JSON/control limit. Browser/native delivery uses this same chunk cap.

Inspection submission seals a complete intake, verifies final declared length/
SHA256, then inspects ZIP asynchronously under the same original operation. This
combines finalize+inspect without a second visible action. An incomplete upload
cannot inspect; subsequent append cannot change sealed bytes. Retain uploaded
bytes for decisions/recovery. Deliberate finite cache/intake expiration must respect
reader/candidate leases and retain compact original outcomes; no destructive
pathname replay. Migration backups have separate deliberate retention.

Default retention is seven days for ready archive cache and 24 hours since last
verified activity for unused intake. A pending returned candidate/active reader
extends retention; after a terminal returned decision, retain its uploaded bytes
for seven further days. Keep compact original outcomes independently. Ready
restored project directories and verified migration backups are not cache and
never expire through this policy. Unknown residual staging/cleanup bytes remain
preserved when deletion ownership cannot be proved.

An export capture that never reaches archive Ready also has a finite seven-day
retry window from its captured start or last explicitly accepted retry. Active
operations stay protected. After a terminal canceled/failed/interrupted capture
expires, release its precise pins and record expired availability; retain original
start/control outcomes. A later retry returns PACKAGE_EXPIRED and cannot recapture
newer state or revive old custody. Reclaim only a known complete stage through the
existing fresh one-shot descriptor/proof cleanup; preserve unknown/partial residuals.
Serialize expiration with capture/retry ownership and recheck current activity, so
an old maintenance observation cannot expire a newer accepted retry.
Apply the same rule to known complete work-copy export captures and their private
copied tree, even after the original work item is discarded. Those captures own
copied files rather than project object pins; preserve original outcomes and
record expired availability before any later retry can recapture mutable work.
Partial or unproved work-copy staging remains a preserved residual.

## Restore, copied availability and returned work

Independent verified restore checks every member and complete trusted invariants
before normal startup. Use schema-only staging, revoke copied execution/preparation
authority and fence nonterminal jobs before Ready. Original terminal evidence and
receipt outcomes remain immutable. Global app data/secrets are excluded. Unmanaged
creative-only intake is classified explicitly for later adoption, not silently
accepted as verified managed restore. Activation/default adoption stays OP6.

Purpose-bound restore targets record current source-root owner, inspected intake
identity and a separately recorded result project UUID. Preserve the archive
project UUID exactly, including when it equals the active owner project UUID;
only the new target/root identity must be distinct. Native/browser initial targets are
app-managed persisted opaque locations. A migration target cannot be repurposed.
Existing target/no-clobber/result-journal crash/cancel-after-promotion behavior has
the same guarantees as A, including actual held-parent I/O and Ready verification.

Copied mutable OP4 roots/locations/reveal/cleanup leases are unavailable in the
target, even if the copied item says its original operation succeeded. Add truthful
current availability/guards without rewriting original outcomes. Explicit discard
of an unavailable item releases its slot with no guessed path deletion. Immutable
candidate/context evidence stays readable; a newly created same path cannot
resurrect copied authority. Preserve A's genuine-legacy empty-work behavior.

Returned work-copy edits require its existing trusted item/base/grant; complete
edited packages require this source core's retained export/base record and an
explicit OP4 creative grant. Current accepted graph must match the recorded base.
Ignore archive-claimed base/grant and reject or explicitly ignore supplied changed
management; it never replaces active SQL/locks/history. Preserve uploaded bytes.
Create/inspect candidates through OP4 actual-diff logic and its immutable prepared
mapping, not a second acceptance/history path. Missing trusted base offers independent
restore/adoption. Acceptance, locks, one grouped history operation, original receipt
replay after pruning and Undo/Redo retain existing semantics.

## Required frozen handoff

Cover every OP5-B gate with actual native and real-core HTTP tests, including
concurrent later edits, consistent capture, archive self-compatibility, all resource/
path/header/CRC failures, management tampering, copied preparation/no mock SDK,
current+historical approval/five history, duplicate/lost chunk acknowledgment,
start/capture/journal/promotion cuts and status/cancel/source-save responsiveness.
Injected tiny limits prove bounds; no GiB allocations. Retain A regression tests.

Run focused Rust/Clippy, schemas/types/format, full affected Node and named HTTP/
preload checks. No broad browser rerun for backend-only B. Freeze intended files/
hashes/HANDOFF in `.artifacts/op5b/` and stop all owned checks/writes/processes.
Root independently reviews, reruns material gates, documents and commits/pushes.
Every shell sources cloud-env; Rust wrappers use both zero-debug profiles and
`CARGO_BUILD_JOBS=4`, no concurrent Cargo. No delegation/Git/worktrees, root-doc or
`.agents/` changes, real conversion/provider, merge/tag/deploy/cloud publication.
