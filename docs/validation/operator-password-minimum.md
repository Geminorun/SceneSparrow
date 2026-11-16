# Operator password minimum amendment

Subsequent implementation evidence on 2026-11-16, managed Linux x86_64. The user
selected a six-character minimum for `WEB_OPERATOR_PASSWORD`. This amends the
current credential policy in [ADR 0003](../decisions/0003-private-self-hosted-web.md),
[ADR 0004](../decisions/0004-release-policy.md) and the
[deployment runbook](../web-deployment.md). The earlier
[release-policy validation](release-policy.md) retains its measured 16-character
credential and image evidence.

The deployment client, gateway and server deployment script now accept passwords
of 6–256 printable ASCII characters without spaces. Username bounds, pair
precedence, partial-pair rejection, legacy fallback, optional secret-file final
newline, Basic authentication and exact-origin restrictions remain unchanged.
The shared domain, host port 8070, persistent data and actual credentials are
unchanged.

Measured checks:

- `node --test tests/unit/operator-config.test.mjs tests/unit/web-gateway.test.mjs tests/unit/web-deploy.test.mjs`:
  four tests passed. They cover six-character pair/legacy/file authentication,
  five-character rejection, compatibility at 16 and 32 characters, the 256/257
  boundary, spaces/Unicode/embedded and extra newlines, username bounds and
  secret-free diagnostics. Invalid incoming and provisioned server credentials
  fail before Docker. The real HTTP gateway uses a six-character credential while
  retaining its origin, private-token forwarding, path and SSE checks. Deployment
  fixtures retain pull-before-downtime, live-volume refusal, offline backups and
  failed-start backup retention.
- `pnpm format:check`: passed repository Prettier and Rust formatting checks.
- ShellCheck 0.10.0 and `bash -n deploy/deploy.sh`: passed.
- `git diff --check`: passed.
- Root independently reviewed the complete change and reran
  `node --import tsx --test tests/unit/*.test.mjs`: all 107 tests passed.
- Cached AMD64 Docker rebuild and complete final-image smoke: passed with a
  synthetic six-character password, actual authenticated core/frontend,
  TXT/MD/DOCX/PDF imports, TXT/MD/DOCX exports, one counted fake AI SDK response,
  graceful restart and durable state. Test containers/volumes were removed.

The local image is `scenesparrow-web:password-six`, image ID
`sha256:1c0f3fb075f73b2112eb7c657b8bfb93d642c942c63d75fdb7127977490c7f42`.
Builds used the managed Docker socket and a transient BuildKit CA secret with
TLS verification enabled; unchanged dependency/core layers were cached. Logs are
`/tmp/scenesparrow-password-root-node-tsx.log`,
`/tmp/scenesparrow-password-root-docker.log` and
`/tmp/scenesparrow-password-root-container.log`. An initial root all-Node
invocation omitted the required `--import tsx` loader and failed on existing
TypeScript parameter properties; the corrected repository invocation above passed
without source changes to those modules.

Host Rust compilation and browser checks were not rerun for this credential-only
change; the existing ignored host Rust build cache remains cleared after the
earlier disk exhaustion. Remote GitHub/server deployment and real provider/native
platform behavior remain unverified by these local checks.
