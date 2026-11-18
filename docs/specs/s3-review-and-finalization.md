# S3 specification: review and finalization

Current presentation: [central writing workspace](../design/writing-workspace.md)
adds compact Ask/Revise to AI assistant and retains full anchored review in Comments.
Selected text is the default scope when present; explicit whole scope includes all
supported blocks, rejects more than 100 blocks/oversized captures without truncation,
and still requires candidate acceptance and lock validation.

Status: steps 6–7 implement anchored review, candidate decisions, production locks,
derived finalization and validated review replay. The
[step 6](../validation/step-06.md) and [step 7 validation](../validation/step-07.md)
record actual checks and limits. Native/provider and large-document performance
acceptance remains open. [Step 8](../validation/step-08.md) adds S4/export and
cross-stage evidence, including measured performance misses.
Version: 0.1. This is the third slice of the
[implementation plan](../design/implementation-and-acceptance-v0.1.md).

Read the [S1 spec](s1-manuscript-foundation.md),
[S2 spec](s2-outline-and-initial-draft.md),
[workbench design](../design/script-workbench-v0.1.md), and
[shared AI design](../design/shared-ai-v0.1.md). The interview defines product
behavior. Concrete schemas, limits and implementation defaults below refine that
behavior and require validation as implementation lands.
The [shared AI implementation spec](shared-ai-integration.md) supplies the actual
generic ports, migration ledger and execution/recovery acceptance contract.

## 1. Outcome, scope, and dependencies

A user selects manuscript text, asks a question or leaves a revision note, reads
AI replies or proposed changes, accepts/discards changes, and explicitly locks
paragraphs. Locking all content finalizes the manuscript. Manual and imported
drafts use the same workflow as AI-generated drafts.

| Module                       | Required result                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Review anchors               | Stable block/range binding, highlighting, changed-source/orphan handling                  |
| Review threads               | Only question and revision-note types, adjacent messages and explicit user handling       |
| Script review AI             | Read-only answers or scoped candidate changes using the global text model                 |
| Comparison and decisions     | Latest before/after comparison, individual/all acceptance and discard                     |
| User locks and readiness     | Far-right lock column, lock-all, explicit unlock and derived finalization                 |
| Mutation/history integration | Same enforced rules for edits, acceptance, imports, structure and undo/redo               |
| Recovery and retention       | Durable pending reviews, idempotent results, bounded comparison payloads and safe restart |

These operations exist only in `workspaceStage = draft`. Outline-stage review
commands fail with `STAGE_CONFLICT`; the outline UI gains no paragraph comments,
comparison controls or locks. Export/delivery belongs to S4. Video/audio jobs remain
future integrations; use a fake dependency consumer to test their contract.

| Dependency               | Required handoff                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S3-DEP01: S1 foundation  | Canonical blocks/ranges/IDs, serialized save queue, history, command receipts, mutation-policy seam, object store/events                     |
| S3-DEP02: S2 integration | Source/context preparation, versioned script prompts/interpreters, generic run binding, reservations/cancellation and restart reconciliation |
| S3-DEP03: shared AI      | Frozen global text config, generic execution/results/errors, secure credentials and unit-of-work ports from the independent shared AI spec   |

Shared AI owns provider/configuration/transport/queue internals. Script application
services own review intent, context scope, anchors, candidate validation and user
decisions. No provider SDK, API key, approval rule or paragraph type enters the
wrong side of that boundary. A fake execution port is sufficient for deterministic
S3 tests, but does not certify live shared AI behavior.
Use its `withResolvedConfiguration`/`enqueueInUnitOfWork` start boundary and
`cancelInUnitOfWork` coordinator hook. Review claim/reservation/binding writes
share the generic run transaction; they are never raw runtime or provider fields.

## 2. Interaction and user-visible states

### 2.1 Selection, comments, and explicit AI actions

In the draft editor, selecting text exposes **Question / 提问** and
**Revision note / 备注**. The adjacent card shows the referenced text, user message,
task state and answer or comparison. With no text selection, anchor to a chosen
whole block. Cross-block selection records one range per block in document order.

Saving a comment creates no paid call. The card's explicit **Ask AI** or
**Generate change** submission saves the current request and starts one AI run.
Opening a card, typing a message, changing selection, or receiving a result never
starts another run. Failed calls show transient safe notices plus durable settings/manual
retry actions. Use the same global text category as outlining and drafting.

The two kinds have distinct results:

- A question returns an answer in the thread. It cannot return an applicable body
  patch or mark itself handled. The user may add a follow-up and explicitly ask
  again, or mark the question handled.
- A revision note returns a candidate change and a brief explanation in the card.
  Current body remains unchanged until user acceptance. Follow-up instructions
  create a new request version; they do not edit the body automatically.

New user comments can be created anywhere, including locked text or text with
another pending candidate. Execution/claim conflicts are checked when requesting
a body-change proposal, not by preventing users from writing review notes.

### 2.2 Side cards, comparison, and clean body

Show review cards beside the selected block and keep a review list for offscreen,
handled and orphaned threads. On narrow windows, use an adjacent panel without
losing the selected block/range. Highlight anchors and show **Original text changed /
原文已变更** where applicable. Repeated text must not make a card jump to another
matching sentence.

Keep the normal body current and editable under its lock/reservation rules. Show
candidate before/after text as a comparison decoration/card, not a second saved
manuscript. One active candidate owns a block at a time. A multi-block candidate
is one group with per-block comparisons and one acceptance decision.

**Accept change / 采纳修改** applies the candidate, marks its revision request
handled, removes active comparison marks and leaves clean current text. It does
not lock anything. **Discard change / 放弃修改** removes that active candidate and
keeps current text; leave the note open for further discussion unless the user
also marks it handled. **Accept all changes / 全部采纳** applies the explicitly
displayed set as one atomic operation and one undo step.

Handled threads can remain available in the side list, but their active highlights
and comparisons are cleared. Do not delete review text just to clean the body.
There is no user-facing version browser or chain of older comparisons.

### 2.3 Locks and readiness

Put lock buttons in one column at the document's far right, aligned with content
blocks; put **Lock entire manuscript / 锁定全文** at the top. Do not put lock actions
in the selection toolbar. Headings/list items use the same protection as paragraphs.
Use localized accessible labels and distinguish user approval from temporary
task-use status by both text/icon, not color alone.

Locked content still supports comments, answers and candidate proposals. Accepting
a proposal into it requires explicit user unlock. A proposal arriving against an
already locked block changes neither its user lock nor current finalization.
Starting a new lock requires affected pending candidates to be accepted/discarded
and affected revision-generation reservations to have ended. Ordinary open comments
or unanswered questions are not blockers.

Unlock affects only the selected user lock. It does not cancel a task or release
its reservation. A user can remove approval while a task uses that text, but the
body remains temporarily read-only until that task ends/cancels. There is no default
"unlock all and continue" shortcut embedded in an acceptance error.

## 3. Models, identities, and state ownership

Use S1 stable UUIDs, monotonic revisions, immutable objects and UTF-16 text offsets.
Public DTOs are generated from the existing JSON Schema source of truth.

| Record               | Principal fields                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ReviewThread`       | ID, kind, user status `open                                                                                               | handled`, current request version, current anchor, optional tombstone    |
| `ReviewAnchor`       | Block ID/revision, half-open range or whole-block flag, selected quote, request version and attachment state              |
| `ReviewMessage`      | ID, author `user                                                                                                          | ai`, text, associated request/version and optional task/result reference |
| `ReviewRequest`      | Immutable saved instruction/context references, request version, target ranges or insertion slot, prompt/output versions  |
| `ReviewTaskBinding`  | Run/input identity, active attempt fence, request/version, dependencies and result applicability                          |
| `CandidateGroup`     | ID, version, request/run binding, validated target scope, base hashes/revisions, proposed payload and decision projection |
| `CandidateClaim`     | Unique claimed block or insertion-slot owner and request; prevents overlapping active proposals                           |
| `ReviewComparison`   | One active latest before/after projection per claimed block, source-change flag and candidate/request reference           |
| `ReviewDecision`     | User action, candidate IDs/versions, applied/discarded/handled state and operation ID                                     |
| `UserLock`           | Block ID, current approved content revision/hash, lock action ID and timestamp                                            |
| `TaskReservation`    | Run/attempt fence, scoped input IDs/ranges, expiry and owner operation; never a user approval                             |
| `ManuscriptBaseline` | Immutable manifest of exact ordered block IDs/revisions/content hashes and schema version                                 |

Persist user decisions separately from immutable AI artifacts. A candidate's current
UI state is derived from its artifact, latest decision, dependency validation and
claim; do not let a worker change those decisions. Useful projections are
`pending`, `stale`, `accepted`, `discarded`, and `superseded`. A worker's generic
success is not an accepted manuscript change.

Each request version has its own source quote and AI result binding. Current
threads show their current request and retained messages; do not retain every
intermediate editor state as comment history. Deleting a thread tombstones user
visibility and fences its active request. Undo may restore the thread, but cannot
reactivate its previous network task or decrease its version counter.

Initial engineering limits: 2,000 threads per manuscript, 16 KiB UTF-8 per message,
100 blocks per selected request, and 100 candidate groups per accept-all command.
Page thread/message queries and validate total response sizes. S1 manuscript and
S2 context/output limits continue to apply. These are validation defaults, not
measurements or permission to trim user comments silently.

## 4. Anchors and source-change comparisons

### 4.1 Binding and deterministic mapping

Flush pending editor changes before creating a persisted anchor or starting AI.
The command includes expected block revisions, exact selected quote and ranges.
The core checks them against canonical text and Unicode boundaries. Reject a
stale selection with `ANCHOR_STALE`; preserve the user's unsent comment so they
can select again. Do not silently relocate it by searching the document.

Map anchors through the **accepted canonical edit**, using a deterministic range
map derived and verified in the core; editor transaction mappings are UI assistance,
not authoritative coordinates. Changes outside a selection shift it when the
mapping is unambiguous. Moves keep block identity. Splits/merges use S1 identity
rules and map ranges through the actual operation. When mapping is ambiguous or
the selected text is replaced/deleted, mark it `source_changed` or `orphaned`.
Keep orphaned comments in the review list even if the original block no longer exists.

Preserve the quote captured for the current review request. For a block without an
active candidate, share one latest source-change comparison across its affected
threads: only the immediately preceding and current affected text. A later change
replaces that pair rather than appending a version.
This does not reset the review's quoted instruction to mean different text.
Manual edits remain directly saved and need no acceptance. Their changed-source
indicator is review evidence, not an unaccepted body patch.

### 4.2 Latest comparison and acknowledgment

If a valid AI candidate exists, its comparison uses its captured current-body base
and proposed replacement, with changed-source status shown separately when needed.
Never use an earlier unaccepted candidate as the current-body base. A later accepted
edit becomes the base for the next request. Store one latest comparison projection
per claimed block; per-thread quotes are compact anchor evidence, not extra body
versions. An active candidate occupies that block's comparison slot; later manual
edits mark it stale instead of creating another visible comparison history. A
stale comparison can be inspected but cannot be accepted.

Marking a comment handled clears its source-change projection/highlight; a shared
pair remains only while another active thread references it. It does not alter
manually edited body text. Accepting or discarding a candidate clears
its active candidate comparison. If a note still has a candidate, handling the
note requires an explicit decision to accept or discard it; handling alone cannot
silently apply or abandon a proposal. These actions provide a clean body without
adding an approval step to manual editing.
Handling a note while its revision task is active requires waiting or cancelling
that task first, so a late proposal cannot appear underneath a handled request.
A question answer may still attach to its original handled thread without reopening
it or changing body/readiness.

Prune superseded comparison payloads unless retained history, live tasks, original
request evidence or downstream provenance still references them. Preserve only
the evidence needed to understand a current review request, not an unbounded chain
of before/after manuscripts.

## 5. AI question and revision workflows

### 5.1 Shared context and execution

Reuse S2 evidence preparation and shared AI ports. Snapshot target ranges/body,
relevant nearby blocks, the current request/messages, selected evidence, language,
prompt/schema versions and the current global text config at start. Record each
actual context dependency explicitly. Unrelated project changes do not stale a
result; changed request/target/included context or source dependencies do.
Review preflight validates a saved comment and target scope; it does not require
a topic, confirmed planning outline or AI-generated draft. This keeps questions
and notes fully usable on manuscripts imported or written manually in S1.
Apply the shared AI message/byte/image ceilings before dispatch. If target plus
context cannot fit, explain the required smaller selection/context; do not silently
drop the target or run a second model request to compensate.

Question tasks read immutable snapshots and need no body reservation. Revision
generation acquires its scoped task reservation and candidate claim in the same
start transaction. It may read user-locked content; this is proposal generation,
not body mutation. Direct edits/history affecting that scope wait or cancel, while
other blocks remain editable. Terminal completion/failure/cancellation releases
only the task reservation, never a user lock.

Display bounded streaming preview inside the task/card only. Complete validated
answers/candidates are committed once. No partial output enters body, no automatic
model/provider switching, paid retry, output-repair call or implicit fallback.
Explicit retry creates a new run using current saved context/config and preserves
the prior run identity. Shared AI owns actual SDK/transport behavior.

### 5.2 Questions and request changes

The question output schema contains answer text and bounded evidence references,
not a patch/approval action. Validate references against the input evidence manifest.
Save the answer under its exact thread/request version and keep user status open.
Changing a question or deleting its thread fences old applicability. A late answer
may remain labeled task evidence; it cannot replace a newer answer or resolve the
current question. Restored threads may show retained evidence under its original
request, never as a fresh reply to a different instruction.

Submitting follow-up text advances the saved request version and snapshots the
conversation chosen for that call. Editing user review text is a project history
operation; answer arrival is system state outside those snapshots. Regeneration
of the same unchanged question replaces the current answer projection only after
success; failure leaves its previous answer accessible.

### 5.3 Scoped candidate format and section filling

The first revision schema has two explicit modes:

- `replace_ranges`: ordered replacements of the saved target ranges with supported
  S1 text runs. A whole-paragraph request names its full range. The core preserves
  all content outside allowed ranges and keeps block identities/kinds intact.
- `fill_section`: insert supported paragraph/list blocks into a user-selected empty
  section's explicit insertion slot. Bind the heading ID, outline-derived section
  range and adjacent boundary IDs. The core assigns new block IDs once. No existing
  body is replaced, and new blocks start unlocked.

Normal notes use `replace_ranges`. Expose section filling only for an explicitly
chosen empty section; nonempty sections use scoped revision instead of an implicit
overwrite. S1 manual editing handles general split/merge/reordering/kind changes.
Model output cannot contain arbitrary S1 commands, lock fields, review decisions,
SQL, executable code or undeclared insertions/deletions. A candidate may span
several ranges/blocks and remains one indivisible group. Splitting it into smaller
independent requests is explicit; there is no token-by-token acceptance in v0.1.

Normalize output once, verify schema/size, reconstruct the actual candidate result
and compute affected fields/IDs. Reject changes outside scope even if the model
claims they are harmless. An empty replacement is allowed within an explicit
selection; it removes text, not the block. A completely unchanged result reports
`NO_CHANGE`, creates no pending candidate and leaves the note open.
If regenerating an existing valid candidate, `NO_CHANGE` is not an implicit user
discard: preserve that candidate and explain that no new replacement was produced.

### 5.4 Claims, overlap, and regeneration

Conservatively claim entire touched blocks for a pending candidate, even when two
selections in one block do not overlap. Section filling claims its insertion-slot
owner/boundaries as needed to reject conflicting structure. Another note can be
saved there but cannot start conflicting revision generation until the current
claim is handled. Independent question tasks do not claim body-change slots.

Regenerating the same request may retain its own claim. A new successful valid
result replaces its old candidate/comparison atomically. Failed regeneration keeps
the prior candidate **if the request and dependencies are still valid**. Changing
the instruction/anchor advances request version and immediately makes the old
candidate stale; a failed new run cannot make it valid again. Pending/stale active
candidates continue to block a new lock until discarded or successfully replaced.
The same thread may transfer its claim to a newer request version after fencing
its old attempt; a different thread cannot take that claim implicitly. Editing an
instruction alone starts no call. While its old run is still active, a new start
must wait/cancel it rather than enqueue overlapping revisions.

Deleting a note with an active candidate requires explicit discard confirmation
in the same user command. Cancellation fences the active generation and leaves a
prior applicable candidate intact. Claim, run and deletion races are serialized
by the core, not determined by UI timing.
If generation ends without a candidate and no previous candidate exists, release
its claim as well as its task reservation. A retained pending/stale candidate keeps
its claim until an explicit decision or successful replacement. Discarding while
regeneration is active requires wait/cancel first, preventing its late output from
recreating the discarded proposal. Deletion explicitly fences that run atomically.

## 6. Acceptance and discard transactions

Flush manual edits before acceptance. The command enumerates candidate IDs/versions,
current dependency bindings and the expected project/history revision. The core:

1. Resolves idempotency receipt and validates candidate/request/run identities.
2. Confirms successful complete outputs, active request versions and live claim
   ownership; checks exact target/context/source revisions and allowed scope.
3. Validates actual reconstructed diffs, insertion boundaries and canonical limits.
4. Rejects locked writes, active task reservations, stale/overlapping candidates
   and unauthorized structural effects using the shared mutation guard.
5. Materializes new payloads and commits body, fresh revisions, user decisions,
   claim release, handled states, comparison cleanup, one history entry, receipt
   and outbox events in one transaction.

Locked candidates can be inspected or discarded, but acceptance returns
`CONTENT_LOCKED` with affected IDs. Unlocking alone changes no content revision,
so a still-current proposal remains usable after explicit unlock. Context changes
can invalidate it independently. Direct manual changes after generation make a
candidate stale; never merge it over a newer paragraph automatically.

Accept-all uses the exact submitted set, not an open-ended query of all candidates.
If one is invalid, locked, stale, generating or overlapping, apply none and return
the conflict list. Do not silently skip items or add candidates that arrived later.
Success is one undo step across all affected paragraphs. Duplicate submission with
the same request ID returns its existing receipt; a changed payload reusing the
ID fails. Individual group acceptance follows the same rules.

Discard changes user decision/claim/comparison state, never body text or locks,
and is undoable. It can discard stale candidates without pretending their old
base is current. Marking an ordinary question/note handled is also undoable;
AI completion never performs that user decision on its own.

## 7. Lock enforcement and finalization

### 7.1 Actual mutation impact

Install the production S3 mutation policy behind the S1 seam. All mutation paths
must use it: manual edits/format changes, import replace/append, structural changes,
candidate acceptance, and history replay. API calls cannot bypass the same rules.

| Operation                             | Required lock/reservation check                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Edit text/marks/kind, split or merge  | All actually changed/deleted blocks                                                                                   |
| Delete/move a section                 | Heading and all moved/deleted descendants                                                                             |
| Change heading/list hierarchy         | Any existing block whose structural parentage/protected order changes                                                 |
| Insert new sibling or fill empty slot | Validate boundaries and any actual structural changes; unchanged locked neighbors do not forbid independent insertion |
| Replace manuscript                    | All replaced/deleted existing blocks; no implicit unlock                                                              |
| Undo/redo                             | Its computed affected business fields plus current restrictions, not the historical lock list alone                   |

Do not compare absolute array indexes and call every later paragraph modified.
Moving existing protected content or changing its parentage is different from
inserting an independent sibling. Compute effects in the core from S1 canonical
structure, including nested lists and derived sections.

### 7.2 Lock commands and temporary reservations

`LockBlocks` accepts explicit IDs/revisions; `LockAll` validates the entire current
document and computes its unlocked targets. Pending/stale candidates and active
revision-generation claims/reservations block new locks affecting their targets.
Already locked unchanged blocks need no relocking and remain locked when a new
read-only proposal exists. An all-already-locked request is an idempotent no-op.

Lock-all is one atomic user operation. If one new target is blocked, lock none;
show the conflict list and let the user handle it. Ordinary saved notes/questions,
including unanswered ones, do not block. Do not silently discard their content.
`UnlockBlocks` removes only user locks, leaves temporary reservations intact, and
is one history operation. Lock/unlock advances project/review state as needed,
not the protected body-content revision merely because approval changed.

Explicit Review retry captures committed composer/context identity before any
input flush and revalidates after every asynchronous flush. Resolving an older
receipt never sends newly typed instruction text or a newly selected scope; the
new draft remains available for a separate Send action.

Read-only question tasks never prevent body edits or locking. A revision task
reserves its input scope, including user-locked text, only until terminal/fenced
completion. Input reservation is not approval, and approval is not task ownership.
Releasing an expired/cancelled lease must not remove a user lock.

### 7.3 Derived finalization and baseline

Derive readiness exactly as in the workbench design: at least one nonempty body
block exists, and every persisted content block has a user lock matching current
content. Include headings/list items; exclude editor-only placeholders. An empty
or heading-only document cannot finalize. There is no writable `finalized` flag
and no extra confirmation action after locking.

On transition to all-locked, create/reuse an immutable exact-block manifest and
set the current approved baseline reference. Unlocking one block or inserting a
new unlocked block returns readiness to editing and clears that current reference.
Other locks stay intact. A candidate or comment arriving against an already
locked body does not change readiness. A stored historical baseline does not
approve different current text.
Back the bootstrap's nullable `approvedBaseline` sequence with a manifest record
for that approval transition, plus an opaque manifest ID. Review-only project
revision changes do not rewrite the approved body manifest. Migrate the provisional
storage/API mapping explicitly while keeping its current-baseline meaning clear.

For future media consumers, register exact input block/order/content references
and acquire the same task-use reservations. Actual upstream changes mark dependent
artifacts needing update; unrelated blocks remain valid. Unlocking alone does not
invalidate artifacts. Preserve their referenced old payloads after history pruning.
S3 verifies these contracts with a fake artifact and never creates audio/video jobs.

## 8. Project undo/redo and async state

Extend S1's single five-transition history with user-authored thread/messages,
handled/delete decisions, candidate accept/discard and user lock/unlock actions.
Creating/saving a comment is discrete; continuous editing of the same saved user
message may use S1 grouping. Acceptance/accept-all and lock-all each form one step.
No independent editor, review or lock history stack is introduced.

AI answers, immutable candidates, run/fence/reservation rows and result-arrival
timestamps remain outside business snapshots. Snapshot user decisions and the
artifact references they affect; never replace whole async state with an old
snapshot. Arrival alone creates no undo entry and clears no redo tail. Adding a
new user decision after undo branches the linear history under the usual rules.
When history changes body text, recompute current anchor projections and candidate
staleness from that accepted edit. Do not erase newer messages/results merely
because they were absent from the older content snapshot.

Replay computes its actual affected fields and revalidates current state, claims,
locks and task use. Undo of a user lock command may intentionally remove its own
lock as a user action. Undo of a content edit cannot remove an unrelated current
lock. Redo of locking must recheck pending candidates/reservations. If replay is
blocked, change nothing, keep cursor and do not skip to another entry.

Undo acceptance restores previous body and its pending decision/comparison if
applicable, with fresh content revision tokens. Rebind the immutable candidate to
those new revisions only if content hashes, request version, included dependencies
and scope all match; record a new validated binding, never decrement counters.
Otherwise restore it as stale. If another current candidate owns its required
claim, block replay atomically instead of deleting the newer artifact/decision.

Undo discard/handle can restore review visibility and evidence without an AI call.
Undoing thread creation removes that user thread through the same tombstone/fence
coordinator as explicit deletion: cancel its active request, release its claims,
hide unapplied proposals, and retain immutable results as evidence. This is part
of the inverse operation, not a new history entry or body change. Redo restores
user state and may rebind retained evidence only under the same validity/claim
checks; it cannot restart a cancelled task. Preserve the latest linked output for
thread/request IDs still referenced by history even if it arrived after the
original snapshot, so replay does not require another model call.
Undo thread deletion restores user state under fresh request/version identities;
old tasks stay terminal/fenced. Do not automatically resubmit the restored review.
Restoring a lock against restored content binds the fresh current revision after
validation; current finalization/baseline is derived again rather than replaying
an obsolete baseline pointer as authority.

Reopen preserves saved body, current review decisions/claims, user locks, latest
comparisons and the history cursor. Pruning beyond five steps cannot delete inputs
still referenced by current review, pending tasks, baseline/artifact manifests or
the remaining snapshots. Bound old candidate/answer alternatives to active thread
projections and required references; message history is not a body-version browser.

## 9. Commands, queries, events, and errors

Reuse the S1 command envelope, current revision preconditions, closed JSON Schema
unions, durable request receipts and S2 preflight/execution ports. Model selection
is never a project-level command parameter. These are planned application operations:

| Command                                 | Required payload / effect                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `CreateReviewThread`                    | Kind, validated anchor and initial user message; save only                                                             |
| `UpdateReviewMessage`, `AddReviewReply` | Current message/thread revision and text; advance affected request version when instruction changes                    |
| `AskReviewQuestion`                     | Saved request version, ready context preparation and expected anchor dependencies                                      |
| `GenerateReviewChange`                  | Request/version, mode/ranges or insertion slot and ready preparation; claim/reserve scope                              |
| `CancelReviewTask`, `RetryReviewTask`   | Current binding/request identity; fence or start a new explicit run with fresh context/config                          |
| `AcceptReviewChanges`                   | Explicit candidate IDs/versions and expected history/state; single/all use the same command                            |
| `DiscardReviewChanges`                  | Explicit candidate IDs/versions; release claims/clear comparisons, body unchanged                                      |
| `SetReviewHandled`                      | Current thread/request version and user status; pending candidate requires a separate explicit accept/discard decision |
| `DeleteReviewThread`                    | Current version and explicit discard flag if needed; fence task/applicability and tombstone                            |
| `LockBlocks`, `LockAll`, `UnlockBlocks` | Exact block/document revisions and target set; user approval operations only                                           |

Task start/cancellation and run status are execution operations, not extra history
entries. The associated saved comment edits are history entries. A candidate user
decision can neither apply twice nor consume a newer candidate sharing its thread.
All command handlers validate stage and actual affected scope, not just UI state.

Read review threads through `GET /v1/reviews` with cursor/filter and per-thread
message/candidate queries. Expose `GET /v1/manuscript/locks` for user-lock and
task-use summaries, and include derived readiness/current baseline in manuscript
queries. Reuse `POST /v1/manuscript/commands` and named desktop bridge operations.
Read-only queries never change handled/lock states implicitly.

Extend SSE with `review.changed`, `reviewTask.changed`, `candidate.changed`,
`locks.changed`, and `manuscript.readinessChanged`. Use monotonic project sequence,
safe IDs/revisions and originating request ID. Atomic body/decision/history updates
publish together after commit; clients deduplicate receipt/event races and resync
after expired cursors. Virtualize large review lists and update only affected editor
decorations instead of serializing every thread per keystroke.

| Error                                                        | Required response                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `STAGE_CONFLICT`, `ANCHOR_STALE`, `ANCHOR_INVALID`           | Preserve unsent text/current body and request valid current selection/stage        |
| `REVIEW_VERSION_CONFLICT`, `REVIEW_TASK_ACTIVE`              | Explain old instruction or conflicting run; no silent resubmit                     |
| `CANDIDATE_CLAIMED`, `CANDIDATE_OVERLAP`                     | Report claiming request/affected IDs, keep all current decisions intact            |
| `CANDIDATE_STALE`, `PATCH_OUT_OF_SCOPE`, `CANDIDATE_INVALID` | Keep body unchanged; inspect/discard/regenerate as appropriate                     |
| `CONTENT_LOCKED`, `TASK_USING_CONTENT`, `PENDING_CANDIDATE`  | Explain required unlock, task wait/cancel or candidate handling; never auto-unlock |
| `HISTORY_BLOCKED`, `HISTORY_CONFLICT`                        | Cursor/state unchanged; show actual current blocker                                |
| Shared AI safe failures                                      | Persistent task tip, settings/manual retry; no credentials/raw provider output     |

Map revision/stage/claim/lock conflicts to 409, malformed schema to 400, invalid
content to 422, and resource ceilings to 413. Long-running provider failures use
terminal task status. A `NO_CHANGE` result is an informational completion, not
silently treated as accepted wording or a failed generation requiring another call.

## 10. Storage, recovery, and lifecycle races

Add script/review-owned tables for threads, user messages, anchors, request versions,
review task bindings, candidate artifacts/claims, user decisions, comparison
projections, user locks and baseline manifests. Generic run/attempt/result rows
remain shared AI-owned. Tables use foreign keys and unique claim/application keys;
index threads by manuscript/target/status and candidates by request/claimed block.

Store large quoted/diff/context payloads as immutable references. Complete verified
objects before referencing them. Commit acceptance, lock/readiness changes, history,
receipts and events with the same short SQLite transaction. No provider call,
large diff computation or UI wait runs inside it. Reserve `007_review.sql` for
step 6 after S2 schema version 6, then append `008` for step 7's finalization/lock
storage under the shared AI migration ledger;
migrate existing drafts/history without inventing locks, reviews or approved baselines.

Persist generic results first, then apply script-local answer/candidate projections
idempotently under request/fence checks. Recover durable unapplied results locally,
never by another remote call. Cancellation/deletion fences both generic execution
and script-local applicability. If application committed first, return that state;
if cancellation/deletion won, a late reply cannot recreate a thread/candidate.

On restart reconcile requests, reservations and claims. Release expired task use
after fencing its attempt; retain valid pending candidates and their claims.
Distinguish normal original-database restart from restored/unknown-origin copies
using shared AI recovery mode; copied queued calls also require explicit retry.
Do not release user locks or discard pending proposals as crash cleanup. An
interrupted replacement run keeps a previously valid candidate where dependencies
still match. Expired/ambiguous runs wait for explicit retry. Event reconnection,
duplicate receipts and user undo never restart model calls.

Reference-safe garbage collection keeps current thread evidence, active/latest
candidate projections, retained history and approved/downstream manifests. An old
artifact can remain referenced internally while its comparison is absent from the
normal UI. Deleting a current source does not erase evidence already pinned by a
review task; it can make applicability stale under the declared dependency policy.
Compact superseded unreferenced payloads, not the latest active evidence or user text.

## 11. Development tasks and dependencies

Execution step 6 implements the review portion of T01–T08; its root gate is recorded
in [step 6 evidence](../validation/step-06.md). Step 7 implements T09–T15 core/browser
behavior; target-host/provider and performance acceptance remain open in
[step 7](../validation/step-07.md) and [step 8 evidence](../validation/step-08.md). `Tnn`, `ACnn` and `DEPnn` mean `S3-Tnn`, `S3-ACnn` and
`S3-DEPnn`. Keep tasks/tests in this one stage document. Implement with controlled
fake tasks and barriers before deliberately initiated live-provider checks.

| Task   | Concrete deliverable                                                                                       | Depends on                | Acceptance                   |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------- |
| S3-T01 | Define review/anchor/candidate/lock schemas, states, limits and generated contracts                        | DEP01, DEP02              | AC01, AC02, AC06             |
| S3-T02 | Add migration/repositories, unique claims, user decisions and immutable evidence/baseline references       | T01, DEP01                | AC03, AC23, AC24, AC26       |
| S3-T03 | Implement core Unicode anchor validation and canonical edit mapping with changed/orphan projections        | T01, T02                  | AC02, AC03, AC04             |
| S3-T04 | Build selection toolbar, adjacent cards/list, save/reply/handled/delete interactions and localization      | T01, T03                  | AC01, AC04, AC05, AC25       |
| S3-T05 | Add script review prompts/context/output interpreters and question-task integration                        | T01, T02, DEP02, DEP03    | AC05, AC06, AC07, AC22       |
| S3-T06 | Implement scoped revision/fill-section generation, reservations, claims and regeneration lifecycle         | T03, T05                  | AC08, AC09, AC10, AC11       |
| S3-T07 | Implement latest comparison projections and individual accept/discard commands with stale/scope validation | T02, T03, T06             | AC10, AC11, AC12, AC13       |
| S3-T08 | Implement explicit-set atomic accept-all, idempotency and conflict reporting                               | T07                       | AC14, AC15                   |
| S3-T09 | Install production mutation guard for edits/format/structure/import/history and task-use enforcement       | T01, T02, T06, DEP01      | AC16, AC17, AC19             |
| S3-T10 | Add user lock/unlock/lock-all use cases, far-right controls and candidate blockers                         | T07, T09                  | AC16, AC18, AC19, AC25       |
| S3-T11 | Derive finalization/current baseline and fake downstream dependency retention/invalidation                 | T02, T09, T10             | AC18, AC20, AC26             |
| S3-T12 | Extend five-step history/rebinding for review decisions and locks; preserve async state and claims         | T07, T08, T10, T11        | AC15, AC21, AC22, AC23       |
| S3-T13 | Complete restart/cancel/delete/result races and event resync without paid replay                           | T05, T06, T07, T12, DEP03 | AC07, AC22, AC23, AC24, AC27 |
| S3-T14 | Validate review-list/decorations performance, keyboard/locale/platform interaction                         | T04, T08, T10, T13        | AC25, AC28                   |
| S3-T15 | Run complete edit-review-accept-lock workflow, fault/API suites and explicit provider integration smoke    | T11, T12, T13, T14        | AC01–AC28                    |

Checkpoints: T01–T04 deliver anchored review; T05–T08 deliver answers/candidates and
decisions; T09–T11 enforce locks/finalization; T12–T15 verify history, recovery and
interaction evidence. Do not postpone mutation-policy tests until after a lock UI
appears to work; the actual guard is the protection boundary.

## 12. Acceptance cases and test mapping

Parent IDs refer to the workbench implementation plan; `partial` mappings exercise
the specified integration without claiming later media/export functionality.

| ID      | Given / when                                                                    | Required observable result                                                                                                                              | Level / parent mapping                    |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| S3-AC01 | Outline versus draft; select text or a whole block                              | Only draft exposes question/note cards and locks; no extra comment types or project model selector                                                      | Browser; SW-01                            |
| S3-AC02 | Chinese/emoji/combining text and cross-block selection                          | Exact UTF-16/grapheme-safe anchor checked against saved canonical revisions; stale selection preserves unsent comment                                   | Domain/adapter; SW-29                     |
| S3-AC03 | Edit outside/inside anchor, split/merge/move/delete, including repeated text    | Deterministic mapping or explicit changed/orphan state; latest prior/current comparison only; no guessed reassignment                                   | Domain/storage; SW-11                     |
| S3-AC04 | Handle changed-source comment or accept/discard comparison                      | Active marks clean up, retained thread evidence accessible; manual edits need no extra approval                                                         | Browser; SW-08, SW-11                     |
| S3-AC05 | Save comment, explicitly ask AI, receive answer                                 | Save alone makes zero calls; explicit ask replies in the thread without body mutation or automatic handled state                                        | Counted fake/browser; SW-06               |
| S3-AC06 | Model returns patch/unlock/handled instructions to a question                   | Reject unsupported output; provider cannot mutate body/approval/user decisions                                                                          | Contract/domain; AI-12                    |
| S3-AC07 | Edit/delete question or retry while old answer arrives                          | Exact request/version/fence enforced; late output cannot replace current answer or resurrect thread                                                     | Barrier integration; AI-13                |
| S3-AC08 | Generate a revision on locked or unlocked content                               | Proposal/answer leaves body and locks unchanged; reserve inputs only during generation and release only task use                                        | Integration/browser; SW-07, SW-13         |
| S3-AC09 | Model replaces outside selection, changes structure/IDs, or fills wrong section | Actual patch/schema/boundary validation rejects all unauthorized changes; no partial body application                                                   | Domain/contract; AI-12                    |
| S3-AC10 | Two notes target one block; regenerate same request                             | One claim, no overlapping candidate; successful replacement leaves one latest comparison                                                                | Domain/barrier; SW-10                     |
| S3-AC11 | Regeneration fails after unchanged or edited instruction                        | Preserve prior candidate only when still applicable; otherwise stale, never silently revalidated                                                        | Fake integration; SW-10                   |
| S3-AC12 | Accept current candidate after manual target/context change                     | Reject stale candidate and keep body; discard remains possible; no automatic merge                                                                      | Domain/integration; SW-07, SW-08          |
| S3-AC13 | Accept locked candidate, explicitly unlock then accept                          | First attempt fails; unlock alone keeps body revision/candidate validity; valid acceptance clears comparison, handles note and does not relock          | API/browser; SW-08, SW-13                 |
| S3-AC14 | Accept-all includes locked/stale/overlapping/newly arriving candidate           | Exact submitted set, all-or-nothing, explicit conflicts; later arrivals are not silently included                                                       | Storage/API; SW-09                        |
| S3-AC15 | Duplicate individual/all acceptance, then undo/redo batch                       | One body commit/receipt/history step; no double application; replay creates no provider request                                                         | Integration/history; SW-09, SW-26 partial |
| S3-AC16 | Direct API/manual/import/format/section operations touch locked content         | Every path enforces actual lock impact including descendants; independent new siblings do not mutate existing locks                                     | Domain/API; SW-12, SW-16                  |
| S3-AC17 | Task uses target while editing/undoing/importing there or elsewhere             | Affected mutation blocked without partial write; unrelated work remains possible                                                                        | Domain/barrier; SW-20                     |
| S3-AC18 | Lock all with pending candidate/open question; all locked; unlock one           | Candidate blocks affected new locks, ordinary comments do not; atomic lock-all; readiness derives from body locks                                       | API/browser; SW-14, SW-15                 |
| S3-AC19 | Locked candidate arrives, user unlocks during task use, or task expires         | Proposal arrival preserves existing approval; unlock cannot release task use; cleanup cannot remove user lock                                           | Barrier/storage; SW-13, SW-14             |
| S3-AC20 | Empty/heading-only manuscript or newly inserted unlocked block                  | No false finalization; existing locks preserved; current baseline cleared/derived appropriately                                                         | Domain/storage; SW-15                     |
| S3-AC21 | Undo lock/content/discard/thread creation under current locks/claims/tasks      | Same guards, no bypass/cursor skip; thread removal fences its run without body change; restore evidence only through validated rebinding or stale state | Domain/history; SW-12, SW-22              |
| S3-AC22 | Answer/candidate arrives during unrelated undo or redo tail                     | Async evidence survives; no history entry/tail clearing from arrival; no job resurrection or paid replay                                                | Barrier/history; SW-21, AI-04             |
| S3-AC23 | Reopen at middle history cursor with pending reviews/locks; prune history       | Recover body/decisions/claims/latest comparison/cursor; keep referenced originals and fresh revision tokens                                             | Restart/storage; SW-19, SW-22             |
| S3-AC24 | Crash between output persistence and application; cancel/delete races result    | Apply saved local result at most once; fenced late output cannot recreate state; interrupted call awaits user retry                                     | Fault/restart; AI-06, AI-07, AI-08        |
| S3-AC25 | Keyboard/locale change, narrow window, long paragraph with far-right locks      | Accessible controls, correct block alignment, review panel retains selection; UI locale independent of manuscript                                       | Browser/platform                          |
| S3-AC26 | Fake downstream artifact consumes locked text; unlock/edit/prune                | Unlock alone preserves artifact validity; actual dependent changes mark outdated; referenced payloads survive pruning                                   | Storage/domain; SW-30                     |
| S3-AC27 | SSE event before receipt, duplicate result or expired event cursor              | Deduplicated projections and snapshot resync; no extra model call or repeated user decision                                                             | API/browser; AI-17                        |
| S3-AC28 | Many comments/candidates on 500 KB/2 MB manuscript                              | Bounded/paged reads and measured decoration/typing/save/undo costs, without all-thread per-keystroke serialization                                      | Performance                               |

## 13. Completion evidence and S4 handoff

Use existing `pnpm check`, `pnpm build`, `pnpm test:integration`, and
`pnpm test:e2e` as relevant implementation lands. Add meaningful state, lock,
acceptance, Unicode and fault-injection cases. Use deterministic barriers rather
than sleeps for concurrent result/cancel/delete/undo tests. No paid provider call
belongs in ordinary CI; explicitly initiated smoke checks report model/endpoint
and actual validated capabilities without exposing credentials.

Record the task/acceptance-to-test mapping, migration/restart evidence, full
question-note-accept-lock workflow, direct-API lock enforcement, five-step history,
and fake downstream invalidation/retention. Measure review decoration/scroll and
typing/undo p50/p95 using the parent plan's representative document/comment sizes.
State actual hardware/platform and skipped checks; do not infer Windows/macOS
interaction readiness from a Linux browser run.

S4 receives one canonical current manuscript, derived readiness/baseline, review
metadata stored outside spoken text, pending-candidate exclusion rules and durable
history/locks. Export must read a consistent current-body snapshot and never
include unaccepted proposals or review UI marks as manuscript content.

## 14. Execution steps 6–7 implementation interface

Step 6 implements the review portion of T01–T08; independent root review/gate is
recorded separately in [step 6 evidence](../validation/step-06.md). Step 7 adds
production locks/finalization, retained approved baselines and validated decision
replay/rebinding; see [step 7 evidence](../validation/step-07.md). Remaining
target-host/provider and performance cases are tracked in the
[acceptance matrix](../validation/acceptance-matrix.md).

`SaveReview`, `SetReviewHandled`, `DeleteReviewThread`, `StartReviewTask`,
`CancelReviewTask`, `DiscardReviewCandidate` and exact-set
`AcceptReviewCandidates` use the existing manuscript command/receipt boundary.
Named read routes provide paged `/v1/reviews`,
`/v1/reviews/{id}/messages`, `/v1/reviews/candidates/{id}?offset=...` and per-block
`/v1/reviews/comparisons/{id}`. Desktop exposes matching named operations.
Optional candidate conflict details carry submitted IDs/versions, safe reasons and
scope. Schema version 1 revision outputs include a bounded explanation outside the
body. Both output modes reject unknown fields and arbitrary editor commands.

Business snapshot v4 stores compact review user state, current decisions and user
message membership; asynchronous answers/candidates/tasks remain outside it.
Large quotes use immutable `quoteHash` references above 1 KiB, hydrated by bounded
queries/preparation. Restored request tokens associate with their original user
message instead of relabeling an old AI answer. A separate attributed current-answer
projection can survive a later failed task. Engineering limits additionally cap
retained messages at 200/thread and explicitly included conversation at 20 messages/
64 KiB, rejecting overflow. Detail reads are paged/bounded; preview truncation is
explicit and never affects acceptance payloads.

Full-run edit mapping deliberately flags unproven repeated-text/multi-span cases
instead of guessing identity. Basic user decisions participate in the existing
five-step history; complete production lock-aware replay and candidate rebinding
are step 7 work. See the evidence report for exact implemented cases and limits.

## 15. Execution step 7 implementation interface

The implementation consolidates lock/unlock/lock-all into `SetUserLocks`, with
explicit `blockIds`, `locked` and `all` fields and the existing expected working
revision. That revision freezes the current block tokens; lock-all computes only
new targets. `GET /v1/manuscript/finalization` and the named desktop read expose
current exact locks, temporary use, derived readiness and the opaque baseline.
The closed event contract includes `locks.changed` and
`manuscript.readinessChanged`; event-page decoding and projection resync are tested.

Migration 008 keeps compatible version-4 business roots with optional lock IDs.
Validated candidate bindings and exact history-entry evidence remain separate from
immutable AI artifacts. Retained-entry identities also bound historical baseline
roots, while current approval/downstream references preserve required payloads.
Reopen verifies the approval graph. The Rust-only future-consumer fixture tests
scoped fences and dependency retention without adding a media workflow. See
[step 7 validation](../validation/step-07.md) for the complete replay/race mapping,
measured performance misses and native/provider checks that remain unrun.

## 16. Auxiliary Review and manuscript lock strip

The [editor-first workspace](../design/editor-workspace.md) places Review inside
the right auxiliary pane and the lock strip at the manuscript's right edge, before
that pane. S3-AC25 now checks this geometry, including nested blocks and narrow
windows. Hidden pane tabs preserve unsent review buffers. Selection actions live
in a portal outside the hidden tab, preserve the captured range, and open Review
from Structure, Planning or Sources. Review and lock actions remain Draft-only.
The same core approval, task reservation, candidate and history guards apply.
