# Development setup

## What the foundation implements

The pnpm workspace contains a shared React UI, browser and Electron entry points,
JSON Schema contracts, a platform client, a procedural Remotion sample, and Agent
and render boundaries. The Cargo workspace separates domain, application,
infrastructure, and local HTTP service responsibilities.

The current integration sample creates one project in a selected directory, persists
it in SQLite, and reopens it after a core restart. The working revision starts at
zero and has no approved baseline. Creating the same request twice is idempotent;
a different request cannot replace the existing project. A file lock prevents two
core instances from owning the same directory.

The current phase is detailed design following framework setup. The
[workbench and shared AI specifications](design/README.md) describe planned
functionality, not a completed business implementation milestone. Script
editing/Tiptap, assets, revision history, lock enforcement, review acceptance, SSE,
durable worker jobs, provider authentication, incremental rendering, file pickers,
packaging, and updates remain to be implemented. The Agent package contains an
interface only. The sample render does not render project scenes or contain audio.

## Pinned tools and prerequisites

| Tool              | Version / policy                                              |
| ----------------- | ------------------------------------------------------------- |
| Node.js           | 24.22.1, `.node-version`                                      |
| pnpm              | 11.25.0, root `packageManager`                                |
| Rust              | 1.100.0, `rust-toolchain.toml`, with rustfmt and Clippy       |
| TypeScript        | 5.9.3                                                         |
| React / Vite      | 19.3.1 / 8.3.8                                                |
| Electron          | 45.3.2, installed independently of the renderer browser       |
| Remotion          | 4.0.543 across all Remotion packages                          |
| Rendering browser | Chrome Headless Shell selected by the pinned Remotion version |
| FFmpeg            | System prerequisite; cloud validation uses 7.1.5              |
| SQLite            | Bundled through rusqlite; no database server needed           |

Install Node, pnpm, Rust/rustfmt/Clippy, a native C compiler, and FFmpeg for local
development. Windows needs the MSVC build tools; macOS needs Xcode command-line
tools. The pinned pnpm and Cargo lockfiles define dependency resolution. Production
bundling of Node, FFmpeg, and browsers is future packaging work; current developer
prerequisites are not the intended end-user installation experience.

```sh
pnpm install --frozen-lockfile
node apps/desktop/node_modules/electron/install.js
pnpm build
pnpm dev
```

Run from the repository root. The development launcher builds and starts the core,
generates an ephemeral session token, waits for authenticated readiness, then
starts Vite. The token remains in server/main-process memory and is never a
`VITE_*` client variable. Vite proxies `/api` to the local core. Only loopback
listeners are used; core requests require authentication and validate supplied
origins. Stop the launcher with Ctrl+C to stop its child services.

The default browser development ports are 5173 (web) and 4318 (core). Override with
`SCENESPARROW_WEB_PORT` and `SCENESPARROW_CORE_PORT`. Browser development stores its
scratch project in `.local/project`; `SCENESPARROW_PROJECT_DIR` selects a different
directory. Each directory currently holds one project, so use a fresh directory
to create another. Do not point development tests at real user projects.

## Managed cloud environment

```sh
cd /workspace/SceneSparrow
bash scripts/cloud-setup.sh
source scripts/cloud-env.sh
pnpm dev
```

The setup script installs tools into `/workspace/.toolchains`, uses writable cache
locations, installs locked dependencies, downloads Electron through its verified
installer, builds the workspaces, and exercises rendering. It preserves TLS and
artifact verification and uses the existing proxy configuration. Node, FFmpeg,
Chromium, and native build tools are supplied by the managed base image; missing
prerequisites produce explicit errors. Source `cloud-env.sh` in each new shell;
live services do not survive environment snapshots.

The current cloud supports the browser workflow and headless Remotion rendering.
The Electron binary is installed and TypeScript compilation is validated, but
launching it in this managed Linux sandbox fails because its Chromium sandbox
helper cannot be configured here. No `--no-sandbox` workaround is included. Test
the desktop application on the intended Windows/macOS hosts; cloud browser tests
do not establish desktop readiness.

## Desktop development

```sh
pnpm dev:desktop
```

The launcher builds the web bundle, desktop code, and Rust core. Electron owns the
core lifecycle, creates a session token, and exposes only health/read/create
operations through a sandboxed preload bridge. The renderer cannot read arbitrary
files, run commands, or call arbitrary core endpoints. Electron uses an application
data directory by default; set `SCENESPARROW_PROJECT_DIR` to share a particular
development project with the browser, one core instance at a time.

## Commands and verification

| Command                             | Purpose                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm run env:check`                | Report tool versions and Electron binary presence; does not certify desktop launch |
| `pnpm contracts:generate`           | Generate committed TypeScript and Rust protocol types from JSON Schema             |
| `pnpm contracts:check`              | Detect stale generated protocol types                                              |
| `pnpm typecheck`                    | Check all TypeScript packages                                                      |
| `pnpm format` / `pnpm format:check` | Apply/check Prettier and rustfmt                                                   |
| `pnpm test`                         | Run locale consistency and Rust domain/storage/HTTP tests                          |
| `pnpm check`                        | Run contract, format, type, unit, and Clippy checks                                |
| `pnpm build`                        | Build the browser, Electron shell, and Rust workspaces                             |
| `pnpm test:integration`             | Create a project via HTTP and verify recovery across actual process restart        |
| `pnpm test:e2e`                     | Create/reload a project and switch languages in a real browser                     |
| `pnpm render:smoke`                 | Download the dedicated rendering browser if needed and render 30 H.264 frames      |

For browser tests, use `pnpm exec playwright install chromium`, or point
`SCENESPARROW_TEST_BROWSER` to a compatible installed Chromium. The cloud activation
script selects `/usr/bin/chromium`. Tests use an isolated ignored project under
`.local/`; screenshots and media outputs go to `.artifacts/`. The render sample is
`.artifacts/render/smoke.mp4` (640×360, 30 fps, one second, no audio).

The Linux CI definition performs checks, builds, restart integration, and browser
tests. Remote CI execution and Windows/macOS validation have not occurred merely
because the workflow file exists. Media rendering and desktop packaging should
gain dedicated CI jobs as those workflows mature.

## Protocol and change boundaries

`packages/contracts/schema/protocol.schema.json` is the protocol source of truth.
Its named definitions generate `packages/contracts/src/generated.ts` and
`crates/service/src/contracts.rs`; generated files are committed and checked for
drift. Generated Rust structs reject unknown fields for these closed schema
objects. Domain validation enforces name and request constraints separately.

The initial authenticated endpoints are `GET /v1/health`, `GET /v1/project`, and
`POST /v1/project`. Creation accepts a request ID and title; it does not accept a
client-supplied revision or approve a baseline. There is intentionally no edit,
unlock, or acceptance endpoint until revision and lock validation exist.

The [workbench implementation plan](design/implementation-and-acceptance-v0.1.md)
orders upcoming work by usable manuscript slices. The preliminary M0/M1 media
roadmap does not authorize further feature implementation. Treat the bootstrap's
single-project API as an integration sample, not a substitute for the detailed
domain, history, lock and execution contracts.
All [stage and shared AI specs](specs/README.md) are now documented. Their tasks
remain unimplemented; follow the shared AI migration/port ledger when those slices
are explicitly developed, without making provider access a prerequisite for
manual editing/export.
