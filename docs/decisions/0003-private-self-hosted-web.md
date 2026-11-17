# ADR 0003: Private self-hosted Web delivery

Status: accepted for implementation, pending real server deployment validation.

The user selected a complete online deployment on an Ubuntu 24.04 x86_64 server
with Docker Compose and an existing domain reverse proxy through Cloudflare.
The existing React application, Rust core, SQLite project and Node document/AI
workers must run together. Static hosting does not provide these capabilities.

Ship an AMD64 container containing a production HTTP gateway, built Web assets,
the Rust core and worker dependencies. The gateway authenticates the entire
workspace with one operator Basic credential over external HTTPS. It injects
private process tokens into loopback core requests and denies native operations.
The container supervisor owns startup, readiness, worker quiescence and shutdown.
The existing host reverse proxy terminates HTTPS; Compose publishes only loopback.

This is one private, shared project and one shared global AI configuration. It
does not introduce user accounts, tenant isolation, collaboration or a hosted
service. Giving another person the operator credential shares the whole workspace.
The initial delivery used session-memory AI credentials. The later
[model-services decision](../design/ai-model-services.md) adds authenticated
encrypted Web storage with an external deployment master key, while preserving
the shared credential port. No plaintext fallback is introduced.

GitHub Actions checks, builds and exercises the final image before publication.
Deployment uses its immutable GHCR digest, pinned SSH host keys and temporary
registry authentication. Both persistent volumes receive offline backups after
graceful stop and before a replacement starts. Failed startup preserves backups
and never automatically restores databases or rolls back migrated state.

This adds a supported private Web delivery path while retaining the desktop
architecture and current business/schema boundaries. The cost is planned downtime
for consistent backups, operator-managed backup retention/recovery, an image that
retains workspace dependencies, and no automatic recovery of acknowledged writes
after a failed deployment. See [the runbook](../web-deployment.md).

## Release policy refinement

[ADR 0004](0004-release-policy.md) supersedes the original main-push deployment
policy: release branches and version tags run full checks before deploying to one
shared environment. Ordinary PRs and main pushes do not trigger CI; local
validation and review remain required. The Web workflow also supports manual
checks/build/smoke without deployment. The single public origin is
`https://scene.mindreview.me` and the default host loopback port is 8070. Separate operator username/password
secrets accept a 6–256 character printable ASCII password, retaining the same
Basic authentication and secure mounted-file implementation. The AI credential
follow-up provisions and reuses a separate read-only master secret; encrypted
credentials persist across restart. See the [backup and recovery runbook](../web-deployment.md).
