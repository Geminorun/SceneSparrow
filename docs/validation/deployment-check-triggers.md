# Deployment check trigger refinement

Historical report: the removal of PR/main checks below has been superseded by
the user's decision to restore Foundation checks before merging. See
[the restored gate and browser regression validation](foundation-checks.md).
The measured results below describe the earlier policy only.

The user requested full checks before deployment without repeating them for
ordinary merges. This amends the trigger policy recorded in the earlier
[release-policy validation](release-policy.md); its measured results remain
historical evidence.

The redundant `Foundation checks` workflow is removed. The remaining
`Private Web deployment` workflow keeps release-branch pushes, version-like tag
pushes and manual dispatch, with this behavior:

| Event                                        | Automatic behavior                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Ordinary PR or task branch push              | No workflow run                                                                                            |
| Main push, including release PR merge        | No workflow run                                                                                            |
| Release branch push, including task PR merge | Full checks, image build/smoke, publish and deploy                                                         |
| Stable or matching RC tag push               | Full checks, image build/smoke, publish and deploy after policy validation                                 |
| Manual dispatch, default                     | Full checks and image build/smoke without publication or deployment, including on main                     |
| Manual dispatch, deploy enabled              | Full checks and image build/smoke before publication/deployment; valid release branch/version tag required |

The deployment workflow changes only its push branch filter. Its policy,
checks, image/smoke/publication and deployment dependencies, exact event SHA,
fresh-ref and ancestry guards, concurrency queue, immutable image digest,
operator authentication, single environment and backup behavior are unchanged.
An accepted release is merged into main and explicitly tagged; the tag run
checks the code before formal deployment. Untagged main deployment remains
forbidden. Local validation, root review and the PR policy remain required.
Recommended PR protections no longer require the removed workflow or deployment
jobs that begin only after a release push. No GitHub settings were changed.

Focused validation passed:

- `node --test tests/unit/release-policy.test.mjs tests/unit/operator-config.test.mjs`:
  five tests, covering exact refs/ancestry, allowed deployment events, main/feature
  deployment rejection, manual defaults and operator credential boundaries.
- `/tmp/scenesparrow-web-tools/actionlint .github/workflows/web-deploy.yml`.
- `pnpm format:check` and `git diff --check`.

Full application, Rust tests/builds, browser, Docker and remote workflow runs are
outside this trigger/documentation change; the storage fix's prior validation
remains in its separate report and PR evidence. No new tests duplicate workflow
YAML; the only retained workflow diff removes main from the push filter.

Root independently reviewed the final trigger diff and documentation, reran the
five focused tests and actionlint, and verified that the Rust fix and its report
were unchanged. The storage commit `4ab12fc` had already passed the complete
[GitHub run 43819424965](https://github.com/Geminorun/SceneSparrow/actions/runs/43819424965)
on its first attempt, including the original export test, 145 infrastructure tests
and 24 browser tests (three performance cases skipped). That evidence belongs to
the storage commit; this trigger-only refinement does not start another PR run.

Read-only GitHub inspection at review time returned no repository rulesets and
reported both main and release/1.0.0 as unprotected, so no required Foundation
status needed removal. No remote settings were changed.
