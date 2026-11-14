# SceneSparrow · 幕雀

SceneSparrow is a local-first, AI-assisted video creation application. It brings
script writing, review, storyboarding, editable video, and targeted revisions into
one workspace while preserving approved work.

Windows and macOS are the intended product platforms. A browser entry point will
validate the same React UI, application protocol, and Rust core during development.
The initial validation project is a short Chinese-language explanatory video;
the product architecture and contributor workflow support internationalization.

## Repository status

The current phase is framework setup only. The v0.1 technical proposal remains a
preliminary draft, and detailed design documents will precede production workflow
implementation. Existing sample models and interfaces are provisional.

The initial pnpm/Cargo monorepo is runnable: a shared bilingual React UI connects
to an authenticated Rust core and creates/reopens a SQLite project. Electron uses
the same UI through a restricted preload bridge. A Remotion sample validates the
separate render pipeline. These are framework integration samples, not completed
product features or evidence that a business implementation milestone has begun.

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
- [Architecture, planned layout, and milestones](docs/architecture.md)
- [Original requirements and technical design, v0.1](docs/reference/README.md)

The planned stack is React, TypeScript, Vite, Tiptap/ProseMirror, Electron,
Rust/Tokio/Axum, SQLite, and Node.js/Remotion with a dedicated rendering browser
and FFmpeg. TypeScript and Rust will use pnpm and Cargo workspaces in one repository.

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
