# Script workbench technical design, v0.1

Status: implementation specification for review; business functionality is not
implemented. Product decisions come from the completed manuscript interview.
Engineering defaults and performance budgets remain subject to implementation
validation. See the [design index](README.md) for precedence and scope.

## 1. Goal and boundaries

Deliver a local, single-user workbench with one primary manuscript per project:

```text
Topic and sources -> editable outline -> confirm and generate complete draft
                 -> manual editing / questions / AI revision notes
                 -> compare and accept -> lock paragraphs -> finalized manuscript
```

An existing manuscript can be imported or pasted directly into the draft workspace,
with every block initially unlocked. Outline confirmation gates AI generation of
a new manuscript, not the user's ability to bring an existing draft.

Copy and Markdown, TXT, and DOCX export work in both draft and finalized states.
They export the current manuscript, including saved manual edits, and exclude
unaccepted AI candidates. Source material, review comments, comparison marks, and
lock controls are not spoken manuscript content and are not exported as body text.

Audio synthesis, storyboards, generated video code execution, rendering workflows,
collaboration, accounts, cloud tenancy, and a visible version browser are outside
this delivery. Existing Remotion integration remains a bootstrap sample. Preserve
extension points for downstream artifacts without implementing those products now.

## 2. Confirmed product contract

| Area                  | Required behavior                                                                                                   | Interview                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Starting point        | Accept a topic and scattered references, or an existing draft                                                       | Q1                          |
| Sources               | Links and uploaded/local TXT, Markdown, DOCX, text-extractable PDF; no generic website crawler                      | Q2, Q4–Q5                   |
| Image understanding   | Depends on the selected model's actual multimodal capability                                                        | Q5                          |
| AI setup              | User-supplied provider credentials; global text/audio/video categories, no project model settings                   | Q3, Q6, Q9                  |
| Generation            | Confirm the outline, then generate one complete initial draft                                                       | Q7, Q26, Q29                |
| Creativity            | AI may develop the material; distinguish generated claims from verified source evidence                             | Q8                          |
| Task configuration    | Fix configuration when a task starts; changes affect later tasks                                                    | Q10                         |
| Failures              | Show the problem and let the user change settings/retry; no automatic model switching                               | Q11                         |
| Locks                 | User-controlled paragraph locks and lock-all; tasks may temporarily reserve input content                           | Q12–Q13                     |
| History               | Project-scoped, persistent, at most five undo/redo transitions on one linear history                                | Q14–Q18                     |
| Finalization          | All manuscript blocks locked means finalized; lock-all is a batch operation                                         | Q19                         |
| Review UI             | Selection highlighting, adjacent review content, lock column at the far right                                       | Q20                         |
| Review types          | Question: AI answers. Revision note: AI proposes a body modification                                                | Q21                         |
| Locked review         | Comments remain available; body changes require unlock                                                              | Q22                         |
| Comparisons           | Show only the latest before/after comparison; indicate changed source text; acceptance clears the active comparison | Q23                         |
| Acceptance            | Individual or accept-all; rejecting a candidate keeps current body; acceptance never auto-locks                     | Q24–Q25                     |
| Later structure edits | Derive the outline/navigation from the draft's headings; no second independently edited outline                     | Q27, delegated design       |
| Delivery              | Copy and Markdown/TXT/DOCX export, including work in progress                                                       | Q28                         |
| Outline UI            | Direct structure editing and one overall AI adjustment input; no paragraph review/locks                             | Q29 and stage clarification |
| Manual editing        | Directly update and autosave the body; use project undo, not AI acceptance                                          | Q30                         |
| Lock precondition     | Resolve pending candidates affecting the target before locking; ordinary comments do not block                      | Q31                         |

## 3. User interface and state transitions

### 3.1 Outline workspace

Show the topic/brief, project sources, outline tree, and one overall AI instruction
input. Allow editing headings, key points, and order directly. AI outline adjustment
produces a replacement planning outline; apply a valid result only if its captured
outline revision is still current. Treat the applied adjustment as one undoable
operation. It is planning content, not a paragraph review candidate, and creates
no inline comments, comparison controls, or locks. If the outline changed while
AI was running, leave it intact and show a stale-result tip with manual retry.

The primary action is **Confirm outline and generate draft**. Flush outstanding
edits, persist the confirmed outline snapshot and brief/source references, then
start one logical initial-draft task. Keep the outline visible while generation
runs. A stream may show a labeled preview, but it does not write partial paragraphs
into the manuscript. On complete, valid output, create the draft atomically and
enter the draft workspace. The first implementation uses one completion; output
truncation is a failure, not a successful partial manuscript. Automatic continuation
or multi-call chapter generation is not required for this release.

Failure/cancellation retains the confirmed outline and leaves the user in the
outline workspace. Editing that outline invalidates its confirmation for the next
generation. Starting generation reserves the outline transition until terminal
completion or cancellation. Retry is explicit and never creates duplicate drafts.
Creating the initial draft is one user-initiated history operation, including the
stage transition. Undo may restore the preceding outline workspace when normal
history/lock guards permit; redo restores the stored draft without another AI call.

### 3.2 Draft workspace

Use a structure/source navigation area, the document editor, adjacent review
cards, and a dedicated lock column at the document's far right. Align each lock
control with its content block; put lock-all at the top. Do not mix locks into
the selection toolbar. On narrow windows, review cards can open in a side panel
while preserving the selected text and block identity.

Selecting text exposes only **Question** and **Revision note** in v0.1. A question
creates an answer in its thread. A revision note creates a candidate modification
for the selected range or paragraph. Submitting a note explicitly requests AI
work; simply saving a comment or typing into its input does not make a paid call.
For locked paragraphs, allow notes, answers and read-only AI revision proposals.
Generating a candidate does not alter the body; accepting it requires the user to
unlock the affected paragraphs first. Review activity never unlocks content.

Display a candidate's before/after comparison adjacent to the affected content,
with **Accept change** and **Discard change**. Allow **Accept all changes** for the
currently displayed candidate set. Accepting clears the active comparison and
marks the associated revision request handled; it does not lock the paragraph.
Discarding keeps the current body and records the review decision. Questions can
be marked handled by the user; an AI reply alone does not resolve a request.

Use stable localization keys; examples of required labels:

| Key                    | English                | Simplified Chinese |
| ---------------------- | ---------------------- | ------------------ |
| `review.question`      | Question               | 提问               |
| `review.revisionNote`  | Revision note          | 备注               |
| `review.acceptChange`  | Accept change          | 采纳修改           |
| `review.acceptAll`     | Accept all changes     | 全部采纳           |
| `review.discardChange` | Discard change         | 放弃修改           |
| `review.sourceChanged` | Original text changed  | 原文已变更         |
| `script.lockAll`       | Lock entire manuscript | 锁定全文           |
| `script.finalized`     | Finalized              | 已定稿             |

UI language and manuscript language are independent. AI uses the manuscript's
language/brief, not the application's display locale.

### 3.3 Later structure changes

Once a draft exists, derive its navigation tree from heading blocks. The initial
outline remains an input snapshot for provenance; it is no longer a competing
editable document. Changing a heading or adding/reordering a section does not
automatically regenerate existing prose. An added section may be filled manually
or through an explicit scoped generation request whose output is reviewed.

Compute the full affected block set for a structural edit. Moving, deleting,
splitting, merging, or reparenting locked blocks requires unlocking the affected
blocks first. Inserting a sibling paragraph does not mutate its locked neighbors;
the new unlocked block makes the manuscript no longer finalized. Do not interpret
a parent-section operation as permission to bypass child locks.

### 3.4 Derived state

Persist `workspaceStage = outline | draft`. In the draft stage, derive readiness:

```text
finalized = at least one nonempty body block exists
            AND every persisted manuscript content block has a user lock
editing   = otherwise
```

Headings and list items are content blocks with the same protection as prose.
Editor-only trailing placeholders are not persisted blocks. A document containing
only a heading or empty placeholders is not a finalized manuscript.

Lock-all runs the same validation as individual locking in one transaction. There
is no independent "confirm finalization" button or writable finalized boolean.
Unlocking one block returns readiness to editing and leaves other locks intact.
Comments, answers, and source metadata do not alone change body readiness.
An AI candidate proposed against an already locked paragraph also leaves the
current body's lock/readiness intact. The pending-candidate rule governs a new
lock action; it does not retrospectively unlock content when a proposal arrives.

## 4. Architecture and technology

Keep the existing React/TypeScript/Vite UI, Electron shell, Rust/Tokio/Axum core,
SQLite persistence, and Node worker boundary. Introduce Tiptap/ProseMirror for
structured editing. Its selection, transaction mapping, and decorations are useful;
business review, persistence, and lock enforcement remain application features.

| Location                                    | Planned responsibility                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/editor-ui/src/workspaces/script/` | Outline/draft views, selection UI, comparison cards, lock column                         |
| `packages/editor-ui/src/editor/`            | Tiptap schema, canonical document conversion, selections and history routing             |
| `packages/platform-client/`                 | Typed commands/events and browser/desktop platform operations                            |
| `packages/contracts/schema/`                | Versioned JSON Schema protocol definitions; generated Rust/TS types                      |
| `crates/domain/src/script/`                 | Block identity, revisions, review state, mutation/lock invariants                        |
| `crates/application/src/script/`            | Editing, review acceptance, context composition, export and history use cases            |
| `crates/application/src/ai/`                | Generic execution/configuration ports; no manuscript-specific rules                      |
| `crates/infrastructure/`                    | Project repositories, objects, migrations, parser/worker/credential adapters             |
| `workers/agent/`                            | Generic AI execution host; uses the proposed shared AI runtime                           |
| `workers/document/`                         | Proposed bounded import/extraction/export utility worker, with no AI/provider dependency |

These are planned paths, not packages implemented by this documentation change.
Avoid creating additional services or a second business database. See the
[shared AI design](shared-ai-v0.1.md) for dependency restrictions.

The canonical document is a versioned, application-owned block model, not raw
HTML or arbitrary Tiptap JSON. Start with headings, paragraphs, list items, text,
basic emphasis, and links. Map this model to/from the editor in one adapter. The
Rust core validates supported nodes, nesting, marks, IDs, and size limits. Do not
let different clients redefine block identity or smuggle unsupported node types.

Proposed document libraries are `mammoth` for DOCX import, `pdfjs-dist` for PDF
extraction, a Markdown AST parser such as `remark-parse`, and `docx` for DOCX export.
Validate maintained versions, licenses, Node compatibility, fixtures, and bundle
cost before pinning them. No new dependency is installed by this design.

## 5. Domain models and persistence

### 5.1 Identity and revisions

Use stable opaque IDs for manuscripts, blocks, sources, threads, and candidates.
Maintain a monotonic project mutation sequence and monotonic per-object revisions.
An edit, undo, or redo creates a new revision token; it never resets a counter to
an older value. A content hash identifies immutable payloads independently of the
sequence. Internal revisions support conflict checks and downstream provenance;
they do not expose a version-management workflow to the user.

| Entity             | Principal fields and ownership                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `Manuscript`       | ID, stage, document schema version, ordered block IDs, mutation sequence                              |
| `Brief`            | Topic, manuscript language, optional audience/style/length constraints                                |
| `Outline`          | Stable node IDs, heading/key points/order, revision, confirmed snapshot reference                     |
| `Block`            | ID, kind, parent/order, current revision, immutable content reference                                 |
| `UserLock`         | Block ID, locked content revision, user action ID, timestamp                                          |
| `TaskLease`        | Run ID/attempt, affected IDs, fence token, expiry; separate from user locks                           |
| `ReviewThread`     | Kind, target ID/range, quote, anchor revision, request version, handled state                         |
| `ReviewMessage`    | Author kind, text, input snapshot reference; answers do not mutate body                               |
| `Candidate`        | ID, request/run binding, expected base revisions, allowed scope, replacement payloads, decision state |
| `ReviewComparison` | One active before/after pair per affected block; source-change indicator                              |
| `Source`           | Kind, source revision, local object or URL metadata, extraction/evidence status                       |
| `HistoryEntry`     | Operation ID, label, before/after business snapshot references, touched IDs, grouping key             |
| `HistoryCursor`    | Project ID, position in a linear sequence of at most five entries                                     |

Treat multi-block AI output as a candidate group. It is accepted/rejected atomically
unless the domain can explicitly split it into independent groups with valid
scopes. Do not accept arbitrary individual tokens of a patch in v0.1.

### 5.2 Storage layout

Retain one core-owned `project.sqlite`, immutable `objects/`, temporary `staging/`,
rebuildable `cache/`, and `exports/` in each project directory. Suggested logical
tables are `manuscripts`, `outline_nodes`, `blocks`, `content_revisions`,
`user_locks`, `review_threads`, `review_messages`, `candidates`, `review_decisions`,
`sources`, `source_extractions`, `history_entries`, `history_cursor`,
`command_receipts`, and `project_events`. Generic `ai_runs`, task inputs and leases
are described in the shared AI specification. Use foreign keys and explicit
ownership; UI and workers never open the project database directly.

Index blocks by document/parent/order, threads by target/status, candidates by
target/decision, and events by sequence. Store large extracted text and model
artifacts as immutable objects referenced by hashes. Keep comments and block
metadata queryable in SQLite; do not load complete source files to render a page.

Write and verify an immutable object before committing its database reference.
Commit body changes, lock/review updates, history cursor, idempotency receipt and
outbox event in one short SQLite transaction. Network calls, parsing, exports,
and AI generation never run inside that transaction. Garbage collection removes
unreferenced objects after reconciliation; a failed transaction may leave an
unreferenced staged object, never a live reference to an incomplete file.

The bootstrap's `working_revision` and nullable `approved_baseline` are provisional.
Migrate working revision to the project mutation sequence. When all blocks lock,
register a manuscript manifest of exact block revisions; expose it as the current
approved baseline. Unlocking clears current readiness/baseline but does not delete
manifests still referenced by an artifact. This is a derived transition, not a new
manual approval action. A historical baseline alone never makes a changed draft
appear finalized.

## 6. Anchors, comparisons, and candidate validation

Anchor a selection using block ID, content revision, range, and the selected quote.
Define text offsets as UTF-16 offsets within the canonical block text, matching
JavaScript. They are not UTF-8 byte offsets or global ProseMirror positions. Rust
must validate conversion and reject surrogate/grapheme-splitting boundaries; keep
Chinese, combining characters, and emoji fixtures. Cross-block selections carry
one range per block. An absent selection anchors a note to its whole paragraph.

Map anchors through editor transactions while their original content remains
identifiable. If the referenced text is replaced or deleted, preserve the last
quoted text and latest comparison, mark `source_changed`, and retain a visible
orphaned-thread entry when its block no longer exists. Do not silently attach the
comment to similar text elsewhere. Manual edits need no extra acceptance action;
only the affected review evidence is marked changed.

Only one active candidate group may claim a given block. A new generation for the
same review request explicitly replaces its prior candidate after successful
validation; a failed regeneration leaves the prior candidate intact. Disallow a
second overlapping review request's candidate until the first is handled. Keep
only the newest candidate comparison against its captured current-body baseline,
not a chain of earlier AI alternatives. A previous unaccepted candidate is not
silently treated as current body. After an accepted edit, the next modification
compares against that newly accepted body. Prune superseded comparison payloads
when no undo/task/provenance reference needs them.

Before accepting any candidate, the core validates:

1. Candidate/run identity, terminal success, active attempt, request version, and
   exact expected input revisions for the target content.
2. The parsed actual patch against allowed block IDs, fields, and selected ranges.
3. Lock and task-lease impact, including structural descendants.
4. Canonical document schema, all references, and size limits.
5. Overlap with the rest of an accept-all batch and the submitted candidate set.

Unrelated project edits should not stale a candidate whose explicit dependencies
are unchanged. Changing its target, review instruction, or a context dependency
invalidates it. Record context dependencies, including referenced source revisions,
instead of checking only a global counter. A stale candidate remains inspectable
but cannot overwrite current text. Offer explicit regeneration or discard.

Accept-all is one all-or-nothing command over explicitly enumerated candidate IDs
and revisions. If one is stale, locked, or overlapping, return a conflict list and
apply none. Do not silently skip items or include candidates that arrived later.
Successful acceptance is one undo step, even across many paragraphs. A second
submission with the same request ID returns the original receipt.

## 7. Lock and task rules

All mutation paths use the same domain guard: direct edit, structure change,
candidate acceptance, import replacement, undo, and redo. Disabling editor controls
is helpful feedback, not the enforcement boundary.

- A user lock protects content and structural operations affecting that block.
- A task lease temporarily reserves the scope of a generation/modification task.
  Read-only question tasks use immutable snapshots and need not lock the body.
- Requesting a revision is a read/proposal operation and may target user-locked
  text. Reserve its input scope during generation without clearing existing locks;
  the actual body mutation guard runs when the user accepts the candidate.
- Generation must finish/fail/cancel before edits to its reserved scope continue.
  Other unlocked paragraphs remain editable.
- A terminal task releases only its own lease, never a user approval lock.
- Lock/lock-all checks for pending candidates and active mutation leases. Ask the
  user to accept/discard the affected candidates or wait/cancel the task first.
- Comments and resolved/unresolved questions alone do not block locking. Adding
  a comment to locked text does not unlock it or change its content revision.

For future audio/video, the executor will acquire the same source-use lease on
consumed paragraphs. Once generation finishes, a user can unlock and edit them;
mark only artifacts depending on changed content/structure as needing an update.
Unlocking without changing text does not itself invalidate an artifact. Preserve
the old artifact and exact input references. Undo history pruning must not delete
those source revisions. These are extension contracts, not media jobs to implement
in the manuscript release.

## 8. Bounded persistent undo and redo

### 8.1 Semantics

One project owns one linear sequence of at most five undoable operations and one
cursor. Five undo actions return to the oldest retained state; five redo actions
return to the previous endpoint if no new edit occurred. They are not two independent
five-entry histories. After undo, a new undoable project mutation discards the redo
tail. Navigation, selection, autosave ticks, task progress, and AI response arrival
do not create entries or clear redo. Application-wide AI settings are outside the
project history.

Include committed body/outline edits, source membership and brief changes,
user-authored comment edits/status changes, acceptance/discard, and lock/unlock
commands, including initial draft creation and its workspace-stage transition.
Do not replay network calls, rerun parsers, resend prompts, or regenerate
exports during undo/redo. Generic execution rows, leases, provider errors, AI
answers, and candidate payloads are immutable/system state outside editor snapshots.
User review decisions reference those artifacts and are undoable business state.

Use one project history router for committed operations. Disable a competing
ProseMirror document history so keyboard undo and toolbar undo agree. Unsaved text
inside a dialog/comment input may keep ordinary local input undo until submission;
it has not yet become a project operation. Flush an active document edit group
before invoking project undo or another project command.

### 8.2 Snapshot implementation

Start with bounded snapshots of the recoverable business state plus each entry's
affected-entity set. Adjacent operations share snapshot references, giving at most
six retained business states. Attachments, extracted text, task results, and media
remain references rather than copied bytes. Continuous typing in the same block
groups into one operation; close a group on focus change, a different command,
undo/redo, or an initial 750 ms idle threshold. While typing continues, update the
same group's latest after-state instead of creating autosave history entries.

Undo computes the selected entry's inverse only for its affected business fields;
it does not replace the whole live database with an old snapshot. Validate current
field state, current locks, leases, and referenced objects before committing.
This prevents a late AI answer or unrelated system event from disappearing when
an older user operation is undone. Never restore task leases or running jobs from
a snapshot. Redo applies the stored business change under the same guards.

Undoing a lock command may intentionally unlock its own targets as a user action.
Undoing a content edit cannot bypass a lock or active task lease. A blocked action
does not move the cursor or skip to another entry. Restoring earlier content still
increments monotonic revisions. A restored review candidate must be revalidated:
if its dependency hashes and request are identical, the core may issue a new
validated binding to the restored revisions without an AI call; otherwise mark
it stale. Old input tokens must never become valid merely by decrementing a counter.

Persist business state, history entries/group state, cursor and command receipt in
one transaction. On reopen, close an unfinished typing group at the last committed
after-state. Preserve redo position. Prune history beyond five transitions and
garbage-collect only objects not referenced by current state, retained snapshots,
active review/task inputs, or downstream manifests. A compact operation journal
may aid diagnostics, but is not an unbounded content archive.

### 8.3 Performance approach

Render typing immediately in the editor. The
[save-preferences follow-up](editor-save-and-ai-feedback.md) replaces the initial
300 ms/two-second schedule and field-blur flush with application preferences:
after 5/10/30 seconds (default 10, maximum dirty interval 60 seconds), application
window/tab change, or off. Local idle/selection/blur history boundaries do not
force network delivery. Manual save, generation, lock, export, undo and controlled
close retain required settlement. Show saving/saved/error state accurately. Acknowledged
edits survive restart; a crash can lose an unacknowledged local input buffer. Do not
claim that each keystroke is durable or block the UI on a per-keystroke Rust call.
If the core rejects an optimistic edit or saving fails, retain the unsaved local
buffer for recovery and show the conflict; do not silently overwrite either it or
the core's accepted state. Generation, lock and export commands wait for a successful
flush rather than operating on a body different from the one the user sees.

Run serialization/parsing and SQLite work outside latency-sensitive UI paths. Use
short write transactions and configure durability explicitly; propose WAL with
`synchronous=FULL` initially, then measure on target devices. Prefer bulk reads,
bounded subscriptions and content references over repeated full-project transfer.

For illustration, six 200 KB business snapshots are about 1.2 MB before indexes,
SQLite/WAL overhead and live references. This is not a benchmark or a maximum
database size. Use measured large-document behavior to decide whether affected-block
before/after payloads are needed. Rust alone does not establish interactive latency.

## 9. Source intake and document export

Store a URL as a source entry with user-provided/discovered title, URL and any
available search snippet. Distinguish `link_only`, `snippet`, `extracted_text`, and
`visual_input` evidence. A URL string does not prove the model read the page.
If full content is needed, ask for pasted/uploaded material or use an explicitly
supported retrieval capability; do not add an implicit crawler. Optional discovery
returns links through the independent search port in the shared AI design.

Desktop file selection and browser upload both hand bytes to the core's intake
service. Copy imported content into project objects, recording its original name,
MIME type, checksum and extraction version. Do not depend on the original file
remaining at an external path. Text extraction must preserve useful page/section
locations for references. Scanned PDFs without extractable text produce an explicit
notice; they are not silently treated as empty, successfully understood documents.

Embedded DOCX/PDF images may become referenced visual inputs when the configured
model supports them. Make included/omitted image evidence visible. Text extraction
does not imply visual understanding. Unsupported images remain source attachments;
the user can choose a capable model or explicitly proceed with text-only evidence.
General OCR is not a required fallback.

Run parsers in the document worker with timeout, memory, file-size and expanded-archive
limits. Do not execute macros, scripts, embedded objects, or remote document links.
Normalize parsed content into the canonical schema, sanitize imported links, and
report unsupported layout rather than claiming Word round-trip fidelity. Proposed
initial limits are 25 MiB per input and 100 MiB expanded DOCX data, adjustable after
fixture validation and always reported before rejection.

Export reads a consistent saved manuscript snapshot. Map its headings, lists,
emphasis and links into each supported format. TXT flattens formatting; Markdown
uses standard syntax; DOCX uses basic document styles. Clipboard operations use
the platform adapter. Desktop export uses a selected destination and browser export
uses a download. Generate to a temporary artifact and atomically finalize; failure
does not overwrite an existing export. Exports neither finalize the manuscript nor
create an undo entry. Unaccepted changes remain excluded with a clear UI indication.

## 10. Commands, events, and concurrency

Extend the existing JSON Schema contract rather than hand-maintaining Rust/TS DTOs.
These are proposed application commands, not endpoints already present:

| Commands                                                       | Required preconditions / effect                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `UpdateBrief`, `EditOutline`, `AdjustOutline`                  | Stage/revision check; ordinary edits or AI planning task           |
| `ConfirmOutlineAndGenerate`                                    | Saved valid outline, text configuration, no conflicting generation |
| `ImportManuscript`, `EditBlocks`, `ChangeStructure`            | Revision/scope validation and lock/lease guard                     |
| `AddSource`, `RemoveSource`, `ExtractSource`                   | Verified source reference; extraction is a durable utility task    |
| `CreateReview`, `EditReview`, `AskQuestion`, `RequestRevision` | Anchor/request version; immutable task context                     |
| `AcceptCandidates`, `DiscardCandidates`                        | Explicit candidate IDs/versions; atomic review decision            |
| `LockBlocks`, `UnlockBlocks`, `LockAll`                        | Exact target set and revisions; pending-candidate/task checks      |
| `Undo`, `Redo`                                                 | Expected history cursor; same mutation guard                       |
| `ExportManuscript`                                             | Flush/save acknowledged; consistent content snapshot               |

Every mutation carries a unique request ID and expected object revisions. Scope is
resolved by the core; an `allowedIds` field supplied by a client is not authority.
Persist a receipt with the request digest: identical request retries return the
same outcome, and the same ID with a different payload returns a conflict. SSE
events report committed changes with a project sequence/cursor. Reconnection resumes
from a retained cursor or requests a fresh state snapshot if the event gap expired.
Neither transport retries nor event replay start another AI call.

Use a stable error envelope with `code`, `requestId`, optional conflicting IDs and
safe details. Important codes include `REVISION_CONFLICT`, `CONTENT_LOCKED`,
`TASK_USING_CONTENT`, `PENDING_CANDIDATE`, `CANDIDATE_STALE`, `PATCH_OUT_OF_SCOPE`,
`HISTORY_BLOCKED`, `SOURCE_UNSUPPORTED`, and `SAVE_FAILED`. Localize messages in the
UI; do not expose SQL errors, credential values, or raw provider response headers.

## 11. Recovery and migration

Evolve the existing schema through numbered transactional migrations. Back up a
consistent SQLite snapshot and its referenced objects before migration. Reject an
unknown newer schema with a readable message; never downgrade it in place. A
failed migration must leave either the previous usable project or a recoverable
backup, not a half-upgraded document. Include a bootstrap-project migration fixture.

On startup, reconcile staged objects, unfinished edit groups, command receipts,
pending candidates, and generic task leases. Restore committed work and pending
review. Mark interrupted remote tasks explicitly and require user retry; do not
silently charge for another call. Rebuild UI state from the core, not browser
storage. Keep the existing single-core project directory lock.

Use the SQLite backup API or a stopped/checkpointed consistent database for backups;
copying only a live WAL database's main file is insufficient. Source export is a
document output, not a complete project backup. Multi-window concurrent editing is
not a v0.1 collaboration feature; stale clients receive revision conflicts.

## 12. Validation and delivery

The [implementation and acceptance plan](implementation-and-acceptance-v0.1.md)
defines the four slices and behavioral test IDs. Prioritize state transitions,
locks, atomic acceptance, persistent five-step history, stale AI responses, imports,
exports, and recovery. Browser tests verify shared interaction; actual Windows and
macOS tests are required for credentials, file dialogs, shortcuts and desktop
lifecycle. Current bootstrap checks do not validate any of the planned behaviors.
