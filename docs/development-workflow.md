# Development workflow

## Branch model

Use a lightweight trunk-based workflow: one long-lived `main`, short-lived task
branches, and pull requests. A single monorepo keeps coordinated UI, core,
protocol, and worker changes together. A permanent `develop` branch would add a
second integration baseline without a current release-management need.

| Branch or tag | Purpose | Lifecycle |
| --- | --- | --- |
| `main` | Reviewed integration baseline; kept buildable as implementation grows | Permanent |
| `feat/<description>` | Product capability | Delete after merge |
| `fix/<description>` | Defect correction, including urgent fixes | Delete after merge |
| `refactor/`, `docs/`, `test/`, `chore/`, `build/`, `ci/`, `perf/` | Focused maintenance and engineering work | Delete after merge |
| `release/<major>.<minor>` | Optional maintenance for a shipped version that differs from `main` | Create only when needed |
| `v0.1.0`, `v0.1.0-alpha.1` | A specific reviewed release commit | Immutable |

Branch names use lowercase English kebab-case; optionally include an issue number,
such as `feat/42-script-review`. Keep each branch focused on one reviewable outcome
and merge promptly rather than maintaining personal or module-specific branches.

The empty repository was seeded with one empty root commit on `main`. All bootstrap
files are developed on `chore/repository-bootstrap`. This one-time seed establishes
a real base for a PR; it is not permission for later direct development on `main`.

## Daily workflow

1. Inspect `git status --short --branch` and preserve existing changes.
2. Once `origin/main` exists, fetch it and create a task branch from its latest
   reviewed state. Before the first remote push, use local `main` as the base.
3. Implement a focused change, run relevant checks, and review the diff. Keep
   credentials, user projects, and generated artifacts out of the commit.
4. Commit in English and open a PR targeting `main`. Include validation evidence
   and any known limitations. Draft PRs are useful for early feedback.
5. Address review and pass applicable checks. Prefer squash merge, using the
   Conventional Commit PR title as the resulting commit subject.
6. Delete the merged task branch. Start the next independent task from updated
   `main`. Rebase only private local history; coordinate changes to shared branches.

After the remote baseline exists, a typical start is:

```sh
git fetch origin
git switch -c feat/project-persistence origin/main
```

## Commits and pull requests

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

These are settings to apply when the remote `main` exists. This document and
`AGENTS.md` do not enforce server-side protection; no remote settings have been
changed by this bootstrap.

- Set `main` as the default branch; require PRs, resolved review conversations,
  and linear history; disallow force pushes and branch deletion.
- Use squash merging and automatically delete merged task branches.
- With multiple maintainers, require at least one independent approval and dismiss
  stale approvals after changes. For a sole maintainer, keep the PR workflow but
  avoid an approval rule that nobody else can satisfy; agents are not independent
  human reviewers.
- Require actual CI jobs only after those workflows exist and pass reliably. Add
  formatting, lint, type, domain, integration, and schema-consistency checks as the
  corresponding components land. Do not configure nonexistent required checks.
- Validate Windows x64 and macOS Apple Silicon for relevant desktop milestones.
  Linux CI provides useful core checks but cannot certify desktop behavior.
- Add path ownership rules when real maintainers are assigned; do not invent
  GitHub usernames or teams in `CODEOWNERS`.

## Releases and maintenance

Tag reviewed commits on `main` for initial pre-release development. Do not create
release branches for each milestone. If a shipped version later needs maintenance
while `main` has advanced, use a `release/<major>.<minor>` branch with the same PR
and validation rules, and bring fixes back to `main` through a separate PR.

Version tags identify source revisions; they do not by themselves publish binaries
or prove signing, upgrades, media compatibility, or recovery have been validated.
