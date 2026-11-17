# Foundation checks and responsive pane regression

The user requested restoration of pre-merge checks after
[release run 44050812479](https://github.com/Geminorun/SceneSparrow/actions/runs/44050812479)
failed the workspace pane keyboard/navigation browser case at the 90-second test
limit. This supersedes the earlier
[deployment-only trigger refinement](deployment-check-triggers.md).

## Failure and correction

Local repetition reproduced the timeout. The trace showed `openPanel` reading
the desktop opener as hidden immediately after `setViewportSize`, then waiting
for the Create tab after the media-query listener had switched React to a closed
mobile drawer. The tab was correctly hidden; the test helper had acted on the
previous layout. The failure snapshot showed the mobile Open assistant button.

The shared `openPanel` helper now waits for `data-layout` to agree with the current
media query before inspecting opener visibility. It preserves the original
keyboard, resize, saved-width, focus-return and inert-background assertions and
the existing 90-second timeout. No product behavior or save preference changed.

## Merge and deployment checks

`.github/workflows/ci.yml` restores `Foundation checks` for PRs targeting main or
release branches and main pushes. PRs check the synthetic merge commit, including
drafts, without path filters. The `foundation` job performs frozen installation,
contracts/format/types/unit/Rust/Clippy checks, builds, integration and browser
tests. It has read-only repository permissions and no deployment credentials.
Browser failures retain `test-results/` traces and error contexts for seven days.
New commits cancel obsolete PR runs.

The Web deployment workflow calls the same local reusable workflow after its
release-policy job. Image publication/deployment still depend on those checks;
publication, exact-ref validation, smoke, shared environment, backup, immutable
digest and deployment concurrency rules remain unchanged. Release commits are
checked again after merge before deployment.

Require `foundation` on main and release branches, and require branches to be up
to date before merging. The workflow alone cannot enforce that setting. During
this task, repository branch listings reported both main and release/1.0.0 as
unprotected. The available GitHub integration returned HTTP 403, Resource not
accessible by integration, for the branch-protection endpoint, so remote
protection changes could not be made with this credential.

## Validation

Managed Linux validation:

- `pnpm check`: contracts, formatting, types, 237 Node tests, 194 Rust tests and
  warnings-denied Clippy passed.
- `pnpm build`: Web, desktop TypeScript and Rust workspace builds passed.
- `pnpm test:integration`: all 11 tests passed.
- The original pane keyboard/navigation case passed 20 consecutive times using
  Playwright's bundled Chromium, with retries disabled.
- actionlint 1.7.12 passed both workflow files; `git diff --check` passed.

The associated PR tracks the complete browser regression and GitHub-hosted checks.
No merge, release, deployment, production data or credential change is part of
this correction. Linux validation does not certify native Windows/macOS behavior.
