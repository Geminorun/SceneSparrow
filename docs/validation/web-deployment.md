# Private Web deployment validation

Implementation checks on 2026-11-16, Linux x86_64 in the managed cloud workspace.
No GitHub publication, SSH deployment, domain change or paid provider call was run.

| Check                                                         | Measured result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                  | Passed: contracts, formatting, types, 102 JavaScript tests, 157 Rust tests, Clippy. Run before the final navigation regression and browser-fixture teardown adjustment; the affected Web unit suites were rerun afterward.                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm build`                                                  | Passed: Web, desktop TypeScript and Rust workspace build. Existing large Web chunk warning remains.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test:integration`                                       | Passed, 7 real-core integration tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| New Web unit suites                                           | Passed: gateway authentication, foreign host/origin and CSRF, external document navigation, native/credential stripping, static traversal/symlink escape, preserved query, upload length/chunk limits, download limit, SSE cancellation/shutdown; actual-child supervisor startup failures, quiesce/SIGINT, SIGTERM, child death; deployment ordering, live-volume refusal, pull failure, backup retention and secret rotation.                                                                                                                                                        |
| `actionlint .github/workflows/web-deploy.yml`                 | Passed with actionlint 1.7.7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `bash -n deploy/deploy.sh`                                    | Passed. Independent root review also ran ShellCheck 0.10.0 on the helper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Production Docker build                                       | Passed with Node 24.22.1, Rust 1.100.0, pnpm 11.25.0, locked installs and optional BuildKit CA secret. TLS verification remained enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `node scripts/web/container-smoke.mjs scenesparrow-web:local` | Passed: real Rust core/project writes, authenticated built frontend, uid 1000, TXT/MD/DOCX/PDF extraction, TXT/MD/DOCX exports and hashes, actual Rust-supervised review worker and actual SDK with exactly one local fake response, graceful restart, persisted manuscript/project, exit code 0. Smoke containers/volumes were removed.                                                                                                                                                                                                                                               |
| Full browser suite                                            | 23 passed, 3 intentionally skipped performance cases, 1 failed in existing review fixture teardown: a background intercepted project read reached the fixture core after shutdown.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Targeted review rerun                                         | Failed: the pre-existing nested-lock race reached the 90-second timeout; the screenshot showed the associated lock control disappearing/offscreen. The fixture cleanup was adjusted to release gates/drain routes before stopping the core and to guarantee child cleanup on page-close errors. Root subsequently made the held-lock fixture deterministic and passed both the targeted test and full browser suite; see the final gate below. No business code was changed. One overlapping retry attempt was invalidated by port/artifact contention and is not acceptance evidence. |

The successful final container runtime checkpoint is
`sha256:270fab800d72a0d8a9fd86f336a998a33ba9f6d266a7d258874ac79d24ca6563`,
AMD64, approximately 674 MB uncompressed. This is a local image ID, not a published
GHCR manifest digest. It includes the external-navigation gateway fix and the
bounded supervisor. Later edits concern tests, deployment helper/docs and ignore
rules. The CI workflow gates publication on the full browser suite, and the final independent browser gate passed after the fixture corrections below.

Initial local checks exposed and corrected build trust and packaging issues:
the cloud's interception CA needed a transient build secret for npm/pnpm and
rustup/Cargo; managed-workspace file modes needed normalization for uid 1000; the
smoke credential prefix needed forwarding over stdin; and Docker's dynamically
allocated host port needed rereading after restart. These corrected attempts do
not establish real-server behavior.

Still unrun: a GitHub-hosted workflow execution, private GHCR push/pull, real SSH
host-key validation, real server deployment, external HTTPS/Cloudflare/Nginx
behavior and operator-driven backup recovery. Real provider credentials and
Windows/macOS native delivery remain outside this Linux deployment evidence.
The release runbook is [Private Web deployment](../web-deployment.md).

## Independent root review and final gate

Root reviewed gateway authentication/origin and streaming boundaries, process
lifecycle, Docker workspace/worker paths, SSH and registry credential handling,
backup ordering and digest-pinned deployment. A separate read-only audit found no
remaining blockers in the corrected gateway, supervisor or deployment helpers.
No database migration or manuscript business code changed.

Root corrected the pre-existing review fixture's nondeterministic held-lock case:
it now holds both the acknowledgment and finalization projection until newer
private input is visibly present, then releases both and scrolls the associated
paragraph into view before using its virtualized lock control. Every gate is
released during teardown and routes drain before the fixture core stops. The
targeted test and subsequent full suite passed. These assertions retain the
actual input-preservation check rather than bypassing it.

Independent commands and results on the final implementation:

- `pnpm check`: passed contracts, formatting, types, 102 Node tests, 157 Rust
  tests (12 domain, 143 infrastructure, two service) and warnings-denied Clippy.
- `pnpm build`: passed production Web, desktop TypeScript and Rust workspace.
- `pnpm test:integration`: seven passed.
- `pnpm test:e2e`: 24 passed, three dedicated performance cases intentionally
  skipped. This change does not resolve the documented interaction budget misses.
- `pnpm peers check`, `git diff --check`, actionlint 1.7.7 with ShellCheck 0.10.0,
  direct ShellCheck and `bash -n deploy/deploy.sh`: passed.
- Root rebuilt the final AMD64 image and reran the complete production container
  smoke: real core, authenticated built Web, four extraction formats, three export
  formats, Rust-supervised AI with exactly one local fake SDK request, graceful
  restart and durable state all passed. The image ID matches the checkpoint above.
- Root exercised the real Compose definition with isolated overridden volume names,
  uid 1000, dropped capabilities and loopback-only publication. It wrote a project
  and TXT artifact, stopped cleanly, created both offline archives using the same
  tar commands as deployment, restored them into new empty volumes, and verified
  the recovered project/body and byte-identical export. Additional checks verified
  the history cursor/counts/labels and a saved nonsecret provider configuration.
  History metadata revision may advance during reopen maintenance; the check
  requires monotonicity and exact logical history position. No real project
  volume was read or modified.

The independent Docker rebuild caught an overbroad ignore pattern excluding the
legitimate Rust `credentials` source module. Root removed that nested-directory
pattern, retained the credential-file/secret exclusions, and rebuilt successfully
before counting container evidence. Root's final changes are confined to the test
fixture, that ignore rule and documentation.

Root logs use `/tmp/scenesparrow-web-root-` with `check`, `build`, `integration`,
`e2e`, `review`, `docker`, `container`, `compose` and `compose-detail` suffixes. Local Docker tests
used the managed local socket and a transient BuildKit CA secret; no TLS
verification was disabled and no cloud CA was copied into the runtime image.
Only isolated test containers and volumes were removed.

All applicable local code, container and workflow gates pass. GitHub-hosted
execution, GHCR permissions, real SSH and external HTTPS/Cloudflare behavior
remain unrun as listed above; no remote deployment was attempted.
