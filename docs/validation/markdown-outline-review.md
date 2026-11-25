# Markdown outline and shared document review validation

[Specification](../specs/markdown-outline-review.md)

## MOR-T01 — Outline persistence and drafting

Reviewed against `570ed0d` on PR #28. Outline reads and writes use fixed document
kinds and independent byte revisions. Draft dispatch reads the saved outline
and draft adoption checks that revision under the same writer lock as the
manuscript save.

| Acceptance | Evidence                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOR-AC01   | Missing and empty outline revisions differ. Reopening, direct export, exact bytes, and a writable manuscript with an unavailable outline passed.                        |
| MOR-AC02   | Held saves, tab switching, manual and delayed saves, and IME completion preserved both document buffers.                                                                |
| MOR-AC03   | The real worker fixture received the saved outline with a blank brief. Failed saves prevented dispatch. Local and external outline edits left stale previews unapplied. |

Root review applied Ponytail Review to storage, API and editor paths. Independent
contract, type, formatting, focused integration, and full Markdown browser
checks passed. The implementation checks also passed the Web build, workspace
Clippy, and the full integration suite. The AI checks used a local fixture. The
initial hosted browser smoke found an empty heading retained after clearing the
outline. MOR-T02 fixed that behavior and passed
[Foundation checks](https://github.com/Geminorun/SceneSparrow/actions/runs/45597953308).

## MOR-T02 — Block protection and comments

Both tabs use the same selection controls, revision-bound annotations, and
Markdown write guard. The core validates protection under its writer lock
before replacing either document. The editor renders the current document's
locks and keeps its comments available when an anchor needs repositioning.

| Acceptance | Evidence                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOR-AC04   | Browser checks covered outline and manuscript locks, keyboard and source protection, preserved list marker bytes, and unlock. Rust cases covered ambiguous matches, context changes and unreadable lock files. |
| MOR-AC05   | A multi-block comment remained available across edits, document switches and reload. Removing its target kept the quote and allowed repositioning or resolution.                                               |
| MOR-AC06   | A real worker with a local provider fixture generated a scoped candidate. Browser and core checks verified exact-range adoption, late lock rejection, stale revision rejection and replay behavior.            |

The full project check, Web build, 14 integration cases and 25 Markdown browser
cases passed during implementation. Root review applied Ponytail Review and
independently reran the annotation Rust cases, the file/worker integration
tests, and browser smoke on the reviewed tree. This stage uses the existing
visual editor's supported Markdown blocks. Native UI and live providers were
outside the validation scope.

## MOR-T03 — Project ZIP handoff

The exporter verifies both saved revisions and reads both Markdown files and the
optional annotation sidecars under the core writer lock. Return review computes
the changed files from the exported revisions. Each apply uses the existing
document save guard and the project's live locks.

| Acceptance | Evidence                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MOR-AC07   | Browser coverage verified both captured buffers are saved before export, failed and intervening saves keep local input, and an outline-only return can be applied alongside unsaved and stored manuscript changes. |
| MOR-AC08   | Both changed files appeared in separate comparisons. Applying one kept the other pending. A later lock blocked only its document. Returned sidecar bytes had no effect on the live annotations.                    |
| MOR-AC09   | A legacy ZIP applied only to its manuscript. A new ZIP with a null outline base could add an empty outline. The real core rejected malformed, oversized, and wrong-project packages.                               |

Root review applied Ponytail Review and independently checked contracts, formatting,
the real file and worker integrations, and the production container smoke path.

The workspace check passed 285 JavaScript tests and 213 Rust tests, including
contract, type, format and Clippy checks. All 14 integration tests passed.
The 29-case Markdown suite passed before the final test synchronization and
copy refinements. The final run passed 28 cases and hit disk exhaustion while
starting one project. That case passed on the final source after reclaiming
temporary build caches. The final Web production build passed.

The production container smoke passed authenticated startup, ZIP roundtrip,
saved-outline drafting, encrypted credential storage, restart and backup restore.
The image tested the final core and smoke scripts. The final standalone Web build
also included the two copy refinements made after that image was prepared.
