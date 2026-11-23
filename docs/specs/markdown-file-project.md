# Markdown file project

Status — implemented as an opt-in Web validation slice for one operator. It
narrows the open project proposal in [PR #19][old-pr] to a file-backed writing
loop. See the draft [file-first Web writing workspace](web-file-workspace.md)
for the proposed default workflow and scope.

## User workflow

Open the Web writing workspace and start typing in a blank project. A title,
AI setup, and outline are optional for writing. The user can also choose one
UTF-8 `.md` file and open it as a fresh manuscript. Import gives the new project
its own identity and leaves the source file and previous project intact. The
imported manuscript starts without inherited comments, locks, approvals, or
history. Interpret Markdown as document text, including comments and links.
Only the selected file is read. Link targets and referenced files are not fetched
or imported automatically.

Save edits to the current project. Refresh the workspace and reopen its last
successful save. Keep normal in-editor undo and redo for the open document. The
five-step project history and undo across sessions are deferred. Export the
current manuscript as an ordinary `.md` download. Settle active IME composition
before capturing the download text. Export leaves the editor's save status alone.
An external Agent can edit the downloaded file, which can then be opened as a
fresh manuscript through the same import action.

## Format and ownership

A new project consists of two files:

```text
project.json
manuscript.md
```

The manifest declares `format: "scenesparrow"`, integer `formatVersion: 1`, a
stable `projectId`, and `manuscript: "manuscript.md"`. The Markdown file is the
only current manuscript source. Preserve UTF-8 text, optional BOM, and line
endings on an untouched import and export. New empty projects start with an empty
UTF-8 file. Avoid serialization through the legacy editor's block model.

The shared core owns filesystem access. Web stores project directories under a
configured persistent server root. It uses a project ID as an opaque locator and
keeps that selection on refresh. A project ID is scoped to the existing operator
access rules. An import filename is display data and never selects a server path.
For this slice the manifest's manuscript entry is the fixed root-level filename.
New file projects use only project files for persistent project data. Global model
settings and credentials live in the existing application stores.

## Save and failure behavior

Reuse the shared writing workspace, current save preferences, and localized status
presentation. Keep typing, selection, and composition stable while a save is in
flight. Serialize writes to each manuscript. Save against the version last read
and refuse a stale save if the stored content has changed. Keep the user's local
text available to copy or export on a conflict or failed save. A late acknowledgment
can mark only its captured input as saved.

Publish a manuscript save by replacing it from a complete temporary sibling file.
On interruption, reopening must read a complete saved version. Only open a newly
created or imported project after both files exist. Validate the format version,
UTF-8 input and manuscript size using the existing text budget before accepting
input. Report read, write, format, and conflict errors with localized messages.
An invalid import or failed previous-project save keeps the current editor open
with its text. An invalid or incomplete existing project reports an error rather
than being reinitialized as a blank one.

## Implementation sequence

1. **MFP-T01** Define the two-file contract and implement create, read, and save
   under the configured project root. Reuse the existing transport boundary and
   keep the API specific to project IDs and manuscript text.
2. **MFP-T02** Wire the Web validation entry into the existing writing workspace.
   Connect new project, single-file import, save, reopen, and `.md` download.
   Keep the validation data root separate from existing deployed project data.
3. **MFP-T03** Verify the behavior below through the Web entry. Reuse useful
   format validation, lossless Markdown handling, editor pieces, or fixtures from
   [PR #19][old-pr] after checking their dependencies. Carry over only the pieces
   used by this flow.

## Acceptance

| ID       | Evidence to collect                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| MFP-AC01 | New Web project opens ready to type. Its manifest and manuscript are the complete project state.                              |
| MFP-AC02 | Valid `.md` opens as a fresh project. The previous project and source file stay intact. A no-edit export preserves the bytes. |
| MFP-AC03 | A completed save survives refresh and reopen. Typing and IME remain usable while the save is pending.                         |
| MFP-AC04 | Stale or failed writes retain local text. An interrupted save leaves a complete saved file available on reopen.               |
| MFP-AC05 | Invalid input leaves the current project open and produces a localized error.                                                 |
| MFP-AC06 | An externally edited `.md` can be imported as a fresh manuscript, without history or review state.                            |

## Later slices

Existing SQLite projects keep their current workflow until a separately designed
migration is available. Active-project approval state, package restore, merging
returned edits into the original manuscript, desktop file operations, and audio
or video authoring are separate slices. Ordinary project files and a small
Remotion fixture can validate future external rendering without putting a media
runtime in the writing loop.

[old-pr]: https://github.com/Geminorun/SceneSparrow/pull/19
