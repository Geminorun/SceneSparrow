# File-first Web writing workspace

Status — draft for product approval.

## Scope

Make the file-backed editor the default Web workspace for one operator. A user
can start writing immediately, use the built-in AI to prepare a draft, or send
the project to an external agent and apply the returned manuscript. Reuse the
two-file format, save behavior, and revision check from the
[Markdown file project validation slice](markdown-file-project.md).

This release scope supersedes the Web validation slice on approval. SQLite
project migration, persistent undo/redo, active-project comments, paragraph locks,
the reference library, native folder opening, and Remotion authoring are deferred.
Existing manuscripts can be carried forward as ordinary Markdown using the
single-file import action.

## Writing and saving

Open the last selected project or create a blank one on first use. Give the
manuscript the main editor area. Derive the collapsible document navigation from
Markdown headings. Put project actions in the Project menu, keep save status near
the editor, and open the AI assistant on demand. Separate writing actions,
download/import, and model settings so each has a clear entry point. The
interaction draws on Obsidian for file ownership and Notion AI for assistance
alongside the current document.
[Obsidian file storage](https://help.obsidian.md/data-storage) ·
[Notion AI](https://www.notion.com/help/notion-ai-faqs)

- Keep delayed autosave, the manual save action, and normal in-editor undo/redo
  for the current session. Saving or generating text must preserve typing,
  focus, and IME composition. Return to the last successful save after refresh.
- Open a standalone UTF-8 `.md` file as a new project. Offer direct Markdown
  download alongside project download. Preserve the bytes of untouched files.
- Put actionable failures in the localized top-layer notice. A failed write
  keeps the local text available to edit or download. An unreadable project
  stays an error until the user chooses what to open.

## Project files and writes

```text
project/
├── project.json
└── manuscript.md
```

Use the existing format version 1 manifest and stable project ID. The Markdown
file is the only authoritative manuscript. Copying the two files carries all
persistent project content. The project contains neither editor history nor
background task state. Store global AI profiles and credentials in their
existing application stores.

The Rust core owns writes and resolves project IDs within the configured
persistent root. Reuse the current bounded UTF-8 reads, revision derived from
the exact Markdown bytes, and atomic writes. Each write must match the last
read or reviewed revision. Keep server and editor buffers separate so that a late
acknowledgment only marks its captured text as saved. Use shared contracts,
localized errors in English and Simplified Chinese, and the existing
authenticated Web gateway.

## AI writing

1. Open **AI Writing**, enter a writing request, and select **Generate Outline**.
   Show the formatted outline in the assistant and let the user edit it.
2. Select **Write Draft from Outline**. Capture the outline, the current
   manuscript revision, and the editor text. Display the result in a Markdown
   preview in the main editor area. Keep the current manuscript available.
3. Select **Use Draft** to save the preview through the normal revision-checked
   write. If the editor or the saved manuscript changed during generation,
   surface the conflict and retain both texts for review before applying.
   Closing the preview leaves the manuscript as it was.

Keep the brief, outline, progress, and unapplied draft in the current session.
Refreshing, switching projects, or closing the workspace ends that session.
Results can only update the requesting project and session. Capture the global
text model at the beginning of each action. Reserve the dispatch identity
before the provider call. Deduplicate a submitted action within the live
session and treat interrupted actions as ended. A retry is an explicit new
action. Reuse shared model configuration, credential handling, provider
execution, and error mapping. Keep writing prompts and output validation in the
manuscript application. This interactive flow ends when the service restarts.
[Shared AI specification](shared-ai-integration.md)

## External agent handoff

Use **Project → Download Project** to obtain a ZIP. If the editor has unsaved
changes, label the action **Save and Download** and finish saving the captured
text before building the ZIP. If that save fails, keep the text in the editor
and report the failure. Use the saved bytes and their revision from the same
snapshot.

```text
exchange.json
project/
├── project.json
└── manuscript.md
```

The ZIP-level `exchange.json` carries `baseRevision` from the export. It is
transfer metadata outside the two-file project folder. The user or agent edits
`project/manuscript.md` and returns the ZIP with the original manifest and
exchange metadata. Include short instructions at download/import. Require one
regular file at each expected path and bound ZIP size and expanded contents.
Validate the manifest, revision, and UTF-8 text before reading an import as a
candidate. Treat the ZIP as data and keep its paths out of filesystem
resolution. The download contains only the specified files.

Use **Project → Import Changes** to review a returned ZIP against the active
project. Preview the Markdown additions and removals before writing, drawing
on the [GitHub Desktop diff view](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop).

- If the project ID matches and the saved and editor content still match the
  exported revision, enable **Apply Changes**. Check the revision again at the
  write and start a fresh editing history after success.
- If the current draft changed since export, show the conflict and both texts.
  Let the user keep the current draft or save the returned text as a new
  project. A change between preview and apply follows the same conflict flow.
- A package from another project is invalid for **Import Changes**. Report the
  mismatch and keep the current draft available. For an unchanged package, show
  that there are no changes to apply.

## Implementation and acceptance

| Task    | Deliverable                                                                | Acceptance         |
| ------- | -------------------------------------------------------------------------- | ------------------ |
| WFW-T01 | Default Web editor, Markdown storage and save/reopen behavior              | WFW-AC01, WFW-AC02 |
| WFW-T02 | Session-only outline and draft preview with shared AI                      | WFW-AC03, WFW-AC04 |
| WFW-T03 | Project ZIP download, import comparison and guarded apply                  | WFW-AC05, WFW-AC06 |
| WFW-T04 | Persistent Web directory, release smoke check, backup and restore guidance | WFW-AC07           |

1. **WFW-AC01** — Open the default Web entry, type immediately, save and refresh.
   The same project reopens with exact saved Markdown. Its complete persistent
   project data consists of the two specified files.
2. **WFW-AC02** — Verify edit-session undo/redo, typing and IME during save, a
   plain Markdown round trip, and stale-write rejection with the local text
   retained. Reopening starts a fresh editing history.
3. **WFW-AC03** — With a configured text model, generate and edit an outline,
   preview a draft, adopt it, and refresh. Only the adopted manuscript survives
   the session. Canceling or closing an unapplied preview keeps the existing
   manuscript bytes.
4. **WFW-AC04** — Exercise a model failure, repeated submission, and a project
   switch during generation. Observe localized feedback, one dispatch per
   action, and a draft that cannot be applied outside its captured context.
5. **WFW-AC05** — Download a project, modify the Markdown with an external
   editor or agent, then import and apply it. Review the differences first and
   confirm that the same project ID reopens with the new bytes.
6. **WFW-AC06** — Exercise an invalid ZIP, a project mismatch, and an intervening
   local write during preview. Verify that the current file and unsaved buffer
   survive and that a conflicting returned draft can be saved separately.
7. **WFW-AC07** — Exercise the production container entry and persist a project
   across container restart. Recover its folder from a backup and verify the
   two files and the same manuscript. Update the release smoke check to cover
   the file-backed path.

Enable the new default in the production configuration after the writing and
handoff checks pass. Use a distinct persistent project root and include it in
the deployment backup and recovery procedures. Approval of this specification
is the gate for implementation.
