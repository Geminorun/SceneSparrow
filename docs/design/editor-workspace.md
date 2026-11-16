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
| EW-10 | Use compact, consistent controls: desktop secondary controls around 28–32px, primary actions 32–36px, with larger touch targets on touch layouts. One primary action per task area; SVG icons, readable text, visible focus and reduced-motion support.                                                                                                                                               |
| EW-11 | Project menu owns rename/recent/open/recovery; settings stay behind the gear. Preserve the released private diagnostics UI/API, desktop close protection, single-project Web boundary and existing narrow platform bridge.                                                                                                                                                                            |
| EW-12 | Persist auxiliary selection, collapse and width as non-authoritative UI preferences. Panel switches preserve planning/review buffers, editor position and selected text. Small screens use an auxiliary drawer without horizontal overflow or inaccessible controls.                                                                                                                                  |

## Layout and visual decisions

```text
Ribbon | Project name / menu        Save status           Export  Settings
       |---------------------------------------------------------------
Write  |                                 | Structure Planning Review Sources
       |           Manuscript            |
       |           editor                |       Auxiliary content
       |                                 |
```

The ribbon is approximately 40–44px; the auxiliary pane defaults to about 320px
and supports keyboard-accessible resizing/collapse. The document has a bounded
readable measure rather than stretching across the full window. The paragraph
lock strip stays at the far right of the manuscript, aligned to its blocks.
Structure navigation moves into the auxiliary pane; review comments remain
anchored to the manuscript and available through its selection actions.

Use neutral workspace surfaces (#f5f6f8), white editor paper (#ffffff), ink
(#242a35), secondary text (#626b7a), boundaries (#e1e4ea), and restrained blue
accent (#4665c9). System sans controls surround readable manuscript prose. Dense
toolbars, subdued secondary actions and stable status geometry carry the hierarchy;
avoid marketing cards, oversized actions, decorative gradients and nested form
containers. Use frontend-design and ui-ux-pro-max guidance with the actual desktop
editor context; mobile minimums must not inflate every desktop control.

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
