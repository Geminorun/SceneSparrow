# SceneSparrow · 幕雀

SceneSparrow is a local-first, AI-assisted video creation application. It brings
script writing, review, storyboarding, editable video, and targeted revisions into
one workspace while preserving approved work.

Windows and macOS remain intended desktop platforms. The browser shares the same
React UI, application protocol and Rust core, with a
[private self-hosted Web deployment](docs/web-deployment.md) path for one operator workspace.
The current delivery target is the manuscript workbench; audio/video production
follows later. The architecture and contributor workflow support internationalization.

## Repository status

The manuscript workbench is being implemented in eight reviewed steps. Steps 1–3
provide manual manuscript editing, autosave, recovery and persistent five-step
undo/redo, including reopening at the current history position.
[Step 1](docs/validation/step-01.md), [step 2](docs/validation/step-02.md) and
[step 3 evidence](docs/validation/step-03.md) record checks and limits. References,
bounded TXT/Markdown/DOCX/PDF extraction, import previews, events and recovery are
implemented. [Step 4](docs/validation/step-04.md) adds global AI settings,
credentials, an independent compatible text runtime and durable execution ports.
[Step 5](docs/validation/step-05.md) adds saved planning, explicit text/visual
evidence, outline generation/adjustment and one complete initial draft.
[Step 6](docs/validation/step-06.md) adds anchored questions/follow-ups, scoped
revision candidates, comparisons and individual/batch decisions.
[Step 7](docs/validation/step-07.md) adds production locks, derived finalization,
approved baselines and validated review history rebinding.
[Step 8](docs/validation/step-08.md) adds clean copy/TXT/Markdown/DOCX export,
scoped native delivery, verified backups/recovered copies, lifecycle guards and
cross-stage evidence. The [acceptance matrix](docs/validation/acceptance-matrix.md)
records all 130 cases and their remaining limits; the
[workbench and shared AI specifications](docs/design/README.md) define those slices.

The initial pnpm/Cargo monorepo is runnable: a shared bilingual React UI connects
to an authenticated Rust core and creates/reopens a SQLite project. Electron uses
the same UI through a restricted preload bridge. A Remotion sample validates the
separate render pipeline. The render sample remains a framework example. Native
Windows/macOS desktop validation and complete-stage acceptance remain open.
Large-document and attachment-heavy interaction budgets remain unmet after the
measured optimizations. Release-build results and their causes are recorded in
step 8. Native document/AI-worker RSS enforcement remains unverified.
Real-provider interoperability, native credential stores and packaged workers also
need separate acceptance; local fake endpoints establish the tested behavior only.

See [development setup](docs/development.md) for prerequisites and platform limits.
After installing the pinned tools:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

In the managed cloud, first run `bash scripts/cloud-setup.sh` and source
`scripts/cloud-env.sh` in each shell. The Electron binary is installed, but desktop
launch is blocked by this cloud's Linux sandbox configuration; use the browser
workflow here and validate desktop behavior on Windows/macOS.

## Start here

- [Agent and contributor rules](AGENTS.md)
- [Setup, commands, and current implementation](docs/development.md)
- [Branch, commit, and review workflow](docs/development-workflow.md)
- [Eight-step implementation, subagent dispatch, and root review](docs/implementation-execution.md)
- [Manuscript workbench, shared AI, and implementation plan](docs/design/README.md)
- [Stage specifications and shared AI integration](docs/specs/README.md)
- [Decision: manuscript first and reusable AI execution](docs/decisions/0001-script-workbench-and-shared-ai.md)
- [Architecture, planned layout, and milestones](docs/architecture.md)
- [Original requirements and technical design, v0.1](docs/reference/README.md)

The stack is React, TypeScript, Vite, Tiptap/ProseMirror, Electron,
Rust/Tokio/Axum, SQLite, and Node.js/Remotion with a dedicated rendering browser
and FFmpeg. TypeScript and Rust use pnpm and Cargo workspaces in one repository.

## Working on SceneSparrow

The initial application target is **1.0.0**, still awaiting release acceptance.
Start a short-lived task branch from `release/1.0.0`, such as
`feat/project-persistence` or `fix/locked-shot-validation`, and target
`release/1.0.0` in its PR. After acceptance, merge the release PR into stable `main`;
the immutable `v1.0.0` tag runs full checks before formal release.
See [the workflow](docs/development-workflow.md) for version bumps and hotfixes.

There is one shared deployment at `https://scene.mindreview.me` (host loopback
8070). Release pushes and optional RC tags run full checks before updating that
same instance/data. Ordinary PRs and main pushes do not trigger CI; validate
changes locally and review before merging. The Web deployment workflow supports
manual checks/build/smoke without deployment, including on main. No isolated
preview environment is created.

Commit messages, pull request titles, code comments, and new engineering
documentation use English. The supplied Chinese reference documents retain their
original language. User-facing content is localized rather than restricted to
English.

Keep real user projects, credentials, runtime downloads, and rendered exports out
of this source checkout. Small, licensed, sanitized test fixtures may be committed.
