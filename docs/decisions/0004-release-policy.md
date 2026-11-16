# ADR 0004: Version integration and one shared Web deployment

Status: accepted policy, implementation independently reviewed and locally
validated. Actual remote/server validation remains pending. This does not accept
or publish application 1.0.0.

The user selected a stable `main` baseline and version-specific integration and
acceptance branches. Initial work targets `release/1.0.0`; task branches start
there and PR back there. After version acceptance, the release PR targets main.
After main CI passes, an explicitly created immutable `v1.0.0` tag initiates the
formal release. There is no permanent develop branch. Compatible features,
compatible fixes and breaking changes next use 1.1.0, 1.0.1 and 2.0.0 respectively.
Hotfixes must also be forward-ported to any next release in progress.

There is only one deployed environment during development. Its public origin is
`https://scene.mindreview.me`, default host port 8070, Compose project scenesparrow,
directory `/srv/scenesparrow`, and existing project/appdata volumes and credential
configuration. The existing GitHub Environment name `web-production` is retained
for compatibility. Release pushes, optional matching RC tags and stable tags all
replace this instance and use its data; candidates are not isolated preproduction.
Main pushes only check. Manual dispatch defaults to build/test; explicit deploy
requires a valid release branch, stable tag or RC tag.

A Node-builtins helper enforces strict version/ref syntax, application version
agreement, exact event checkout and freshly fetched remote refs before publishing
and deployment. Stable tag commits must be on main history; RC tag commits must
be on matching release history. Full CI plus final-container smoke precede a
single image publication; deployment consumes that image's immutable digest.
Queued concurrency never cancels a running deployment. The existing pull-before-
downtime, running-volume-owner refusal, offline backups, secret rotation and no
automatic database rollback invariants remain.

All private pnpm packages and four Cargo crates share the application version.
The `pnpm release:version` helper changes only these manifests/lock entries;
protocol versions, schema identifiers, migrations and historical design versions
remain independent. 1.0.0 is the initial application target, not accepted release
evidence. Remote branch protections and settings are recommendations until
configured explicitly; this policy does not create tags or change remote settings.

Operator configuration uses separate GitHub username/password secrets, rejecting
an incomplete pair before SSH. A complete pair takes precedence over optional
legacy combined auth; legacy fallback applies only if both new secrets are unset.
Passwords accept 16–256 printable ASCII characters without spaces and usernames
1–64 ASCII letters, digits, underscore or hyphen. This preserves browser Basic
auth, secure mounted secret files and constant-time authentication, with no new
accounts/login UI. AI credentials retain session-memory behavior.

See [the workflow](../development-workflow.md), [runbook](../web-deployment.md) and
[validation](../validation/release-policy.md). No additional server, DNS/TLS or
provider behavior is authorized by this decision.
