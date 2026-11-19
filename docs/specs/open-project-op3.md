# OP3: source authoring and external-file reconciliation

Status: implementation authorized on 2026-11-19, following reviewed OP2 at
`9c59723` on `feat/open-project-format`. Root owns this brief and design.
Parent: [open project format](open-project-format.md); prior source/store contract:
[OP2](open-project-op2.md). Acceptance: OPF-AC04/05/08/09/12/19.

## Tasks and owners

- OP3-T01: source-capable Markdown surface and lossless editor transaction adapter.
- OP3-T02: one project queue/save/history/input owner for source, planning and
  existing business commands, including captured acknowledgments and IME.
- OP3-T03: manuscript surface adapters for review, locks, selection and layout.
- OP3-T04: native external inspection/candidate status, watch/rescan and bounded
  same-process recovery, with generated HTTP/preload contracts.
- OP3-T05: explicit source accept/discard/manual resolution using the existing
  policy/receipt/journal seam, preserving both local and external content.
- OP3-T06: source-aware identity and clean Markdown delivery without silent loss.
- OP3-T07: real-core/browser interaction evidence and legacy regressions.

Likely owners: editor-ui manuscript/project-session/workbench/review/delivery,
shared manuscript-format source utilities, platform-client/contracts, native
source journal/inspection/retention and named service/preload capabilities.
Append migrations after 011; applied versions remain immutable. No arbitrary
filesystem/shell API, full project migration/ZIP, Agent SDK or media execution.

## Sequential implementation substeps

OP3 is split into two coding assignments with the same final acceptance gate:

1. OP3-A implements T04–T06 backend/contracts: trusted source candidates,
   stable inspection/watch/rescan, journal v2 reconciliation, same-process recovery
   and full-source clean Markdown delivery. It may change native/service/worker
   owners and typed HTTP/preload adapters, plus focused tests. It does not rewrite
   the workbench, ProjectSession, review components or styles. Root reviews and
   commits/pushes that bounded backend checkpoint before OP3-B.
2. OP3-B implements T01–T03 and visible reconciliation/delivery integration using
   the accepted APIs, with T07 browser and input-ownership evidence. Root writes
   its exact handoff brief after accepting A, then assigns a fresh coding agent.

OP3 remains incomplete until both pass. Each substep uses one writer and stops
all writes/checks for root review. A failed intermediate check is corrected by
the same coding agent; a partial backend checkpoint is not final UI acceptance.

## Chosen presentation and editor

New-format projects use a pinned CodeMirror 6 Markdown surface with live Markdown
presentation and a source toggle. Legacy projects retain Tiptap until explicit
OP5 migration. This is an editor adapter inside the existing workbench/session,
not another project application or an editable canonical mirror of the source.
Use public pinned packages and reproducible lockfile updates.

Keep the approved Obsidian-style layout: ribbon, collapsible Directory/Library,
central Manuscript/Outline, auxiliary AI assistant/Review. Keep current neutral
canvas/chrome, text measure, spacing, semantic tokens and SVG icons. No page frame,
Word toolbar, mandatory title/workspace form, marketing page or visual redesign.
Metadata hiding is a decoration, never deletion of source bytes. Supported syntax
gets live styling; unknown syntax remains editable source. Never execute HTML/JS
or fetch arbitrary remote preview assets. Preserve the central outline workflow.

Root applied frontend-design and ui-ux-pro-max review guidance to this direction:
honor the supplied Obsidian reference, preserve keyboard focus and input, announce
failures accessibly, and provide concrete recovery. Existing three-second top
notices plus compact durable recovery override generic persistent-error advice.
Read those installed skills when implementing/reviewing the UI, within this
root-owned design. Do not delegate design or introduce a new theme.

CodeMirror's internal Text normalizes line endings. Do not save doc.toString() as
raw source. Keep an original raw buffer and explicit normalized-editor-to-raw
offset map, applying editor transactions as bounded patches. Preserve BOM, CRLF
and mixed line endings outside actual edits. A lineSeparator facet alone cannot
prove mixed-ending fidelity. Configure inserted newlines intentionally; do not
normalize the rest. Keep one stable EditorView through status/polling, language,
pane and view changes. Composition updates must not replace inputs/caret.

## Shared ownership and acknowledgments

ProjectSession remains the one writer queue, revision/history/receipt owner and
save scheduler. Add an explicit raw-source participant/adapter alongside planning,
or equivalently generalize the existing body participant. Do not run independent
source autosave or CodeMirror project history beside it. Preserve five transitions,
bounded pending checkpoints, original uncertain payloads and 5/10/30-second
preferences (default 10), off/window/manual behavior and native IME shortcuts.

Accepted source/hash/generation and canonical projection are core facts. Raw local
input is an owned buffer. Capture its generation and raw bytes before each action;
after every prerequisite await revalidate context. Include raw changes in visible
input identity even if the semantic projection is unchanged. Metadata/AI actions
settle only captured input and execute once through the shared composition intent.
Typing/background saves must not disable unrelated actions or replace the editor.

Save response includes an original receipt and a current snapshot, potentially
newer than that receipt. An acknowledgment may add proven markers. Map those
insertions through pending editor changes and revalidate ownership; never replace
newer input with the returned source. If mapping is ambiguous, retain both sides
and expose recovery. Delayed reads/ACKs cannot clear newer input, close a newer
conflict, change the pending request ID or silently switch the selected view.
Preserve user input/copy recovery during missing/unavailable source reads.

Use lightweight identity/events for unchanged-state polling. OP2 full source reads
parse native Markdown twice; do not refetch/reparse large unchanged source on
every planning/task poll. Fetch bindings when content identity changes. External
rescan verifies actual bytes; mtime alone is not proof of unchanged content.

## Manuscript surface boundary

Review/Locks/layout currently depend on Tiptap Editor and ProseMirror positions.
Extract a small manuscript surface port with legacy/source adapters for capturing
selection or explicit whole-block/document scope, block coordinates/scroll/focus,
selection/content/viewport subscription, annotations and protection decorations.
Keep the existing conversation/candidate/decision owners; do not duplicate review
UI or fake a Tiptap document that drops unknown Markdown.

Supported source selection maps to native block IDs and canonical text/grapheme
ranges. Prove mappings for inline marks, links, escapes/entities, code spans,
hard/soft breaks, Chinese/emoji, BOM and line-ending coordinates. Do not equate raw
Markdown offsets with decoded text offsets or guess by repeated text search.
Ambiguous/unsupported selections fail with a localized actionable notice; ordinary
supported partial selection and explicit whole-block scope must keep working.
Preserve locked ranges client-side while core remains the final policy authority.
Never turn one paragraph lock into a global editing fence or bump unrelated IDs.

## External inspection and stable reads

Add a registered-source watcher with debounced inspection. Events are hints, not
acceptance. Handle partial writes/rename/empty reads; require stable actual bytes
after a quiet interval before publishing a selectable candidate. Own-write echoes
must not add history. Reopen/focus/manual rescan repairs missed events. If native
watching is unavailable, expose an honest fallback with bounded rescan. Owned
watchers stop with lifecycle/quiescence and cannot keep project close hanging.

Store an immutable source candidate with project ID, accepted base hash/generation,
observed live hash and payload, native binding/capability results and stable
candidate identity. Use named generated APIs over HTTP/preload, never paths from
the browser. Missing/unstable/invalid input preserves accepted content and local
buffers; passive repeated reads do not stack notices.

External edits remain pending explicit acceptance even for a clean editor. A dirty
local buffer, accepted base and external candidate are three distinct versions.
Show a focused Changes/recovery surface via existing auxiliary-pane/dialog
primitives, with readable differences and clear actions. No raw JSON dashboard.
Keep local copy/download available. Let users accept external, keep current local
content, edit a combined proposal, or discard external; label the actual effect.
No automatic merge is required. An unproved merge never becomes silently saved.

## Frozen reconciliation and journal extension

OP2 v1 intents assume physical before bytes equal accepted metadata bytes. External
acceptance cannot satisfy that assumption: live bytes are already the candidate.
Extend the intent to version 2 with explicit accepted-before/accepted-after source
hashes separately from each physical before/after change. Read/recover existing v1
intents using their original rule before dispatching new operations; never rewrite
or reinterpret an unresolved v1 intent as v2.

Normal app save requires physical-before == accepted-before. External accept or
discard additionally binds a trusted persisted candidate ID/hash/base. At commit
revalidate generation, accepted base, actual live hash/identity, protected IDs and
actual policy scope. Acceptance stages the validated proposal, which may receive
native-proved markers. Discard restores the accepted source only if live bytes
still match the captured candidate. A newer external write invalidates the action.

One existing writer/journal/SQL/receipt seam owns promotion. Intent v2 records both
metadata generations and physical versions; SQL commits candidate disposition,
source generation, ordinary receipt and history atomically. On uncommitted
recovery restore physical-before and keep metadata-before; on committed recovery
validate/finish physical-after and metadata-after. Unknown bytes remain preserved
conflicts. A local mutex alone never authorizes overwrite of unseen file content.

One accepted content resolution is one grouped history operation. Discard without
accepted-content change does not add prose Undo history; source generation may
advance to fence stale physical observations. The full original action DTO binds
the receipt digest, including candidate/base/disposition/proposal. Replay is once;
same ID/different proposal conflicts. Do not replace trusted locks/history from
candidate payloads. Candidate/current/history/approval references pin raw objects.

Passive filesystem observations must not retain a full source snapshot forever
for every external autosave. Keep the current observed candidate, every candidate
referenced by an unresolved intent, and candidates explicitly protected by
`preserveExternal`. Retain at most five most-recent other automatic candidate
records for comparison. Prune obsolete rows/payload references under the same
writer, then use the existing collector for unreferenced blobs. Existing current,
history, approved and task roots remain independent. Explicit recovery/conflict
evidence is not automatically discarded. This comparison window is separate from
the five-step Undo history. Receipt-first replay must still work after an old
candidate row is retired; a changed payload with that request ID still conflicts.

Local dirty reconciliation uses a queue action that captures that buffer directly;
it must not first attempt a normal save over external bytes. Preserve any original
uncertain request until its outcome is resolved or fenced by the new generation.
Late responses cannot clear input typed after the chosen proposal was captured.

Expose pending intent status and a bounded named same-process recovery operation
bound to its captured intent hash/operation. Browser refresh does not reopen the
deployed core. Reuse a locked recovery helper to avoid recursively taking the DB
mutex. Recovery settles known file/SQL states, never initializes missing metadata
or erases unknown external bytes. Keep its action reachable after a tip expires.

Automatic recovery still refuses unknown bytes. Provide a separate explicit
`preserveExternal` disposition bound to the captured intent/original operation and
observed physical fingerprint (absence is distinct). Prove the current SQL commit
outcome and accepted generation, retain unknown live/staged evidence, and durably
record this recovery decision plus a trusted candidate against that accepted base.
A committed original keeps its receipt; an uncommitted original receives a
definite non-applied `SOURCE_EXTERNAL_CHANGE` outcome if no outcome already exists.
Never replace a valid earlier outcome. Only then clear the pending intent fence,
without overwriting live external bytes. Unknown stage artifacts remain intact.
Restart after decision/cleanup interruption resumes this disposition instead of
normal file promotion. A stale recovery choice rejects. Acceptance of preserved
external content is a separate guarded candidate resolution; this is not a force
write or automatic approval operation.

Provide a bounded read-only evidence list/member capability scoped to that durable
recovery and project. Users must be able to compare or download unseen staged
content after the pending fence is cleared, not just the latest live candidate.
List retained source versions with role/hash/size; exclude the journal JSON blob.
Fetch only verified members, preserving original bytes/BOM and representing
invalid UTF-8 honestly. Foreign hashes reject. This is not a general object/path
reader and never accepts or applies evidence automatically. Status/events remain
small and contain no raw evidence payload. Prove staged evidence retrieval after
cleanup/reopen and membership rejection.

A missing live manuscript is also an observed candidate with absent physical
before state, not the hash of empty content. Explicit discard restores the saved
file using no-clobber promotion; an external recreation invalidates that choice.
Accepting required-source deletion may refuse, while an explicit supplied source
proposal can recreate it. Recovery must handle absent-before states on both SQL
sides without deleting or replacing a newer external file.

Filesystem conflicts at AI-result application do not make a succeeded model
result invalid. With no definite application receipt, retain the original pending
application/artifact and allow only its local application to continue after
resolution. If explicit recovery definitively rejects that application command,
stop background replay of its ID and expose `not_applied` with retained binding/
artifact. A user can issue explicit `UsePlanningResult` with a new business request
and the same paid run. Never automatically mint that request or run inference
again. Prove both paths with one counted SDK call and duplicate-application guards.

## Delivery identity and clean Markdown

OP2 includes raw hash in new-format body identity and refuses lossy semantic
export for unknown leaves. Connect UI identity accordingly; do not recompute the
legacy canonical-only token for a source project. Provide full-source clean
Markdown copy/export: retain all authored content and strip only actual metadata
nodes using parser-owned ranges. Literal marker text inside code stays literal.
Do not persist through that presentation projection. Plain/DOCX may refuse unknown
content explicitly; no silent omission. OP5 ZIP keeps original marked source and
trusted management closure separately from clean presentation exports.

## Required verification and final freeze

Add dedicated new-format real-core browser cases, with a separate test project or
config so existing legacy suites still test legacy behavior. `scripts/dev.mjs`
passes `SCENESPARROW_PROJECT_OPEN_MODE`; use explicit `format-create` with a
nonexistent isolated root, no default switch yet. All fixtures stay sanitized.

Required cases: no-op/one-leaf BOM + CRLF + mixed-EOL + unsupported syntax edits;
held ACK and newer input/IME/caret; ordinary typing keeps unrelated controls active;
five-step local/saved history; AI initial draft and accepted revision appear in
actual MD; supported partial/whole-block selection and unchanged outside anchors;
lock A/edit B; active task scoped protection; self-write echo no duplicate history;
partial/missing external write and missed-event rescan; dirty local versus external
candidate; stale candidate/late resolution; v1/v2 intent recovery on both sides of
SQL commit, including external physical-before != accepted-before; duplicate/lost
ACK; explicit unknown-preserving recovery decision/cleanup interruption and stale
choices; missing-file discard/proposal with an external recreation race;
same-process recovery without restarting core; clean export preserves unknown
content and literal markers; three-second localized feedback plus durable recovery.

Run contracts/type/format/Clippy and affected Node/native/integration/browser gates.
Inspect actual screenshots for editor geometry/focus/overflow, not only selectors.
Root independently reruns key cases and reviews the diff before commit/push.
No paid provider, migration of real projects, arbitrary code execution, full media
workflow, deployment, merge or environment publication.

Use one `gpt-6.1-sol` high-effort coding writer, no delegation/Git/branch/worktree
actions. Root-owned specs/design/docs and preexisting `.agents/` stay untouched.
Source `scripts/cloud-env.sh` every shell; every Rust-invoking command, including
pnpm wrappers, uses `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
CARGO_BUILD_JOBS=4`. Record exact evidence and gaps; stop all writes and owned
checks/processes before handoff. Root may divide this large stage into sequential
coding substeps without bypassing its acceptance gate.
