# Script workbench implementation and acceptance, v0.1

Status: planned work and acceptance criteria, not completed features or test results.
Read the [workbench design](script-workbench-v0.1.md) and
[shared AI design](shared-ai-v0.1.md) first. This plan scopes the feature branch to
the manuscript stage. Audio/video implementation requires later designs.

## 1. Baseline and implementation policy

Remote `main` at `ba71ffc` contains the merged bootstrap: project create/reopen,
SQLite ownership, bilingual shared UI, authenticated local API, protocol generation,
worker interfaces and a Remotion smoke sample. No editor, review, production AI,
history or lock workflow is implemented at that baseline.

Develop on `feat/script-workbench` and follow the repository's English commit,
documentation and comment rules. Keep each change reviewable; do not introduce
all four slices in one implementation commit. This design delivery itself changes
documentation only. Framework integration tests remain useful regression checks,
but their passing does not certify the new workflows below.

Start each slice with a small coherent schema/domain/application/UI path. Generate
contracts from JSON Schema, migrate storage explicitly, and expose the same behavior
through browser and desktop platform clients. Use fake AI adapters until a slice
needs a deliberately initiated real-provider smoke test.

## 2. Delivery slices

### S1 — Usable manuscript editing without AI

Detailed contract, development tasks and stage-specific acceptance are in the
[S1 implementation spec](../specs/s1-manuscript-foundation.md). Each stage and
shared AI have separate spec ownership according to the [spec index](../specs/README.md).

Implement the canonical block schema, stable IDs, project migrations and repository
operations. Add Tiptap conversion, direct editing, headings/lists/basic marks, saved
state feedback, source intake, and initial/existing manuscript import. Add project
history with bounded snapshots and its shared keyboard/toolbar routing.

Persist five operations plus cursor; group typing; retain history across reopening.
Separate system task/result records from recoverable editor state from the start.
Use meaningful Chinese/English/emoji fixtures and a bootstrap migration fixture.

Exit evidence: a user can enter/import and edit a manuscript, reopen the project,
undo five grouped operations, redo to the previous endpoint, branch history with a
new edit, and see save/import failures without losing acknowledged work. No real
AI service is needed for this slice.

### S2 — Reusable AI and outline-to-draft flow

The [S2 implementation spec](../specs/s2-outline-and-initial-draft.md) details
manuscript planning/orchestration and declares dependencies on the independent
shared AI spec. Shared configuration, credentials, provider adapters and generic
execution below belong to that separate AI specification; S2 delivery requires
both sides to be implemented and validated.
The [shared AI spec](../specs/shared-ai-integration.md) owns its `SAI-*` tasks and
acceptance cases, public ports, dispatch guarantee and initial migration sequence.

Implement global settings, secure credential ports, one text category binding,
manual/discovered model selection and an explicit connection test. Add the generic
execution service, agent-host protocol, `packages/ai-runtime`, compatible provider
adapter and deterministic test adapter. Complete cancellation, task-start snapshots,
stale receipts, no-retry behavior and interrupted-run recovery before wiring review.

Add brief/source context assembly, outline generation/adjustment and confirmation.
One user action generates a complete initial draft; commit it only after complete
output validation. All new blocks start unlocked. Provide input-capability and
source-evidence visibility. Manual source links/files are unconditional; live
discovery needs a separately configured, tested search adapter.

Exit evidence: the complete planning/draft path works with a fake provider and one
explicitly tested compatible endpoint. Settings changes do not mutate active runs;
failures do not trigger another paid call. A fake non-manuscript caller can exercise
the shared runtime without importing script models. Audio/video remain reserved
categories, not implemented features.

### S3 — Review, comparison, and finalization

The [S3 implementation spec](../specs/s3-review-and-finalization.md) defines
review anchors, AI answer/candidate integration, atomic user decisions, enforced
locks, derived finalization, and their interaction with project history/recovery.

Add anchored questions and revision notes, thread/request versions, candidates,
latest comparison, source-changed markers, acceptance/discard and accept-all.
Implement the shared domain mutation guard for edits, structure changes, acceptance,
locks, history and imports. Add the far-right lock column and derive finalization
from all content-block locks.

Connect candidate acceptance and review decisions to the existing history store.
Model temporary task leases separately from user locks. Exercise simultaneous
user edits, cancellation, late replies and lock conflicts with controlled fake
worker barriers rather than timing-sensitive sleeps.

Exit evidence: a user can question or request a change, inspect one comparison,
accept individually or in a batch, and manually lock the result. Locked content
survives every mutation path. Ordinary comments remain usable on locked content.
Unresolved candidate changes block locking their targets.

### S4 — Export and end-to-end acceptance

The [S4 implementation spec](../specs/s4-delivery-and-validation.md) defines
saved-body export/copy, native/browser delivery, recovery evidence, performance
and target-platform completion gates for the full manuscript workflow.

Add consistent-snapshot copy, Markdown, TXT and DOCX output; validate their content
and exclusion of review metadata/candidates. Add recovery/fault-injection coverage,
performance measurements and desktop-specific checks. Finish localization and
accessible keyboard behavior for the shared UI.

Exit evidence: complete a project from topic/sources through outline, draft, review,
lock-all and each export format; reopen it with history and locks intact. Run the
same core workflow in the browser and on actual target desktop systems. Report
separately any untested operating system, provider or capability.

## 3. Workbench acceptance matrix

Each case requires behavior assertions, not screenshots alone. IDs remain stable
as implementation files evolve.

| ID    | Scenario                                                     | Expected result                                                                                                                       |
| ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| SW-01 | Open outline workspace                                       | Manual structure editing and overall AI adjustment exist; paragraph review, comparisons and locks are absent                          |
| SW-02 | Generate initial draft without confirmed current outline     | Reject start; confirmation captures exact outline/brief/source inputs                                                                 |
| SW-03 | Complete, fail or cancel initial generation                  | Success creates the whole draft once with unlocked blocks; failure/cancel leaves outline and existing content intact                  |
| SW-04 | Import existing manuscript                                   | Enter draft workspace unlocked; no forced AI call or artificial outline confirmation                                                  |
| SW-05 | Type manually and restart after saved acknowledgment         | Text is present; manual edits require no acceptance; save errors remain visible                                                       |
| SW-06 | Submit a question                                            | Answer attaches to the original thread; no body mutation and no automatic resolution                                                  |
| SW-07 | Submit a revision note                                       | Only scoped candidate changes appear; current body stays unchanged until user acceptance                                              |
| SW-08 | Accept or discard one candidate                              | Acceptance updates body and clears active comparison without locking; discard keeps body                                              |
| SW-09 | Accept all, including stale/locked/overlapping candidate     | All-or-nothing transaction, exact submitted set, useful conflict list; successful batch is one undo operation                         |
| SW-10 | Regenerate a candidate repeatedly                            | Only latest successful comparison remains active; failed regeneration preserves previous candidate; no alternate-version browser      |
| SW-11 | Edit/delete referenced text                                  | Preserve the last quote/latest comparison, mark original changed, and keep orphaned comments accessible without false reattachment    |
| SW-12 | Edit locked paragraph through UI and direct API              | Reject typing, deletion, split/merge, structural impact, candidate acceptance and history-based bypass consistently                   |
| SW-13 | Add review on locked content                                 | Questions and candidate proposals work without body changes; accepting requires unlock; review arrival does not remove existing locks |
| SW-14 | Lock one/all with pending candidates or mutation tasks       | Require affected candidates handled and task lease released; ordinary unresolved comments do not block                                |
| SW-15 | Lock all, unlock one, or insert a new sibling                | Finalization derives from all non-placeholder content blocks; unlock/new block returns to editing; other locks remain                 |
| SW-16 | Edit headings/order after draft exists                       | Navigation follows the body; no second editable outline and no automatic prose regeneration; locked descendants remain protected      |
| SW-17 | Perform more than five grouped edits                         | Exactly five transitions remain undoable; grouping and pruning preserve current body                                                  |
| SW-18 | Undo five, redo five, then undo and type                     | Restore previous endpoint when no branching edit exists; new mutation discards redo tail; navigation/autosave do not                  |
| SW-19 | Reopen while positioned in history                           | Recover body, history and cursor; unfinished typing group closes at its last committed state                                          |
| SW-20 | Undo accept-all or a manual edit during a scope lease        | Apply no partial reversal; report blocked action without cursor change; no model call or job resurrection                             |
| SW-21 | Receive AI answer/candidate while undoing unrelated edit     | Preserve async artifacts and task state; inverse affects only the recorded business fields                                            |
| SW-22 | Restore text with undo then receive an old AI result         | Monotonic revision prevents stale-token reuse; candidate rebinding requires matching content/dependencies/request                     |
| SW-23 | Intake TXT/Markdown/DOCX/extractable PDF                     | Copy immutable source, retain extraction provenance, report unsupported layout/images/scanned-only PDF honestly                       |
| SW-24 | Select images with incapable/unknown model                   | No silent omission presented as successful visual understanding; user gets a clear capability choice                                  |
| SW-25 | Export edited or finalized manuscript in each format         | Export current saved body only, preserving supported structure and excluding pending candidates/comments/diff/locks                   |
| SW-26 | Export failure or duplicate command receipt                  | Existing destination survives failure; duplicate request does not double-apply changes or AI jobs                                     |
| SW-27 | Crash between object write and database commit               | Reconcile orphan staging data; no committed reference to an incomplete object; content/history remain atomic                          |
| SW-28 | Upgrade bootstrap project, fail migration, open newer schema | Preserve recoverable old state; reject unsupported newer format without mutation                                                      |
| SW-29 | Emoji/combining characters and cross-block selections        | Valid anchors and patch scopes in both Rust and editor; no byte/UTF-16 mismatch                                                       |
| SW-30 | Prune undo history with referenced downstream input fixture  | Keep referenced revisions; editing content marks dependent fixture outdated; unlocking alone does not                                 |

SW-30 uses a minimal fake artifact dependency, not a video implementation. It
verifies the retention/invalidation contract needed by later stages.

## 4. Shared AI acceptance matrix

| ID    | Scenario                                                     | Expected result                                                                                                        |
| ----- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| AI-01 | Change global text settings                                  | All subsequent text workflows use the new binding; no hidden project or per-substep model override                     |
| AI-02 | Change endpoint/model/parameters after queued start          | Frozen execution remains unchanged; retry creates a new run using current settings                                     |
| AI-03 | Discover models unavailable, manual model provided           | Manual configuration and explicit inference test still work                                                            |
| AI-04 | Fail auth, rate limit, network, timeout, JSON or stream      | One request only; typed tip plus settings/retry action; no SDK retries, fallback, parameter-repair call or auto-switch |
| AI-05 | Use streaming and non-streaming adapters                     | Same normalized lifecycle/result contract; partial/truncated output is not a completed manuscript                      |
| AI-06 | Duplicate/out-of-order result or old attempt                 | Validate run/attempt/fence/input identity and idempotency; no duplicate or stale candidate                             |
| AI-07 | Race completion with cancellation                            | One terminal result; late output cannot override a revoked attempt or modify body                                      |
| AI-08 | Restart after ambiguous in-flight provider call              | Mark interrupted and wait for user; no automatic paid reissue; release obsolete local task leases                      |
| AI-09 | Inspect settings, task DB/export, logs and process arguments | No raw key; key readback masked; unsupported secure storage uses labeled session-only mode                             |
| AI-10 | Rotate/delete key with queued run                            | Preserve pinned credential semantics; explicit failure if unavailable; never substitute another key silently           |
| AI-11 | Call runtime from fake non-script client                     | No script/editor/Remotion imports or required paragraph/comment types                                                  |
| AI-12 | Return fabricated out-of-scope patch/approval instructions   | Business validator rejects mutation; generic runtime cannot unlock, approve, finalize or execute code                  |
| AI-13 | Receive answer to changed review instruction                 | Old request version is stale and cannot resolve or overwrite the current request                                       |
| AI-14 | Supply a plain URL without retrieval capability              | Record link-only evidence; do not claim full page access; discovery returns only actual search results                 |
| AI-15 | Request text and future reserved categories                  | Text works; unimplemented audio/video capabilities are explicitly unavailable, never routed as fake synthesis          |
| AI-16 | Context/output budget exceeded                               | Clear failure/action before dispatch when detectable; no silent loss of mandatory outline/target content               |
| AI-17 | Reconnect client stream                                      | Replay status/state from cursor without resubmitting generation                                                        |
| AI-18 | Select configured local keyless endpoint                     | Explicit no-auth mode works without saving a fictitious secret; no change to remote authentication rules               |

## 5. Test layers and meaningful fixtures

- **Domain:** mutation guards, derived readiness, history transitions, scope and
  UTF-16 conversions. Use direct commands to prove UI bypass cannot defeat locks.
- **Storage/integration:** real SQLite transactions, process restarts, migration,
  staged-object faults, command idempotency and undo persistence.
- **AI contract:** local fake endpoint/worker with controlled streaming, late
  completion, truncation, rejected parameters and counted requests. Assert that
  failure recovery does not make a hidden second provider call.
- **Browser:** selected-text review, outline-only controls, side comments/right
  locks, keyboard undo, batch acceptance, save errors, locale parity and exports.
- **Desktop:** Windows/macOS credentials, file selection, Unicode paths, clipboard,
  shortcuts, controlled close/reopen and worker lifecycle.

Use representative licensed/synthetic documents, not user API keys or uploaded
private content, as committed fixtures. Include DOCX headings/lists/embedded image,
text PDF, scanned-only PDF, corrupt archives, large paragraphs, repeated text and
emoji. Inspect exported document structure/text using independent parsers where
practical, and manually open DOCX in a target word processor; do not assert only
that an output file exists.

Existing commands to use as relevant implementation lands are `pnpm check`,
`pnpm build`, `pnpm test:integration` and `pnpm test:e2e`. Add targeted tests to those
existing workflows rather than inventing checks that cannot run. A documentation
change needs formatting, link/anchor integrity, source checksum and diff checks;
it does not require rendering video or making paid model calls.

## 6. Performance and resource experiments

Use reproducible fixtures with approximately 50 KB, 500 KB and 2 MB serialized
manuscripts, varying paragraph counts, up to 500 comments and five history steps.
Exercise both many short blocks and one long paragraph, plus referenced source
files that are much larger than the editor state. These are test sizes, not a
promise of unrestricted file support.

Record hardware, OS, tool versions, warm/cold state, operation count, p50/p95 and
peak memory/disk including Node, Electron and Rust processes. Measure local work
separately from provider/network latency. Suggested initial engineering budgets:

| Measurement                                       | Initial target to validate                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| Typing-to-paint at ordinary fixture sizes         | p95 below 50 ms without synchronous database/network work                   |
| Local undo/redo acknowledgment at 500 KB          | p95 below 150 ms                                                            |
| Local undo/redo acknowledgment at 2 MB            | p95 below 500 ms; investigate block snapshots if missed                     |
| Save acknowledgment after a flushed ordinary edit | p95 below 250 ms, excluding debounce                                        |
| Retained undo payload                             | At most six referenced business states; no attachment duplication per state |

These are proposed budgets, not measured claims or release guarantees. If they
fail, inspect serialization, editor decoration updates, transaction cost and full
document transfers before attributing latency to Rust or adding complex delta
history. Confirm filesystem durability behavior with fault tests, not latency
alone. Large DOCX/PDF extraction must remain cancellable and off the UI thread.

## 7. Implementation investigations with bounded outcomes

These are engineering validation tasks, not unsettled product requirements:

| Investigation                        | Decision/evidence needed before the relevant slice exits                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Tiptap canonical mapping and anchors | Supported nodes map losslessly; repeated text/Unicode/split/merge tests pass                                                                |
| Credential backend                   | Windows/macOS storage tested; development fallback explicitly session-only                                                                  |
| Compatible provider differences      | Pin SDK; verify selected endpoint's params, output/stream handling and one additional compatible endpoint before broad compatibility claims |
| Document libraries                   | Pin tested versions/licenses; fixture-based import/export behavior and bounded parser resources                                             |
| Snapshot performance                 | Measure before switching to affected-block payload storage                                                                                  |
| Search integration                   | Enable only a tested search capability; manual links/uploads remain usable regardless                                                       |

Do not expand scope to video, accounts or a version-management UI to solve these
questions. Record any necessary product change for review rather than silently
altering confirmed behavior.
