# Lean code cleanup

Base: `b410b5c` on `release/1.0.0`. This follow-up implements the seven
deletion, consolidation and responsibility-splitting recommendations from the
repository audit. It does not implement the separate bug-review findings.

## Changes and review

| Recommendation                          | Result                                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consolidate Markdown writers            | Added the pure `@scenesparrow/manuscript-format` workspace package. The editor parser and document exporter use one writer, with caller-specific empty-output and final-newline adapters.                                                |
| Consolidate database execution wrappers | One service helper acquires the database semaphore, keeps its permit inside blocking work, and preserves response/error mapping and receipt request IDs.                                                                                 |
| Remove obsolete CSS                     | Removed nine rules for unused classes, pruned unused selector branches and removed 63 declarations superseded in the same selector/at-rule context. Effective declaration maps for reachable selectors matched before and after cleanup. |
| Remove dead computations and helpers    | Removed the discarded retired-credential vector, unused runtime search helper and unused credential-selection argument. Credential reconciliation remains in place.                                                                      |
| Remove unused editor dependencies       | Removed the editor's direct `@remotion/player` and `@scenesparrow/video-runtime` dependencies. Rendering still needs these packages; this does not claim a smaller complete workspace installation.                                      |
| Split manuscript import UI              | Moved `ImportDialog` out of `Sources`, with a single shared warning formatter. Root independently compared the component and formatter bodies with the prior commit: unchanged.                                                          |
| Split desktop IPC responsibilities      | Extracted named AI and export/copy IPC routes. Main retains current process/session/window ownership, sender/frame/URL validation, JSON authentication, SSE, registry and project switching.                                             |

The shared writer adopts the editor's existing overlap grouping and terminal
hard-break normalization, and retains the exporter's CRLF normalization. Exported
Markdown now follows the same formatting semantics as the editor. TXT and DOCX
implementations are unchanged. The `canonical-1` identity, protocol, project
format, migrations and localization resources are unchanged; existing artifacts
remain immutable.

The database helper leaves AI dispatch on its separate semaphore and preserves
replay before settings resolution. Specialized document/AI workers and project
service response mapping remain separate. Desktop export settling and replay-cache
clearing occur at the same close/switch boundaries; authenticated session getters
read current host state rather than retaining initial tokens.

Root implemented localized cleanup, designed the shared seams and independently
reviewed both substantial implementation deliveries. Each accepted step was
committed and pushed before starting the next, following
[the implementation workflow](../implementation-execution.md).

## Validation

| Check                                                               | Result                                                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused settings/runtime tests and credential retirement regression | 22 Node tests and one Rust regression passed.                                                                                                                                      |
| Native Node Markdown tests, without a tsx loader                    | 17 passed, exercising both real consumers, independent reparsing, overlapping marks, nested/restarted lists, CRLF, terminal breaks and invalid links.                              |
| Service tests and all-target service Clippy                         | Five tests passed; Clippy passed. The new regression covers cancellation retaining the database slot, queued work, panic mapping and error details/request ID preservation.        |
| Focused desktop/export/reference/activation/process tests           | 41 passed, including five new IPC tests for sender denial, closed routes, current authentication, binary limits/hash validation, stale native ownership and settle/clear behavior. |
| Focused package/editor/desktop typechecks and desktop build         | Passed.                                                                                                                                                                            |
| `pnpm check`                                                        | Passed: contracts, formatting, workspace typechecks, 276 Node tests, 201 Rust tests and all-target Clippy.                                                                         |
| `pnpm build`                                                        | Passed.                                                                                                                                                                            |
| `pnpm test:integration`                                             | 12 passed.                                                                                                                                                                         |
| Full browser suite and GitHub `foundation`                          | Final outcomes are tracked in [PR #18](https://github.com/Geminorun/SceneSparrow/pull/18).                                                                                         |
| Browser screenshot inspection                                       | Inspected current 1280px workbench/Library and 375px planning/settings screenshots; no visible layout regression observed.                                                         |

The PR records full browser validation and the required `foundation` status.
Mocked desktop checks do not establish real Electron, Windows or macOS behavior.
Live providers, container deployment and opt-in performance suites are outside
this refactor's validation.
