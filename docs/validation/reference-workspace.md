# Reference workspace validation

The approved [reference workspace design](../design/reference-workspace.md)
replaces the fake project tab and four-tab assistant with a single manuscript,
left Contents/Library navigation and right Create/Review assistance. Root handled
planning/design and independently reviewed the substantial implementation slices;
implementation agents used `gpt-6.1-sol` with high reasoning, one writer at a time.
The delegation boundary is recorded in `AGENTS.md` and the development workflow.

## Delivered behavior and evidence

| Acceptance | Implementation and evidence                                                                                                                                                                                                                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RW-01      | Independent persisted pane tabs, widths and collapse state; keyboard tabs/resizers, exclusive narrow drawers and focus return. Invalid saved preferences fall back without blocking the manuscript.                                                                                                                                                |
| RW-02      | Continuous warm-gray canvas, heading-derived manuscript identity, compact application menu and native-picker controls with localized labels. No fake project tab or white paper frame.                                                                                                                                                             |
| RW-03      | Validated optional portable source paths, nested library tree, Web multiple/folder uploads and reopening. Core tests reject traversal, drives, control characters and duplicate live paths. Existing sources without path metadata remain valid.                                                                                                   |
| RW-04      | Explicit desktop directory association/refresh through project-scoped opaque capabilities. Immutable same-ID file refresh, exact receipts, cancellation cleanup and source-hash-aware extraction. Host unit tests cover roots, symlinks, file identity, bounds, cancellation and close fencing. Native Windows/macOS execution remains unverified. |
| RW-05      | Adding references does not select them. A single planning adapter owns selection; Library and Review share full-text/excerpt/visual controls. Creation shows a count/removable summary. UTF-16 selections become valid UTF-8 ranges; stale source reads are rejected. No byte-offset form is exposed.                                              |
| RW-06      | Idea, outline and initial draft actions, optional preferences, Chinese/English manuscript language and existing-body guidance. Form disclosure, editor DOM and input focus survive ordinary saves, composition, tabs and settings. Initial drafting cannot replace existing prose.                                                                 |
| RW-07      | Existing Markdown input/paste, locked-content rejection, review anchors, candidate decisions, finalization, five-step history, delivery, project recovery and diagnostics pass the browser regression suite.                                                                                                                                       |

The core refresh tests verify retained original task input after history eviction,
cleared planning/review choices, stale result/candidate rejection, no automatic
redispatch, undo/redo and reopen. Root review found and corrected retention by live
source ID: completed extraction objects now follow retained source **hashes**, so
unreferenced superseded versions are collected while current/history/task inputs
remain intact.

Root also corrected compact-header recovery-button overlap, disclosure collapse
after the first manual edit, stale source-selection callbacks and unnecessary
selection invalidation. Event subscriptions stay at panel scope rather than being
created for every library file. Browser fixtures explicitly control stale
projections when testing conflicts and wait for the actual responsive layout
before interacting with panes; recovery and content assertions remain in place.

## Final Linux validation

| Command/check                | Result                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                 | Passed: schema/generated contracts, formatting, workspace TypeScript, 206 Node tests, 184 Rust tests (12 domain, 168 infrastructure, 4 service), and Clippy with warnings denied.                               |
| `pnpm build`                 | Passed: shared Web, Electron TypeScript output and locked Cargo workspace build.                                                                                                                                |
| `pnpm test:integration`      | Passed: 10 HTTP/lifecycle integration tests.                                                                                                                                                                    |
| `pnpm test:e2e`              | Passed: 56 browser tests; 3 opt-in performance tests skipped.                                                                                                                                                   |
| Manual Linux Chromium review | Uploaded a real nested reference folder with two files, extracted and selected text, restored the manuscript, and inspected desktop/375px screenshots without horizontal overflow. No inference was dispatched. |

The full final browser suite uses isolated project fixtures and counted/mock AI
providers. Earlier regression failures were diagnosed and corrected before the
final passing run. Logs are local ignored artifacts named
`.artifacts/reference-workspace-{check,build,e2e}-complete.log` and
`.artifacts/reference-workspace-integration.log`; private traces are not committed.

## Reviewed screenshots

- [Idea and selected references](assets/reference-workspace-idea-desktop.png)
- [Draft with library and creation guidance](assets/reference-workspace-draft-desktop.png)
- [Manuscript heading navigation](assets/reference-workspace-contents-desktop.png)
- [Narrow manuscript](assets/reference-workspace-draft-mobile.png)
- [Narrow reference drawer](assets/reference-workspace-library-mobile.png)

The screenshots contain fabricated Chinese sample prose and reference files,
without credentials or actual provider configuration.

## Compatibility and limits

- Applied migrations 001–010 are unchanged. Relative paths are optional JSON
  metadata; file refresh uses existing immutable objects, receipts and history.
  New code reads existing projects, but older binaries are not promised to read
  newly written metadata/command receipts. Downgrades require a compatible backup.
- The editor remains Tiptap over canonical blocks. Markdown source viewing is
  explicitly normalized and read-only; this PR does not introduce byte-exact
  editable source storage or a CodeMirror replacement.
- Desktop directory selection and manual refresh are implemented; native dialogs,
  credential stores, file semantics and packaging need Windows/macOS verification.
  A directory association is host-local and distinct from the application project
  database. Missing files are not automatically removed from the library; originals
  are never deleted. No filesystem watcher is introduced.
- Directory batches are bounded to 100 files/100 MiB, 25 MiB per file, 2,000 examined
  entries and depth 32. Browser file/folder batches also enforce file/size limits.
  Text selections are bounded to 128 KiB on character boundaries and disclose
  leading excerpts. Links remain title/URL only; PDF/DOCX visuals require explicit
  preparation and a compatible model.
- Real provider inference, native desktop operation and the three opt-in
  performance scenarios were not run. Existing large-document/attachment-heavy
  budgets remain open; passing functional tests does not establish those budgets.
