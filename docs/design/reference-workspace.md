# Reference and creation workspace

Presentation follow-up: [central writing workspace](writing-workspace.md)
supersedes the right-side creation form, task/error dashboard and view-specific
heading navigation below. The reference intake/consent and platform rules remain.
See [current implementation evidence](../validation/writing-workspace.md).

Status: implementation scope approved on 2026-11-17. This document supersedes
the four-tab auxiliary layout and project-tab chrome in `editor-workspace.md`.

## Information architecture

The shared Web/Electron workspace has four regions: the existing application
ribbon, a collapsible left navigator, the primary Markdown manuscript, and a
collapsible right assistant. The left tabs are **Contents** (headings in the
current manuscript) and **Library** (reference files and links). The right tabs
are **Create** and **Review**. Heading navigation is never the AI writing outline.
There is exactly one primary manuscript, not a synthetic list of documents.

Remove the large editable project tab and the misleading Project files menu.
Keep project identity and restoration internally. Put genuine project lifecycle
actions in a compact application menu; manuscript import belongs to the document
menu. Use the first manuscript heading as display identity with a localized
Manuscript fallback. Settings remain behind the gear. Keep export, source mode,
and history commands available without a formatting toolbar.

Use a continuous warm gray editor surface, quiet separators, restrained paragraph
spacing, compact controls, and visible keyboard focus. No white paper rectangle,
page shadow, forced grid on every paragraph, or visible Word formatting ribbon.
Both panes remember their widths, tab and collapsed state. Narrow screens show
only one drawer at a time, with focus return and Escape handling; hidden controls
must not capture keyboard input. Pane updates must not remount the editor or
interrupt composition, selection, or autosave.

## Reference library and platform boundary

Reference paths are portable display metadata, never server filesystem paths.
Represent folders as a virtual tree derived from validated relative paths on
source records. A path uses `/`, has no absolute root, empty/dot/dot-dot segment,
control characters, or platform drive prefix. Existing records without metadata
remain valid and appear at the library root. Immutable file bytes, extraction
jobs, history and task pins remain authoritative. Removing a library record never
deletes the user's original file.

Web supports multiple files and directory upload, retaining relative paths.
Desktop supports choosing a reference directory and explicitly refreshing it;
the main process owns the chosen path and exposes an opaque capability, never
an arbitrary renderer-supplied path. Skip symlinks, unsupported files and files
outside the chosen root; bound file size/count and provide per-file outcomes.
Directory association is distinct from opening the application's project DB.
Refresh copies immutable snapshots and avoids duplicate unchanged entries. No
filesystem watcher is introduced. Existing running tasks keep their old inputs.

Library rows expose extraction status and preview. Links remain title plus URL;
no automatic crawling or assertion that the linked body was read. Being present
in the library does not imply consent to send it to AI. Users explicitly select
references for the next task. The creation panel shows a count and removable
summary, with an action to open the library, instead of a second file list.
Ordinary full-text selection resolves a valid UTF-8 range; users never enter byte
offsets. Multimodal preparation remains explicit and capability-dependent.

## Creation flow and editing

The manuscript is editable immediately. Creation is optional assistance, organized
as **Idea → Outline → Draft**. In Idea, show a topic/prompt, language (Chinese or
English), selected reference summary, optional audience/style/length preferences,
and one primary Generate outline action. In Outline, show the editable proposed
outline, a secondary adjustment action, and one primary Confirm and draft action.
Preparation is performed behind that explicit action; it must never dispatch paid
work automatically after a restart. Show task progress/cancel/error locally.
Existing prose always stays visible. A nonempty draft must never be replaced by
initial drafting; guide users to review or optional planning assistance instead.

Markdown source and live preview must refer to the same content and preserve
stable block IDs, UTF-16 review offsets, locks, five-step project history, and
recovery. Unsupported syntax must remain visible and recoverable. Do not describe
a normalized read-only projection as editable source or byte-exact storage.
Any editor-engine or persistence change requires explicit compatibility tests;
the layout redesign does not authorize bypassing core block/lock validation.

## Acceptance and delivery

- RW-01: Left Contents/Library and right Create/Review work independently on
  desktop widths; narrow drawers remain keyboard-accessible and exclusive.
- RW-02: The main surface is warm gray and has no fake project tab or paper frame.
- RW-03: Nested uploaded references survive reopen/history; malformed relative
  paths are rejected in the core and desktop IPC never accepts arbitrary paths.
- RW-04: Desktop directory refresh skips unchanged bytes, reports failures, and
  cannot mutate already captured AI inputs or delete originals.
- RW-05: Adding references does not select them. Selection is explicit and valid
  for text/multimodal/link modes; creation displays one consistent summary.
- RW-06: Idea/Outline/Draft actions are understandable, preserve entered text,
  never change focus during saves, and never overwrite an existing draft.
- RW-07: Locks, review anchors, Markdown, IME, undo/redo, project restoration,
  settings and export continue to pass meaningful regression checks.

Implementation uses the substantial-code delegation loop with one writer;
planning and architecture stay with the primary agent. Root reviews each slice,
commits verified changes, runs final checks and opens a new PR against
`release/1.0.0`. This task does not merge or deploy the PR.
