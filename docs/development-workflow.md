# Development workflow

## Branch model

`main` is the stable, accepted baseline. Development integrates and is accepted on
`release/MAJOR.MINOR.PATCH`; the initial target is `release/1.0.0`. Features and
fixes start from the active release branch and return to it by PR. No permanent
`develop` branch is used. A single monorepo keeps UI, core, protocol and workers
coordinated.

| Branch or tag                                                                      | Purpose                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `main`                                                                             | Stable baseline after version acceptance; pushes run Foundation checks        |
| `release/1.0.0`                                                                    | Initial version integration and acceptance; pushes deploy the shared instance |
| `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`, `build/`, `ci/`, `perf/` | Short-lived task branches, PR to the active release branch                    |
| `v1.0.0-rc.1`                                                                      | Optional immutable candidate tag on the matching release history              |
| `v1.0.0`                                                                           | Immutable formal release tag on accepted main history                         |

Task names use lowercase English kebab-case, e.g. `feat/42-script-review`.
Release branches integrate a complete version; they are not separate deployment
environments. There is only one deployed instance, domain, port, Compose project,
configuration directory, credential set and pair of data volumes. Candidate and
formal release deployment replace the same application and operate on the same
project/global configuration. Each deployment backs up that data before startup.

## Daily workflow

1. Inspect repository status and preserve existing changes. Root alone manages
   branches and Git delivery during delegated implementation.
2. Fetch the active release branch and create a focused task branch from it.
3. Implement, validate locally and review; keep credentials and real projects out
   of Git. PRs targeting main/release branches and main pushes run Foundation checks.
4. Open an English PR targeting `release/1.0.0` for the initial version. Include
   relevant checks and unresolved limits. Wait for the `foundation` check to pass
   on the current PR merge commit. Prefer squash merge for task PRs.
5. After merge, delete the task branch and start the next from the updated release.
6. Once the version passes user acceptance, open a release PR into `main`. Preserve
   the accepted release history with a merge commit so optional RC tags remain
   reachable; do not squash the entire release integration history.
7. Explicitly create the immutable matching stable tag on the accepted main
   commit. Tag CI checks and smokes that code before formal publication/deployment.
   This policy does not itself accept 1.0.0, create tags, merge PRs or deploy.

```sh
git fetch origin
git switch -c feat/project-persistence origin/release/1.0.0
# Open the resulting PR with base release/1.0.0.
```

The local initial release baseline is created from accepted `origin/main`; its
existence does not establish a remote protected branch or release acceptance.

## Design and stage specifications

Use the following sequence for planned product work: technical design, stage spec
with ordered tasks, implementation with tests, then PR validation. The
[spec index](specs/README.md) defines one document for each S1–S4 stage and a separate
document for shared AI. Each stage keeps its functional contracts, task breakdown
and acceptance cases together. The [S1 spec](specs/s1-manuscript-foundation.md) is
the first detailed implementation slice; [S2](specs/s2-outline-and-initial-draft.md)
specifies planning and drafting against the independent shared AI boundary.
The [S3 spec](specs/s3-review-and-finalization.md) extends those contracts with
review decisions, production lock enforcement and derived finalization.
The [S4 spec](specs/s4-delivery-and-validation.md) defines export/delivery and the
evidence required for recovery, complete workflows and target-platform readiness.
The [shared AI spec](specs/shared-ai-integration.md) independently defines provider
access, credentials, task execution and the initial migration ledger. S1 can be
implemented without AI; live S2/S3 integration depends on this shared capability.

Before implementing a stage, make its scope, user behavior, data/command contracts,
errors, recovery, dependencies and acceptance criteria concrete in that spec.
Shared AI owns provider/configuration/execution rules; S2/S3 reference its
independent spec and own manuscript orchestration. Avoid duplicating AI rules
inside each business stage.

Resolve material product ambiguities with the user while applying previously
confirmed decisions directly. Routine engineering choices can be specified and
validated during implementation. A documentation request authorizes its documented
scope; task checklists do not themselves start feature development. Record actual
test evidence with completed tasks and keep any deviations visible in the spec.

Documentation changes use relevant formatting/link/integrity checks. Product changes
add behavioral checks for the touched contracts and acceptance IDs. A spec is not
evidence that its implementation or tests have passed.

## Commits and pull requests

The user-selected [eight-step implementation workflow](implementation-execution.md)
defines subagent settings, root review, correction loops and the per-step
commit/push gate. It supplements this branch/PR policy. Implementation agents
deliver uncommitted changes; only root stages and pushes reviewed commits.

This delegation workflow applies only to substantial coding work. The primary
agent directly handles planning, design, requirements/research, standalone
documentation, and small/localized code changes. Read-only subagents follow the
same scope limit.

Use `type(scope): summary`, with an optional scope and an imperative English
summary. Types are `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`,
and `perf`. Useful scopes include `web`, `desktop`, `editor`, `contracts`, `core`,
`assets`, `review`, `agent`, `render`, and `i18n`.

Examples:

```text
feat(review): reject changes that affect locked shots
fix(render): preserve audio timing across chunk boundaries
docs: document the project recovery model
chore(repo): add repository conventions and ignore rules
```

Commit bodies and PR descriptions also use English. Explain meaningful behavior
changes and evidence; avoid generic messages such as `update` or `fix bugs`. Mark
breaking public protocol or project-format changes using `!` and explain migration
and compatibility in a `BREAKING CHANGE:` footer when appropriate.

Git branches track application source development. User-project candidate
revisions, locks, and review acceptance are application concepts; Git branch names
must not substitute for those mechanisms.

## Recommended GitHub settings

These are recommendations, not configured or enforced server-side settings.
Keep `main` as default; protect it and `release/*` against direct development,
force pushes and deletion. Protect version tags against update/deletion as well;
formal and RC tags are immutable. Require PRs and resolved conversations, with
local validation and review evidence. Require the `foundation` status from
`Foundation checks` on both main and release branches, with the branch up to date
before merging. Deployment jobs run after merge and cannot serve as PR status
checks. Do not bypass a failed or pending Foundation check. Use squash merging for task PRs and merge
commits for release-to-main PRs. Delete merged task branches; retain the release branch while candidates,
acceptance or maintenance need it. With multiple maintainers, require independent
human review; a sole maintainer should avoid an impossible approval requirement.
Agents do not constitute independent human approval. Validate Windows/macOS at
relevant desktop milestones; Linux CI cannot certify them.

The existing GitHub Environment name `web-production` remains for compatibility
and represents the one shared deployment. Its branch/tag policies, if configured,
must allow valid release branches, matching RC tags and stable version tags.
This change does not install approval gates or alter remote settings.

## Versions, releases and maintenance

All private pnpm package versions and the Cargo workspace version share the
application version. To prepare a version on its release branch, run:

```sh
pnpm release:version 1.1.0
```

This builtin helper updates only private package manifests, Cargo workspace
version and four workspace Cargo.lock entries. It does not upgrade dependencies,
change protocol/schema/migration versions, commit or create a tag. CI checks that
all application versions agree and match release/tag refs. Application 1.0.0 is
the initial target, not an assertion of accepted delivery; design v0.1 and
protocolVersion remain independently versioned.

After 1.0.0, a compatible feature targets `release/1.1.0`; a compatible correction
uses `release/1.0.1`; a breaking change uses `release/2.0.0`. Start each version
branch from the appropriate accepted main baseline. For an urgent 1.0.1 while
1.1.0 is in progress, branch the fix from `release/1.0.1`, PR it there, accept and
merge it into main, then tag `v1.0.1` to run checks before release. Forward-port the
fix by reviewed PR into `release/1.1.0`. Keep version bumps consistent with each target.

The [deployment runbook](web-deployment.md) and [ADR 0004](decisions/0004-release-policy.md)
define allowed deployment refs. Release pushes and optional `v1.0.0-rc.1` tags
deploy to the same instance as formal `v1.0.0`; candidates have the same access to
real shared data. Full checks run once in the Web deployment workflow before each
deployment. A task PR merged into a release branch triggers this deployment via
the resulting release push. Before merge, Foundation checks test the PR merge
commit without publishing or deploying. PRs and main pushes run all build, unit
and integration checks plus `pnpm test:e2e:smoke` for file-backed Web writing. Use
**Run workflow** on **Foundation checks** for the full browser suite without
deployment. A manual run of **Private Web deployment** defaults to verification,
with explicit deployment restricted to valid version refs.
