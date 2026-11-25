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
