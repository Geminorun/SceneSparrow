# Editor saving and AI feedback follow-up

Status: implemented on 2026-11-17; independent validation is recorded in the
[validation report](../validation/editor-save-and-ai-feedback.md). Base:
`release/1.0.0` at `cbbb721`. This follow-up addresses the user's four reported usability problems
without changing the single-manuscript workspace, five-step history, shared AI
configuration, task-start pinning or encrypted credential storage.

## SF-01: Application preferences and save policy

The gear owns application-wide General, Model services and Default models.
General adds three save modes: `after_delay`, `on_window_change`, `off`.
After-delay choices are **5, 10 and 30 seconds**, default **10 seconds**. Show
the delay selector only for after-delay mode. In that mode continuous typing has
a fixed 60-second maximum dirty interval; a 30-second choice must never be
silently capped by the former two-second maximum. Off/window-change modes do
not run background delay/maximum timers.

Store versioned, nonsecret application preferences separately from AI settings
and project history. Shared renderer storage persists them in the current browser
or Electron profile, applies them across projects and handles invalid/unavailable
storage without breaking editing. Browser storage events update other tabs.
This does not add cross-device preference synchronization. A single shared store
supplies both manuscript and planning saves; policy changes preserve local edits
and reschedule/cancel timers rather than recreating editors.

`Ctrl/Cmd+S` explicitly saves the current manuscript and planning. AI generation,
Undo/Redo, import/export, business commands and desktop close retain their required
explicit flush/validation boundaries. Browser close warns when unsaved state
cannot be settled; do not promise asynchronous unload delivery. Window-change
means actual application blur/tab hiding, not moving between inputs or panels.

## SF-02: Local history boundaries versus network writes

Idle/selection/blur boundaries still capture distinct user operations, but do not
force a background write independently of the selected save policy. Basic editing
and discrete editor changes obey the policy; explicit business actions still
settle the authoritative state. Keep IME input local until composition completes,
serialize writes, preserve uncertain receipt identities and retain failure buffers.
Saving updates compact status without disabling/replacing active controls.

Long delays and off mode must not accumulate unbounded full-document snapshots.
Keep at most five unsent local history groups plus the current group, coalescing
within a group; never evict an in-flight/unresolved command or its captured input.
Retain the latest visible content and the established five-transition semantics.
Undo must be available for pending local edits even before the first timed save;
new local edits invalidate Redo's presentation immediately. Generation eligibility
must account for visible unsaved body content, not only acknowledged blocks.

## SF-03: Global and project settings

Replace reused workspace-opening labels inside AI/planning loaders with localized
operation-specific text. General explains application preferences and has no
project rename/help controls. Application menu exposes Project settings for
existing project metadata (currently the name), reusing the proven rename/CAS,
receipt, stale-title and local-editor preservation behavior. Keep project
open/recovery/backup/recent operations and creative brief fields in their existing
appropriate workspaces; do not invent unavailable settings.

## SF-04: Shared notifications and localization

All user-facing asynchronous action failures use a shared notification store and
localized presenter, including business rejections, transport errors, AI preflight,
task failures, settings/credentials, sources/import/export and project operations.
Keep specific inline validation/recovery state in addition to the notification.
Catch awaited actions at their ownership boundary; error boundaries/unhandled
rejection handling are a sanitized fallback, not a substitute for action handling.

Show a compact red notification near the top of the viewport, outside scrolling
panel content. It must remain visible and interactive above native `showModal()`
dialogs and nested pickers: a body portal with a large z-index alone is insufficient.
Use an appropriate host in the active dialog/top layer, preserve keyboard focus
and announce errors accessibly. Do not replace the existing workbench layout or
introduce blocking alert dialogs.

Deduplicate repeated errors and bound the queue. Ordinary notifications dismiss
after a short interval or explicitly; failed saves retain persistent compact
status/recovery actions. Cancellation is not an error. Background recovery does
not flood the screen. Store stable codes/translation keys so locale changes update
visible messages. Unknown errors receive a localized fallback, never raw SDK
messages, responses, keys or arbitrary exception text. Details may show safe
codes, HTTP information and existing validated trace IDs.

`CONFIGURATION_UNAVAILABLE` says the global manuscript default is missing and
offers Open settings directly at Default models. Missing credentials routes to
Model services. Opening the editor must not initiate inference or a new eager
credential/settings read. Model summaries may use already loaded configuration;
configuration controls remain global and no per-project override is added.

## SF-05: Credential state and model discovery

Saved credentials show a constant masked presentation and an explicit Replace
key action, rather than an apparently emptied input. The mask contains no actual
saved key characters. New-entry visibility controls apply only to typed input.
Distinguish missing, editing/unsaved, saving, saved, partial/unknown and failed.
Saved means present in the configured store, not verified by the vendor.

Preserve current UUID-owned provider drafts, service-switch isolation, partial
save readback and close-time secret clearing. Never return stored plaintext to
the renderer or write it to renderer storage. Ambiguous writes must not be
silently retried or falsely confirmed. Keep old valid configuration/key state
until a successful replacement; model listing failure never clears saved models,
changes a default or deletes a key.

Discovery shows the saved service and actual `GET <root>/models` target. Keep
manual model addition available after failure. Connection inference remains an
explicit quota action with its captured action/session identity, without automatic
redispatch, fallback or unrequested paid testing.

## SF-06: Provider error classification

Separate upstream 401 authentication rejection from 403 access rejection. Discovery
404/405 describes a missing/unsupported model-list endpoint, not a missing chosen
model. Preserve distinct quota/rate, timeout/network and provider-server failures
when supported by safe known information. Allowlist provider quota codes; never
forward arbitrary vendor messages/bodies. Keep codes generic to shared AI rather
than manuscript-specific. New stable codes must survive the Rust worker error
allowlist and have both `en` and `zh-CN` presentations.

Do not invent upstream status information that is unavailable. Existing core HTTP
status/trace and the saved nonsecret request target remain useful context. No
protocol/project migration is required solely to preserve raw SDK exceptions.
HTTP/auth/origin boundaries, SDK `maxRetries: 0`, redirect refusal and secret
isolation remain in force. The reported live key's exact rejection reason is not
established by a local fixture; do not claim actual-vendor verification.

## SF-07: Delivery and acceptance

Implementation uses two sequential coding slices with root review/commit/push:
(1) SF-01–SF-03 preferences/save behavior/settings scope; (2) SF-04–SF-06 shared
notifications, model/credential feedback and error classification. Root owns this
design, implementation review and final evidence. Use the user-selected coding
agent configuration and one writer per shared checkout. Preserve `.agents/`.

Acceptance covers all delay choices/default persistence, no early writes through
old 300/750ms/selection paths, off/window behavior, keyboard/manual flush and
save-before-business actions; bounded pending groups, five Undo/Redo and IME/focus
across delayed acknowledgements; project settings isolation and metadata races;
Chinese/English preflight/task/transport failures visible above nested dialogs;
deduplication and retained recovery state; masked saved/unknown key feedback and
cross-service isolation; counted discovery 401/403/404/405/quota/server errors,
manual models after failure and no automatic paid calls.

Use controlled timers for long-delay tests and real behavior assertions, not
30-second sleeps per case. Adapt existing tests without replacing autosave/IME
assertions with manual-save shortcuts. Final root gates include relevant unit,
contracts/typechecks, build, integration and browser suites plus desktop/narrow
visual inspection. Record native OS/real-provider and existing performance gaps
separately. No automatic merge, release, deployment or live-provider request is
authorized by this implementation.
