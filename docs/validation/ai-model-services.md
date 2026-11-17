# Model services and durable credentials validation

Date: 2026-11-17. Branch: `feat/ai-model-services`, based on accepted
`release/1.0.0` at `22cb413`. PR: [#12](https://github.com/Geminorun/SceneSparrow/pull/12).
Source: [approved design and MS-01–MS-09](../design/ai-model-services.md).

## Implemented scope

MS-01–MS-05 replace the former single AI form with General, Model services and
Default models navigation. OpenAI and DeepSeek share the compatible text adapter;
saved custom/duplicate profiles retain their identities, authentication modes,
models and bindings. Discovery/manual addition does not bind a default or run
inference. Model preferences save independently; the row action and Defaults
selector use the same text binding. Audio/video bindings remain internal.

The controller serializes revision-aware writes, isolates provider UUID drafts,
preserves dirty values, clears unsaved secrets on dismissal and exposes conflict
reload. Test receipts remain tied to the captured saved configuration and session.
Resolving an uncertain action reuses its identity without another provider call.
Nested modal focus and service/list navigation work at desktop and narrow widths.

MS-06–MS-08 add a CredentialStore adapter using pinned AES-256-GCM, fresh OS-random
nonces, separate header/entry authenticated identities and immutable revision
files. Header/master failures reject opening; isolated entry corruption makes
that revision unavailable. Atomic files, private permissions, file locks and
directory synchronization cover the implemented write boundary. Settings still
owns inventory, retirement and orphan cleanup.

The Web supervisor passes only a master-file locator to the core. Compose mounts
it read-only; deployment provisions it once and reuses it. Missing keys over an
existing vault and unreadable volume inventories stop provisioning before
downtime. Backup archives exclude the master; restore requires the matching
separately protected key. Native keyrings and ordinary session-only development
retain their existing selection rules.

## Review and targeted evidence

Implementation used one writer at a time. Root reviewed the shared UI/contracts,
legacy compatibility, draft/receipt targeting, credential lifecycle, crypto file
format, supervisor environment and deployment failure paths before committing
each slice. Review corrections included stable accessible input names, nested
closed-details focus exclusion, UUID-owned drafts, explicit conflict reload,
header/entry AAD separation, production locator wiring, fail-closed volume
inspection and synchronization of a newly created vault directory's parent.
Root also reproduced a creation-alias leak when a newly saved profile moved to
another preset. Clearing that alias on authoritative publication preserves
independent roots/secrets and prevents reusing the moved profile's UUID when the
original service is configured again; the added browser regression passed.

Targeted checks passed: initially 14 browser cases (5 model services and 9 workspace),
17 Node AI/helper/locale cases, 14 Rust AI cases, 7 vault cases, 6 Node
runtime/deploy/release cases, and 2 real-service HTTP integration variants.
The encrypted integration verifies actual SDK requests after restart and key
rotation, deletion/reconciliation, wrong/missing master rejection and absence of
the master locator/contents from worker environments and logs. All credentials
and endpoints in these checks are synthetic/local.

Root inspected `.artifacts/model-services-zh.png`,
`.artifacts/model-services-narrow.png` and
`.artifacts/model-services-legacy.png`. These are local, ignored artifacts, not
published screenshots. Installed Docker Compose also accepted the new secret
configuration before its first host file exists.

## Final independent gates

Root ran the following gates with implementation writers stopped. The final
browser/image reruns include the focus traversal and creation-alias corrections:

| Command                                                                | Result                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                           | Passed: contracts, formatting, workspace typechecks, 211 Node tests, 193 Rust tests and Clippy with warnings denied.                                                                                                                               |
| `pnpm build`                                                           | Passed: built Web assets, Electron TypeScript and the locked Cargo workspace.                                                                                                                                                                      |
| `pnpm test:integration`                                                | Passed: 11 cases.                                                                                                                                                                                                                                  |
| `pnpm test:e2e`                                                        | Passed: final rerun 60 cases; 3 opt-in performance cases skipped.                                                                                                                                                                                  |
| Local AMD64 Docker image build                                         | Passed: code checkpoint `8b0acac`, image `sha256:0209895b85063051046870b1de78c86063d849eef683ea38e7fc8c1a859a3236`.                                                                                                                                |
| `node scripts/web/container-smoke.mjs scenesparrow-web:model-services` | Passed: real core/built frontend, authentication/diagnostics, document workers/exports, one counted local SDK response, encrypted credentials and manuscript/project persistence after graceful restart. Own temporary containers/volumes removed. |

Logs are retained locally as `.artifacts/model-services-{check,build,integration}.log`,
`.artifacts/model-services-e2e-final.log`,
`.artifacts/model-services-docker-build-final.log` and
`.artifacts/model-services-container-smoke-final.log`.
Final UI corrections additionally passed editor typecheck, the focused modal
regression, rebuilt Web assets and all 15 model-service/workspace cases (6 + 9).
Root limited modal filtering to each control's ancestors, avoiding repeated
whole-catalog scans. The reassignment regression failed before its fix and passed
afterward; no automatic inference was introduced.

## Compatibility and limits

The two provider/model fields are optional and generated from the AI schema;
`encrypted_file` extends the backend status enum. Existing settings remain
readable and presentation metadata does not change runtime fingerprints. No
project migration, manuscript history rewrite, category override or automatic
provider fallback is added. Applied migrations 001–010 remain unchanged.

An upgrade from Linux session storage retains configuration but needs one-time
API-key entry after the old process exits. Protect and separately back up the
server's generated master as documented in the runbook. This is one private
shared deployment, not user isolation.

Linux fixtures and a local image do not establish native Windows/macOS keyring,
desktop packaging, actual power-loss durability or real-provider interoperability.
No paid endpoint, real SSH server, registry publication, GitHub deployment run,
domain change or production deployment is part of this validation. Existing
large-document/media-stage limits remain unchanged.
