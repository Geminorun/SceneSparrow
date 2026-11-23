# Private self-hosted Web deployment

The production Web entry runs the built React application, Rust core, and Node
AI worker in one Linux AMD64 container. A private operator can open file-backed
manuscripts, write or generate a draft, and exchange project ZIPs. The operator
credential grants access to the same project root and global AI configuration.
[File-first Web specification](specs/web-file-workspace.md)

The container starts `node apps/web/server/start.mjs`. The Web app owns the
production supervisor, gateway, diagnostics and master-key validation modules in
[`apps/web/server/`](../apps/web/server/). Deployment/operator configuration and
container/worker smoke tools remain in `scripts/web/`.

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
Username: 1–64 ASCII letters, digits, `_` or `-`. Password: 6–256 printable ASCII
characters without spaces. A memorable password of at least 6 characters is
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

`Private Web deployment` triggers on pushes to `release/**`, version-like `v*`
tags and manual dispatch. `Foundation checks` runs on PRs targeting main/release
branches and main pushes, testing the PR merge commit before integration.
Local validation and review remain required before merging. Every run of the
deployment workflow performs full checks, an AMD64 Docker build and the
complete final-container smoke. The release helper fails closed on malformed
versions, deleted/moved refs, mismatched app versions and failed ancestry checks.

| Event/ref                     | Publish and deploy                                                              |
| ----------------------------- | ------------------------------------------------------------------------------- |
| PR targeting main/release     | Foundation checks only; no publication or deployment                            |
| Task branch push without a PR | No automatic workflow run                                                       |
| Main push                     | Foundation checks only; no publication or deployment                            |
| `release/1.0.0` push          | Automatically to the single shared instance                                     |
| `v1.0.0-rc.1` push            | Same instance, only on matching `release/1.0.0` history                         |
| `v1.0.0` push                 | Formal release to that same instance, only on accepted main history             |
| Manual dispatch, default      | Checks/build/smoke only, including feature branches and main                    |
| Manual dispatch with deploy   | Valid release branch, stable tag or RC tag only; feature/untagged main rejected |

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
the release PR into stable `main`. Explicitly create the immutable `v1.0.0` tag on
the accepted main commit; that run completes full checks and final-container smoke
before formal publication/deployment. No formal release/tag has been
created by implementing this policy. Optional RC tags and ordinary release pushes
are candidates on **the same domain `https://scene.mindreview.me`, host port 8070,
Compose project, volumes, `/srv/scenesparrow` directory and credential settings**.
They overwrite the shared application and use the same data; there is no isolated
preview/staging environment or second port. Back up and assess candidate changes
accordingly. Keep operator credentials in the compatible `web-production` GitHub
Environment, which represents this single shared instance.

The checks job calls the same Foundation workflow used by PRs: contracts,
formatting, types, unit/Rust tests, Clippy, builds, integration tests and browser
tests. Failed browser runs upload `test-results/` (including traces and error
contexts) for seven days. PR checks use read-only permissions and no deployment
secrets. The image job builds once for AMD64, exercises
that loaded image, then only on an eligible deployment event tags/pushes that
same image to `ghcr.io/<lowercase-owner>/<lowercase-repository>/web:<commit-sha>`.
Deployment uses its exact `@sha256:...` digest; there is no arbitrary image input
or separate rebuild. Build-only manual runs do not log in or publish.
Actions permissions are contents-read, packages-write only in the image job and
packages-read for deployment. All deployment events use the same concurrency
queue and environment; the helper never changes DNS, TLS or provider settings.

Full checks run once in this workflow before deployment, even after a successful
PR check, to verify the exact resulting release commit. Merging a task PR into a
release branch starts it through the resulting release push. Require the
`foundation` status from `Foundation checks` on main/release PRs and require the
branch to be up to date. Deployment jobs run after merge and cannot serve as PR
checks. Workflow files alone do not configure these GitHub branch protections.

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
and `/app/workers` preserve Rust's compiled worker paths. The smoke check uses
isolated temporary Docker volumes and verifies authenticated Web startup, file
writes, outline and draft generation through the Rust-supervised AI worker with
a counted local fake provider, encrypted credentials, restart, and backup
recovery into an empty volume.

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
directories. Existing volumes must be writable by uid 1000. The default project
root is `/data/project/markdown-projects` inside the project volume. On upgrade,
this directory starts a fresh file workspace and any older SQLite files are
preserved outside that directory. Import exported Markdown to carry forward
earlier manuscripts. Keep the Compose project name stable across deployments.
Never use `docker compose down -v` on real data.

On replacement, the supervisor stops admissions and connections, sends SIGINT to
Rust, and uses a bounded process-group kill if necessary. Compose allows 60
seconds. Deploy stops the current service and refuses to proceed if **any running
container** still mounts either volume. It copies both complete volumes into
gzip tar archives under `<DEPLOY_DIR>/backups/<timestamp>.<unique>/` before starting
the replacement with readiness checking. The project archive includes the
`markdown-projects` directory and all its project folders, along with any older
data still present on the volume. An empty first deployment records configuration
metadata. A backup failure leaves the service stopped for inspection. A
same-commit redeployment creates a fresh backup.

Backups include the previous Compose/runtime configuration and requested image
digest; they intentionally exclude operator credentials and the AI master key. Backups are never deleted
automatically. Monitor disk space, export encrypted copies off-server, and choose
retention explicitly. No unrelated Docker images, containers or volumes are pruned.
Global provider/model settings and encrypted API credential revisions persist in
app data. The deployment provisions `<DEPLOY_DIR>/secrets/ai-master-key` once,
using 32 cryptographically random bytes encoded as standard base64. It reuses that
file on redeploy, sets its mode to `0444` within the host's `0700` secrets directory,
and mounts it read-only as `/run/secrets/ai_master_key` for uid 1000. Runtime env
contains only its host locator (`AI_MASTER_KEY_FILE`), while the supervisor passes
only the container locator (`SCENESPARROW_AI_MASTER_KEY_FILE`) to the core. Worker
environments receive neither locator nor master contents. No additional GitHub
secret is required and builds never rotate the master.

Back up the master separately to protected off-server secret storage, retaining
the key corresponding to each app-data archive. Never bundle it in the app-data
archive or print it in diagnostics. An app-data archive contains ciphertext and
requires that original master to recover saved credentials. If the host key is
missing while the existing app-data volume contains a vault header, entries or
unknown vault contents, deployment stops before service downtime and asks the
operator to restore the original key. It never generates a replacement over an
existing encrypted vault. Empty/lock-only initialization directories do not count
as encrypted data. Unreadable volume inventory also stops provisioning.

First deployment and upgrade from an unencrypted app-data volume may provision a
new master. Existing provider/model references survive; session-only API keys
cannot be recovered after the old core exits, so enter those keys once after
upgrade. The settings view reports the encrypted-file backend. Wrong, malformed,
missing or unreadable configured keys fail with a stable credential error rather
than falling back to session memory/plaintext. Ordinary local development without
a master or existing encrypted vault remains session-only.

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
and use the matching prior image/configuration. Restore the corresponding master
separately to the protected host secrets directory before starting an encrypted
app-data restore; preserve its original bytes and read-only mode. A wrong master
fails authenticated header validation and is never overwritten. Restoration loses every write
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
backup retention and encrypted-key availability after restart on the actual server before accepting
online deployment. Desktop Windows/macOS compatibility, real provider behavior,
multiuser isolation and full production video rendering remain separate work.

## Private diagnostics

The gateway serves `/diagnostics` directly, with inline nonce-protected assets and
English/Simplified Chinese resources. It does not import the React bundle or use
the project API. Open it with the existing operator Basic credential when the
application bundle fails. The page provides runtime status, recent events, a
bounded JSON download and explicit create/replace/revoke controls for temporary
read access. See the [design](design/remote-diagnostics-v0.1.md) and
[validation evidence](validation/remote-diagnostics.md).

A read grant defaults to 15 minutes (API range: 60–3600 seconds). One grant is
active at a time. Creating another, revoking, expiry or a gateway restart invalidates
it. The gateway stores only the token hash in RAM; the page reveals the token
only after the operator creates it and keeps it in memory. Supply it to a support
tool as an Authorization Bearer header. Its exact scope is GET on
`/diagnostics/v1/status`, `/diagnostics/v1/logs` and `/diagnostics/v1/bundle`.
It cannot open the page, change grants, submit events, call project/native APIs or
access the host. The support flow is status, a narrow recent event window, optional
bundle export, then revocation. No permanent support secret is needed.

The APIs also accept the operator credential. This command prompts for the
password without putting it in arguments or history:

```sh
curl --user OPERATOR_USERNAME --fail-with-body \
  https://scene.mindreview.me/diagnostics/v1/status
```

Header-authenticated CLI reads may omit Origin. POST operations require the exact
configured Origin, including revocation:

```sh
curl --user OPERATOR_USERNAME --fail-with-body \
  --header 'Origin: https://scene.mindreview.me' \
  --header 'Content-Type: application/json' --data '{}' \
  https://scene.mindreview.me/diagnostics/v1/access-grants/revoke
```

Logs contain allowlisted operational codes, timing/status/size metadata and
transport trace identifiers. They exclude authorization, bodies, IP addresses,
paths, filenames, project/content IDs, prompts and raw provider/SDK errors. Child
stdout/stderr is drained and revalidated; worker stdout remains its RPC channel.
Rust producers use a separate bounded queue and detached stderr writer; output
failures drop diagnostic events without panicking a business request. Delivered
safe drop summaries contribute to collector totals. Collection begins with the
instrumented runtime; previously discarded output
cannot be recovered. A failure before JavaScript runs has no client report; use
document/asset gateway records and browser network evidence to identify that stage.

Safe JSONL lives under `/data/app/diagnostics` in the existing app-data volume,
with directory/file modes 0700/0600. Files rotate at 2 MiB and are bounded by
20 MiB total, three days and 64 files. Startup and a serialized, unref maintenance
check every 60 seconds remove expired files; idle expiry may take that maintenance
interval. Full app-data backups can contain these logs and have their own backup
retention. No project schema migration is introduced.

Reads default to the last 15 minutes, accept at most a 24-hour requested window,
and return at most 500 events/1 MiB. A bundle contains safe status, a retention
manifest and one bounded page, with gap/truncation markers. Cursors freeze the
window and expire at restart; retained events survive with their original boot
and sequence identity. Requests, exports, grant management and reports are rate
limited. Disk failures and full queues degrade diagnostics rather than business
operations; status exposes aggregate drop/error counts.

The build workflow passes its source SHA to both Vite's safe build meta tag and
the gateway runtime. Local builds without that value report `unknown`; only
allowlisted version/SHA metadata is exposed, never environment or configuration.
The public `/readyz` continues to expose minimal readiness only. Existing hostname
cache-bypass configuration also applies to diagnostics.

Lifecycle supervision is unchanged: failed core startup prevents gateway startup,
and an unexpected core exit shuts the runtime down. Gateway/container/edge death
can therefore make the page unavailable. Use the trusted host console or SSH for
Compose state and offline access to the already-safe JSONL; application read grants
do not grant that host access. Proxy, TLS/DNS and host logs are outside this
collector. RD-3 sanitized Nginx/host collectors and a separate manual workflow are
not installed. Missing application events alone do not identify an edge failure.
