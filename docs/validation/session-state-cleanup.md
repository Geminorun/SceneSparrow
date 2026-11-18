# Session state and planning rule cleanup

Base: `9c50179` on `refactor/lean-code-cleanup`, continuing
[PR #18](https://github.com/Geminorun/SceneSparrow/pull/18). This maintenance
follow-up removes unused code and makes two existing ownership boundaries
explicit. It introduces no new product behavior, dependencies, protocol or
project-format changes, migrations or localization strings.

## Changes and independent review

- Removed the unconsumed agent barrel and capability constant, package export,
  empty TypeScript configuration/check and unused direct contracts dependency.
  The private worker package and actual `entry.mjs` process remain. Updated the
  source-boundary test and workspace lockfile. Existing process tests exercise
  the real worker entry.
- Reused the already loaded AI settings reference in the planning route and
  passed the existing command independence classification through to execution.
  Builders remain lazy; receipt replay still precedes settings resolution.
- Paired the pending control command and its first visible-input snapshot in
  one nullable session-owned object. Creation, retry and every clearing path
  retain the original command/snapshot together. The pure body comparison is
  shared with `ProjectCommands`; history checkpoint settlement remains separate.
  Metadata cancellation, body saves and caller intentions keep distinct owners.
- Moved outline node revision decisions into a pure domain function. The
  infrastructure adapter retains its per-node SQL/error order and existing
  callers for manual save, generated outline adoption and history restoration.
  Single-writer, transaction, receipt, lock and AI dispatch boundaries are unchanged.

Root implemented the localized deletion, designed both ownership seams and
independently reviewed the two sequential implementation deliveries. Only root
committed/pushed reviewed checkpoints. The preexisting untracked `.agents/`
directory was preserved.

## Verification

| Check                                                 | Actual result                                                                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial runtime/command units                         | 25 passed, including actual framed worker processes.                                                                                                                                            |
| Root session/command/composition/planning regressions | 109 passed. New cases cover failed canonical/history readback, repeated original-command retries, preservation of later input, rejection clearing and unsaved history round trips.              |
| Domain planning and storage checks                    | Six domain planning tests and 30 infrastructure planning tests passed. Four new domain tests cover CAS, unchanged/edited/reordered nodes, ID reuse, restore/high-water behavior and exhaustion. |
| `pnpm check`                                          | Passed: contracts, formatting, workspace typechecks, 280 Node tests, 205 Rust tests and all-target Clippy.                                                                                      |
| `pnpm build`                                          | Passed for Web, desktop and the Rust workspace. Existing bundle-size warnings remain.                                                                                                           |
| `pnpm test:integration`                               | All 12 HTTP integration tests passed.                                                                                                                                                           |

The session checks maintain [SF-02](../design/editor-save-and-ai-feedback.md)
and [WIG-01](../design/writing-interaction-and-generation.md). Revision checks
maintain S2-T01/T03 and S2-AC02/09/17 in the
[S2 specification](../specs/s2-outline-and-initial-draft.md).

Final browser, rebuilt-container smoke and hosted `foundation` outcomes are
recorded in [PR #18](https://github.com/Geminorun/SceneSparrow/pull/18). Earlier
architecture image/check results are not evidence for this follow-up artifact.
Linux/fake-provider verification does not establish native Windows/macOS,
credential-store, live-provider or opt-in performance acceptance. No merge or
deployment is part of this cleanup.
