# OP4-A: native file graph and recoverable batch writer

Status: root-frozen implementation assignment, 2026-11-19, base `ba8e0b8`.
Parent [OP4](open-project-op4.md) owns product requirements. This checkpoint
implements OP4-T01–T03 only. OP4-B owns recorded Agent work items, grants,
production-file lock operations, HTTP/preload exchange and Changes UI.

Implementation is independently reviewed on Linux; see the actual
[validation and limits](../validation/open-project-op4a.md). The assignment below
records its frozen requirements and root-authorized refinements.

## Existing owners and permitted changes

Read `AGENTS.md`, `docs/architecture.md`, the development workflow, the common
format contract, OP2/OP3 and their validation before implementation. Inspect the
real repository seams before adding code: `open_source.rs`/submodules,
`manuscript.rs`, `history.rs`, `storage/`, `backup.rs`, repository lifecycle and
the shared migration ledger. Extend the single writer, ordinary command receipts,
source recovery and stable history identities. Do not build a parallel project
repository. Migrations 001–012 are immutable; append 013 and any necessary
successor. Any generated protocol change starts in JSON Schema, but no new public
work-copy API or renderer rewrite belongs in this checkpoint.

Provide native methods/types usable by B for explicit registration, immutable
graph reads and checked batch acceptance. A batch receives immutable base graph,
expected working revision, original request/digest and immutable candidate graph;
that internal entry is not an externally trusted scope capability. B performs
recorded grant/candidate validation before calling it. A must still enforce actual
manuscript policy, current production reservations and source/journal fences.
Do not expose an unrestricted batch endpoint in A.

Root-authorized refinement during integration: provide a core-produced native
`GraphObservation` for explicitly inspected live creative edits, separate from
the accepted graph. It captures the allowed inventory, immutable content and
physical member identities/absences. A trusted resolution can bind this observation
as physical-before, while private-copy batches still require physical==accepted.
Revalidate the complete observed inventory immediately before promotion. Live
accept may already have the after bytes; explicit discard restores accepted bytes
through the checked journal. Physical-only discard does not fabricate a prose/
history edit or alter locks/approvals. Document its generation semantics. B owns
durable scope/candidate binding and APIs; this is not an ambient file-write grant.

## Required implementation

1. Implement sorted immutable file inventories with generation, SHA-256, size
   and a verified graph hash. Manifest/manuscript are mandatory; immutable graph
   documents reference verified ordinary-object members. Use the exact exclusions
   and Unicode/prefix policy in OP4. Reject special/link/hardlinked input. Retain
   accepted graph independently from filesystem observations. Registration is an
   explicit baseline operation, not approval/history. Create/adopt may register
   within their verified initialization; existing OP2/3 projects remain readable
   before registration. Refuse source conflict/unknown intent/name mismatch.
2. Stream large creative objects, hashing, copying, verification, retention and
   backup/restore with bounded buffers. Default budgets are 20,000 files, 4 GiB
   per file and 16 GiB total. Inject small budgets for tests. Small JSON/MD retain
   their own bounds. Never materialize a full media file in `Vec<u8>` and never
   hardlink mutable creative/work-copy files to immutable objects. Protect source
   and management descriptors at reads and promotion. Linux implementation first;
   preserve explicit native OS refusals until OP6 supplies those primitives.
3. Add intent v3 as a general list of file changes with graph before/after,
   accepted versus physical identities, and original request/outcome binding.
   Stage/flush every member before durable intent; checked addition, retained
   deletion and displaced replacement, then one short guarded SQL commit. Reuse
   existing source preparation/projection for actual Markdown changes. Empty prose
   impact media/manifest edits cannot bump unrelated block revisions. No-op batch
   must not fabricate a history transition. New rejection codes must survive
   original receipt lookup and exact replay, not just the first return.
4. Recover each file from its actual known states on both sides of SQL commit.
   Cut points include every promotion, SQL and cleanup. Unknown live, stage or
   displaced bytes preserve all members and fence the entire operation. Extend
   explicit preserve-external settlement without overwriting unknown versions.
   Store path/role/hash/size evidence membership for B's paginated stream API;
   preserve v1/v2 compatibility. No whole-project success from a mixed generation.
5. Attach complete graphs to existing stable history entry identities. One
   batch is one of the existing five transitions; Undo/Redo is guarded and journaled.
   Old entries predating registration alter only their retained manuscript.
   Ordinary source saves, accepted AI results and source reconciliation update
   graph manuscript identity through this same seam. Media-only transitions
   advance project/history revisions while keeping prose revisions/anchors.
   Registration and passive scans cannot create a hidden approval baseline.
6. Apply OP4's manifest-name authority and graph-aware rename policy. Preserve the
   existing DTO, legacy route semantics and original rename receipt/CAS behavior.
   New-format non-noop name changes use one graph history/physical/SQL transition;
   Undo/Redo restores name and SQL title consistently. Do not trust a second name
   master. Whole manifest replacement may be serialized by a normal rename;
   unrelated creative bytes must remain intact.
7. Retain and verify graph closure for current, history/redo, approvals/downstream,
   pending intent and deliberate evidence; leave a clear pin extension for B's
   work items. Collection uses the writer. Complete native verified backup and
   restore reconstruct accepted extra files through streams. If an unsupported
   graph feature cannot be backed up, refuse explicitly rather than emit an
   apparently complete text-only backup. Preserve legacy backup behavior.

Do not hash 16 GiB on every existing two-second source poll. Graph status is cheap;
explicit inventory/rescan or operation-time checks do actual required verification.
Do not add SDK calls, code execution, an audio/video editor, package ZIPs, project
migration or product preview execution. Unknown production effects are conservative
production scope; text locks do not prohibit media creation. A supplies a policy
hook for B's minimal file locks and reuses existing active-downstream fences.

Root performance refinement: use the parent's explicit `checked_paths` v3 scope
for ordinary app manuscript/name and proved source/name-only history. Do not scan
or verify unchanged binary objects on every autosave. Full batches/live graph
inspection still prove the whole inventory. Scope must bind all touched physical
members and be validated during recovery; unrelated pending media stays intact
and unaccepted. Test actual physical/object read counts, pending media versus
source save, accepted-only backup, pending manifest name and identity/path tamper.

Root decision during implementation: v3 may refuse a regular-file↔directory
prefix transition (`a` versus `a/child`) before live/SQL/history mutation, including
live-origin acceptance whose Undo would require that shape. It must preserve all
bytes, return a definite typed capability outcome and replay it exactly. Add both
direction tests; retain ordinary safe per-file/subtree rename coverage. Do not
move live content before intent or disguise this limit as tested general support.

Root candidate-preparation handoff: provide a native-only proved preparation
helper that binds missing Markdown leaf IDs into an immutable prepared graph,
returning original/prepared identities and mappings without physical/SQL/history
mutation. Preserve existing IDs and unrelated bytes; reject invalid/ambiguous
syntax. Acceptance still requires exact native-prepared bytes and never performs
an uninspected random rebinding. B persists preparation with the original raw
candidate digest; a live observation remains the original physical-before while
the prepared graph is the inspected after. Test new paragraphs and preservation.

## Acceptance evidence

- Register/reopen a real manifest + bound MD + binary + TSX + lockfile graph;
  reject aliases/prefixes, special/hardlinks, credential injections and budgets.
- Grouped add/replace/delete including nested directories, a media-only change,
  manifest rename, normal rename, source save and old/new five-step Undo/Redo.
- Locked A remains at the same revision/anchor during B-only or media-only edits;
  actual locked-source modification/deletion refuses. Retain approved evidence.
- Receipt replay after later edits, same-ID/different-payload refusal and durable
  rejection lookup/replay. No repeated file/history mutation after lost ACK.
- Inject failure at each member, SQL and cleanup; restart known rollback/forward,
  exact third-party-byte preservation, stale recovery refusal, explicit settlement
  and path-aware retained evidence. Regress old v1/v2 intentions.
- Non-manuscript live replace/add/delete observation, already-after acceptance,
  checked discard, later external modification refusal and interrupted recovery.
- Changed ancestor/file races at actual promotion, no untracked path overwrite;
  verify the original accepted graph never becomes a partial saved graph.
- Collection/reopen/history/backup/restore binary closure using bounded streaming;
  tiny budgets make overflow/oversize behavior directly observable.
- Run affected native tests, full native suite/Clippy if shared coordination
  changes, contracts/types/format and real source HTTP regressions. Give exact
  commands, counts, logs, failures, skipped/native limits and performance probes.

## Assignment and handoff

One `gpt-6.1-sol` / high writer, no child agents. No Git mutation, staging, commits,
push, branch/worktree changes, merge/tag/deploy or environment publication.
Preserve the preexisting untracked `.agents/`. Root owns specs and reports; report
design conflicts instead of changing the frozen policy. Implementation comments,
diagnostics and test names use English. Keep code split by responsibility.

Source `scripts/cloud-env.sh` in every shell. Every Rust-invoking command/wrapper
sets `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
Do not run parallel Cargo processes. Keep root informed of blockers/findings.
Finish with `.artifacts/op4a/HANDOFF.md`: changed ownership/seams, schema/protocol,
actual evidence, known limits and next B handoff. Stop all writes and owned
checks/processes before announcing the frozen handoff. Root independently reviews,
returns corrections to the same writer, then alone commits and pushes.
