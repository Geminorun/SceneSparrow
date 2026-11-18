# Draft architecture outline

This is a provisional framework outline derived from the two user-provided v0.1
documents. The [manuscript workbench and shared AI designs](design/README.md) now
refine the first product stage and supersede conflicting preliminary assumptions.
Framework samples do not establish implemented business workflows. See the
[reference index](reference/README.md) for the unmodified originals and
[ADR 0001](decisions/0001-script-workbench-and-shared-ai.md) for the scope decisions.

## Product direction

**SceneSparrow / 幕雀** combines content planning, script review, storyboards,
editable video, frame-level feedback, targeted revisions, and export. Its central
promise to validate is changing a selected object while preserving approved work.
The editable project and its history remain primary; an exported video is an
artifact of a specific project snapshot.

The technical design refines the requirements report: Windows and macOS remain
desktop platforms. The browser supports development/validation and the user-selected
[private self-hosted deployment](web-deployment.md), with a built Web gateway, the
same Rust core and Node workers; see [ADR 0003](decisions/0003-private-self-hosted-web.md).
That deployment shares one project and AI configuration without user isolation.
The initial representative project is an approximately two-minute Chinese
explanatory video with text, diagrams, images, narration, and captions. This test
scope does not restrict the internationalized UI or future content languages.

## Runtime responsibilities

| Unit          | Planned technologies                        | Responsibility                                                              |
| ------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| Shared editor | React, TypeScript, Vite, Tiptap/ProseMirror | Script, storyboard, review, asset, and task workspaces                      |
| Desktop shell | Electron and a narrow preload bridge        | Windows, platform APIs, and local process lifecycle                         |
| Local core    | Rust, Tokio, Axum, SQLite                   | Domain rules, revisions, locks, dependencies, persistence, and durable jobs |
| Agent worker  | Provider adapters and versioned Skills      | Read scoped inputs and propose candidate changes with evidence              |
| Render worker | Node.js, Remotion, dedicated Chrome, FFmpeg | Preview, render chunks, transcode, mix audio, and export                    |

Browser and desktop clients share the UI and versioned application protocol.
JSON Schema defines the protocol; TypeScript and Rust protocol structures derive
from it. HTTP/SSE serves browser development, while desktop integration uses
restricted platform capabilities. The Rust core owns authoritative writes.

`apps/web` is also the desktop renderer entry: it mounts the shared
`packages/editor-ui` workbench and selects either the authenticated HTTP client
or the restricted Electron preload client. Web and desktop do not maintain
separate business interfaces. The workbench opens an existing project or atomically
ensures one default project; project-title changes are metadata commands outside
manuscript history. Desktop recent-project locators remain in the host. The
[workspace follow-up](design/workspace-onboarding.md) records settings placement,
editor lifecycle and the single-project Web boundary.

The core is a modular monolith with seven business modules: project/workflow,
script/content, review/versioning, storyboard/engineering, assets/media,
Agent/Skills, and rendering/delivery. These are ownership boundaries within one
core, not seven independently deployed services.

## Workspace layout

The foundation now contains these workspace boundaries, with project creation and
reopening as its first working slice. Worker interfaces and the procedural render
sample do not yet implement production jobs. See [development setup](development.md)
for the exact implemented scope and commands.

```text
SceneSparrow/
├── apps/
│   ├── web/                 # Browser validation entry point
│   └── desktop/             # Electron main process and preload
├── packages/
│   ├── editor-ui/           # Shared application workspaces
│   ├── contracts/           # JSON Schema and generated protocol types
│   ├── manuscript-format/   # Pure Markdown projection shared by editor and worker
│   ├── platform-client/     # Application client and platform interfaces
│   └── video-runtime/       # Remotion components and project interpreter
├── crates/
│   ├── domain/              # Objects, invariants, and dependency rules
│   ├── application/         # Use cases and infrastructure interfaces
│   ├── infrastructure/      # SQLite, files, jobs, and process adapters
│   └── service/             # Local API and service startup
├── workers/
│   ├── agent/               # Provider and Skill execution adapters
│   └── render/              # Rendering, transcoding, mixing, and export
├── skills/                  # Reviewed production Skills and manifests
├── tests/
│   ├── fixtures/            # Small, sanitized, licensed samples
│   └── integration/         # Workflow and platform integration checks
├── scripts/                # Development, packaging, and validation tools
└── docs/                   # References, architecture, workflow, and decisions
```

The pnpm/Cargo manifests, toolchain pins, and lockfiles are now committed with the
foundation. Protocol types are generated from JSON Schema, committed, and checked
with `pnpm contracts:check`. Validate compatible versions when updating dependencies
rather than selecting versions solely from the design's publication date.

## Invariants to implement first

1. **Identity and history:** objects have stable IDs and immutable revisions.
   Bindings connect sentences, shots, elements, audio, and captions. Keep the
   working revision distinct from the approved baseline.
2. **Review and locks:** candidate changes carry their base revision, request
   version, scope, actual patch, and evidence. The core checks the real dependency
   impact and rechecks locks transactionally at acceptance. Only the user unlocks
   or accepts work; Agent completion means pending review.
3. **Time:** use integer frames and half-open ranges. The design suggests 30 fps
   for the initial fixed-frame-rate project. Convert boundaries at Remotion APIs;
   preserve shot-local and global positions and account for transitions/audio.
4. **Storage:** one core owns project writes. Complete and verify immutable files
   before committing database references. SQLite WAL requires consistent backups;
   copying only a live database's main file is insufficient.
5. **Jobs:** persist inputs, attempts, leases, progress, and results. Handle stale
   responses, duplicate receipts, cancellation, and restart without damaging the
   accepted baseline or applying the same result twice.
6. **Isolation:** workers submit proposals; they cannot modify authoritative
   project state. Arbitrary generated code remains disabled until operating-system
   isolation is implemented and tested. Approved structured patches and reviewed
   components are the initial execution model.
7. **Rendering:** compute invalidation from dependencies, including shared styles,
   parent layout, transitions, audio, fonts, and runtime versions. Reuse approved
   chunks when valid. Final encoding may still process the full video even when
   most rendered frames are reused.

## User projects and development outputs

A real user project lives outside the source repository and contains
`project.sqlite`, `objects/`, `staging/`, `cache/`, and `exports/`. Approved objects
and history are durable data; cache entries are rebuildable. Project recovery must
collect all referenced objects from one consistent snapshot.

For development, use ignored root directories such as `.local/` for scratch
projects, `.runtime/` for verified platform runtime downloads, and `.artifacts/`
for render/test outputs. The ignore file also protects conventional root project
data directories and live SQLite files. Small sanitized SQLite fixtures under
`tests/fixtures/` are explicitly allowed; live WAL/journal sidecars remain ignored.
Media extensions are not globally ignored, so legitimate fixtures stay visible.
Large media must be kept in managed external storage or a separately agreed LFS
policy; no LFS dependency is introduced in this bootstrap.

## Internationalization

Use English for engineering collaboration and provide shared `en` and `zh-CN`
resources as UI is implemented. Localize built-in UI text and formatting, while
preserving user-authored content in its own language. Keep stable protocol/error
codes and persisted values independent of display locale. Font availability,
Unicode paths, text expansion, and OS differences need actual platform checks.

## Current implementation direction

Deliver the manuscript workbench first: editing/history, shared AI with
outline-to-draft generation, review/locks, then export and end-to-end validation.
Use the [detailed implementation plan](design/implementation-and-acceptance-v0.1.md).
Audio/video bindings remain architectural extension points. Shared AI execution
does not own script rules or rendering. Internal revision/provenance requirements
remain, with five-step project undo and bounded review comparisons rather than
unbounded user-facing manuscript version management.

## Preliminary full-product stages

The table below preserves the original technical design's stage definitions; the
earlier requirements report uses different M0–M3 boundaries. It is historical
planning context, not the current manuscript-first work order.

| Stage                    | Intended deliverable                                                  | Evidence needed                                                                           |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M0: Core foundation      | Protocol, models, SQLite, assets, and minimal revisions               | Browser entry saves and reopens a project; working/approved revisions are distinct        |
| M1: High-risk mechanisms | Three-shot sample, lock checks, local rendering, basic Electron entry | Shared core works through browser and Windows; applicable DESIGN-v0.1:T03–T08 checks pass |
| M2: Creation loop        | Script, review, storyboard, Agent, preview, and export                | A real two-minute project completes a revision cycle; Windows is the primary experience   |
| M3: Desktop product      | macOS adaptation, packaging, updates, recovery, performance           | Both target platforms pass relevant workflow and distribution checks                      |

The first mechanism scenario locks sentence/shot one, changes shot two's title,
and verifies dependency checks and unaffected chunk reuse. A subsequent narration
duration change must expose downstream invalidation and position-lock conflicts.

Acceptance identifiers must include their source: `DESIGN-v0.1:T04` tests shared
components affecting locked shots, while `REQ-v0.1:T04` tests content/time locks.
The source documents' suggested performance thresholds and reuse examples are not
measured results or delivery commitments.

## Deferred decisions and scope

Prototype platform isolation, media stitching/audio continuity, desktop runtime
packaging, provider authentication/cancellation, and actual performance before
claiming those capabilities. The first production text adapter is OpenAI-compatible
user-supplied API access under the [shared AI spec](specs/shared-ai-integration.md).
Codex App Server remains a deferred candidate; existing subscriptions do not
establish API access or access to every generation capability.

The initial design excludes cloud multitenancy, a second business database,
simultaneous Electron/Tauri implementations, real-time collaboration, automatic
cross-device live-database synchronization, and automatic social publishing.
MotionHarness is a reference for interaction and versioning, not an adopted second
rendering runtime. Record justified architecture changes in `docs/decisions/` as
they arise rather than silently expanding these boundaries.
