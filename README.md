# SceneSparrow · 幕雀

SceneSparrow is a local-first, AI-assisted video creation application. It brings
script writing, review, storyboarding, editable video, and targeted revisions into
one workspace while preserving approved work.

Windows and macOS are the intended product platforms. A browser entry point will
validate the same React UI, application protocol, and Rust core during development.
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
evidence, outline generation/adjustment and one complete initial draft. Review,
production locks and export follow in steps 6–8; the
[workbench and shared AI specifications](docs/design/README.md) define those slices.

The initial pnpm/Cargo monorepo is runnable: a shared bilingual React UI connects
to an authenticated Rust core and creates/reopens a SQLite project. Electron uses
the same UI through a restricted preload bridge. A Remotion sample validates the
separate render pipeline. The render sample remains a framework example. Native
Windows/macOS desktop validation and complete-stage acceptance remain open.
Measured 500 KB/2 MB save and undo latency exceed the initial budgets; performance
optimization and native document-worker RSS enforcement remain open for step 8.
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

Use a short-lived task branch from `main`, such as `feat/project-persistence` or
`fix/locked-shot-validation`. Submit changes through a pull request targeting
`main`; do not develop directly on `main`.

Commit messages, pull request titles, code comments, and new engineering
documentation use English. The supplied Chinese reference documents retain their
original language. User-facing content is localized rather than restricted to
English.

Keep real user projects, credentials, runtime downloads, and rendered exports out
of this source checkout. Small, licensed, sanitized test fixtures may be committed.
