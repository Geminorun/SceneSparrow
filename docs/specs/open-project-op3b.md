# OP3-B: source editor and shared authoring integration

Status: implementation authorized, 2026-11-19. Backend checkpoint: `c4fac7d`.
Read [OP3](open-project-op3.md) in full; it remains normative. This brief fixes
the coding assignment for OP3-T01–T03, visible T04–T06 and T07. Root owns design,
specs, review and Git. OP3 remains incomplete until this checkpoint passes.

## Scope and ownership

Implement inside existing `packages/editor-ui/src/{manuscript,project-session,
workbench,review,delivery,planning,feedback}` owners. Allowed supporting changes:
locales/styles, a pure source mapping utility in manuscript-format, pinned public
editor dependencies and lockfile, typed client use, focused unit/browser fixtures,
and a dedicated source-mode Playwright config/dev pass-through. Preserve the
legacy authoring route. Do not change core schemas/migrations, journal policy,
stage specs/design/docs, application defaults, project ZIP/migration or media
execution. Report a concrete backend blocker to root before changing that scope.

Read `AGENTS.md`, architecture/development workflow, the writing-workspace and
save/feedback designs, source codec/API implementations, and
`.artifacts/op3a/HANDOFF.md`. Read installed frontend-design and ui-ux-pro-max
skills at `/home/agent/.agents/skills/`; apply their interaction/accessibility
guidance within the existing root-owned Obsidian direction, without a new theme.

## Editor and raw buffer

Use CodeMirror 6 only for native source-capable projects. A capability read can
distinguish legacy `SOURCE_CAPABILITY_UNSUPPORTED` from failures: a failing native
read must never become a blank legacy document. Keep one mounted editor instance
and one ProjectSession per mounted project. Outline/manuscript switching retains
buffers and focus ownership; hidden surfaces are inert. Do not instantiate a
parallel application/session or persist through canonical/Tiptap serialization.

CodeMirror's normalized Text is a view. Maintain exact original raw bytes/text and
map transaction ranges to raw offsets; no-op and unrelated edits must preserve
BOM, CRLF and mixed EOL. Inserted newlines use a deliberate local convention.
Pure transaction/ack mapping must reject invalid scalar/ambiguous boundaries.
Never save `doc.toString()` as full raw source. Metadata comments remain raw and
may be hidden through safe decorations; do not replace the composing caret line.
Provide live Markdown styling and a source toggle with compact existing controls.
Do not execute embedded HTML/JS, load remote preview images or add a Word toolbar.

Live presentation must be visibly distinct from syntax-highlighted source. Outside
the active caret/selection/composition lines, hide proved Markdown formatting
punctuation for headings, emphasis/strong, code spans and links while keeping
their text styled/readable; source mode reveals it. Handle entity presentation
only through proved token ranges and selection mapping. Unknown syntax stays
literal. Hide complete metadata-only presentation lines and their codec separators
without leaving large artificial vertical gaps; preserve authored paragraph
spacing and empty blocks. Decorations never change raw bytes or hide literal
marker text inside code. Active lines remain source and retain stable IME/caret.

Hidden identity metadata must not make ordinary live editing unsavable. Clearing
and retyping one proved paragraph preserves its identity using the codec's explicit
empty-leaf representation; new/copied content receives native-assigned identities.
Normal live copy/paste must not duplicate hidden block IDs. Explicit source mode
retains access to actual raw metadata and its validation errors. Use parsed ranges
and bounded patches, preserve literal code markers, and retain native protection
and independent leaf scope. Test actual CM delete/retype/copy/paste, not just a
whole-source replacement helper. Report a concrete native scope gap to root.

Source offset and selection maps come from actual parsed tokens/native bindings,
not searching for decoded block text. Cover raw source to decoded grapheme ranges
for marks, escaped punctuation, links, entities, code spans, hard/soft breaks,
repeated text, Chinese/emoji, BOM and mixed EOL. Unknown/ambiguous regions stay
editable source but refuse unsupported review scopes with a localized explanation.

Batch missing-ID acknowledgment proof uses one captured syntax tree and one final
meaning/binding proof. Do not call the single-ID whole-document parser/prover per
leaf. Preserve frozen single-insertion bytes and native batch agreement; return
planned scalar-safe metadata insertions for the view/ACK adapter. Retire already
acknowledged checkpoints before doing work on retained newer checkpoints, and
stage mapped checkpoints before assignment so a later failed proof cannot leave
partially modified history. Root reproduced a receipt-path freeze of about 1 s
for 100 paragraphs and 8 s for 300 before this correction; report corrected
bulk samples without claiming complete large-document interaction acceptance.

## Session, input and history

Generalize the existing ProjectSession body participant to own raw local input,
accepted hash/generation, canonical read model, pending original source DTO,
bounded checkpoints and visible input generation. Planning retains the same queue
and scheduler. All actions retain existing composition intent, revalidation,
deduplication and actual policy fences. No independent CodeMirror project history
or source autosave timer. Preserve 5/10/30 seconds (default 10), off/window/manual,
local-only boundaries and five project transitions.

Every raw change advances input identity even when the semantic blocks match.
Capture the input/context before every prerequisite await. A delayed ACK returns
an original receipt and possibly newer current snapshot: these are different
facts. Proven marker insertions may be mapped through newer local transactions;
unprovable mapping preserves local and accepted versions for explicit recovery.
Never erase newer input, flush it early, steal selection, reset composition or
change an uncertain request ID. No unrelated disabled controls while typing or
background saving. Real active jobs/locks and action prerequisites still apply.

Use lightweight manuscript identity and source status for unchanged polling.
Read full source/bindings only on changed content identity or explicit recovery.
No full Markdown parse per unchanged task poll or scroll/selection event.

## Manuscript surface port

Extract one small manuscript surface interface shared by legacy and source
adapters. It supplies supported selection/explicit block scope, block rectangles,
scroll/focus and change subscriptions, review/protection decorations. Migrate
existing Review, Locks and layout callers to that boundary; retain conversation,
candidate, acceptance and history owners. Do not emulate a lossy fake Tiptap tree
or create a separate source review UI.

Ordinary supported partial selection, explicit whole block and whole manuscript
must work. Whole-document unsupported semantic actions refuse honestly. A locked
A cannot be changed/deleted by raw input; an independent B remains editable and
its save/Undo/Redo cannot bump A's revision or move its review anchor. Native
policy remains authoritative. Active task scope uses actual protected IDs.

## Visible external changes and recovery

Use the accepted optional APIs from OP3-A:

- `readAuthoredSource`, `saveAuthoredSource`;
- `readAuthoredSourceStatus`, `rescanAuthoredSource`;
- `readAuthoredSourceCandidate`, `resolveAuthoredSource`;
- `recoverAuthoredSource`;
- `readAuthoredSourceRecoveryEvidence`, `readAuthoredSourceRecoveryVersion`.

Expose a compact durable Changes/recovery entry near save state, independent of
three-second top notices. Focused existing dialog/auxiliary primitives show
accepted, local dirty and external versions with readable differences and clear
effects. Offer accept external, keep local through a captured proposal, editable
combined proposal, and discard external by restoring accepted source. Never
autoaccept, even with a clean buffer. Keep copy/download of unsaved local content
available while reads/saves fail. Invalid UTF-8 evidence downloads exact base64
bytes, with no replacement-character preview pretending to be faithful content.

Compare local and external against the saved base with readable changed-line
hunks/highlighting and bounded context, not only three full-source textareas.
Raw versions and combined-source editing remain available as deliberate details;
default presentation prioritizes changed prose and clear actions. Use bounded
diff work/preview with explicit truncation and full download for large changes.
Identity changes remain visible as metadata changes, never silently discarded.

Combined-proposal editing follows the same raw preservation rule as the main
editor. Browser textareas normalize line endings, so their complete value cannot
replace the raw proposal. Apply bounded normalized-view edits to its original raw
buffer, preserving untouched BOM/mixed EOL/markers. Prove a one-line combined edit
does not normalize unrelated locked content. Read-only display may normalize its
view; exact recovery downloads retain the original bytes.

Dirty resolution captures its proposal directly through the project queue; it
must not first attempt a normal save over the external file. Bind decisions to
captured candidate/base/generation. Revalidate after awaits. A late response must
not close a later conflict or clear subsequently typed content. Missing candidate
is distinct from empty text. Accepting required deletion refuses; explicit
restore/proposal uses native no-clobber behavior. A newer external file stales it.

Pending intent recovery binds the original operation `requestId` plus captured
`intentHash`. `preserveExternal` also binds the opaque observed fingerprint.
Known recovery and explicit unknown-preserving recovery are separate choices.
Durable evidence list/member views make retained staged versions accessible after
the fence clears. Evidence operations are read-only and cannot bypass native
candidate acceptance. A late old recovery cannot dismiss a newer pending intent.

On succeeded AI application conflicts, show waiting-to-apply rather than generating
again. With no definite outcome, preserve the original pending application; after
definite non-application, offer explicit application of the retained paid result
with a new business request and unchanged run. Do not mint that request in polling
or trigger inference as a retry side effect. Preserve actual planning semantics.

## Delivery and presentation

Use core source-aware body identity for staleness. Source clean Markdown copy uses
`prepareCopy` with `format: "md"`; export uses existing `startExport("md")` flow.
Never create presentation output by a lossy canonical round trip. Handle legacy
MD-copy capability explicitly rather than breaking its old copy/export controls.
Plain/DOCX errors for unsupported syntax are localized. Keep exact original source
available for local recovery, distinct from clean presentation copy.

New strings have English and Simplified Chinese catalog keys. Use accessible
status/alert announcements, keyboard focus containment/return, responsive dialog
widths, readable labels and no raw JSON dashboard. Top notices fade after three
seconds; recovery remains reachable. Retain compact Library rows, panes, neutral
canvas, right-edge locks and approved ribbon geometry.

## Evidence and handoff

Root approved one bounded backend correction during B: extend the existing durable
command-rejection decoder with applicable OP3-A source error codes, including
SOURCE_CANDIDATE_STALE, SOURCE_CANDIDATE_INVALID, SOURCE_RECOVERY_STALE and
SOURCE_REQUIRED_FILE_DELETED. Strict source receipt ownership exposed stored
rejections incorrectly decoding as STORAGE_UNAVAILABLE. Add native and HTTP
original-receipt/exact-replay regressions; no journal/schema/migration expansion.

Root also approved the concrete CRLF semantic-projection correction found while
mapping actual source selections. Raw source/offsets stay byte-exact. Canonical
text normalizes CRLF and lone CR to LF; hard breaks remain LF. Inline code follows
CommonMark: derive its content from the parser-proved raw delimiter range, replace
each line ending with one ASCII space, then remove exactly one leading/trailing
space if both exist and the content is not entirely spaces. Do not trim an already
trimmed parser value a second time. Match native projection, UI selection and live
presentation, including LF/CRLF/CR, edge padding, all-space code, entities/escapes
literal inside code, Chinese/emoji and grapheme anchors. Ordinary supported CRLF
paragraphs must not silently become semanticEditable=false. Add domain/native
and client/browser regressions. This fixes unreleased source projection semantics;
it does not rewrite raw files, IDs, old migrations or legacy project behavior.

Root approved a bounded native root-leaf structural scope extension after live
paste exposed the existing unequal-ID-set fallback. Proved insertion/removal of
ordinary root paragraphs/headings/empty leaves must remain independent of locked
unmodified A. Keep the lock in the test. Extend native proof, not permission.
Initially restrict this additional proof to documents whose actual root nodes
are only supported bound leaves and their recognized metadata (or a truly empty
source); images/unknown HTML/code/list/container effects retain conservative
behavior. Prove all native projected identities, unique metadata, unchanged
surviving order/ownership and exact raw bytes for unchanged leaves. Compare raw
whitespace gaps for boundary pairs that remain adjacent before/after; only gaps
at inserted/deleted leaves may change. Preserve BOM. A changed unrelated gap,
unknown node, movement, lost protected ID or unproved structure cannot use this
proof. Actual semantic/raw affected IDs include added/deleted/changed leaves;
unmodified A keeps revision/anchor/lock. Existing active whole-task and scoped
reservation guards still apply, including empty-source generation. Add native and
real CM paste/add/remove/Undo/Redo cases with locked A plus negative unknown/
container/gap/locked-deletion controls. No schema/journal/migration change.

Add a dedicated source-mode browser config using an isolated NONEXISTENT project
directory with `SCENESPARROW_PROJECT_OPEN_MODE=format-create`. Existing legacy
suites keep legacy behavior. `scripts/dev.mjs` already spreads process env; do not
pre-create the target root or switch product defaults. Tests may use a sanitized
server-owned fixture directory for actual external file writes, never renderer
filesystem access or a test-only production mutation API.

Required focused cases (combine related steps where that makes tests stronger):

1. Raw no-op/one-leaf edits retain BOM, CRLF/mixed EOL and unsupported regions.
2. Held source ACK plus newer typing/IME retains caret/input; no early flush and
   no unrelated disabled controls. Ambiguous requests retain original payload/ID.
3. Shared source/planning manual/autosave and five-step local/saved Undo/Redo.
4. Partial selection and block review across inline syntax/Chinese/emoji;
   independent lock A/edit B with unchanged A anchor/revision and B Undo/Redo.
5. Actual AI draft/accepted revision updates the MD file; active scope stays guarded.
6. Self-write echo adds no history; clean external change still needs acceptance;
   dirty/local/external are retained; stale and delayed choices cannot erase input.
7. Partial/missing external writes and missed-event/manual rescan preserve content.
8. Same-process known/unknown recovery, evidence download and stale pending choice,
   with exact fixture injection through native test setup if needed, not broad IPC.
9. Retained succeeded AI result applies without a second counted SDK call.
10. Clean Markdown copy/export includes unknown content and code-literal markers.
11. Existing legacy unit/browser regressions, locale and focus/overflow checks.

Unit-test pure raw mapping/selection and held ACK ownership; browser-test actual
EditorView/session behavior. Run contracts/typecheck/format/Clippy as affected,
focused native regressions if supporting core changes are authorized, UI unit
tests, both legacy and source browser evidence. Capture screenshots and inspect
actual editor/dialog geometry, selection and overflow. Record exact commands,
counts, initial failures/fixes and platform/performance limits in
`.artifacts/op3b/HANDOFF.md`. Do not claim unrun native GUI/packaging checks.

One `gpt-6.1-sol` high-effort writer. No subdelegation, Git, branch/worktree,
deployment, environment publication, real provider or user-project operations.
Preserve preexisting untracked `.agents/`. Source `scripts/cloud-env.sh` in EVERY
shell. EVERY Rust-invoking command/wrapper uses
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
No concurrent Cargo builds. Stop all writes and owned processes/checks before
handoff; root then independently reviews/tests and submits the checkpoint.
