# ADR 0004: Version integration and one shared Web deployment

Status: accepted policy, implementation independently reviewed and locally
validated. Actual remote/server validation remains pending. This does not accept
or publish application 1.0.0.

The user selected a stable `main` baseline and version-specific integration and
acceptance branches. Initial work targets `release/1.0.0`; task branches start
there and PR back there. After version acceptance, the release PR targets main.
An explicitly created immutable `v1.0.0` tag on accepted main history runs full
checks before the formal release. There is no permanent develop branch. Compatible
features, compatible fixes and breaking changes next use 1.1.0, 1.0.1 and 2.0.0 respectively.
Hotfixes must also be forward-ported to any next release in progress.

There is only one deployed environment during development. Its public origin is
`https://scene.mindreview.me`, default host port 8070, Compose project scenesparrow,
directory `/srv/scenesparrow`, and existing project/appdata volumes and credential
configuration. The existing GitHub Environment name `web-production` is retained
for compatibility. Release pushes, optional matching RC tags and stable tags all
replace this instance and use its data; candidates are not isolated preproduction.
PRs targeting main/release branches and main pushes run Foundation checks. This
restores the pre-merge gate at the user's request after a browser test failure
reached release integration. Local validation and root review remain required
before merging. A task PR merged into a release branch triggers
the deployment workflow once via its resulting release push. Manual dispatch
defaults to checks/build/smoke, including on main; explicit deploy requires a valid
release branch, stable tag or RC tag.

A Node-builtins helper enforces strict version/ref syntax, application version
agreement, exact event checkout and freshly fetched remote refs before publishing
and deployment. Stable tag commits must be on main history; RC tag commits must
be on matching release history. The Web deployment workflow reuses Foundation
checks, then runs final-container smoke before a single image publication;
deployment consumes that image's immutable digest.
Queued concurrency never cancels a running deployment. The existing pull-before-
downtime, running-volume-owner refusal, offline backups, secret rotation and no
automatic database rollback invariants remain.

All private pnpm packages and four Cargo crates share the application version.
The `pnpm release:version` helper changes only these manifests/lock entries;
protocol versions, schema identifiers, migrations and historical design versions
remain independent. 1.0.0 is the initial application target, not accepted release
evidence. Remote branch protections and settings are recommendations until
configured explicitly; this policy does not create tags or change remote settings.
PR protections should require the `foundation` status on main and release
branches, with the branch up to date before merging. Foundation tests the PR merge
commit using read-only repository permissions and no deployment secrets. It runs
without path filters, including for draft PRs, and retains browser failure traces
for seven days. Deployment jobs run only after a release push and cannot serve as
PR checks. Configuring the workflow alone does not enforce branch protection.

Operator configuration uses separate GitHub username/password secrets, rejecting
an incomplete pair before SSH. A complete pair takes precedence over optional
legacy combined auth; legacy fallback applies only if both new secrets are unset.
Passwords accept 6–256 printable ASCII characters without spaces and usernames
1–64 ASCII letters, digits, underscore or hyphen. This preserves browser Basic
auth, secure mounted secret files and constant-time authentication, with no new
accounts/login UI. AI credentials retain session-memory behavior.

See [the workflow](../development-workflow.md), [runbook](../web-deployment.md) and
[validation](../validation/release-policy.md). No additional server, DNS/TLS or
provider behavior is authorized by this decision.
