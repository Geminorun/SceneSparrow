# Markdown workspace and protected agent handoff

Status — workspace restoration in this change. Paragraph protection is a
proposed follow-up.

## Workspace restoration

Use the Web workbench immediately before [PR #24][pr24] as the visual reference
(`4ac750b`). Reuse its application menu, settings gear and tabs, ribbon,
resizable contents and assistant panes, manuscript header, and continuous
editor surface. Keep existing pane preferences. Put project exchange actions
in the application menu and keep outline, draft, and imported change previews
in the main writing area. Place save preferences in General settings.

Connect the restored controls to the current Markdown workspace. Reuse its
project identity, delayed and manual save, session undo/redo, global model
settings, draft adoption, and ZIP exchange. Show controls for the available
file workflow. The older library, comments, and approval features remain
outside this slice. [File-first Web workspace](web-file-workspace.md)

The editor can derive a block view from the original Markdown. Preserve the
UTF-8 bytes of an untouched manuscript and untouched source ranges in an
ordinary edit. Provide the Markdown source action in the existing document
menu. Use that action for content the visual editor cannot safely round trip.
The file service continues to own authoritative writes and revision checks.

## Project contents and ownership

`manuscript.md` holds the complete, ordered manuscript for the editor and
external agents. `project.json` identifies the project. Editor blocks are a
projection of the Markdown source. A future audio or video template can
reference this manuscript within the same project directory.

Paragraph protection adds an optional `locks.json` only when a project has
locks. It stores user decisions and is included in project backups. Each
record carries a project-local block ID, a source revision and byte range,
enough structural context to locate it after an edit, and a fingerprint of
the protected source bytes. A block ID identifies the target. A fingerprint
validates its content. Two identical paragraphs can have different IDs.
Keep the existing two-file format for projects without locks.

## Write and handoff rules for paragraph protection

- A user locks or unlocks a block in the editor. Leave the text readable and
  copyable. Enforce the lock in editor transactions and in the core's save
  path. Reject replacements, deletions, or structural changes that invalidate
  a protected block. Apply the same rule to manual writes and candidate
  adoption.
- Built-in AI can see the document context. For an existing manuscript with
  locked blocks, request replacements scoped to editable ranges in the
  captured revision. Apply them as a candidate after validation.
- An external agent edits a downloaded copy. It can read the full Markdown
  and any accompanying lock guide. Use the original project's locks to
  review the returned Markdown. Check the existing ZIP base revision and
  project identity. Reject a changed or ambiguous protected range.
- Recheck the current manuscript and current locks when the user confirms a
  write, including any locks added while an agent was working. Rebase valid
  lock anchors across accepted edits. If interruption or outside editing
  leaves an anchor unresolved, retain the lock and surface a conflict until
  the user resolves it. File writers with direct access to the original
  project can bypass app-mediated validation.

Draw on the file editing and diff workflow used by Aider, and on the stable
cell identities and operation checks in JupyterLab. Keep ZIP review as the
Web handoff path.
[Aider and Git](https://aider.chat/docs/git.html) ·
[Jupyter cell IDs](https://github.com/jupyter/enhancement-proposals/blob/master/62-cell-id/cell-id.md)

## Tasks and acceptance

| Task    | Deliverable                                                          | Acceptance         |
| ------- | -------------------------------------------------------------------- | ------------------ |
| MAW-T01 | Restore the prior Web workbench presentation over the file workspace | MAW-AC01, MAW-AC02 |
| MAW-T02 | Future editor and core paragraph protection                          | MAW-AC03, MAW-AC04 |

1. **MAW-AC01** — Compare the same manuscript, locale, and viewport with the
   prior workbench. Verify the original chrome, pane behavior, editor
   typography, and settings entry. Exercise the outline/draft and project
   exchange entry points.
2. **MAW-AC02** — Open and edit an existing project through the restored
   workbench. Save and reopen the same project ID. An untouched Markdown
   round trip preserves bytes. Verify source editing, version conflicts,
   and that AI/Agent candidates still require explicit adoption.
3. **MAW-AC03** — In the future lock implementation, lock an opening paragraph
   and update the ending. Apply only the allowed edit and keep the lock across
   reload. Verify that manual and generated edits both protect the opening.
4. **MAW-AC04** — Reject an import that changes a locked block, cannot locate
   it unambiguously, or predates a conflicting edit. Preserve the saved
   manuscript and the existing lock record.

[pr24]: https://github.com/Geminorun/SceneSparrow/pull/24
