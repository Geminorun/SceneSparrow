# Central writing workspace and unified assistant

Status: implementation authorized on 2026-11-17. Base: `release/1.0.0` at
`cefe535`. This replaces the former right-side creation form/task log, superseding
conflicting presentation in reference-workspace.md and editor-save-and-ai-feedback.md.
Keep existing durable planning/manuscript commands, evidence consent, locks,
five-step history, task-start configuration pinning and one-dispatch recovery.

## WW-01: Keys and service navigation

Saved credentials appear as a noneditable constant eight-bullet value with Saved,
Replace and Delete controls. They are never read back as plaintext. New entry
exists only for a missing key or explicit replacement; preserve per-provider UUID
drafts, ambiguous-write readback without resubmission and close-time secret clearing.
Remove the Manage saved configurations modal and its normal navigation path.
Saved legacy/custom profiles appear directly as service-list rows; preserve their
IDs, auth modes, models, bindings and explicit preset reassignment without deletion.

Use a dedicated non-login secret component. In Chromium/WebKit use a text input
with supported visual text masking, autocomplete off and API-token-specific
identity, without new-password semantics. Default to masking at first paint;
unsupported browsers use a masked password fallback rather than expose text.
Keep paste, explicit reveal/hide, no capitalization/spellcheck and optional
password-manager ignore hints. A headless input test does not establish every
native browser/extension prompt; report that limitation honestly.

## WW-02: Stable startup and view restoration

Remove full-page Opening workspace and manuscript-opening text screens. Mount a
warm, stable workbench skeleton with the normal ribbon/panes/content geometry,
accessible busy state and lightweight content placeholders while reads complete.
Do not mount writable empty content or initialize a replacement project after a
read failure. Restore the persisted project and view/pane preferences after success.
No new credential read, inference or browser-content persistence on startup.
Expose read failure/retry at the top notification layer rather than an inline page.

## WW-03: One top-layer error surface

All operation failures use the localized, bounded native-dialog-aware presenter.
Action-required errors remain until dismissed, resolved or deliberately replaced;
success notifications may time out. Preserve queue bounds, suppression of passive
repeats, current-action reporting, locale switching, safe codes/details, focus
and Tab/Shift+Tab behavior. Reopening must not replay historical task failures.

Support owner-scoped typed actions such as Retry, Model settings, Review changes
or Open library without storing secrets/raw vendor messages in notices. Callback
identities are ephemeral and must be cleaned up on owner unmount; do not resend
an ambiguous paid operation through a generic retry. Settings/config failures
route to the right global section. Task failures retry only on an explicit click.
Do not let a duplicate passive hook erase a richer active notice/action or attach
another operation's stale diagnostic target. Persisted error codes stay data.

Remove duplicate red error blocks and verbose failure prose from normal panels,
including planning/model discovery. Highlight invalid fields and expose compact
Unsaved/status badges without repeating full error text. Keep recovery functional:
copy/discard/conflict decisions remain explicit and may open a focused recovery
dialog from a top-layer action or compact save-status control. No blocking alert().

## WW-04: Distinct output limits and practical initial drafting

Keep generic AI independent of manuscript prompts. Distinguish known provider
finish_reason=length (OUTPUT_TOKEN_LIMIT) from app output/response byte bounds
(OUTPUT_SIZE_LIMIT); preserve safe codes through worker allowlisting and bilingual
presentation. Existing OUTPUT_TRUNCATED receipts remain readable. Do not mislabel
known size failures as network/auth failures. Expose actionable Model settings
for token failures and appropriate length guidance for size failures; no silent
continuation, repair, retry, provider fallback or partial-draft application.

New manually/discovered models default to an 8192-token output allowance, clamped
to an explicitly known model limit. Preserve existing explicitly saved budgets,
bindings and legacy preference inheritance; do not silently raise existing users'
cost limits or claim model names prove capabilities. Initial-draft prompts request
concise valid structure and the saved language/length, with a version bump if the
prompt changes. Reuse context/preparation checks and task-start snapshots.
Test an approximately 2000-Chinese-character complete initial draft in one counted
SDK request under the new allowance, plus truncated output preserving old content.
Real-provider acceptance remains independent of local fixtures.

## WW-05: Central outline and manuscript views

The central region edits either Outline or Manuscript for one project. One primary
manuscript remains authoritative; the outline is retained planning, not inserted
into spoken text or a second independent manuscript. The initial empty view is an
editable manuscript with optional AI assistance, never a mandatory creation gate.
An explicitly generated/applied outline switches to central Outline; a complete
initial draft switches to Manuscript. Ordinary refresh/history/polling cannot
steal focus or repeatedly switch a user's chosen view. Remember view per project
as nonsecret UI metadata and restore it when available; use sane defaults otherwise.

The Outline view is a continuous Markdown-like editing surface with headings and
key-point bullets, no card-per-node forms or Word toolbar. Support heading order,
depth (0..3), titles and key points; preserve node identities when editing/reordering.
Provide an honest bounded codec to the existing OutlineNode model; unsupported or
invalid syntax stays recoverable locally and blocks dependent dispatch, not silent
loss. Prefer the existing editor engine where it supports a stable implementation;
new dependencies need root review. Manual changes feed one PlanningAutosave owner,
not a duplicate state/queue. Keep IME, 5/10/30-second policy, manual/window saving,
five-step history and in-flight receipt fences. No paragraph locks/review in Outline.

Both views remain mounted where needed to preserve editor identity, local text,
selection and composition; hidden views are inert/nonfocusable. Real explicit
view switches settle valid inputs, preserve rejected/uncertain buffers and honor
the existing receipt barrier. Retain body-first save-before-business semantics.
Left Contents follows headings of the active central view; Library remains the
single reference tree. Existing nonempty manual/imported prose cannot be replaced
by initial drafting; use scoped review instead.

## WW-06: Unified assistant and comments

Replace Create/Review labels with AI assistant/Comments. The assistant contains
one compact context summary (view, references, already-loaded global text model),
a bounded activity/conversation presentation and one instruction input. Include
at most one primary next action for the current stage: Generate outline when
empty, Adjust outline when an instruction targets an existing outline, Write
draft from this outline after explicit confirmation, and question/revision entry
for existing prose. Users may always write manually. Do not add arbitrary tools,
code execution or an unrelated agent framework.

Topic and Chinese/English language belong to a compact brief; optional audience,
style and length share one progressive disclosure. The existing overall outline
instruction is the assistant's planning composer; one persisted planning owner
also holds evidence selections from Library. Keep explicit full text/excerpt/image
consent and honest link-only behavior. Reference chips show the selected count and
lead to Library, not another file list or a second evidence form.

On a manuscript, route Ask/Revise through the proven anchored review pipeline:
selection scope when present, explicit whole manuscript scope otherwise. Respect
locks and show revision candidates before user acceptance; never let AI unlock.
The Comments tab exposes anchored questions/notes/candidate decisions, with clear
short names. Keep follow-up, comparison/clear-comparison and batch acceptance.
Assistant replies should be human-readable; generated outline/prose belongs in
the center. Display only current progress with a meaningful Cancel action.

Remove the normal Planning tasks list, Prepared context, Prepare inputs, repeated
generation buttons, raw JSON preview and technical result/evidence blocks from
the right panel. Move necessary troubleshooting/provenance into an explicitly
opened diagnostics/details dialog or application-menu entry. It must not replay
or execute tasks. Retained usable unapplied results and recovery cannot become
inaccessible: offer clear owner-scoped recovery actions in a compact notification
or dedicated activity entry without restoring the old task dashboard.

## WW-07: Validation and delivery

Root owns design, Git and independent review. Use sequential substantial coding
slices with one source writer and frozen checks: (1) WW-01–WW-03 settings/startup/
feedback foundation; (2) WW-04 generic output handling; (3) WW-05–WW-06 central
writing/assistant integration and retirement of old UI. Root commits/pushes each
reviewed slice, then runs final check/build/integration/browser gates and opens a
ready English PR to release/1.0.0. No merge, live provider call, publication or
deployment is authorized. Preserve untracked .agents/ and unrelated processes.

Acceptance: initial and replaced keys mask correctly and avoid new-password
semantics; no Manage modal; legacy identities survive; startup has stable geometry
and safe failure recovery; active errors are top-layer-only and actionable above
nested dialogs; no historical replay; distinct counted token/size failures; one
complete ~2000-character Chinese initial draft; central outline edit/manual/AI
adjustment, unchanged node identities/history, automatic result view routing,
retained outline after draft, refresh view restoration; explicit reference consent,
locked-text protection, review candidates, five Undo/Redo, IME/focus and autosave
fences; mobile drawer access and Chinese/English screenshots of real workflows.
Update existing browser helpers/assertions to the new UI without bypassing
autosave or weakening paid-call/lock/receipt assertions. Remove retired UI code
and tests that only validate removed presentation. Preserve behavioral coverage.
