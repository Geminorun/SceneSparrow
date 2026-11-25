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
Clippy, and the full integration suite. The AI checks used a local fixture.

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
