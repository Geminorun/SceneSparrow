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

Execution step 1 now provides manual manuscript editing: start an empty draft,
write paragraphs/headings/nested lists with bold, italic, inline code and safe
links, autosave, and reopen acknowledged content. The shared Tiptap editor adapts
application-owned canonical blocks; it does not persist editor JSON or HTML.
Heading navigation derives from the same blocks. Save feedback distinguishes
pending, saving, saved, error and conflict; failed/uncertain saves retain local
input and offer retry or explicit copy/discard recovery.

Migration 002 adds immutable content-addressed objects, canonical block identities
and revisions, request receipts, edit-group metadata and a transactional outbox.
Bootstrap upgrades use SQLite's consistent backup API. Migration 003 adds a
persistent project history with five transitions and at most six shared business
snapshot roots. Its backup directory contains a consistent SQLite database and
pinned copies of immutable objects. Keep each backup directory intact; copying
only the live main SQLite file or deleting its objects cannot restore a project.
The existing project owner lock remains.

The manual command union includes `StartManualDraft`, atomic `ApplyDocumentEdit`,
`UndoProject`, `RedoProject`, and metadata-only `CloseEditGroup`. Document and
history-toolbar shortcuts use the same serialized project queue; native dialog
text inputs retain local undo. Typing batches share one group until 750 ms of
actual input inactivity or a selection/focus/discrete boundary. Save delivery gaps
do not decide typing inactivity. Controlled close drains later valid input that
arrives while group closure is awaiting a receipt. Invalid structure can be
corrected locally, with an explicit retry before dependent project operations.

Step 3 adds a shared reference panel and prepared manuscript import. Link references
remain link-only metadata; file references retain copied original bytes and show
extraction status/text/warnings. Importing TXT, Markdown, DOCX, PDF or pasted text
prepares a preview before start/append/replace; imports do not add references.
Sources and imports use the same serialized queue, mutation-policy seam and five-step
history. Migration 004 extends business roots with backward-compatible source
membership and adds intake, fenced document jobs, provenance and external object pins.

The supervised non-AI Node utility has pinned parsers, bounded input/output, a
60-second wall limit and sampled 512 MiB Linux RSS enforcement. Windows/macOS RSS
budget enforcement remains open; the V8 heap setting is not full OS isolation.
Authenticated SSE supports replay/resync and desktop subscriptions have scoped cleanup.
Reopen verifies retained references, fences interrupted work, abandons active previews
and runs coordinated object GC with a 60-second grace period. Backups own independent
pinned copies and are never traversed by the collector. See
[step 3 evidence](validation/step-03.md) for parser behavior, fault/upgrade tests and
measured performance-budget misses. Production locks, review, AI and export remain
planned. The procedural motion sample remains an independent collapsible example.

## Pinned tools and prerequisites

| Tool              | Version / policy                                                   |
| ----------------- | ------------------------------------------------------------------ |
| Node.js           | 24.22.1, `.node-version`                                           |
| pnpm              | 11.25.0, root `packageManager`                                     |
| Rust              | 1.100.0, `rust-toolchain.toml`, with rustfmt and Clippy            |
| Tiptap            | 3.34.0, including the core, React, ProseMirror and used extensions |
| TypeScript        | 5.9.3                                                              |
| React / Vite      | 19.3.1 / 8.3.8                                                     |
| Electron          | 45.3.2, installed independently of the renderer browser            |
| Remotion          | 4.0.543 across all Remotion packages                               |
| Rendering browser | Chrome Headless Shell selected by the pinned Remotion version      |
| FFmpeg            | System prerequisite; cloud validation uses 7.1.5                   |
| SQLite            | Bundled through rusqlite; no database server needed                |

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
core lifecycle, creates a session token, and exposes only named project/manuscript reads, closed commands and
receipt lookup operations through a sandboxed preload bridge. The renderer cannot read arbitrary
files, run commands, or call arbitrary core endpoints. Electron uses an application
data directory by default; set `SCENESPARROW_PROJECT_DIR` to share a particular
development project with the browser, one core instance at a time.

Controlled desktop close waits for a flush and group closure, repeating the drain
if newer valid input arrives while closure is in flight. Failure keeps the window open for
retry, cancellation or an explicit discard decision; an unresponsive renderer has
a separate confirmation path. The handshake/preload lifecycle is unit-tested and
compiled in the cloud. Actual Windows/macOS launch, IME and close behavior remain
unverified. Browser unload warns about unsaved edits and cannot guarantee a final
asynchronous save. Unexpected process/browser failure can lose unacknowledged
input; no local-storage keystroke replay is used.

## Commands and verification

| Command                             | Purpose                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm run env:check`                | Report tool versions and Electron binary presence; does not certify desktop launch                           |
| `pnpm contracts:generate`           | Generate committed TypeScript and Rust protocol types from JSON Schema                                       |
| `pnpm contracts:check`              | Detect stale generated protocol types                                                                        |
| `pnpm typecheck`                    | Check all TypeScript packages                                                                                |
| `pnpm format` / `pnpm format:check` | Apply/check Prettier and rustfmt                                                                             |
| `pnpm test`                         | Run autosave/bridge/locale and Rust domain/storage/HTTP tests                                                |
| `pnpm check`                        | Run contract, format, type, unit, and Clippy checks                                                          |
| `pnpm build`                        | Build the browser, Electron shell, and Rust workspaces                                                       |
| `pnpm test:integration`             | Save a manuscript/receipts via HTTP and verify actual core restart recovery                                  |
| `pnpm test:e2e`                     | Exercise structure, formatting, IME events, autosave and recovery in Chromium                                |
| `pnpm perf:s1`                      | Measure explicit Linux/browser manuscript fixtures; reports budget misses without claiming native acceptance |
| `pnpm render:smoke`                 | Download the dedicated rendering browser if needed and render 30 H.264 frames                                |

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
Its named definitions generate `packages/contracts/src/generated.ts`, transport-neutral
canonical/command types in `crates/domain/src/contracts.rs`, and transport DTOs in
`crates/service/src/contracts.rs`. The small generator retains closed tagged
command unions, distinguishes required null from missing fields, and rejects
unsupported schema type constructs. Generated files are committed and checked for
drift. Core validation separately enforces canonical invariants and named limits.

The existing authenticated project/health routes remain compatible. New routes:

- `GET /v1/manuscript`: current canonical manuscript and working revision.
- `GET /v1/history`: current working/history revisions, cursor, counts and operation labels.
- `POST /v1/manuscript/commands`: the closed manual-edit/history command union.
- `GET /v1/commands/{requestId}`: resolve an immutable success/rejection receipt.
- `GET /v1/sources`: cursor-paginated membership/extraction summaries.
- `POST /v1/intakes`: raw bounded upload with `x-intake-id` and URI-encoded
  `x-file-name`; `GET`/`DELETE /v1/intakes/{id}` resolves/cancels that intake.
- `POST /v1/document-jobs`, `GET /v1/document-jobs/{id}`: named preparation,
  source extraction, retry/cancel and bounded result reads.
- `GET /v1/source-extractions/{id}?offset=...`: scoped text pages.
- `GET /v1/project/events?after=...`: authenticated SSE with replay/resync;
  authentication never appears in the URL.

Manuscript commands have an 8 MiB route limit; small routes retain 16 KiB. Identical
requests replay their original outcomes before revision checks; changed payloads
with a reused request ID fail. Successful responses follow object verification and
an atomic SQLite commit of state, revisions, receipt and outbox metadata. No-op
edits preserve working/block revisions. History receipts report committed history revision, cursor and undo/redo counts,
with optional operation-label codes. Label fields remain optional so step 1 success
receipts replay unchanged. History rejection details contain only stable reasons
and affected IDs. Undo/redo never restores receipt/event/runtime rows or old
revision tokens.

See [step 1](validation/step-01.md), [step 2](validation/step-02.md) and
[step 3 evidence](validation/step-03.md) for the acceptance mapping and
remaining platform/fault/performance gaps.

The [workbench implementation plan](design/implementation-and-acceptance-v0.1.md)
orders upcoming work by usable manuscript slices. The preliminary M0/M1 media
roadmap does not authorize further feature implementation. Treat the bootstrap's
single-project API as an integration sample, not a substitute for the detailed
domain, history, lock and execution contracts.
All [stage and shared AI specs](specs/README.md) are documented. The manual editing/history/source/import paths above are implemented; follow the shared AI migration/port ledger when those slices
are explicitly developed, without making provider access a prerequisite for
manual editing/export.

## Shared AI (execution step 4)

The global AI settings panel is shared by browser and desktop. Add a provider with
its full compatible API root (no automatic `/v1`), enter a key or explicitly select
no authentication, then manually enter/discover a model and bind it to text.
Audio/video and search remain unavailable. Inference tests are explicit quota
actions against the selected saved provider/manual model; testing another profile
does not change the global text binding. A duplicate submitted test reuses its
session receipt; after restart an uncertain old test is not replayed.

Set `SCENESPARROW_APP_DATA_DIR` to a writable application directory outside the
project. `scripts/cloud-env.sh` defaults it to `/workspace/.local/share/scenesparrow`;
the desktop launcher uses Electron user data. Settings, nonsecret credential
revision inventory and execution-origin registry live there, outside project
undo/backups. Linux/browser development keys are clearly labeled session memory
and disappear on core restart. Windows/macOS keyring source adapters require actual
target-host validation; no plaintext credential fallback exists.

Migration 005 stores generic AI execution state. Internal consumer coordinators use
the application UOW/configuration ports and controlled host tick; no public raw
prompt route exists. The independent runtime uses OpenAI 7.57.0 with retries and
SDK logging disabled, system TLS/proxy transport and rejected redirects. Plain
Node 24 launches `workers/agent/src/entry.mjs` against installed workspace source.
The process has no project DB API, service/API-key environment or generated-code
executor. This development path is not a packaged desktop worker runtime.

Named authenticated routes add `/v1/ai/settings`, credential update/delete, model
discovery, configuration readiness, explicit connection-test prepare/submit and
scoped run/result/cancel reads/actions. Desktop preload exposes matching named
methods. Worker control frames stay bounded; artifact content streams in small
chunks. Blocking settings/credential/project reads run in separate bounded blocking
slots so a settings file lock does not occupy manual editing's database slots.
See [step 4 evidence](validation/step-04.md) for dispatch, recovery, redaction and
platform/provider limitations. S2/S3 business generation remains future work.
