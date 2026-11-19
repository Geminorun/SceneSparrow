# OP5-C: visible transfer workflows and streamed platform delivery

Status: root-frozen for coding after accepted/pushed OP5-B `9c8a24c`, 2026-11-19.
Read its validation and the [exact brief](open-project-op5c-handoff.md). Completes
OP5-T07 and visible A/B workflows; host activation is still OP6. Root owns
specification, product decisions, acceptance docs and Git.

## Visual and interaction direction

Apply the installed `frontend-design` and `ui-ux-pro-max` guidance within the
user's existing Obsidian/Notion direction. Reuse `WritingDialog`, the current
notification presenter and workspace CSS tokens: paper `#f6f5f2`, panel `#efeeeb`,
ink `#37352f`, muted `#716f68`, accent `#4070a0`, danger `#a3332b`. Keep the existing
system/CJK font stack, compact 14 px controls, left-aligned content and one clear
primary action. Do not add a new theme, hero, decorative cards or marketing copy.
Desktop web controls retain visible focus and at least a 24 CSS px hit target;
small touch layouts can expand the hit area without oversized desktop buttons.

Use a heading/close row, compact file or operation summary, actual phase/progress
and contextual action row. Progress does not remount inputs or steal focus.
Current `WritingDialog` supplies focus trapping/return; notification presentation
already follows the topmost native modal. General React guidance is to clean up
subscriptions/timers; the repository's captured-owner/session rules govern stale
responses. Do not substitute a mutable latest-props callback for an old operation's
captured context. User-requested three-second top notices and compact durable
status take precedence over generic recommendations for inline error panels.

## Shared workbench flow

Use the existing application menu and focused accessible operation dialogs for
legacy conversion, complete project export, package inspection/restore and returned
edits. Keep the existing off-white Markdown workbench, sidebar organization,
compact controls and English/Chinese resources. No new workspace/project-name
gate, permanent dashboard, Word toolbar, gear-based project settings or duplicate
Changes acceptance owner. Global settings remain global.

Conversion shows read-only source facts, normalization/backup notice, explicit
new-target action, bounded phase/progress and durable success/failure/interruption.
The original remains active. A ready target is an offered later activation action,
not an automatic replacement of the mounted source session. Until OP6 supplies
that capability, show an honest available/unavailable state and retain the ready
operation; no fake App metadata update or filesystem path passed to the renderer.

Export identifies a fixed saved generation. Capture owning editor/planning input
and context before awaits, settle only that captured input through ProjectSession,
then obtain the required base tokens and submit once. Newer typing stays local
and remains editable. Existing composition intent, close/dirty guards, uncertain
original DTO owners and known-applied source-conflict recovery remain authoritative.
Ordinary typing/background saving must not disable unrelated actions.

Import inspection can run while current content is dirty, because it cannot change
the active project. Show safe filename/type/count/generation/verification facts
and explicit independent restore versus returned-edit choices. A failed verified
restore is not silently downgraded to unlocked adoption. Returned edits use the
existing Changes actual-diff/grant/base/lock/accept/discard flow; no supplied DB
replacement or implicit approval. Missing trusted base explains independent
restore/adoption options instead of guessing.

Keep the original operation/request ID after an ambiguous response and offer
status/reconcile for that ID. Separate original command outcome from current
operation/project readback. Do not generate a new export/migration/restore merely
because a status read failed. Late progress cannot close a newly selected dialog,
clear newer input, replace a later controller or activate a different target.
Capture owner/context/operation/selection and revalidate after each await.

Three-second localized top-layer notices report each explicit failure episode;
status and compact retry remain accessible after the notice fades. Passive polling
does not repeat errors. Cancel follows the backend's original control semantics
and never claims to undo an already promoted target. Dialog close is distinct
from cancellation. Include keyboard focus trapping/return, labels and reduced
motion. Review actual screenshots at normal and narrow widths.

## Browser streaming

Use named typed PlatformClient methods and existing same-origin operator auth,
exact-origin write checks and private loopback core boundary. Browser input is a
File, never a server folder/path. Hash incrementally with File.stream or bounded
File.slice chunks and a pinned incremental SHA-256 implementation; do not call
whole-file arrayBuffer/WebCrypto digest for an 8 GiB archive. A bounded first hash
pass followed by upload is acceptable. Keep upload chunks bounded, exact offset/
length/chunk hash, identical chunk acknowledgment replay and final length/digest.
No JSON/base64 binary transport or unbounded request aggregation.

Download a ready authorized immutable package through a same-origin authenticated
attachment URL. Use an anchor/browser stream, not fetch.arrayBuffer plus Blob for
the whole package. Safe generated filename and fixed snapshot identity are shown.
OP6 later binds this route to immutable activation context; it must remain private
and operation-authorized meanwhile. Cancel/abort and navigation release readers.

## Electron adapters

Use named main-process file chooser, streamed intake and save capabilities.
The renderer sees safe facts/opaque IDs, not chosen native paths, generic fs/shell
or arbitrary object access. Validate sender and argument shape through existing
sandbox/context-isolated preload conventions. Resolve the current core/session
before prerequisite awaits and retain it; do not retarget a completed chooser
through a later mutable host.session(). OP6 adds activation-epoch fencing.

Stream native reads and save writes with bounded buffers and exact expected
length/hash. Use a trusted resource-specific 8 GiB archive policy while preserving
the 4 GiB ordinary-member limit. The exact brief selects a private native core
delivery operation; do not extend the existing check-then-rename JavaScript save
path for package delivery. Actual destination I/O must remain bound to held native
parent identity; a path precheck followed by an ordinary overwrite rename is not
preservation. Root freezes the private native delivery seam after B; new-file-only
no-clobber archive save avoids implicit overwrite authority. Native save cancel
is a truthful benign outcome, destination
replacement/link changes are refused, and any unknown bytes remain preserved.
No renderer-provided numeric cap, path or expected artifact overrides core facts.

## Verification and handoff

Use actual core HTTP browser cases for conversion, fixed-snapshot export, safe
intake/inspection/restore-ready and returned creative acceptance. Verify a later
edit stays out of export, held acknowledgment retains original ownership, lost
status retains its owner, a late result cannot close a newer dialog, and typing/
IME/focus remain stable during progress. Check first/duplicate chunk, interruption,
cancel, unsafe ZIP and localized failures. Native adapter tests exercise sender,
stale session, canceled chooser, streaming/cap and destination identity guards.

Keep legacy and source editor suites distinct; default startup is not changed here.
Run affected Node/types/contracts/build and focused browser suites on frozen UI
bytes, then stop all checks/processes/writes. Record exact file/checksum manifest
and evidence in `.artifacts/op5c/HANDOFF.md`. Root independently reviews/testing,
writes validation, commits and pushes before OP6. No speculative app code preview
or imported dependency execution is enabled.

Every shell sources `scripts/cloud-env.sh`; Rust commands/wrappers use zero debug
profiles and `CARGO_BUILD_JOBS=4`, no concurrent Cargo. No child delegation, Git
mutation, worktree, real user conversion, paid provider, merge/tag/deployment or
cloud publication. Preserve root docs and `.agents/`.
