# Editor-first manuscript workspace

## Confirmed requirements and scope

This follow-up implements the user's corrections after workspace onboarding. One
project produces one video from one primary manuscript. There is no manuscript
file list or second left sidebar. The Obsidian reference informs workspace layout,
not a multi-document/vault model. Shared Web/Electron UI and global AI settings
remain intact; audio/video workspaces are future integrations, not this delivery.

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EW-01 | Enter an editable manuscript immediately, without a planning form or Start writing gate. Keep the same editor mounted through save acknowledgements, tabs, panel collapse, settings, locale and project rename.                                                                                                                                                                                       |
| EW-02 | Use a narrow global ribbon, central editor and one resizable/collapsible right auxiliary pane. The pane has Structure, Planning, Review and Sources tabs. Do not render unavailable audio/video controls or a left manuscript list.                                                                                                                                                                   |
| EW-03 | Separate UI workspace selection from business stage. Preserve empty outline-stage projects until a real manual edit or confirmed generated draft; the first actual manual document edit atomically enters draft. Existing drafts may save/generate/adjust planning outlines without replacing body content. Initial draft generation continues to require an eligible empty outline-stage manuscript. |
| EW-04 | Retain explicit outline confirmation before generating a complete initial draft. Existing body/locks/history and pending AI applicability remain protected. Revisions stay monotonic; paid work starts only from explicit actions and uses the shared AI runtime.                                                                                                                                     |
| EW-05 | Background saving cannot disable or recreate active inputs, reset selection, steal focus or interrupt IME. Avoid whole-toolbar disabled flicker during composition/saving. Action handlers serialize or defer conflicting work at dispatch; genuine locks/task reservations remain enforced.                                                                                                          |
| EW-06 | Manuscript-language control offers Chinese and English, storing zh-CN/en independently from interface locale. Normalize known legacy Chinese spelling on intake without silently changing an existing user's manuscript language.                                                                                                                                                                     |
| EW-07 | Separate editable draft validation from generation readiness. Partial plans, including temporarily blank outline headings, remain saveable within size/structure constraints. Field errors appear next to fields and resume normal saving after correction.                                                                                                                                           |
| EW-08 | Render saving/offline/error feedback in a compact stable status area. Network failures preserve local input and expose Retry. Hide request-receipt mechanics and raw JSON behind explicit details/recovery actions. Avoid duplicate body/planning error banners and layout jumps.                                                                                                                     |
| EW-09 | Discard/reload is explicitly labelled Discard unsaved changes and requires confirmation. Cancelling preserves local text and focus. Unknown writes resolve their original receipt before replacing local state; an older response cannot acknowledge newer input.                                                                                                                                     |
| EW-10 | Use compact, consistent controls: desktop secondary controls around 28–32px, primary actions 32–36px, with larger touch targets on touch layouts. Markdown is the manuscript editing language; omit permanent formatting/history toolbars. Keep actions in a small document menu with readable text, visible focus and reduced-motion support.                                                        |
| EW-11 | Project menu owns rename/recent/open/recovery; settings stay behind the gear. Preserve the released private diagnostics UI/API, desktop close protection, single-project Web boundary and existing narrow platform bridge.                                                                                                                                                                            |
| EW-12 | Persist auxiliary selection, collapse and width as non-authoritative UI preferences. Panel switches preserve planning/review buffers, editor position and selected text. Small screens use an auxiliary drawer without horizontal overflow or inaccessible controls.                                                                                                                                  |

## Layout and visual decisions

```text
Ribbon | Document tab / project menu                    Locale Settings
       |---------------------------------------------------------------
Write  | Manuscript / save status / locks / ⋯ | Structure Planning Review Sources
       |                                    |
       |           Manuscript               |       Auxiliary content
       |                                    |
```

The ribbon is approximately 40–44px; the auxiliary pane defaults to about 320px
and supports keyboard-accessible resizing/collapse. The document has a bounded
readable measure rather than stretching across the full window. The paragraph
lock strip stays at the far right of the manuscript, aligned to its blocks.
Structure navigation moves into the auxiliary pane; review comments remain
anchored to the manuscript and available through its selection actions.

The user's later Notion/Obsidian correction supersedes the earlier blue-accented
paper/workspace direction. Use a cool neutral shell and auxiliary surface
(#f6f6f6), a continuous white document (#ffffff), warm ink (#37352f), readable
secondary text (#706f69), hairlines (#e9e9e7), and functional focus/link blue
(#4070a0). A quiet document tab carries the project title. The breadcrumb/save
row belongs to the manuscript canvas; auxiliary tabs begin directly beneath the
top shell. There is no paper frame, drop shadow, permanent formatting strip,
left file tree, or additional manuscript. Neutral charcoal identifies the main
action in a task area. Other commands use quiet text/ghost controls and modest
popover elevation. System sans typography includes CJK fallbacks, 16–17px prose,
34px document H1 and 27px H2, bounded reading measure, and generous whitespace.

## Markdown editing and source

The manuscript uses live formatting from supported Markdown typing: headings,
bullet/ordered lists, bold, italic, inline code and safe links. Existing keyboard
project Undo/Redo and paragraph locks remain authoritative. Remove the permanent
formatting/history toolbar and its deferred toolbar actions. The document ⋯ menu
provides View Markdown source, project Undo/Redo and export access; it introduces
no second document or source-editing mode.

External plain-text or mixed-MIME Markdown paste inserts into the current
selection through a discrete editor transaction. Fresh pasted blocks receive new
identities; unaffected blocks retain theirs, and the existing content-protection
and core validation guards still apply. Internal ProseMirror/canonical HTML
clipboard payloads retain the established rich-paste/identity-repair path. During
IME composition, explicit plain-text paste remains literal local text without
conversion or an early save. After composition ends, the existing input rules
may preview completed inline Markdown without moving focus.

The browser codec supports the current canonical subset: paragraphs, headings,
list items through depth 3, bold/italic/inline-code overlaps, absolute HTTP/HTTPS
or mailto links, and line breaks. CRLF normalizes to LF. Unsupported containing
blocks remain literal source text: HTML, images, references, fenced code, quotes,
non-1 ordered starts, titled/unsafe links, overly deep lists and multi-paragraph
list items are not discarded, fetched or executed. Incomplete syntax remains
text. Canonical content normalizes Markdown syntax/spacing; emphasis edge
whitespace is rendered outside emphasis, internal line breaks normalize to
explicit break syntax, and terminal empty lines normalize away. This is not lossless CommonMark storage or an active-line marker
reveal engine.

The native read-only source dialog serializes the current local editor only when
opened, including pending saves. It does not reimport, flush, remount, create a
history transition or change document content. Invalid local structure shows the
retained local text with an explicit recovery explanation instead of presenting
a previous saved snapshot as current source. The existing close-request owner
dismisses the dialog before the normal save/recovery decision.

## Implementation and review order

1. Core/editor command foundation: first manual edit, planning coexistence,
   partial-draft validation, canonical acknowledgement and safety regression tests.
2. Shared workspace: ribbon/editor/auxiliary composition, compact controls,
   language selector, non-disruptive saves and explicit recovery, with browser
   tests and responsive screenshots. Keep mounted state separate from visibility.
3. Root review, integrated checks/build/integration/browser validation, then a new
   English PR into release/1.0.0. Do not merge or deploy this task branch.

Applied migrations 001–010 are immutable. Append a migration only if an actual
storage change is necessary; this layout/command refinement does not itself
require one. Keep original receipts, five-step history, stable block identities,
recovery and global AI boundaries. Update S1/S2/S3/S4 addenda where the new shared
workspace supersedes old mutually exclusive outline/editor presentation.

## Required evidence

Exercise real continuous keyboard input across save round trips and failures;
retain the same DOM node, focus, selection and local input. Cover synthetic IME
start/update/end, including a save acknowledgement arriving mid-composition.
Native Windows/macOS IME acceptance remains separate from Linux Chromium evidence.

Cover first manual typing from a new project, Undo back to empty state, reload,
planning from an existing manuscript with locks, initial generation after explicit
outline confirmation, late results, and no duplicate paid dispatch. Verify field
correction resumes saving, discard cancellation/confirmation, tab/panel/settings
changes with unsaved buffers, structure navigation, review selection and paragraph
lock alignment. Verify zh-CN/en and 375/768/1200+ layouts with long project names.
Record actual outcomes in a dedicated validation report; screenshots alone do not
establish focus or native-platform correctness.
