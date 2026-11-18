# Architecture ownership cleanup

Base: `639e046`, following the first lean-code cleanup in
[PR #18](https://github.com/Geminorun/SceneSparrow/pull/18). The user authorized the
seven architecture recommendations: workbench separation, project-session
ownership, background-job ownership, common storage, document-process mechanisms,
Web runtime ownership and client adapter separation.

## Implementation and independent review

| Scope                                    | Result and evidence                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust routes, background work and storage | HTTP modules now live in `service/src/routes/`; `jobs.rs` starts the unchanged independent loops. Object promotion/read, retention/collection and operation verification live in `infrastructure/src/storage/`. Root compared seven moved method/loop bodies and the verification implementation against the prior commit.  |
| Production Web host and client adapters  | Five runtime modules moved to `apps/web/server/`. Root compared their full bodies; only package/schema path depth changed. Root compared eight extracted client declarations by TypeScript AST; public exports and behavior are unchanged. Docker and active runtime consumers use the new paths.                           |
| Workbench and project session            | Feature directories replace the editor catch-all. One mounted `ProjectSession` retains the original queue/revision/receipt/history state. `ProjectCommands` retains per-caller pending identities; planning/body buffers remain distinct. Root compared declarations in 50 files after intended identifier/type relocation. |
| Tiptap responsibility                    | `manuscript/use-manuscript-editor.ts` owns the existing editor initializer and handlers. Root AST comparison matched the original initializer/dependencies after injecting the label. Workbench retains view/pane/recovery presentation; hidden editors remain mounted.                                                     |
| Shared UI and tests                      | Reusable dialog/focus/icon primitives and shared save/view types have explicit owners. Renamed project-session/project-command tests retain their assertions. Acceptance-matrix links follow the test moves; historical command transcripts remain unchanged.                                                               |
| Document processes                       | One small module owns the existing command environment/stdio, child kill/wait and Linux RSS sampling. The three owners retain their protocol, cancellation/deadline loops, limits and errors. Root inspected every owner diff and reran four actual-process/visual regressions. This extraction removes 51 net lines.       |
| Current architecture                     | `docs/architecture.md` now maps implemented owners, the file tree, dependency direction and actual UI/core/worker call paths. It distinguishes current implementation from historical product plans.                                                                                                                        |

No new dependencies, workspace packages, protocol/schema changes, migrations,
localization strings or presentation styles were introduced. The core remains the
sole authoritative writer; configuration remains global. Root designed the seams,
reviewed each delegated implementation and alone committed/pushed each accepted
step before starting the next.

## Verified checkpoints

| Check                                      | Actual result                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust workspace tests and all-target Clippy | 201 tests passed after route/storage changes and again after process extraction; Clippy passed. Root independently reran five service, two collection/backup and four process/visual tests.                                                                               |
| Web/client focused tests                   | Root independently reran 17 native Node Web/runtime/operator tests and 38 public-client/desktop/reference/event tests; all passed.                                                                                                                                        |
| UI units and builds                        | All 276 Node tests, workspace typechecks and both app builds passed after the UI moves. Root independently reran 129 focused UI tests and typechecks.                                                                                                                     |
| Focused browser regression                 | All 22 manuscript, Markdown-workspace and writing-workspace cases passed. The later correction removed one unused import; final formatting/typechecks passed.                                                                                                             |
| Static import graph                        | Root scanned 77 UI/client/desktop source files and found no static relative import cycles, including type imports. This does not claim to cover dynamic imports or external package graphs.                                                                               |
| Intermediate container                     | Linux AMD64 image `scenesparrow-web:architecture-step-b` built successfully. Existing container smoke passed with real core, authenticated built Web, diagnostics, document workers/exports, synthetic local AI, encrypted credentials, graceful restart and persistence. |
| Final repository/image gates               | Final `pnpm check`, build, integration, full browser suite, rebuilt image smoke and current GitHub `foundation` outcomes are recorded in [PR #18](https://github.com/Geminorun/SceneSparrow/pull/18).                                                                     |

The intermediate image predates the UI/process steps; it is not evidence for the
final artifact. The PR records the final image separately. Linux process checks
do not establish Windows/macOS reaping or RSS enforcement. Real native desktop,
credential stores, live providers and opt-in performance acceptance remain open.
No deployment or merge is part of this refactor.
