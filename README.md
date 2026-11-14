# SceneSparrow · 幕雀

SceneSparrow is a local-first, AI-assisted video creation application. It brings
script writing, review, storyboarding, editable video, and targeted revisions into
one workspace while preserving approved work.

Windows and macOS are the intended product platforms. A browser entry point will
validate the same React UI, application protocol, and Rust core during development.
The initial validation project is a short Chinese-language explanatory video;
the product architecture and contributor workflow support internationalization.

## Repository status

This repository currently contains project foundations and development guidelines.
Application packages, dependency manifests, toolchain pins, CI, and runnable tests
have not been implemented. There is no application startup command yet.

## Start here

- [Agent and contributor rules](AGENTS.md)
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
