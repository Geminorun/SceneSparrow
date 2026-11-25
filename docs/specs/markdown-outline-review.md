# Markdown outline and shared document review

Status — implemented in the file-backed Web workspace. [Validation](../validation/markdown-outline-review.md)

## Scope

The Web workspace persists the manuscript and outline as separate Markdown
files. Both documents support block locks and anchored comments. This extends the
[file-first workspace](web-file-workspace.md) and the protection rules in the
[Markdown workspace spec](markdown-agent-workspace.md).

Use the existing Outline and Manuscript tabs, shared Markdown editor, heading
navigation, and File menu. Keep writing requests, AI progress, unapplied
results, and editor undo/redo in the live session. Use the existing [shared AI
configuration and execution](shared-ai-integration.md) for model calls.

## Project files and save boundaries

| File            | Ownership and lifecycle                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `project.json`  | Existing version 1 manifest and project identity. The supported document paths are fixed.                                 |
| `manuscript.md` | Authoritative manuscript and input for future audio and video work.                                                       |
| `outline.md`    | Authoritative accepted outline and input for draft generation. Optional and created on the first successful outline save. |
| `locks.json`    | Optional records of protected blocks in either document.                                                                  |
| `comments.json` | Optional anchored comments in either document, with their text, quoted context, and open or resolved status.              |

Projects without `outline.md` open with a blank outline. Read and save each
document using the project ID and a fixed document kind (`outline` or
`manuscript`). Derive each revision from its exact UTF-8 bytes. Use a null outline
revision for an absent file. A saved empty outline has its own revision.
Preserve untouched source bytes, including BOM and line endings.

The Rust file service owns path resolution, revision checks, and atomic file
replacement. Every document write carries its expected revision. Serialize
writes and annotation changes per project so that revision and protection checks
use the state that will be written. A stale or failed write keeps the unsaved
editor text and presents a localized error. Saving one document leaves the other
document's revision intact.

Share the editor, save scheduling, focus handling, and IME settling for both
tabs. Each document has its own current text, last saved revision, pending save,
and session undo/redo. **File → Save** and the save shortcut target the active
document. **File → Export → Markdown** downloads the active document. Late
responses acknowledge only the captured write. Switching tabs retains each
buffer and the normal save behavior for that buffer.

The document header's copy action copies the active buffer as Markdown,
including unsaved text. Keep the explicit source editor in the document menu.
When Markdown falls outside the visual editor's supported syntax, use an
editable source field in the document tab with the same lock and comment
actions for recognized headings, paragraphs, and list items.

## Shared locks and comments

- Put the block lock at the right edge of the editor, with the same placement
  and states in both tabs. Make it available on hover and through keyboard
  focus. A heading, paragraph, or list item can be locked individually. A
  selection spanning several blocks locks only the selected blocks.
- Offer **Comment** for the current block or a text selection. In the outline,
  selecting a heading and several bullets can attach one comment to that span.
  The Comments panel follows the active document. Selecting a comment shows its
  anchor and lets the user return to it or resolve it. Locked text stays
  readable, copyable, and open to comments.
- Reuse the Markdown editor, selection controls and decoration mechanics.
  Connect protection to the file service and its Markdown source ranges.

Each record has a stable `id`, a document kind and an anchor. An anchor contains
its source revision, a half-open UTF-8 byte range, a content fingerprint, and
structural and neighboring context for locating it after edits. A lock covering
several blocks preserves an anchor for each protected block. Store the original
quote with a comment so it remains understandable when the anchor needs review.
Editor-session IDs can aid rendering. The durable anchor belongs in the sidecar.
Settle pending input and save the captured document before anchoring a new
lock or comment to unsaved text. A failed save keeps the local text and the
pending comment available for retry.

Locking a block protects its exact source and structural location. An edit may
shift its byte offset by changing adjacent text. Rewriting, deleting, or moving
the protected block requires an explicit unlock. Check this in visual editor
transactions and again in the core for every write, including source edits,
AI adoption, and Agent imports. Revalidate using current locks when applying a
preview. A lock added after preview can still block that write.

Resolve anchors against the current revision before writing. If a protected
block cannot be matched uniquely, preserve the lock and surface a conflict for
the affected document. If an ordinary comment loses its target, keep its quote
and comment text and mark it for repositioning or resolution. An interrupted
sidecar update must preserve enough anchor evidence to retry resolution. If
`locks.json` exists but is unreadable, block document writes until it is recovered.

## AI outline and draft actions

- **Generate Outline** saves the result through the revision-checked outline
  write path and opens the editable Outline tab. Confirm replacement before
  generating over an existing outline. If edits or current locks prevent
  applying the result, keep the editor text and retain the generated Markdown
  in the AI assistant for reference.
- The user can request an AI revision from a comment. Capture the selected scope
  and its document revision. Show the proposed replacement in a preview and
  apply it only after explicit adoption and validation of the current scope and
  locks. A comment alone changes neither Markdown file.
- **Write Draft from Outline** settles pending input and saves the captured
  outline before generation. A saved, nonempty `outline.md` suffices. A writing
  request, when present, adds context. The core supplies the saved outline at
  the captured revision. If that save or revision check fails, report the error
  before dispatching a model request.
- Keep the outline revision and manuscript snapshot with the draft preview. If
  either input changes during generation or before adoption, mark the result as
  based on earlier input and retain it for review. Generate again with the
  current inputs before applying. Changing an outline after a draft has been
  adopted leaves the saved manuscript available for further editing.

## Project ZIP handoff

Use **File → Export → Project ZIP** for the whole project and **File → Import
file…** for Agent returns. Before export, save pending changes in both documents.
If either save fails, preserve both buffers and report the error before export.
Build the ZIP from the saved files and metadata captured in the same snapshot.

```text
exchange.json
project/
  project.json
  manuscript.md
  outline.md       (when saved)
  locks.json       (when present, read-only guidance)
  comments.json    (when present, read-only guidance)
```

Keep `baseRevision` for the manuscript. Include `outlineBaseRevision` in new
packages, using null when no outline existed at export. An Agent can edit either
Markdown file. It can add `project/outline.md` to a package with a null outline
base. To clear an existing outline, return an empty file. The manifest and
exchange metadata travel intact. Use the exported lock and comment snapshots as
guidance. Web validates the return against the original project's live sidecars
and applies Markdown changes only.

For packages without `outlineBaseRevision`, scope the import to the manuscript
and require the original manuscript-only entries. For a package with a
non-null outline base, require the outline entry. Verify the project ID and paths,
reuse the existing ZIP entry validation, and bound the compressed and expanded
payloads. Preserve the manuscript's 2 MiB and outline's 256 KiB UTF-8 limits.
Treat returned sidecars as bounded data. The service owns all file paths.

Identify changed files by comparing returned bytes to their exported revisions.
Show the diff and apply action for each changed document. If an Agent only
changes the outline, concurrent manuscript edits do not block outline review or
apply. For each target, check its current saved revision, pending local edits,
and current locks at preview and again at apply. A conflict retains the current
text and the returned candidate and identifies the affected document. Keep the
existing separate-project recovery for a conflicting returned manuscript.

## Implementation sequence and acceptance

| Task    | Deliverable                                                                          | Acceptance                   |
| ------- | ------------------------------------------------------------------------------------ | ---------------------------- |
| MOR-T01 | Persist the outline, share save behavior, and use the saved outline for drafts.      | MOR-AC01, MOR-AC02, MOR-AC03 |
| MOR-T02 | Share editor locks, anchored comments, and scoped AI previews across both documents. | MOR-AC04, MOR-AC05, MOR-AC06 |
| MOR-T03 | Add both documents to ZIP export and review returned changes by document.            | MOR-AC07, MOR-AC08, MOR-AC09 |

1. **MOR-AC01** — Open an existing project without `outline.md`. Save an outline,
   refresh, and reopen the same project. Verify the outline and manuscript
   and their direct Markdown exports against the exact saved bytes. Clear the
   outline and distinguish that save from an absent outline.
2. **MOR-AC02** — Switch between tabs while a save is pending. Verify that manual
   save and the shortcut target the active document, delayed autosave keeps the
   originating document, and a stale response preserves newer typing and IME
   input.
3. **MOR-AC03** — Draft from a saved outline with an empty writing request. Verify
   the model receives the captured saved outline. Change the outline during
   generation and verify the older draft stays visible for review and cannot be
   applied. A failed outline save prevents model dispatch.
4. **MOR-AC04** — Lock a heading and selected bullets in the outline and a
   paragraph in the manuscript. Reload and verify each document's locks. Check
   that typing, source edits, deletion, and moving protected content are blocked
   while adjacent unlocked text remains editable. An ambiguous match keeps the
   lock and blocks the write.
5. **MOR-AC05** — Attach a comment to a multi-block outline selection. Switch
   tabs, reload, and reopen the comment from the outline. Apply an unrelated edit
   and verify the anchor. Remove its range and verify the quote and comment
   remain available for repositioning or resolution.
6. **MOR-AC06** — Request a scoped AI edit from a comment. Verify the saved file
   stays unchanged in preview and the applied result changes only the selected
   unlocked scope. Add a lock inside that scope during preview and verify that
   adoption is blocked.
7. **MOR-AC07** — Export a project, edit only `outline.md` with an external Agent,
   and independently edit the manuscript in the app. Import and apply the
   outline diff. Verify both files retain their respective edits.
8. **MOR-AC08** — Return changes to both Markdown files. Confirm them separately
   and verify a stale revision or changed locked block prevents applying the
   affected document. Changes to returned locks or comments have no effect on
   the original metadata.
9. **MOR-AC09** — Review an older manuscript-only package and confirm the current
   outline survives. Exercise a new outline added to an exported outline-less
   project, a project mismatch, and a malformed ZIP.
