# S2 specification: outline and initial draft

Status: specified for implementation; S1 and S2 business functionality is not
implemented by this document. Version: 0.1. This is the second slice of the
[implementation plan](../design/implementation-and-acceptance-v0.1.md).

Read the [S1 spec](s1-manuscript-foundation.md),
[workbench design](../design/script-workbench-v0.1.md),
[shared AI design](../design/shared-ai-v0.1.md), and
[development workflow](../development-workflow.md). Product decisions come from
the confirmed interview. Limits and concrete contracts below are engineering
defaults to validate during implementation.

## 1. Outcome, scope, and ownership

A user provides a topic and references, edits or generates an outline, adjusts it
manually or through one overall AI instruction, and confirms it to generate a
complete initial manuscript. The resulting draft opens in the S1 editor with all
blocks unlocked. Manual writing and existing-manuscript import remain available.

| S2 business module            | Required result                                                                |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Planning brief                | Persist topic, manuscript language and optional audience/style/length hints    |
| Outline workspace             | Edit heading hierarchy, order and key points without paragraph review or locks |
| Evidence preparation          | Explicit selected sources, excerpts and visual inputs; honest context summary  |
| Script AI orchestration       | Versioned prompts/output schemas, input snapshots and domain validation        |
| Outline generation/adjustment | Apply one complete valid planning result as one undoable operation             |
| Confirmation and drafting     | Capture the confirmed plan; atomically create one complete initial draft       |
| Task UI and recovery          | Observe progress, cancel, recover durable results and manually retry failures  |

Provider settings, API keys, model discovery/testing, normalized requests, provider
adapters, the generic queue, worker protocol and transport retry policy belong to
the [independent shared AI spec](shared-ai-integration.md). S2 specifies its required
ports and integration tests, not a second implementation of those facilities.

The overall S2 delivery depends on implementing that shared capability. Manuscript
work can proceed against a deterministic fake port; real-provider acceptance cannot
be claimed until that independent implementation and validation are complete.
Paragraph questions/notes, review candidates, acceptance comparisons and approval
locks remain S3. Export remains S4. Audio/video bindings are reserved global
categories; S2 uses the one global **text** binding for all its AI operations.

## 2. Prerequisites and integration boundaries

| Dependency                        | Required handoff                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| S2-DEP01: S1 foundation           | Canonical blocks, atomic commands/receipts, immutable objects, sources/extraction, history, mutation-policy seam and events                  |
| S2-DEP02: shared AI settings      | Read-only global text binding/status, safe settings navigation, capability declarations and immutable resolved config; no key readback       |
| S2-DEP03: shared AI execution     | Enqueue frozen request, read/observe run, cancel/fence attempts, durable result references, explicit retry lineage and idempotent completion |
| S2-DEP04: document utility worker | S1 text extraction plus bounded preparation of selected embedded images/PDF pages when visual input is requested                             |
| S2-DEP05: optional search         | Tested discovery port returning actual URL/title/snippet results; unavailable capability remains visible                                     |

Keep script models/prompts under Rust script domain/application modules; UI owns
planning views; infrastructure connects the generic execution port. Workers and
`packages/ai-runtime` must not import the brief, outline, manuscript or history
domain. A provider SDK never enters the script application or React editor.

The consumer uses the shared AI spec's `resolveConfiguration` and
`withResolvedConfiguration`, `enqueueInUnitOfWork`, run/result reads/subscriptions,
and `cancelInUnitOfWork`. These resolve/freeze configuration, enqueue immutable
execution, observe results and fence attempts/applicability. An opaque
`runId`/`inputSnapshotId` connects the generic run to a separate script task binding.
Only the script coordinator interprets output, checks planning state and commits
a manuscript mutation. Generic execution cannot approve, unlock or finalize it.

## 3. User interaction and state

### 3.1 Planning workspace

Replace S1's simple document-start view with the outline workspace whenever
`workspaceStage = outline`. Existing manual/imported drafts still open in the
draft editor; never force them through AI planning. Starting a manual draft from
planning remains an explicit action and does not call a model.

The planning workspace contains the brief, source selection, an outline editor,
one overall AI instruction input, and a compact task status area. Support:

- Adding, renaming, deleting, indenting/outdenting and reordering outline nodes.
- Editing each node's key points directly; empty key-point lists are valid.
- Generating an outline from an empty plan, or adjusting a nonempty outline.
- Selecting references, excerpts and optional visual inputs; inspecting exactly
  which evidence is included, link-only, omitted or unavailable.
- **Confirm outline and generate draft** after the current plan has been saved.

There are no selection-level questions, revision notes, inline comparisons,
paragraph locks or separate fine-grained model selectors. Outline results are
planning replacements, not S3 review candidates. Keep the initial outline as
provenance after drafting; the draft's headings then own navigation/structure.

All local manual edits autosave through S1's serialized queue. Group continuous
editing of one brief field or one outline title/key point using the same typing
policy; a structural outline operation is discrete. Flush and close that group
before any AI start, preview preparation, confirmation, history action or switch.
Never dispatch paid work while visible planning changes remain unsaved.

### 3.2 Outline generation and adjustment

**Generate outline** requires a saved topic and manuscript language. An empty
outline is allowed; a nonempty outline requires the explicit adjust action so a
new command does not replace it unexpectedly. **Adjust outline** requires a saved
nonempty outline and a nonempty overall instruction, for example a request to
shorten the structure or add an analysis section.

Create one request version per explicit user submission. Show queued/running
status and allow cancellation. The user may continue editing planning content
while an outline request runs. If an included brief, outline, evidence selection
or instruction changed, its result becomes stale and cannot replace the current
plan. It remains inspectable as a task result with a manual retry action.

When current dependencies match, apply the entire validated outline in one
transaction and one history entry. Do not write streamed nodes into the editable
outline. The task can display a labeled generation preview independently. The
user can immediately adjust the applied outline or undo it; there is no extra
paragraph acceptance step at this stage.

### 3.3 Confirmation and complete initial drafting

The primary button combines confirmation and start. Its command validates and
captures the saved brief, complete nonempty outline, selected evidence and current
text configuration, then records a confirmation snapshot and enqueues exactly one
logical initial-draft run. Confirmation approves the **plan**, not manuscript
wording or finalization. There is no additional mandatory approval dialog.

Reserve the planning dependencies and stage transition from successful enqueue
through final application/failure/cancellation. Show why their controls are
temporarily unavailable. The mutation guard blocks edits/import/manual-start and
undo/redo that would change this reserved scope. Unrelated source additions and
global AI settings changes remain allowed; they do not alter the frozen request.
The user can cancel generation before changing the reserved plan.

On a complete valid result with current dependencies, commit the whole draft and
stage transition together, then open the document editor. Never overwrite an
existing draft, create a second main manuscript, or save partial streamed prose
as accepted content. S2 initially uses one completion per explicit generation;
automatic chapter continuation and model-based output repair are excluded.

On failure/cancel/interruption, leave stage and plan intact and release only this
task's temporary reservation. Store the failed confirmation as execution evidence,
not a live editable approval flag. Editing the plan invalidates its current
confirmation. Explicit retry confirms the current saved plan anew and snapshots
the current global text configuration into a new run.

## 4. Planning models and limits

Use stable UUID identities and monotonic revisions from S1. All schemas are
application-owned and generated from JSON Schema during implementation.

| Record                    | Principal fields                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `PlanningBrief`           | `id`, `revision`, required `topic`/`language`, optional `audience`, `style`, `lengthHint`                                      |
| `Outline`                 | Stable ID, monotonic revision, ordered tree of nodes                                                                           |
| `OutlineNode`             | Stable ID, revision, nonempty `title`, ordered `keyPoints`, ordered `children`                                                 |
| `EvidenceSelection`       | Revision, selected source IDs/revisions, excerpt locators, visual selections, explicit text-only choice where applicable       |
| `PlanningInstruction`     | Stable ID/revision and saved overall adjustment text; edits do not submit a new AI task                                        |
| `PlanningRequest`         | ID, version, operation `generate_outline`, `adjust_outline` or `generate_initial_draft`, instruction and dependency binding    |
| `PreparedPlanningInput`   | Preparation ID/expiry, manifest hash, planning/config fingerprints, context budget, warnings and acknowledged evidence choices |
| `PlanningSnapshot`        | Immutable brief/outline/evidence and versioned prompt/output-spec references                                                   |
| `OutlineConfirmation`     | Immutable snapshot ID, confirming command ID, associated run ID                                                                |
| `ScriptAiTaskBinding`     | Request/version, run/input ID, dependency revisions/hashes, operation, result application status                               |
| `DraftGenerationManifest` | Exact confirmed outline, materialized block IDs, section mapping and evidence/verification metadata                            |

Persist the manuscript language as a BCP 47 tag. A new brief can initialize it from
the current UI locale once, but subsequent locale changes never rewrite it.
`lengthHint` is a writing constraint, not a measured audio duration. Topic and
outline content may be multilingual. The model must follow the saved manuscript
language, not the UI's current locale.

| Limit                             | Initial engineering value                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Topic                             | 1–500 Unicode scalar values after trimming                                                          |
| Audience/style/length hints       | 2,000 scalar values per optional field                                                              |
| Overall AI adjustment instruction | 8 KiB UTF-8                                                                                         |
| Outline                           | 200 nodes, maximum nesting depth 4, 256 KiB canonical JSON                                          |
| Node title and key points         | Title 1–300 scalar values; at most 20 key points, each at most 1,000 scalar values                  |
| Evidence manifest                 | 50 selected sources and 100 excerpt/visual entries                                                  |
| Visual input safety ceiling       | 8 images, 4 MiB each, 16 MiB aggregate; 4,096 pixels per image dimension after preparation          |
| Prepared input lifetime           | 10 minutes, invalidated earlier by dependency/configuration changes                                 |
| Output                            | Outline limit above or S1 document limits, plus bounded result metadata                             |
| Draft result metadata             | At most 100 verification hints, 100 evidence references and 20 planning notes, 64 KiB combined JSON |

Validate cycles, IDs, depth/order and strings in the core. A manual node move must
move its children atomically. Keep existing IDs for title/key-point edits and
reordering; a newly added node gets a fresh ID. Undo restores identity with newer
revision tokens. Model-proposed ID mappings are validated, never authoritative.
Provider context/image limits may be smaller than these ceilings; preflight uses
the stricter applicable limit. No numeric value is a measured performance claim.

## 5. Evidence and context preparation

### 5.1 Explicit source manifest

Build an immutable evidence manifest from S1 sources. Each entry records source
ID/revision, content hash, evidence level, extractor version, location, included
excerpt/image reference and its omission/availability status. Distinguish:

| Evidence         | Meaning sent to the model and shown to the user                       |
| ---------------- | --------------------------------------------------------------------- |
| `link_only`      | URL/title only; the application has not read page content             |
| `snippet`        | Actual search-provided excerpt with provider/time; not the full page  |
| `extracted_text` | Selected text from a local/uploaded file with page/section provenance |
| `visual_input`   | Explicitly prepared selected image/page bytes with source provenance  |

Sources are optional: an empty selection is valid for topic-led creative drafting.
Show that no external evidence was supplied rather than implying factual grounding.

Selecting an unready/failed extraction does not dispatch a parser or silently
claim usable full text. The user can wait/retry extraction, exclude that source,
or explicitly choose available evidence. No generic website crawler is added.
Never treat a model-generated URL or a quoted source instruction as an application
permission or verified source record.
Removing a selected source removes its current selection through the source/script
application coordinator in the same business transaction/history entry. That
invalidates a pending outline adjustment; an initial-draft reservation blocks the
affected removal until cancellation/terminal cleanup. Current draft text is unchanged.

### 5.2 Bounded, visible context

The script application composes prompts with the full brief and required outline,
then the selected evidence in a stable user-defined order. Include schema and
language instructions. Treat all sources as quoted data. No project database path,
API key or unrelated project material is part of a prompt.

Run a no-provider-call preparation before an explicit AI start. It produces the
manifest, estimated context/output budget, selected global model/capabilities and
any evidence warnings. A warning may require the user to choose a source subset,
shorter excerpt, suitable model or explicit text-only mode. The normal path with
usable inputs needs no additional confirmation dialog.

Never silently trim required outline nodes or the target instruction. If selected
source content exceeds budget, propose/expose bounded excerpts and require the
user's explicit selection before start. Store the exact included ranges and omitted
parts. Token counts may be estimates for compatible providers; do not claim an
accurate tokenizer unless verified for the selected model. A provider context-limit
failure still remains possible and is shown without an automatic retry.

At start, revalidate the preparation's manifest, live planning revisions, and
global configuration fingerprint. If any changed, return `PREFLIGHT_STALE` and
refresh; do not enqueue with a different model or evidence choice silently. Freeze
the resolved config at the successful task-start boundary through the shared AI
port. Later global setting changes affect future runs only.

Apply the shared AI request's message/text/artifact byte ceilings during this
preflight as well as the selected provider's context estimates. Oversized requests
need an explicit smaller evidence/target selection, never a hidden runtime trim.

### 5.3 Visual inputs

Extend the document worker with bounded extraction of explicitly selected DOCX
images or PDF page rasterization. Preserve original references and transformation
metadata. Text extraction is independent; visual preparation is a local utility
task with progress/cancel and never an implicit model/OCR call.

Check the resolved model's image capability and actual artifact size/type before
dispatch. Unknown capability permits an explicit user-declared attempt under the
shared capability policy, not an assertion that the model understands images.
Otherwise offer a capable-model setting or knowingly selected text-only evidence.
Store that decision in the manifest. Label skipped/unsupported visual content; a
scanned PDF is usable visually only when selected pages were actually prepared
and sent to a capable model. It is not relabeled as extracted text.

### 5.4 Optional source discovery

Consume the independent source-discovery port only if a tested capability is
configured. Results are URL/title/snippet/provider/time, with no downloaded page
body. Users choose which results to add through the S1 source command/history.
Searching itself does not add sources or become manuscript content automatically.
When no adapter is configured, show discovery as unavailable and retain full manual
link/file input. This conditional integration does not block the baseline S2 path.

## 6. Versioned prompts and output interpretation

### 6.1 Ownership and prompt versions

Version three script-owned templates and output schemas: outline generation,
outline adjustment and initial draft. Record prompt/interpreter/schema versions
in task bindings. Providers receive generic messages and output specifications;
the shared runtime never imports these templates or the script domain.

The instruction explicitly separates spoken/manuscript content from production
notes and source evidence. Creative development is allowed within the confirmed
structure. Unsupported factual claims should be listed as verification hints.
The app validates structure/provenance references, not the truth of every sentence;
successful schema validation must not be presented as fact verification.

### 6.2 Outline output

The output is a closed object with schema version and an ordered node tree of
titles/key points/children. Adjustment may name existing node IDs only from the
captured outline; newly generated nodes omit IDs and receive core-assigned ones.
Reject duplicate/foreign IDs, cycles, empty titles, invalid nesting and oversized
output. Removed IDs become tombstoned, and surviving IDs retain their identity.
Fresh outline generation accepts no existing-node references.

Only a complete valid object can replace planning state. Preserve the original
outline on truncated/malformed output, validation failure or stale dependencies.
There is no automatic second model request to fix it and no partial node merge.
The ordinary planning view does not display S3 before/after review controls.

### 6.3 Complete draft output

Request a closed `InitialDraftOutput` with a schema version, `sections`, optional
evidence references, and bounded `verificationHints`/`planningNotes`. Sections carry
captured
`outlineNodeId` and supported S1 paragraph/list content without block IDs or
revisions. Return every confirmed outline node exactly once in preorder. The
core materializes the heading/title/level from that outline rather than trusting
the model to redefine the approved structure. Parent sections may have no prose
when they contain children; every leaf section must contain nonempty body content.

Validate that the result is complete, within the S1 canonical limits and consistent
with the allowed node mapping. Reject extra/missing/duplicate sections, foreign
IDs, unsupported executable/HTML nodes, invalid marks and a truncation finish
reason. A structurally incomplete draft does not become a successful manuscript.
Additional content ideas can be expressed inside allowed prose or returned as
notes, not silently added as unapproved top-level sections.

The core assigns block identities once and records section-to-block mappings in
the generation manifest. Duplicate completion cannot allocate another manuscript.
Evidence references identify only captured manifest entries and section/block
positions; validate them before mapping to real block IDs. Keep source references
and verification hints outside spoken text. Do not upgrade `link_only` to a claim
of full-page reading because the model cited it. Verification hints are informational
metadata, not an additional approval gate or S3 comment thread.
Display those hints and reference evidence levels in the supporting evidence/task
panel so they are available to the user without entering the spoken manuscript.

## 7. Task application, cancellation, and concurrency

### 7.1 Separate execution from application

Generic run states remain owned by shared AI. The script binding separately uses
`waiting`, `applied`, `not_applied`, `rejected`, or `cancelled` with a reason. A run
can succeed generically while its output is rejected by the script validator or
stale against the current planning state. Show both facts clearly in task details.

Before applying, check run/attempt/fence/input identity through the execution port,
request version, operation, exact brief/outline/evidence dependencies, stage,
output schema, mutation scope and history preconditions. Unrelated source additions
or a higher global project revision alone do not stale a valid scoped result.
Each operation records only dependencies it actually consumes: outline adjustment
includes the saved instruction revision; initial drafting does not depend on an
unused adjustment-input field. Changing UI locale or global settings after start
does not invalidate an otherwise current result.

Only one active planning-generation request per manuscript is allowed, including
queued work. A second start with a different request ID returns `PLANNING_TASK_ACTIVE`;
the same ID returns the original receipt/run. Replacing an active request requires
explicit cancellation and a new submission. Outline adjustment allows manual edits;
initial drafting reserves its input scope. Changing the adjustment instruction
increments its saved instruction revision, without a new model call; the old
binding becomes stale. Explicit resubmission creates a newer request version.

### 7.2 Atomic start and completion

Starting creates the command receipt, immutable planning/confirmation snapshot,
script binding, generic queued run and necessary reservation atomically. Resolve
configuration/prepare objects outside a long write transaction, then revalidate
under `withResolvedConfiguration` using its settings-lock, project-coordinator,
then short database-transaction order. Stage both modules through one unit of work;
do not acquire settings from inside an already open project transaction. The
generic dispatch permit must be committed before its provider request. No call starts
before this durable record exists, and no transaction waits on model output.

On completion, first persist/promote the generic immutable output. The script
coordinator then validates/materializes it and atomically commits applied body or
outline, new revisions, history entry, binding status, reservation release and
outbox event. A unique application record per task binding prevents double apply.
If interrupted between result persistence and application, reconcile the saved
result locally; this does not authorize another remote call.

### 7.3 Cancellation and manual retry

Cancellation must fence a still-unapplied script binding as well as generic
execution. A generically completed result may still be waiting for application:
serialize cancellation and script application through the core coordinator. If
application committed first, return already-applied. If cancellation won first,
the result cannot mutate planning/body even if a provider later completes.

Release only the task's reservation. Preserve the user's brief, outline, sources
and acknowledged edits. A provider failure shows a persistent tip/task error with
settings and manual retry actions. The script never retries, changes model/provider,
switches transport or requests output repair automatically. SDK-level suppression
belongs to shared AI but is asserted by the integration tests.

Explicit retry uses a new command/run with `retryOfRunId`, current saved inputs and
current global text settings; it is not an in-place alteration of the old run.
An old draft request can be retried only while still in the outline stage with no
existing draft. If settings or plan changed, the UI shows the new prepared inputs.
Retry must also satisfy its original operation's prerequisites: retrying empty-plan
outline generation cannot silently replace an outline the user has since created.
Use an explicit adjustment request for that situation.

## 8. History, undo, and reservations

Extend S1 business snapshots with brief, outline, saved adjustment instruction and
evidence selection. Manual edits follow S1 grouping; source membership remains in
the same project history.
An applied AI outline replacement is one discrete operation. Initial draft creation,
its block mapping and the outline-to-draft transition are one discrete operation.
Automatic task progress, result arrival, failure and cancellation are not entries.
Confirmation/run/reservation records are execution data and are not resurrected by
undo. No extra history step is created solely for clicking the start button.

Treat applying a valid output as completion of the original explicit user command.
It may automatically append its one history entry only while the current history
is at its endpoint. If the user has moved the cursor back and a redo tail exists,
store the result as `not_applied: HISTORY_DIVERGED`; arrival must not discard redo.
Offer an explicit **Use generated result** action only when all planning dependencies
still match. That action closes the current group, creates a normal new history
branch and revalidates the result without a provider call. This recovery action
has no comparison UI. If dependencies changed, show stale/manual-regenerate instead.

Outline edits after a running adjustment make its result stale even if later text
looks similar. Monotonic revisions prevent a late result from becoming valid just
because undo restored matching words. A new request is needed for such stale output.
The history-only recovery action above cannot override stale dependency checks.

Undo of initial drafting returns to its retained planning state; redo restores the
stored draft without calling AI. Both advance current revision tokens and obey
reservations. Undo/redo touching a queued/running initial-draft scope returns
`HISTORY_BLOCKED`; unrelated operations may be undone. After a terminal result is
stored as not applied, release its reservation; explicit local use revalidates the
plan and stage again. Never restore an old queue lease or claim a retained snapshot
is newly confirmed for another model call.

Keep at most five reversible transitions and their referenced state. Retain extra
immutable plan/source/output objects only while referenced by current draft
provenance, live requests, recoverable not-applied results or retained history.
Retain at most the latest terminal not-applied result per operation/manuscript;
a newer terminal result replaces its recovery slot. Compact superseded unreferenced
payloads while preserving small safe task/receipt metadata and existing live roots.

## 9. Commands, queries, events, and errors

Reuse S1 authenticated command envelopes, unique request IDs, receipts and project
events. Public manual/start commands carry `expectedWorkingRevision` plus the
relevant object revisions. Internal result application uses captured dependencies
and a fresh transaction view, so unrelated edits do not cause global staleness.
No client command accepts an API key or per-project model override.

| Application operation        | Required payload / behavior                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `UpdatePlanningBrief`        | Current brief revision and changed fields; one undoable edit/group                                                     |
| `EditOutline`                | Atomic add/update/move/remove operations, expected outline/node revisions; core validates resulting tree               |
| `SetEvidenceSelection`       | Expected selection revision, exact source/excerpt/visual selections and explicit evidence-mode decisions               |
| `UpdatePlanningInstruction`  | Expected instruction revision and saved text; grouped manual edit, no automatic submission                             |
| `PreparePlanningInput`       | Saved operation/instruction/dependencies; read-only preparation plus temporary manifest, no paid call/history mutation |
| `GenerateOutline`            | Ready preparation ID/hash, request version; empty current outline                                                      |
| `AdjustOutline`              | Ready preparation ID/hash, current outline revision, saved overall instruction/request version                         |
| `ConfirmOutlineAndGenerate`  | Ready preparation ID/hash and current brief/outline/selection revisions; confirmation plus enqueue                     |
| `CancelPlanningTask`         | Script task ID and expected request version; fence application and cancel generic run                                  |
| `RetryPlanningTask`          | Failed/interrupted/stale task ID, new preparation and request ID; new run/current inputs                               |
| `UseGeneratedPlanningResult` | Not-applied result ID/hash, current dependencies/history revision; local application after history divergence only     |

Task cancellation/retry are explicit commands; they do not enter project undo by
themselves. Repeated starts, cancellations and local-use requests return consistent
receipts and never double-apply. A rejected start leaves no active reservation or
confirmation. A source search result is added through S1's source command rather
than a new bypass of project mutation/history validation.

Expose `GET /v1/planning` for brief/outline/selection/revisions and current task
summary; route business mutations through S1's `POST /v1/manuscript/commands` union.
Use `POST /v1/planning/preparations` for no-model-call context preparation, and
`GET /v1/planning/tasks/{taskId}` for the combined script/generic status. Shared AI
owns its global settings and generic run endpoints. Add only named desktop bridge
operations/subscriptions; no unrestricted worker/API access.

Extend SSE with `planning.changed`, `planningTask.changed`, and
`draft.created`. Persist script application events in the same transaction as
state/history. Continue S1 sequence/cursor replay and snapshot resync. The originating
client must distinguish its own in-flight request from a different client's edit;
an event arriving before its HTTP receipt cannot trigger a duplicate start or clear
newer local input. Preview deltas are bounded ephemeral task data, not document events.

| Error                                                               | Required response                                                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `BRIEF_INVALID`, `OUTLINE_INVALID`, `OUTLINE_REQUIRED`              | Explain missing/invalid saved planning fields; dispatch no model call                                            |
| `STAGE_CONFLICT`, `DRAFT_ALREADY_EXISTS`                            | Preserve existing manuscript; generation cannot replace it                                                       |
| `PREFLIGHT_STALE`, `EVIDENCE_NOT_READY`, `EVIDENCE_CHOICE_REQUIRED` | Refresh preparation or require explicit usable input choices                                                     |
| `PLANNING_TASK_ACTIVE`, `TASK_USING_CONTENT`                        | Explain conflicting request/reserved scope; offer wait/cancel                                                    |
| `PLANNING_RESULT_STALE`, `HISTORY_DIVERGED`                         | Preserve current state; stale output needs new request, history-only result can be used explicitly               |
| `DRAFT_STRUCTURE_INVALID`, `INVALID_OUTPUT`, `OUTPUT_TRUNCATED`     | Keep outline/body intact; show validation failure and manual retry                                               |
| Shared AI safe errors                                               | Surface auth/capability/context/network/rate-limit/interruption reasons without vendor secrets or a hidden retry |

Map invalid input to 400/422, revision/stage/task/preflight conflicts to 409, and
size limits to 413. Provider failures normally arrive as terminal task state rather
than an HTTP request held open for the entire generation. Reuse safe error envelopes;
do not return raw prompts, private source text, secrets or worker stack traces.

## 10. Persistence, migration, and restart

Add script-owned tables for brief/outline nodes, evidence selections, adjustment
instructions, confirmations, script task bindings, result applications and
draft-generation manifests. Place large snapshot/context/output payloads in
immutable objects; keep indexed identities,
revisions and applicability in SQLite. Add unique constraints on script task/run
binding and task-result application. Table ownership remains separate from generic
AI runs/attempts/artifacts even within the same project database.

Reserve `006_planning.sql` and project schema version 6 after S1 versions 2–4 and
shared AI version 5, following the shared spec's migration ledger. Append later
changes without renumbering applied migrations. Test migration from bootstrap
through S1 into S2 and reopening an existing S1 draft. That draft
keeps its IDs/content/history, opens in draft stage and gains no invented outline.
An S1 outline-stage project gains empty planning records, not a generated draft.

Backup/transaction/object-promotion rules remain those in S1. Extend garbage
collection roots to live preparations, pinned task inputs, confirmations retained
by a generated draft, result recovery slots and referenced visual/extracted objects.
Project snapshots contain redacted model/config identities for provenance, never
saved secrets or editable project-level provider defaults.

On restart, let shared AI reconcile generic run state, then reconcile script
bindings/reservations/application receipts. In the original database only, known
unclaimed/undispatched queued work may continue with frozen input/config. Restored
or unknown-origin copies fence all nonterminal runs, including queued runs.
Ambiguous in-flight work becomes interrupted and awaits user retry. A durable
succeeded output awaiting local application can be validated
and applied once under the same dependency/history rules without another API call.
Already-applied results remain applied after subsequent user undo; recovery must
not reapply them just because the current stage is outline again.

Expiration/cancellation/worker loss must fence script applicability and release
obsolete reservations even if no provider reply arrives. Rebuilding UI task state
from the core must not restart generation. Preserve acknowledged planning edits,
the last completed outline and history cursor across browser/core restarts.

## 11. Development tasks and dependencies

All tasks are pending. `Tnn` below means `S2-Tnn`, `ACnn` means `S2-ACnn`, and
`DEPnn` means `S2-DEPnn`. Shared AI internals are delivered under their independent
spec; these tasks implement or verify its manuscript integration only.

| Task   | Concrete deliverable                                                                                                                         | Depends on                               | Acceptance                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------- |
| S2-T01 | Define planning/brief/evidence/output schemas and generated contracts, limits and pure validators                                            | DEP01                                    | AC01, AC02, AC10, AC11       |
| S2-T02 | Add planning storage/migrations, snapshot roots and script-task/application identities                                                       | T01, DEP01                               | AC02, AC20, AC23             |
| S2-T03 | Implement brief/outline/selection commands and shared history/mutation-policy integration                                                    | T01, T02                                 | AC01, AC02, AC17, AC18       |
| S2-T04 | Build localized outline workspace, hierarchy/key-point editing, autosave and manual/import routes                                            | T03, DEP01                               | AC01, AC02, AC03             |
| S2-T05 | Implement deterministic text evidence selection/context preparation, budgets and preflight fingerprints                                      | T01, T03, DEP02                          | AC04, AC05, AC06             |
| S2-T06 | Prepare bounded visual artifacts through document worker and implement capability/text-only choices                                          | T05, DEP02, DEP04                        | AC07                         |
| S2-T07 | Add versioned script prompts/interpreters, outline mapping and complete-draft materialization/evidence validation                            | T01, T05                                 | AC10, AC11, AC12             |
| S2-T08 | Connect generic execution/settings ports using deterministic fake and real adapter boundary; keep credentials/provider imports out of script | T02, T05, DEP02, DEP03                   | AC08, AC09, AC21, AC22       |
| S2-T09 | Implement outline generation/adjustment application, request versions and stale-output protection                                            | T03, T07, T08                            | AC03, AC09, AC10, AC13       |
| S2-T10 | Implement confirmed-plan snapshots, reservation enforcement and one-time complete initial draft creation                                     | T03, T06, T07, T08                       | AC08, AC11, AC12, AC14, AC15 |
| S2-T11 | Add cancellation/manual retry and restart/result-reconciliation UI, fences and task events                                                   | T09, T10, DEP03                          | AC14, AC16, AC19, AC20, AC24 |
| S2-T12 | Complete result/history divergence handling, explicit local use and payload retention                                                        | T09, T10, T11                            | AC17, AC18, AC20, AC23       |
| S2-T13 | Wire optional tested source-discovery consumer and selection into S1 sources; show unavailable status otherwise                              | T04, T05, DEP05 when enabled             | AC06                         |
| S2-T14 | Run browser/restart/fault/contract suites and explicitly initiated provider/desktop smoke checks                                             | T04, T06, T11, T12; T13 conditional path | AC01–AC24                    |

Checkpoints: T01–T04 deliver manual planning; T05–T08 establish context and generic
execution integration; T09–T10 deliver outline-to-draft generation; T11–T14 establish
reliable recovery and stage evidence. Shared AI capabilities must pass their own
spec as well; an S2 fake-port test alone does not certify the live runtime.

## 12. Acceptance cases and test mapping

Use controlled fake completions, counted HTTP requests and barriers for races.
Parent `SW-*`/`AI-*` mappings refer to the implementation plan; integration mappings
do not move generic behavior ownership into this spec.

| ID      | Given / when                                                                            | Required result                                                                                                                                  | Level / parent mapping                  |
| ------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| S2-AC01 | New project or existing manual draft; open planning/draft                               | Correct stage view; planning has overall adjustment and no paragraph review/diff/locks; existing draft remains intact                            | Browser; SW-01, SW-04                   |
| S2-AC02 | Edit/reorder/nest brief/outline with Unicode and invalid limits; save/reopen            | Supported tree/IDs persist, invalid mutations atomic, UI language does not change manuscript language                                            | Domain/storage/browser                  |
| S2-AC03 | Generate empty outline or adjust current outline                                        | One complete valid replacement and one undo entry; user can edit directly; no streamed partial nodes or review acceptance gate                   | Fake integration/browser                |
| S2-AC04 | Included source has failed/unready extraction or exceeds context budget                 | No hidden extraction/model call or silent source truncation; explicit evidence choices and exact manifest                                        | Domain/browser; AI-16                   |
| S2-AC05 | Preflight then edit plan/evidence/global model before start                             | Reject stale preparation without enqueue; successful start freezes current configuration/inputs                                                  | Integration; AI-01, AI-02               |
| S2-AC06 | Link-only sources or optional search unavailable/available                              | Honest link/snippet evidence; no crawler or invented verified results; manual sources always usable; selected results add through normal history | Fake discovery/browser; AI-14           |
| S2-AC07 | Selected images/scanned PDF with supported/unknown/unsupported capability               | Bounded artifacts/provenance and explicit attempt/text-only choice; no silent omission or false text-extraction/vision claim                     | Worker/port/browser; SW-24              |
| S2-AC08 | Start initial draft from saved outline; change global settings during run               | Confirmation captures exact plan and original text config; task unchanged; no project model setting appears                                      | Integration; SW-02, AI-02               |
| S2-AC09 | Edit outline/instruction while AI adjustment runs, including undo to same words         | Old request/revisions cannot overwrite current planning; unrelated source addition alone does not stale result                                   | Barrier integration; AI-06 partial      |
| S2-AC10 | Model returns invalid/foreign/duplicate outline nodes or truncated output               | Preserve current outline, typed failure, no partial merge or repair call                                                                         | Fake contract/integration; AI-04, AI-05 |
| S2-AC11 | Draft result misses/adds sections, has unsupported nodes or truncated finish            | No body/stage mutation; complete valid result materializes every required node and nonempty leaf content                                         | Domain/fake integration; SW-03          |
| S2-AC12 | Valid draft includes source references and verification hints                           | Core assigns IDs once; references map only to actual manifest evidence; notes do not become spoken text or fact-verification claims              | Domain/storage                          |
| S2-AC13 | Double-click start, altered duplicate request or late result                            | Same command returns original run; active conflicting start rejected; obsolete result cannot apply twice                                         | API/worker; AI-06                       |
| S2-AC14 | Draft is queued/running; attempt edit/import/history on reserved inputs                 | Guard consistently blocks affected changes; unrelated sources/settings remain usable; terminal cleanup releases only task reservation            | API/domain/browser; SW-20 partial       |
| S2-AC15 | Valid complete initial draft arrives in ordinary path                                   | One atomic stage/body/history/application commit, initially unlocked; no duplicate or replacement of existing draft                              | Storage/browser; SW-03                  |
| S2-AC16 | Cancel races provider completion or local application                                   | One application outcome, no late mutation after cancellation, current plan preserved, no automatic restart                                       | Barrier integration; AI-07              |
| S2-AC17 | Undo/redo outline application or initial drafting                                       | One reversible operation each, fresh revision tokens, restored content/stage without model calls or resurrected jobs                             | Restart/history; SW-18, SW-19           |
| S2-AC18 | Undo unrelated operation during generation leaving redo tail                            | Result arrival preserves redo; explicit local use may branch only with still-current dependencies; stale result cannot use this path             | Domain/browser                          |
| S2-AC19 | Provider/auth/rate/context/stream/schema failure then user retries                      | Persistent actionable failure; one paid request per explicit start; new run uses current plan/settings with retry lineage                        | Fake counted endpoint; AI-04, AI-16     |
| S2-AC20 | Crash before dispatch, during call, after result, after application, or after user undo | Recover known states once; ambiguous call waits for user; saved result can apply locally; applied task never replays after undo                  | Fault/restart; AI-08                    |
| S2-AC21 | Inspect script dependencies and invoke generic runtime with non-script fake caller      | No SDK/keys in script UI/domain; shared runtime requires no manuscript/outline types; settings/secrets remain global                             | Dependency/contract; AI-09, AI-11       |
| S2-AC22 | Use fake then explicitly tested compatible endpoint through shared runtime              | Same request/result boundary; connect/config errors remain actionable; no automatic fallback or SDK retries observed                             | Contract/manual provider; AI-03, AI-04  |
| S2-AC23 | Prune history and superseded task payloads with current draft provenance                | Preserve referenced plan/source/visual inputs and recovery slot; prune unreferenced bodies without unbounded version UI                          | Storage; SW-30 partial                  |
| S2-AC24 | SSE disconnect/replay or event arrives before command receipt                           | Recover task/state without another generation, duplicate application or lost local input                                                         | API/browser; AI-17                      |

## 13. Completion evidence and S3 handoff

Run relevant existing checks as implementation lands: `pnpm check`, `pnpm build`,
`pnpm test:integration`, and `pnpm test:e2e`. Add planning validators, fixtures,
restart/fault cases, and counted fake-provider tests to these workflows. Ordinary
tests/CI must use fakes and never consume real provider credentials or paid calls.
Record actual platform/provider limitations separately.

The stage report must map tasks and acceptance IDs to actual evidence, including
one complete topic-to-draft browser flow, saved planning/history recovery, context
manifest examples, no-retry/cancellation races and independent shared AI acceptance.
An explicit compatible-endpoint smoke test validates the selected model/config;
test another endpoint before making broad compatibility claims. Target-system
credential behavior belongs to shared AI validation and cannot be inferred from
Linux browser success.

Measure local planning save, context preparation and result validation/application
latency separately from provider time. Verify that generation/visual preparation
does not block editor/UI responsiveness. Report fixture sizes, output sizes,
hardware and p50/p95 values; do not promise a model-independent draft completion time.

S3 receives the canonical draft, exact source/plan provenance, reusable script
context/prompt integration, task reservation policy and project history extension.
It adds questions, revision candidates and user locks through those boundaries;
S2 must not preimplement paragraph review or a separate model configuration system.
