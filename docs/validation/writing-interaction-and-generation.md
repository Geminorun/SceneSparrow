# Writing interaction and generation validation

Branch: `fix/writing-interaction-and-generation`, based on `release/1.0.0` at
`546c050`. PR: [#17](https://github.com/Geminorun/SceneSparrow/pull/17).
Source: [approved WIG-01–WIG-05 design](../design/writing-interaction-and-generation.md).
Validation date: 2026-11-18. This records focused evidence before the final source
freeze; the PR records final full-suite and current merge-commit CI outcomes.

## Scope and review

WIG-01 uses one bounded, source-aware composition intent gate across creation,
review, sources, history and exports. Ordinary input/background saving does not
disable unrelated controls. Actions wait for final composed text, revalidate
ownership/context and execute once. Acknowledgments preserve later input; queued
history navigation rebases only over its own preceding canonical transition.

WIG-02 adds fixed-slot compact reference rows, keyboard-accessible title/details,
bounded full-URL scrolling, explicit copy/open/rename/remove, optional title with
domain fallback and persistent read recovery. No webpage fetching is added.
`RenameSourceLink` retains exact URL/ID, monotonic revisions, request receipts,
history and existing link-only choices. Current unhandled review request versions
advance; frozen manifests and handled decision evidence remain unchanged.

WIG-03 replaces the normal results modal with right-pane generation history.
Central editors and both assistant composers retain identity and unsent text.
Status/cancel, viewing current content, applying a retained candidate and starting
a new paid generation have separate controls. The core revalidates retained
candidates at Use; a later dependency change can reject an otherwise visible
action safely. Diagnostics are collapsed; timestamps are omitted because the
current task API does not supply them. Remaining recovery dialogs use defined,
opaque theme surfaces and a fixed header.

WIG-04 removes all editable output-token controls and both compatible request
token keys. Actual usage and model capability metadata remain. Input/context,
byte/deadline/schema protections and complete-output application remain enforced.
WIG-05 expires all notices after 3000 ms plus a 190 ms fade, pauses remaining time
on hover/focus and preserves recovery after expiration. Passive polling cannot
replay expired episodes; a subsequent explicit failed action can report again.

Implementation used one writer at a time and reviewed checkpoints. Root inspected
contracts, compatibility, command/history transitions, UI ownership and screenshots.
Independent coding review identified and verified corrections for post-await
Review input changes, later Add/Rename text, newer desktop-close recovery decisions
and duplicate submission replacing an owned abort controller. These are covered
by held-acknowledgment/held-prerequisite regressions, not timing-only sleeps.

## Focused evidence

All shells sourced `scripts/cloud-env.sh`; Rust-invoking commands used
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
Browser checks used the pinned Playwright 1.65.1 Chromium headless shell.
The following counts are separate focused runs and are not a unique-test total.

| Acceptance                  | Executed evidence                                                                                                | Outcome                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| WIG-01, WIG-05              | Composition/notice units independently rerun by root                                                             | 18 passed                                                               |
| WIG-01, WIG-05              | Focused owner/save/review/notification units                                                                     | 116 passed                                                              |
| WIG-01, WIG-05              | Browser save, IME, recovery and interaction checks                                                               | 28 passed; manuscript 6 and startup 3 also passed                       |
| WIG-02                      | Core rename CAS/no-op/duplicate/undo/reopen, planning consent and review evidence tests                          | 3 passed, independently rerun by root                                   |
| WIG-02                      | Real-service documents HTTP integration including rename conflict/receipt behavior                               | 1 passed                                                                |
| WIG-02, WIG-03              | Focused units after Library/history implementation                                                               | 96 passed                                                               |
| WIG-01–WIG-03, WIG-05       | Sources, WIG input and initial Library/history browser group                                                     | 21 passed                                                               |
| WIG-01–WIG-03, WIG-05       | Final Library/history race/recovery browser suite                                                                | 8 passed                                                                |
| WIG-01–WIG-03, WIG-05       | Root follow-up for repeated explicit read failure and failed manuscript-save ownership after toast expiration    | 2 passed                                                                |
| WIG-03                      | Existing native-close bridge recovery regression                                                                 | 1 passed                                                                |
| WIG-04                      | Runtime/settings/desktop Node tests                                                                              | 27 passed; root independently reran runtime/settings: 22 passed         |
| WIG-04                      | Rust AI, planning and review groups                                                                              | 17, 29 and 50 passed; root independently reran AI unit group: 15 passed |
| WIG-04                      | Encrypted/session AI settings and output-limit HTTP integration                                                  | 3 passed                                                                |
| Contracts and static checks | Generated TS/Rust consistency, workspace typecheck, touched formatting/Rustfmt, infrastructure all-target Clippy | Passed at reviewed checkpoints                                          |

The output-limit integration observes exactly one compatible request for a complete
approximately 2000-Han-character draft with neither token key. Separate supplier
length and response-size failures each make one request and never apply partial
content. Upgrade fixtures observe zero provider calls for old undispatched queued
runs and exactly one for an explicit distinct fresh task. Encrypted settings bytes,
historical config/fingerprints, start/completion receipt replay and reservation
cleanup remain checked.

Root inspected populated English/Chinese Library and history images, including
the 200 px Library. Automated layout checks cover 200/240/360 px panes, narrow
drawers and 150% zoom. Long URLs remain exact/copyable within a focusable scrolling
region bounded to 108 px; titles, selection and menu controls keep separate slots.
Images/logs are ignored local artifacts under `.artifacts/wig-*`.

Earlier PR checkpoint CI found an Undo/Redo acknowledgment race and an ambiguous
global Retry test selector after persistent skeleton recovery was introduced.
The former now has deterministic held-Undo and later-user-input regressions; the
latter targets its actual skeleton owner. Final delivery requires the current
PR merge commit's Foundation checks, not a prior checkpoint's outcome.

## Compatibility and limits

Current live DTOs reject retired token fields. Narrow legacy readers remove only
those fields in memory, preserving stored bytes and fingerprints. Old queued,
undispatched tasks settle `CONFIGURATION_STALE` and release reservations before
credential/provider access; retry is an explicit new task. Dispatched/terminal
facts remain immutable. Update clients/core/worker together and refresh clients
left open across the upgrade. Migrations 001–010, vault/master keys, model bindings
and actual usage records are unchanged. Link rename needs no new migration.

Synthetic composition and Electron bridge fixtures on Linux do not establish
native Windows/macOS IME, keyring or packaged-app behavior. Local counted endpoints
do not establish real-provider interoperability or unlimited completion; providers
retain their own limits. Opt-in large-document/attachment performance acceptance
and existing media-stage gaps remain open. No real provider inference, production
data access, merge, tag, registry publication or deployment is part of this task.
