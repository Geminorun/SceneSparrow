# Version release policy validation

Implementation evidence on 2026-11-16, managed Linux x86_64. This refines
[the existing private Web delivery](web-deployment.md); it does not establish
accepted application 1.0.0 or a real online deployment.

The application target is now 1.0.0 across private pnpm manifests, Cargo workspace
and four Cargo.lock entries. ProtocolVersion, schema IDs, migrations and design
v0.1 remain independent. Dependency versions were not changed. Branch workflow,
ADR 0004 and the runbook describe version integration/acceptance and one shared
instance at `https://scene.mindreview.me`, host loopback 8070. The compatible
GitHub Environment name remains `web-production`.

Measured checks:

- `CARGO_INCREMENTAL=0 pnpm check`: passed contracts, formatting, types, 107 Node
  tests, 157 Rust tests and warnings-denied Clippy. The targeted gateway suite was
  also rerun after changing its synthetic credential to the 16-character lower
  bound.
- `CARGO_INCREMENTAL=0 pnpm build`: passed built Web, desktop TypeScript and Rust
  workspace. The existing large Web chunk warning remains.
- `CARGO_INCREMENTAL=0 pnpm test:integration`: seven passed with actual core and
  counted local fake providers; no paid provider calls.
- Focused policy/auth/deploy/gateway tests: seven passed. Temporary actual Git
  fixtures exercise main check-only behavior, release publication, lightweight and
  annotated stable/RC tags, fresh-ref checks, main/matching-release ancestry,
  mismatched app versions, manual default/explicit behavior, feature/main deploy
  rejection, malformed/injected refs, stale refs and deletion rejection.
- Version helper fixtures verify synchronized application-only changes and preserve
  independent 0.1.0 protocol/dependency examples; an additional test checks real
  repository package/Cargo version agreement.
- Credential tests cover pair precedence, legacy fallback only when both new
  secrets are unset, incomplete-pair rejection before SSH, ASCII username/password
  bounds, minimum 16 and maximum 256, secret-free errors and real gateway auth.
  Remote deployment tests preserve pull-before-downtime, running-owner refusal,
  offline backup ordering, retained failed-start backups, force-recreate secret
  rotation and `--pull never` behavior; a 15-character incoming secret is rejected
  before any Docker call and a 16-character rotated secret is accepted.
- actionlint 1.7.7, ShellCheck 0.10.0 and `bash -n deploy/deploy.sh`: passed.

Initial full-check and Docker attempts ran out of shared overlay disk while
compiling Rust. They are failed environment attempts, not passing evidence. Only
ignored/rebuildable `target/debug/incremental` was removed after those builds
stopped; gates then ran sequentially with Cargo incremental compilation disabled.
The earlier focused temporary-Git rerun also hit ENOSPC and passed when rerun
after disk recovery. A later Docker rebuild completed successfully, but the first
smoke attempt then failed before container startup: the managed Docker VFS driver
ran out of disk copying the runtime filesystem. That failed smoke is recorded
separately in `/tmp/scenesparrow-release-container-enospc.log`. After confirming
all builds/tests had stopped, root removed only the git-ignored host
`target/debug` build cache (5.3 GB), recovering 5.2 GB free. Host Rust/browser
checks were not rerun merely to regenerate that cache. The cached final build
and full smoke were then retried sequentially.
No source, user project, credentials, persistent deployment volume or prior image
was removed.

Final runtime gates:

- `pnpm test:e2e`: 24 passed, three dedicated performance cases intentionally
  skipped. No concurrent browser run or retry was used.
- AMD64 Docker rebuild with the optional transient BuildKit CA secret: passed,
  Node 24.22.1, Rust 1.100.0, pnpm 11.25.0 and locked installs; TLS verification
  stayed enabled and no cloud CA was baked into the image.
- Full final-image smoke: passed with a synthetic **16-character password**,
  actual Rust core/project writes, authenticated built frontend and uid 1000,
  TXT/MD/DOCX/PDF extraction, TXT/MD/DOCX exports/hash validation, actual
  Rust-supervised review worker and SDK with exactly one counted local fake
  response, graceful restart, durable manuscript/project state and exit code 0.
  Smoke containers and isolated volumes were removed; subsequent Docker container
  and volume lists were empty.

The final local image is `scenesparrow-web:release-policy`, image ID
`sha256:ee0d9b0957bb9f40d45fb454ad2a7d738dc889ba396f9e9b7d4b8321e55ced22`,
673,900,339 bytes uncompressed. This is a local image ID, not a published GHCR
manifest digest. Logs use `/tmp/scenesparrow-release-` with `check`, `build`,
`integration`, `e2e`, `docker` and `container` suffixes; the failed runtime-copy
attempt has the separate `container-enospc` suffix.

Independent root review and checks:

- Reviewed the workflow, release/version helpers, credentials, deployment
  invariants and single-instance documentation; no blocking findings remain.
- Reran seven focused policy/version/auth/deployment/gateway tests: all passed.
  Independently reran actionlint, ShellCheck, shell syntax and diff checks.
- Actual Compose verification passed using this final image, the default
  `127.0.0.1:8070` mapping without a WEB_PORT override, configured public origin
  `https://scene.mindreview.me` and a synthetic 16-character password. It verified
  uid 1000, dropped capabilities, actual project/manuscript writes and TXT export,
  clean exit, two complete offline volume archives, restoration into new empty
  temporary volumes, preserved project identity, manuscript blocks, five-step
  history position, global provider configuration and exact exported bytes.
  The checks removed only their own temporary containers/volumes. Logs are
  `/tmp/scenesparrow-release-root-tests.log` and
  `/tmp/scenesparrow-release-root-compose.log`.

GitHub-hosted Actions, remote branch protections, GHCR publish/pull permissions,
real SSH, server/domain/proxy behavior
and real provider/native platform delivery remain unrun. No repository tags,
workflow dispatches, real deployment, DNS/TLS change or provider credential change
was performed. Git mutations in tests occurred only in disposable temporary
fixture repositories.
