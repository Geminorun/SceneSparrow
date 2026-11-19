# OP4-B accepted-native and transport handoff

Status: root-frozen after `2823f6aa266eb83feb7a4c7058d201b7e4957ab7`,
2026-11-19. Implement with [OP4-B](open-project-op4b.md) and parent OP4.
This document resolves the preparation placeholders; root owns design changes.

## Accepted seams

A's actual code is `open_source/graph.rs` and `graph/{inventory,journal,recovery}`,
with the shared `manuscript.rs` coordinator, history sidecars and migration 013.
Read [A validation](../validation/open-project-op4a.md) and its artifact handoff.
Migrations 001–013 are immutable; append 014 and later versions if necessary.

Native methods are `register_file_graph`, `accepted_file_graph`,
`inventory_file_graph`, `observe_file_graph`, `prepare_file_graph_candidate`,
`accept_file_graph`, `accept_observed_file_graph`, `graph_recovery_fingerprint`,
`graph_recovery_members` and
`stream_graph_recovery_member(intent_hash,path,role,expected_hash,output)`.
The latter authenticates the complete member key. Existing v1/v2 base64 evidence
operations explicitly refuse v3. Native capabilities report unsupported prefix
topology changes and code execution. Do not turn native inventory/path arguments
into renderer capabilities.

Extend writer-held variants/context hooks for B. Calling a public mutex-taking
method from an already-held writer is a deadlock; calling it and later separately
pinning or disposing a candidate creates a collection/transaction gap. Registration,
scope/candidate checks, full action digest and disposition must share the existing
ordinary receipt/SQL owner. A's generated action digest currently covers its native
batch; B must bind the complete external DTO before the receipt lookup.

`GraphObservation` is opaque core-captured original physical state. Native marker
preparation returns original/prepared graph hashes and planned original-address/ID
mapping, with no creative/SQL/history mutation. Persist/reuse that preparation by
raw digest; never bind again during acceptance. Original work-copy bytes and an
original live observation are checked separately from the prepared after graph.

Current production policy hook is `guard_graph_production`, called during graph
preflight, physical preparation and SQL commit. Extend it with core-owned file
locks. Source/name-only operations keep their explicit checked-member scope and
zero unchanged-media reads. Full external batch acceptance remains a full proof.

## Frozen generated DTO families and routes

Add `packages/contracts/schema/external-work.schema.json` to the existing generator
and protocol definitions. Generate Rust/TypeScript; do not hand-edit generated
types. Live DTOs are closed objects. No new opaque JSON transport escape hatch.
All operation IDs and item/candidate IDs are canonical UUIDv4 unless an explicitly
named opaque cursor/member identity is used. Hashes are lowercase SHA-256.

| Family                               | Required fields and semantics                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreativeGrant`                      | `wholeTree`, `files`, `directories`, `manuscriptScope` with `kind` all/blocks/none and `blockIds`; whole tree excludes individual paths, blocks requires unique nonempty IDs, other kinds have empty IDs. |
| `GraphActionBase`                    | `requestId`, `projectId`, `expectedWorkingRevision`, `expectedGraphHash`, `expectedGraphGeneration`; the full original payload binds the outcome.                                                         |
| `GraphRegisterRequest`               | Original request/project/working revision plus `expectedSourceHash` and `expectedSourceGeneration`; registration never approves content.                                                                  |
| `WorkItemCreateRequest`              | Action base, origin copy/live, grant and reference IDs; no server path.                                                                                                                                   |
| `WorkItemInspectRequest`             | Action base, work-item ID and expected item revision; captures actual raw bytes, preparation and policy.                                                                                                  |
| `WorkCandidateAcceptRequest`         | Action base, work-item/candidate IDs, candidate digest and expected item revision; binds the immutable inspection/observation.                                                                            |
| `WorkItemDiscardRequest`             | Action base, work-item ID, nullable candidate ID, expected item revision and explicit discardCopy/discardCandidate/restoreAcceptedLive disposition; no stale live overwrite.                              |
| `WorkItemControlRequest`             | Original request/project/item IDs, expected item revision and explicit cancel/retry action; never automatically replaces the original start ID.                                                           |
| `ProductionFileLockRequest`          | Action base, locked flag and exact path/hash targets; existing non-manuscript files only, duplicates reject.                                                                                              |
| `WorkItemView`                       | Recorded base, grant/context, monotonic item revision, operation/state and latest candidate; no absolute paths.                                                                                           |
| `WorkCandidateView`                  | Candidate/digest, original/prepared graph hashes, inspected revision/generation, readable impact/blockers/provenance and change count.                                                                    |
| `WorkOperationView`                  | Original request/project/item, operation kind, queued/running/succeeded/failed/cancelled/interrupted state, safe failure/progress and applicable original outcome.                                        |
| `WorkMutationResponse`               | Original operation facts and current item/snapshot facts remain separate; pending work is not a completed graph receipt.                                                                                  |
| `GraphRecoveryInspection`            | `intentHash` and full `observationFingerprint` for an explicit v3 preserve decision; ordinary polling stays cheap.                                                                                        |
| Named graph/work/lock/recovery pages | Bounded records and opaque scoped continuation; maximum 100 records per page.                                                                                                                             |

Use `/v1/project/file-graph` (read), `/file-graph/register` (POST),
`/v1/project/work-items` (create/list), `/work-items/{id}` (read),
`/work-items/{id}/inspect`, `/accept`, `/discard`, `/control` (POST),
`/work-items/{id}/candidates/{candidate}` and its `/changes` (GET), and
`/v1/project/work-operations/{request}` (GET). File locks use
`/v1/project/file-locks` (GET/POST). Recovery metadata/member streams use
`/v1/project/file-recoveries/{intent}/members` and `/members/{member}/bytes`.
The member identity binds intent/path/role/hash; a supplied path/hash alone cannot
read an arbitrary object. B may add the recorded candidate-member byte route under
that candidate's namespace, with the same membership authorization.

The accepted implementation also provides `GET /v1/project/file-recoveries`,
`GET /v1/project/file-recoveries/{intent}` and `GET /file-graph/files` under the
same project prefix. The middle route is the named optional
`inspectGraphRecovery(intent)` operation. V3 preservation requires this full graph
fingerprint; a manuscript-only `AuthoredSourceStatus.observationFingerprint` cannot
stand in for it. Capture intent/root/project and a collection lease under the
writer, hash outside it under bounded admission, then revalidate ownership before
returning. The UI revalidates its decision/session after awaiting inspection and
before constructing a new recovery DTO. An uncertain original recovery retains its
original fingerprint/DTO. V1/v2 retain their separate source-evidence behavior.

Expose matching named PlatformClient/HTTP/desktop/preload methods, optional where
legacy clients lack the capability. Native reveal accepts only an item ID; core
location is available only to the privileged main-process capability, never browser
JSON. Validate native sender/session before and after awaits. Public status and
metadata contain no private absolute paths, token, vault or global key material.

`AuthoredSourceSaveResponse` already separates ordinary `receipt` from its current
`snapshot`; reuse that shape for completed applicable graph/lock actions rather
than duplicating source/history ownership. Operational create/inspect/status can
use their named views. Additional bounded display fields are routine implementation
choices; changing base/scope/receipt/protection semantics requires root review.

## Long operation lifecycle

Creation/materialization and inspection are core-owned bounded operations with
durable original request/state, not an AI job. Return operation identity promptly;
show preparing/inspecting/terminal state. Use at most one active preparation worker
per project, a bounded queue within the five retained copy limit, checked resource
budgets and explicit cancellation. No automatic new retry IDs or background paid
work. On restart, incomplete work becomes interrupted until explicit user retry;
do not infer a copied operation may resume. Preserve original start outcomes.

Capture/pin the immutable base and context under the writer, then release it for
bulk private-copy I/O. Finalize state under the same coordinator and current session
guard. Status remains readable during copying. The UI stays mounted and typing
retains its buffer. A late completion cannot flush newer input or retarget another
item. Accept still performs A's guarded journal/SQL transition once, using its
original action identity; a long response or lost readback is not a new acceptance.

For inspection preparation outside the business writer, hold a core-owned active
preparation/collection lease acquired under that writer until immutable roots are
durably pinned or operation is abandoned. Collection must defer reclaim while that
lease exists; an ordinary concurrent source save may continue. Immutable object
publication must handle concurrent same-hash publication safely with no-clobber
and verified deduplication, retaining A's descriptor/hash proofs. Do not install a
second authoritative SQL writer. Limit workers/leases and verify base/policy again
when finalizing inspection. Do not acknowledge a candidate before its pins persist.

Downloads similarly capture authenticated immutable membership/reader leases and
release the project mutex before network backpressure or native save dialogs.
Cancellation/close releases leases; collected bytes cannot vanish midstream. This
is scoped byte transfer, not arbitrary filesystem, code execution or a preview host.

## Production locks and history

Store exact path/hash locks in core management, separate from user text locks.
Explicit lock/unlock is a project history transition with no prose revision bump.
Its restore state must follow stable history entry IDs and the same five cursor
transitions, whether implemented in a business snapshot extension or verified
metadata sidecar. Preserve legacy snapshots/hashes with backward-compatible reads.

Current lock targets must match accepted graph members. Source/name-only edits do
not implicitly change production locks. Unknown shared production effects use the
whole production scope and honor current locks/downstream use at accept and Undo/
Redo. Candidate metadata never unlocks, approves or resolves a review. A deliberate
user history action can restore its own lock operation under the same rules as
text-lock history. Test late locks, locked deletion/rename, shared code and text A
locked plus independent media acceptance. Preserve approved raw and graph evidence.

## Presentation and acceptance

Use the existing app menu and Changes/auxiliary owner. A setup dialog may choose
scope/context; the normal working view has compact item state, actual changed files,
readable selected diff, explicit inspect/accept/discard and unavailable execution.
Reuse source recovery; do not add a raw JSON modal, a second dashboard, a permanent
column or a project-name gate. Web ZIP exchange is OP5; Native reveal works now.

Registered normal rename must join ProjectSession's captured-input/queue and apply
original receipt/current snapshot facts: A changed its revision semantics. Test
held readback/newer input/IME/focus and preserve uncertain IDs until proven outcome.
Global settings stay independent. Every new UI string/code has en/zh-CN resources,
three-second top notices and durable compact recovery. Typing never globally
disables unrelated controls or replaces its active DOM.

Implement all parent B acceptance cases with actual native/HTTP/preload/browser
evidence. Add slow copy/inspection/download probes proving ordinary source input
survives and status/appropriate source saves remain live, plus collection while
preparation/reader leases exist. Test worker interruption/retry and duplicate start/
inspection/accept/discard IDs; raw→prepared reuse after lost inspection readback;
same hash different paths and same path/role different versions; no runtime execution.
Run affected source/native, contract/type/Node, real HTTP and source/legacy browser
gates. Root independently reviews frozen output before Git delivery.

One gpt-6.1-sol/high writer; no child agents/Git/worktrees/providers/real projects/
merge/deploy/tag/environment publication. Preserve `.agents/` and root-owned docs.
Source scripts/cloud-env.sh every shell; all Rust wrappers use both zero-debug
profiles and CARGO_BUILD_JOBS=4, no parallel Cargo. Write `.artifacts/op4b/HANDOFF.md`
with exact evidence, capability limits and file/process freeze before root review.

## Reviewed ownership refinements

All create, inspect and explicit-retry admissions share the writer-held bound of
five queued/running preparations. A rejected original ID keeps its rejection after
capacity becomes available. Freeing capacity does not authorize a different retry
payload under that same ID. The independent five-copy slot limit keeps its priority.

An unresolved external action fences ordinary manuscript, planning, manual,
background, proposal and draft-start writes. Typing, IME and reads remain usable.
Scoped original-intent recovery remains available when needed to settle that action.
Definite original submit rejection, later readback failure, original outcome and
possibly newer current metadata are distinct facts. Legacy metadata uses its own
receipt semantics; registered actions use ordinary receipts. A newer verified
project projection must not be overwritten with the original older rename result.

A proved applied receipt plus a complete verified current source/canonical/history
checkpoint can have newer local raw input that cannot be automatically mapped.
Install that checkpoint atomically while preserving the exact local buffer,
composition/caret and original outcome. Retire uncertainty into an explicit merge
conflict with automatic saving paused. Existing Changes offers local download,
saved/local comparison, a new explicit combined proposal through normal source
policy/history, and guarded reload. Never repeatedly resubmit the original accept,
automatically save the old local buffer over applied text, or block both resolution
choices forever. Capture reload/proposal generation/context before queueing and
revalidate after reads; post-click input must survive. Unknown application or failed
readback cannot use this proved-conflict path to release its original fence.

Logical copy discard and slot release are separate from physical cleanup completion.
Physical deletion is a one-shot capability of the first live invocation. Hold the
original directory descriptor continuously through detachment, stage verification
and descriptor-relative no-follow traversal/removal. An original business replay
never reacquires either the old root or a stage pathname for deletion. A persisted
device/inode pair is insufficient after interruption because it can be recycled.
Retain interrupted original/stage bytes and truthful incomplete state; only record
physical completion after actual removal. Cleanup is bounded independently to
64 directory descents and 100,000 entries, checked before recursive opens; refusal
leaves consumed/incomplete cleanup, never a destructive retry. These private cleanup
bounds do not lower creative graph limits. A future explicit residual-cleanup
capability is outside this checkpoint; no automatic pathname-based reclamation is
implied. Migration/packages must not transfer these destructive process capabilities.

Explicit page/selection/download read failures use captured client, surface,
resource, cursor and request ownership. Preserve displayed rows, provide one owned
localized three-second notice and compact retry, and ignore late results after a
newer selection/unmount. Passive status polling cannot replay those notices.
