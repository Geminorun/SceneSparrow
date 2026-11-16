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
- An existing host HTTPS reverse proxy to `127.0.0.1:8080`, an appropriate origin
  certificate and DNS. Cloudflare must use **Full (strict)** and bypass caching
  for this hostname. Cloudflare DNS proxying alone is not access authentication.
  Optional Cloudflare Access is an additional layer, not a substitute for the
  required operator credential. Do not expose port 8080 or core port 4318 publicly.
- This workflow depends on the current manuscript workbench, not the original
  bootstrap-only `main`. Review and integrate the complete source and workflow
  first. GitHub normally shows `workflow_dispatch` after the workflow exists on
  the default branch. This implementation does not merge branches or configure
  GitHub environments, secrets, DNS or the server automatically.

Create `web-production` in GitHub Environments and set its secrets/variables (or
repository secrets/variables). Configure any desired human environment gate there.
Restrict deployment to `main`. Ensure the repository's Actions token may publish
and read its GHCR package; keep the image private. No long-lived registry PAT is
needed: each run uses its short-lived `GITHUB_TOKEN`.

| GitHub secret            | Exact value                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `WEB_DEPLOY_HOST`        | SSH hostname or IPv4 address, without scheme or port                                     |
| `WEB_DEPLOY_USER`        | Dedicated SSH username                                                                   |
| `WEB_DEPLOY_SSH_KEY`     | Private deployment key, including actual newlines                                        |
| `WEB_DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known_hosts entry/entries; for a nonstandard port use `[hostname]:port` |
| `WEB_OPERATOR_AUTH`      | Optional `username:password` described below; omit when separately provisioned           |

Use the actual server IP or an unproxied SSH hostname for `WEB_DEPLOY_HOST`;
normal Cloudflare orange-cloud Web proxying does not forward SSH.
Verify SSH host fingerprints through an already trusted server console or channel
before supplying `WEB_DEPLOY_KNOWN_HOSTS`. The helper uses strict host checking and
does not trust `ssh-keyscan` output automatically. A changed host key fails closed.

| GitHub variable       | Meaning/default                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `WEB_PUBLIC_ORIGIN`   | Required exact HTTPS origin, e.g. `https://scene.example.com`, without trailing slash/path |
| `WEB_DEPLOY_SSH_PORT` | SSH port, default `22`                                                                     |
| `WEB_DEPLOY_DIR`      | Persistent configuration/backup directory, default `/srv/scenesparrow`                     |
| `WEB_PORT`            | Host loopback proxy port, default `8080`; use an unprivileged port                         |

The operator file contains `username:password` with an optional final newline.
Username: 1–64 ASCII letters, digits, `_` or `-`. Password: 32–256 printable ASCII
characters without spaces. Use a long randomly generated password and store it
in a password manager. There is no default password, reset endpoint or account
database. Either set `WEB_OPERATOR_AUTH` as a GitHub secret, or provision
`<WEB_DEPLOY_DIR>/secrets/operator-auth` directly on the server. Make the parent
directory mode `0700` for the deployment user and the file `0444` so container uid
1000 can read the bind-mounted secret. The parent directory protects it on the
host. Keep this file outside project/app data and backups; protect it separately.
Missing or invalid credentials fail startup. Supplying the GitHub secret rotates
the file only after pull/configuration checks and offline backup succeed; the
container is recreated so the rotation takes effect.

## Deployment and local verification

`Private Web deployment` runs only on pushes to `main` and manual dispatch.
Feature-branch pushes never publish or deploy. Manual dispatch defaults to
**build and smoke only**, including on a feature branch. To deploy, select `main`
and enable the `deploy` input. A successful main push checks and deploys directly,
subject to the `web-production` environment's configured gate. Concurrent runs
queue; an in-progress deployment is never cancelled for a newer commit.

The checks job runs contracts, formatting, types, unit/Rust tests, Clippy, builds,
integration tests and browser tests. The image job builds once for AMD64, exercises
that loaded image, and only then tags/pushes that same image to
`ghcr.io/<lowercase-owner>/<lowercase-repository>/web:<commit-sha>`. Deployment
uses its `@sha256:...` digest. Build-only manual runs do not log in or publish.
Actions permissions are contents-read, packages-write only in the image job and
packages-read for deployment.

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
from `main`. The helper uploads configuration into a private temporary directory,
validates it, takes a deployment lock and pulls the digest before any downtime.
The server's registry login uses a temporary Docker configuration and the token
over stdin; the configuration is removed immediately after pull. No credential
is put in image layers, command arguments, runtime environment files or logs.
The helper does not edit the reverse proxy or DNS.

The first visit prompts for operator HTTP Basic authentication. All static files
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

Local automated evidence is recorded in [Web deployment validation](validation/web-deployment.md).
No real SSH host, GHCR publication, GitHub workflow execution, domain/proxy change
or paid provider call is performed by implementation checks. Run a real main
workflow and verify HTTPS, operator rejection, SSE reconnect, project persistence,
backup retention and restart key re-entry on the actual server before accepting
online deployment. Desktop Windows/macOS compatibility, real provider behavior,
multiuser isolation and full production video rendering remain separate work.
