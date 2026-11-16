# Private self-hosted Web deployment

The production Web entry runs the built React application, Rust core and actual
Node AI/document workers in one Linux AMD64 container. It supports one private
workspace with one project and shared global AI configuration. Everyone given the
operator credential sees and changes the same data. There are no separate users,
tenant boundaries or simultaneous independent projects. Native desktop delivery
and native lifecycle/backup endpoints are unavailable over the public gateway;
browser copy and TXT/Markdown/DOCX downloads remain available. The render sample
does not become a production video service through this deployment.

## Server and repository prerequisites

- Ubuntu 24.04 x86_64, Docker Engine and Compose v2 with `up --wait`, Python 3,
  `flock`, `tar`, OpenSSH/SFTP, sufficient disk for images and retained backups.
- A dedicated SSH deployment user able to run Docker without interactive sudo.
  Docker access grants root-equivalent server control; restrict the deployment
  key and repository/environment administrators accordingly.
- A writable deployment directory, default `/srv/scenesparrow`, created for that
  user. The path must be absolute and contain only letters, digits, `_`, `-`, `/`.
  It must not be a general system directory. Keep the same directory across runs.
- An existing host HTTPS reverse proxy to `127.0.0.1:8070`, an appropriate origin
  certificate and DNS. Cloudflare must use **Full (strict)** and bypass caching
  for `scene.mindreview.me`. Use per-hostname configuration/rules; do not change
  zone-wide TLS settings or the existing `mindreview.me` website virtual host. Cloudflare DNS proxying alone is not access authentication.
  Optional Cloudflare Access is an additional layer, not a substitute for the
  required operator credential. Do not expose host port 8070 or core port 4318 publicly.
- This workflow depends on the current manuscript workbench, not the original
  bootstrap-only `main`. Review and integrate the complete source and workflow
  first. GitHub normally shows `workflow_dispatch` after the workflow exists on
  the default branch. This implementation does not merge branches or configure
  GitHub environments, secrets, DNS or the server automatically.

Create `web-production` in GitHub Environments and set its secrets/variables (or
repository secrets/variables). The existing name represents the **one shared deployment**, including candidates;
it is not a second production environment. If deployment branch/tag restrictions
are configured, allow valid `release/*`, stable tags and matching RC tags. No new
approval gate is required by this workflow. Ensure the repository's Actions token may publish
and read its GHCR package; keep the image private. No long-lived registry PAT is
needed: each run uses its short-lived `GITHUB_TOKEN`.

| GitHub secret            | Exact value                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `WEB_DEPLOY_HOST`        | SSH hostname or IPv4 address, without scheme or port                                     |
| `WEB_DEPLOY_USER`        | Dedicated SSH username                                                                   |
| `WEB_DEPLOY_SSH_KEY`     | Private deployment key, including actual newlines                                        |
| `WEB_DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known_hosts entry/entries; for a nonstandard port use `[hostname]:port` |
| `WEB_OPERATOR_USERNAME`  | Operator username; set together with password                                            |
| `WEB_OPERATOR_PASSWORD`  | Operator password; set together with username                                            |
| `WEB_OPERATOR_AUTH`      | Optional legacy `username:password`, used only when both new secrets are unset           |

Use the actual server IP or an unproxied SSH hostname for `WEB_DEPLOY_HOST`;
normal Cloudflare orange-cloud Web proxying does not forward SSH.
Verify SSH host fingerprints through an already trusted server console or channel
before supplying `WEB_DEPLOY_KNOWN_HOSTS`. The helper uses strict host checking and
does not trust `ssh-keyscan` output automatically. A changed host key fails closed.

| GitHub variable       | Meaning/default                                                                        |
| --------------------- | -------------------------------------------------------------------------------------- |
| `WEB_PUBLIC_ORIGIN`   | Exact HTTPS origin; default `https://scene.mindreview.me`, without trailing slash/path |
| `WEB_DEPLOY_SSH_PORT` | SSH port, default `22`                                                                 |
| `WEB_DEPLOY_DIR`      | Persistent configuration/backup directory, default `/srv/scenesparrow`                 |
| `WEB_PORT`            | Host loopback proxy port, default `8070`; use an unprivileged port                     |

When migrating an existing setup, change an explicit GitHub `WEB_PORT=8080` to
`8070` (or remove it to use the default), and update this hostname's reverse proxy
upstream to `127.0.0.1:8070`. Defaults do not override an existing variable. Keep
the existing deployment directory/Compose project/volume names and credentials;
no second instance is needed. Set `WEB_PUBLIC_ORIGIN` to the exact public origin
or remove it to use the known default. Do not edit the root-domain virtual host.

The operator file contains `username:password` with an optional final newline.
Username: 1–64 ASCII letters, digits, `_` or `-`. Password: 16–256 printable ASCII
characters without spaces. A memorable password of at least 16 characters is
accepted; use a unique strong password and store it
in a password manager. There is no default password, reset endpoint or account
database. Set the separate `WEB_OPERATOR_USERNAME` and `WEB_OPERATOR_PASSWORD` GitHub
secrets. They take precedence over the legacy `WEB_OPERATOR_AUTH`; if exactly one
new secret is supplied, deployment fails before SSH, even when legacy auth exists.
When both are unset, legacy auth is supported, or provision
`<WEB_DEPLOY_DIR>/secrets/operator-auth` directly on the server. Make the parent
directory mode `0700` for the deployment user and the file `0444` so container uid
1000 can read the bind-mounted secret. The parent directory protects it on the
host. Keep this file outside project/app data and backups; protect it separately.
Missing or invalid credentials fail startup. Supplying the GitHub credential pair (or legacy secret) rotates
the file only after pull/configuration checks and offline backup succeed; the
container is recreated so the rotation takes effect.

## Deployment and local verification

`Private Web deployment` triggers on pushes to `main`, `release/**`, version-like
`v*` tags and manual dispatch. All run full checks, an AMD64 Docker build and the
complete final-container smoke. The release helper fails closed on malformed
versions, deleted/moved refs, mismatched app versions and failed ancestry checks.

| Event/ref                   | Publish and deploy                                                              |
| --------------------------- | ------------------------------------------------------------------------------- |
| Main push                   | Never; checks/build/smoke only                                                  |
| `release/1.0.0` push        | Automatically to the single shared instance                                     |
| `v1.0.0-rc.1` push          | Same instance, only on matching `release/1.0.0` history                         |
| `v1.0.0` push               | Formal release to that same instance, only on accepted main history             |
| Manual dispatch, default    | Checks/build/smoke only, including feature branches                             |
| Manual dispatch with deploy | Valid release branch, stable tag or RC tag only; feature/untagged main rejected |

Versions use strict `MAJOR.MINOR.PATCH` without leading zeroes; RC numbers start
at 1. Other prerelease forms/build metadata are not deployment refs. The app
version must match the release branch/tag base version. Checkout is pinned to the
event commit; full history and fresh exact remote refs verify that it still
identifies the tested commit immediately before publication and deployment.
Stable tags must be reachable from current `origin/main`; RC tags must be
reachable from their matching release branch. A stale branch push cannot publish
its newer head as if it had tested it. A later concurrent ref move fails the next
validation; workflow concurrency queues all refs and never cancels deployment.

Develop features/fixes through `release/1.0.0` PRs, accept the version, then merge
the release PR into stable `main`. After main CI passes, explicitly create the
immutable `v1.0.0` tag on the accepted main commit. No formal release/tag has been
created by implementing this policy. Optional RC tags and ordinary release pushes
are candidates on **the same domain `https://scene.mindreview.me`, host port 8070,
Compose project, volumes, `/srv/scenesparrow` directory and credential settings**.
They overwrite the shared application and use the same data; there is no isolated
preview/staging environment or second port. Back up and assess candidate changes
accordingly. Keep operator credentials in the compatible `web-production` GitHub
Environment, which represents this single shared instance.

The checks job runs contracts, formatting, types, unit/Rust tests, Clippy, builds,
integration tests and browser tests. The image job builds once for AMD64, exercises
that loaded image, then only on an eligible deployment event tags/pushes that
same image to `ghcr.io/<lowercase-owner>/<lowercase-repository>/web:<commit-sha>`.
Deployment uses its exact `@sha256:...` digest; there is no arbitrary image input
or separate rebuild. Build-only manual and main runs do not log in or publish.
Actions permissions are contents-read, packages-write only in the image job and
packages-read for deployment. All deployment events use the same concurrency
queue and environment; the helper never changes DNS, TLS or provider settings.

Local equivalent (Docker required):

```sh
docker build --platform linux/amd64 -t scenesparrow-web:local .
node scripts/web/container-smoke.mjs scenesparrow-web:local
```

Managed environments with a trusted interception CA can supply it temporarily:

```sh
docker build --platform linux/amd64 \
  --secret id=build_ca,src=/etc/ssl/certs/ca-certificates.crt \
  -t scenesparrow-web:local .
```

The optional CA is used only in dependency/compiler build steps, never copied to
the final image; TLS verification stays enabled. The final image retains pnpm
workspace dependencies (including some development dependencies) and source worker
modules so Node 24 can load their TypeScript and workspace symlinks. It contains
neither Electron/Chromium downloads nor a Rust compiler. `/app/crates/infrastructure`
and `/app/workers` preserve Rust's compiled worker paths. The smoke check creates
isolated temporary Docker volumes, tests the real core and built frontend, imports
TXT/MD/DOCX/PDF, generates TXT/MD/DOCX exports, executes a Rust-supervised review task through the actual AI SDK against
one counted local fake response, restarts and verifies durable state. It removes
only its own containers/volumes.

For first server setup, create the directory and secret, configure the existing
reverse proxy using [the Nginx example](../deploy/nginx.conf.example), then deploy
from `release/1.0.0` (or a valid matching version tag). The helper uploads configuration into a private temporary directory,
validates it, takes a deployment lock and pulls the digest before any downtime.
The server's registry login uses a temporary Docker configuration and the token
over stdin; the configuration is removed immediately after pull. No credential
is put in image layers, command arguments, runtime environment files or logs.
The helper does not edit the reverse proxy or DNS.

The first visit prompts for operator HTTP Basic authentication with the familiar
separate username and password fields; there is no new login UI or account system. All static files
and APIs require it; `/readyz` is a minimal unauthenticated health status and
reveals no project data. Browser requests must use the configured host and exact
origin; mutations require an Origin header. Authenticated top-level navigation to
the frontend from external links is allowed; cross-site API and subresource
requests are denied.
The gateway strips external authorization, cookies, forwarding/native headers and
injects its private core token. No core token is delivered to the browser. Uploads
are limited to 25 MiB, downloads to 32 MiB. SSE streams remain open and use
backpressure/cancellation; configure proxy buffering off and long read timeouts.
Over-limit streamed responses terminate the connection after headers are sent.
Treat browser reconnects as expected; Cloudflare may impose its own request limits.
Basic authentication has browser-managed caching; close the browser profile to
clear it and rotate the operator secret if access must be revoked.

## Persistent state, backups and recovery

Compose uses fixed named volumes `scenesparrow-project` and `scenesparrow-appdata`.
The non-root container (uid/gid 1000) initializes new volumes from owned image
directories. Existing volumes must already be owned by uid 1000; repair ownership
offline if importing data. One stable Compose project name avoids orphaned data
across commit deployments. Never use `docker compose down -v` on real data.

On replacement, the supervisor stops admissions/connections, calls authenticated
native quiesce, sends SIGINT to Rust, and uses a bounded process-group kill if
necessary. Compose allows 60 seconds. Deploy stops the current service and refuses
to proceed if **any running container** still mounts either volume. It then makes
independent gzip tar archives of both complete volumes, including SQLite WAL,
objects and app data, under `<DEPLOY_DIR>/backups/<timestamp>.<unique>/` before
starting the replacement with readiness checking. No live-SQLite-only copy or
hard-linked backup is used. First deployment backs up any existing offline
volumes; an empty first deployment records configuration metadata without data
archives. A backup failure leaves the old service stopped and needs operator
inspection. Same-commit redeployment is safe and still creates a fresh backup.

Backups include the previous Compose/runtime configuration and requested image
digest; they intentionally exclude operator credentials. Backups are never deleted
automatically. Monitor disk space, export encrypted copies off-server, and choose
retention explicitly. No unrelated Docker images, containers or volumes are pruned.
Linux AI keys remain in core session memory, not these volumes: enter keys again
after a container/core restart. Global provider/model settings persist in app data.

A failed replacement may already have migrated databases or accepted writes.
The helper preserves the failed container/data and backup, reports failure and
does **not** automatically restore a database or restart the old image. The current
runtime configuration identifies the attempted image. Inspect readiness/container
state without printing credentials:

```sh
cd /srv/scenesparrow
docker compose --env-file runtime.env -f compose.yaml ps
docker compose --env-file runtime.env -f compose.yaml logs --tail 100
```

For recovery, stop all containers using both volumes and retain an additional
offline copy of the failed state. Decide explicitly whether to repair forward
with compatible code, or restore both complete archives into **new empty volumes**
and use the matching prior image/configuration. Restoration loses every write
after that backup; obtain the operator's decision first. Verify archive integrity,
ownership, project identity and exports in an isolated recovery deployment before
switching traffic. Do not unpack an old archive over a live or nonempty migrated
database, and do not assume an older image can read a newer schema. Document the
chosen data cutover. The existing native verified project-copy tooling remains
available to operators offline; it is not exposed to public browser requests.

## Evidence and limits

Local automated evidence is recorded in [Web deployment validation](validation/web-deployment.md)
and the later [release policy validation](validation/release-policy.md).
No real SSH host, GHCR publication, GitHub workflow execution, domain/proxy change
or paid provider call is performed by implementation checks. Run an authorized real release
workflow and verify HTTPS, operator rejection, SSE reconnect, project persistence,
backup retention and restart key re-entry on the actual server before accepting
online deployment. Desktop Windows/macOS compatibility, real provider behavior,
multiuser isolation and full production video rendering remain separate work.
