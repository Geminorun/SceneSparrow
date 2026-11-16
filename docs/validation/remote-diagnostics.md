# Remote diagnostics implementation evidence

RD-1/RD-2 implement the [remote diagnostics design](../design/remote-diagnostics-v0.1.md).
RD-3 remains deferred. Final validation includes release `40fea56` (workspace
onboarding PR #8); its default workspace, metadata guards, settings dialogs,
existing-only open mode and migration 010 are preserved. Diagnostics adds no new
project migration. This report records local source validation, not a live
production diagnosis, deployment or native platform acceptance.

## Implemented boundaries

The Node gateway owns the independent bilingual page, exact protected APIs,
short-lived hashed grants, bounded safe JSONL collection/read/export and transport
correlation. Rust emits static operational events and worker summaries; business
state, provider dispatch identities, RPC stdout and core supervision remain intact.
The browser client distinguishes transport/decoding errors, shows safe status and
trace metadata, retains original mutation receipts and reports early bootstrap
failures without importing React.

## Validation

All commands ran on the managed Linux x64 environment with the pinned Node,
pnpm and Rust toolchains, after sourcing `scripts/cloud-env.sh`.

| Command                                                                                                            | Observed result                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                                                                       | Passed: generated contracts, formatting, all workspace typechecks, 170 Node tests, 171 Rust tests and all-target Clippy with warnings denied.                                   |
| `pnpm build`                                                                                                       | Passed: built Web, desktop TypeScript and Rust workspaces.                                                                                                                      |
| `pnpm test:integration`                                                                                            | Passed: 10 real-process HTTP/storage/worker/AI/recovery/open-mode cases.                                                                                                        |
| `pnpm exec playwright test tests/e2e/workspace.spec.ts tests/e2e/manuscript.spec.ts tests/e2e/diagnostics.spec.ts` | Passed: 24 cases, including all 3 production-gateway diagnostics cases.                                                                                                         |
| `pnpm test:e2e`                                                                                                    | Passed on final source: 36 cases; 3 existing opt-in performance cases skipped. Includes all 3 diagnostics cases.                                                                |
| `docker build --secret id=build_ca,src=/etc/ssl/certs/ca-certificates.crt -t scenesparrow-diagnostics:local .`     | Final image built successfully on the managed local Docker socket. The CA is a build-time secret mount.                                                                         |
| `node scripts/web/container-smoke.mjs scenesparrow-diagnostics:local`                                              | Passed against the final image: diagnostics page/status/grants/scope/bundle/revocation, actual core, document/export workers, counted AI SDK, graceful restart and persistence. |
| `git diff --check` and changed-document link checks                                                                | Passed.                                                                                                                                                                         |

The local image uses the explicit `unknown` build-SHA fallback. Workflow-to-Docker,
Vite-meta and runtime-status SHA wiring was reviewed; no GitHub deployment or
production workflow was dispatched.

## Acceptance evidence

Case IDs below refer to the [remote diagnostics design](../design/remote-diagnostics-v0.1.md).

| Cases  | Executed evidence                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RD-A01 | A fresh Chromium context receives a server Basic challenge through the actual browser authentication stack (CDP auth-required event). New gateway traces prove wrong-credential rejection and HTML 401 responses; correct credentials mount the built application. External top-level navigation opens both application and diagnostics. The native prompt's visual presentation was not manually inspected. |
| RD-A02 | Aborting the built React bundle still emits a safe bootstrap event; the independent diagnostics page creates/revokes a grant, reads status and downloads a bounded bundle. Existing runtime tests retain failed-start/core-exit supervision.                                                                                                                                                                 |
| RD-A03 | Exact read scope, no Basic fallback for invalid Bearer, TTL/replacement/revocation, Origin/Host checks, query rejection, rate limits and restart-invalid grants/cursors; retained pre-restart envelopes remain readable.                                                                                                                                                                                     |
| RD-A04 | Canary credentials, Unicode filenames/manuscripts, URLs, raw exceptions and child/disk corruption do not escape allowlists. Browser HTML canaries never appear in UI reports or exported events.                                                                                                                                                                                                             |
| RD-A05 | Queue overflow, byte/age/file retention, idle cleanup, restored permissions, corrupt/incomplete tails, cursor gaps and bounded read concurrency are exercised. Controlled stalled I/O verifies timeout degradation, writer/maintenance serialization and natural process exit after the shutdown deadline.                                                                                                   |
| RD-A06 | HTTP/auth/network/body-timeout/MIME/empty/truncated JSON classes preserve safe status/trace metadata. Committed lost replies resolve the original receipt without a duplicate submission, including review actions; unresolved receipts retain their identity.                                                                                                                                               |
| RD-A07 | Existing SSE reconnect/cancel, XHR intake identity/progress/cancel, binary limits, native exclusions, desktop typechecks and counted provider dispatch/recovery checks pass.                                                                                                                                                                                                                                 |

## Review-driven corrections

Full E2E initially exposed `eprintln!` panicking when inherited nonblocking stderr
returned `WouldBlock`. All new operational producers now use bounded nonblocking
admission (256 records, at most 4 KiB each) and a detached error-tolerant writer.
Safe drop summaries flow into collector counts. An injected-output regression and
the final complete browser run pass without that panic. Other review corrections
cover idle expiry, closed read-error codes, stalled-read degradation, bounded
shutdown and binary body-timeout metadata.

Release integration also synchronizes inherited rename/settings history baselines
with the actual edit-group-close receipt. The complete history-equality assertion
remains intact; serialized body-save checks count body mutations separately from
independent edit-group closure. A rootless Docker port collision occurred while
browser fixtures were active; the final container smoke passed serially after
those fixtures stopped.

Safe diagnostics-page and localized transport-error screenshots were visually
inspected; generated artifacts remain under ignored `.artifacts/`.

## Evidence limits

Fresh-browser tests use an isolated HTTPS production gateway with an ephemeral
self-signed fixture certificate, a local Rust core and synthetic credentials.
They cannot establish the original authenticated homepage/Cloudflare/Nginx
response. Real provider, Windows/macOS, real disk exhaustion and production proxy
faults remain separate acceptance evidence. Controlled I/O faults exercise bounded
shutdown/degradation; they do not certify every filesystem/kernel failure mode.
