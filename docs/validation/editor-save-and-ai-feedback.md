# Editor save preferences and AI feedback validation

Date: 2026-11-17. Branch: `fix/editor-save-and-ai-feedback`, based on
`release/1.0.0` at `cbbb721`. PR:
[#14](https://github.com/Geminorun/SceneSparrow/pull/14).
Source: [approved SF-01–SF-07 design](../design/editor-save-and-ai-feedback.md).

## Implemented scope

SF-01–SF-03 add versioned renderer-profile preferences for delayed saving
(5/10/30 seconds, default 10), application-window/tab-change saving, or off.
Manuscript and planning share one coordinator; continuous typing has a 60-second
maximum dirty interval only in after-delay mode. Ctrl/Cmd+S saves both, while
required business commands and desktop close retain explicit settlement. Idle,
selection and field blur create local history boundaries without forcing writes.
Six retained visible checkpoints preserve the last five unsent transitions;
in-flight/uncertain commands keep separately protected inputs. Gear settings are
global; the existing project-name operation lives in Application menu → Project
settings. Preferences persist per browser/Electron profile, not across devices.

SF-04–SF-06 add a bounded localized notification store and a presenter hosted in
the active native HTML dialog. Errors remain visible above modal backdrops and
scrolled panels without taking typing focus. Known action/task owners report
failures; initial historical failures are not replayed. Repeated foreground errors
refresh safe details and remain reportable after dismissal; passive transport
failures are suppressed briefly. Focus/hover pauses dismissal and protects the
notice from queue eviction. Inline save/task recovery remains available.

Missing text defaults link directly to global Defaults; missing credentials link
to Model services. The model summary uses explicitly loaded settings and does
not initiate settings reads or inference when opening the editor. Saved keys use
a constant eight-bullet mask and explicit replacement. Missing, editing, saving,
saved, failed and unknown outcomes are distinguished; root-only saves cannot
resubmit a key after an ambiguous write. Saved means present, not vendor-verified.

Discovery shows the saved GET target and keeps manual model entry available.
401/403, discovery 404/405, known quota exhaustion, rate limits and provider-server
failures have distinct safe codes through the runtime and Rust allowlist.
Core HTTP status is labeled separately from upstream status. Vendor bodies,
arbitrary exception messages and key plaintext are excluded from feedback.

## Independent review and focused evidence

Implementation used two sequential coding writers with root review and separate
commits. Review corrected captured-input scheduling, body/planning coordination,
pending five-step history retention, known versus uncertain planning failures,
IME/manual-save routing, inherited-property error-code sanitization, modal
observer filtering, explicit-error deduplication and same-code request details.
Root's first full browser run also exposed a portal keyboard-routing gap: React
portal events bypass the native host's React handler. A shared dialog focus guard
now handles both regular dialog controls and portaled notification controls,
including nested-picker Tab/Shift+Tab wrapping. Eight affected browser cases passed
after that correction and test updates. The controlled-clock test now advances
minimal timer ticks after asynchronous receipts, preserving real autosave rather
than replacing it with manual saves; existing inline/toast assertions use explicit
owners when both feedback surfaces are present.

The save slice passed 93 focused unit cases and 26 distinct browser cases across
targeted runs. Root verified real-core body and planning buffers after 20 local
operations: five Undo transitions reach operation 14 and five Redo transitions
return to operation 19, with monotonic authoritative revisions.

The feedback slice passed 22 focused Node cases, one Rust allowlist case,
editor/runtime typechecks, contracts, two real-service HTTP variants and 11
distinct browser cases across focused runs. Session/encrypted fixtures each
verify six counted listing failures with no inference during listing. The browser
fixture additionally verifies one explicitly requested failed inference receipt,
unknown credential writes without resubmission, Chinese/English switching and
native-dialog hit testing/focus. The mounted diagnostics case passes against
rebuilt Web assets. Existing UUID-owned drafts, creation-alias retirement,
worker-PID ownership, secret isolation and test action identities remain covered.

Focused logs are local ignored artifacts: `/tmp/scenesparrow-save-unit.log`,
`/tmp/sf-feedback-units.log`, `/tmp/sf-feedback-final-browser.log` and
`/tmp/sf-feedback-diagnostics.log`. Earlier focused failures were repaired and
rerun; the diagnostics fixture required rebuilding its served assets.

## Final independent gates

Root reran all gates with implementation writers stopped after the portal-focus
and browser-assertion corrections:

| Command                      | Final result                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                 | Passed: generated contracts, formatting, workspace typechecks, 237 Node tests, 194 Rust tests and Clippy with warnings denied. |
| `pnpm build`                 | Passed: Web assets, Electron TypeScript and locked Cargo workspace. The existing large-chunk warning remains.                  |
| `pnpm test:integration`      | Passed: 11 cases, including session/encrypted credentials and worker ownership.                                                |
| `pnpm test:e2e`              | Passed in the final complete run: 68 cases; 3 opt-in performance cases skipped.                                                |
| Relative documentation links | Passed for all 9 changed Markdown files.                                                                                       |

Final logs are local ignored files:
`.artifacts/save-feedback-{check,build,integration,e2e}-final.log`.
Affected review regressions are in
`.artifacts/save-feedback-review-regressions.log` and
`.artifacts/save-feedback-delivery-review.log`. Rust commands used
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`; browser checks used the
rebuilt service through `SCENESPARROW_CORE_BIN` and managed Chromium.

## Visual inspection and limits

Root inspected desktop/narrow General preferences, nested model-picker feedback
and provider-error screenshots under `.artifacts/`. Screenshots use synthetic
local data and are not published product assets.
An additional Chinese 390-pixel flow verified the saved-key mask/replacement and
native-picker notice hit testing (top 12 px, right 374 px). Its discovery response
was intercepted locally, with zero provider calls. Screenshots are
`save-feedback-saved-key-narrow-zh.png` and `save-feedback-error-narrow-zh.png`;
the result is in `.artifacts/save-feedback-narrow-visual.log`.

No dependency, schema or project migration is added; applied migrations 001–010
remain unchanged. No automatic provider fallback, paid retry or eager inference
is added. Browser close still cannot guarantee async delivery; a crash can lose
unacknowledged buffers. Preferences do not store credentials or manuscript data.

Linux browser and local fake-provider checks do not establish Windows/macOS
native keyring, operating-system IME, profile packaging or actual-provider
interoperability. Existing large-document and attachment-heavy performance gaps
remain. No real API key, paid endpoint, merge, release or live deployment is part
of this validation.
