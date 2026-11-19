# Open project implementation and review plan

Status: implementation authorized on 2026-11-19. OP1 and Linux OP2 passed
independent local review; OP1's native-worker correction `04ca8e4` also passed
Foundation checks. OP3–OP6 remain pending. Each later gate must pass separately.

Branch: `feat/open-project-format`, based on remote `release/1.0.0` at `bf56982`.
The PR targets that release branch and remains draft during staged delivery.

Source: [open project specification](specs/open-project-format.md),
[ADR 0005](decisions/0005-open-project-workspace.md),
[current source ownership](architecture.md) and the established
[implementation/review workflow](implementation-execution.md).

## Scope and responsibilities

The root writes the common specification, architecture decisions, stage briefs,
plan and validation summaries. Planning/design/documentation use no subagents.
The initial checkpoint changed documentation only. The user has now authorized
the six-stage implementation. Auto-merge, release and deployment remain excluded.

After implementation is started, substantial coding stages use a fresh agent with
`model: gpt-6.1-sol`, `reasoning_effort: high`, `fork_turns: none`. Root remains
the scheduler, independent reviewer and sole Git owner. Use the existing shared
checkout, no worktree and one writer at a time. All writers stop before review,
checks, staging, commit and push. Corrections return to the same stage agent.

Agents may not stage/commit/push, change branches, modify another agent's scope,
create worktrees, delegate, publish, run paid providers or use real user projects
as fixtures. Root handles small review corrections directly where appropriate.
If the requested model is unavailable, report it rather than substituting it.

The six stages build open-project foundations. They do not implement production
TTS/ASR, the complete audio/video workflow, embedded Agent sessions or arbitrary
cross-platform code execution. Media capabilities are declared and preserved;
a trusted standalone Remotion fixture proves interoperability. Product execution
capabilities remain explicitly gated on actual isolation evidence.

## Stage assignments

### OP1 — Contracts, identity codec and portable skeleton

Implement manifest/declaration JSON Schemas and generated consumers, pure path
and format validation, and a standalone text/media fixture. Put reusable Markdown
source/marker logic in `packages/manuscript-format`; keep pure invariants in
domain/contracts rather than UI. Establish source-preserving edits and marker
mapping for nested/unsupported structures before storage/UI work depends on them.

Root first writes the stage brief, proposes the codec and records its acceptance
fixtures; the implementation agent supplies the concrete codec proof and
executable contracts. Root freezes the encoding only after reviewing that proof,
and resolves any failed round-trip assumption before OP2. Do not connect a lossy
serializer to source persistence.

Likely owners: `packages/contracts`, `packages/manuscript-format`,
`crates/domain`, small sanitized `tests/fixtures`, focused unit tests.
Acceptance: OPF-AC01–AC05 and the standalone portion of AC17. No default-storage
switch, automatic dependency installation on project open, migration or Agent host.

### OP2 — File-backed project store and recoverable snapshots

Implement new-format detection/create/open, explicit creative-file ownership,
management storage, base-hash writes, immutable snapshots and coordinated
file/metadata recovery. Preserve the existing project writer, receipts, locks,
consistent backups and retention. New-format and legacy projects have distinct
loaders, never two writable manuscript sources within one project.

Root fixes the durable journal/promotion and crash-recovery protocol in the stage
brief before implementation. Fault-injection evidence must include every point
between file promotion, metadata commit and reopen. Keep legacy routing working
until explicit migration; do not silently relocate the current database.

Likely owners: domain/application ports, `crates/infrastructure` repository and
`storage/`, named service routes, generated/typed client changes when required.
Acceptance: AC01, AC03, AC06, AC07 and AC19. No conversion of real projects.

### OP3 — Markdown authoring and external-file reconciliation

Connect the shared manuscript/workbench/project-session UI to source-preserving
file authoring. Maintain the current planning/review/history projection and stable
bindings. Add debounced watch/rescan, partial-write handling, self-write recognition,
dirty-buffer conflicts and safe reopen. Preserve save preferences, bounded history,
IME/caret identity and original ambiguous command ownership.

Root confirms the source-capable editor approach against OP1's fixtures. Reuse
current modules where they meet fidelity; an editor dependency change needs explicit
review and reproducible lockfile updates. Do not reduce unsupported syntax to a
literal replacement and claim lossless visual editing.

Likely owners: `editor-ui/manuscript`, `project-session`, `workbench`,
`platform-client`, infrastructure watch/read coordination and browser tests.
Acceptance: AC04, AC05, AC08, AC09, AC12 and AC19. Root reruns deterministic
held-acknowledgment and local-versus-external-edit regressions.

### OP4 — External candidate changes and acceptance protection

Implement scoped candidate/work-copy records, actual file/asset diff inspection,
base validation, permitted management-state boundaries and explicit accept/discard.
Revalidate lock/dependency impact through the existing policy. Group an accepted
batch into one project operation, retain original receipts and preserve approved
snapshots. Unknown TSX/shared dependency effects conservatively expand review.

Likely owners: core manuscript/history/review/finalization integration, named
service/client contracts and shared candidate/diff/recovery UI. Keep generic AI
execution independent. No Codex/Claude SDK integration or automatic paid operation.
Acceptance: AC10–AC12 and AC19. Include stale base, management tampering, locked
deletion/rename, cancellation and duplicate/lost-ack acceptance cases.

### OP5 — Legacy migration and complete project packages

Implement inspect/backup/convert/validate/switch for legacy projects, then ZIP
export, bounded inspection/import and explicit restore-versus-returned-edit flows.
Collect the referenced source/media/management snapshot closure, preserve original
IDs and decision/history evidence, exclude secrets/cache and fence copied jobs.

Root fixes ZIP resource limits and the metadata/object mapping before dispatch.
Use old-version fixtures and fault injection; never test destructive conversion
against user directories. A failed migration/import leaves a recoverable original.

Likely owners: infrastructure backup/objects/retention/export, supervised document
utility where applicable, named routes/platform adapters and delivery/recovery UI.
Acceptance: AC13–AC15, package portion of AC17 and AC19. Test WAL consistency,
interrupted migration, missing objects, zip traversal/bombs/collisions and edits
made during export.

### OP6 — Shared platform integration and end-to-end readiness

Finish Web configured-project and desktop named-folder/lifecycle integration.
Connect visible capability and recovery states, preserve deployment project volumes
and verify independent rendering from a packaged fixture. Add the end-to-end cases
for external Markdown/scene changes, acceptance, reopen, migration and export.

Product preview of arbitrary edited code requires an explicitly reviewed execution
boundary with actual escape/credential tests; it cannot be enabled by merely
moving code to a child process. Where unavailable, show a truthful capability and
retain external-CLI interoperability. Root must report that limitation rather
than treating a trusted fixture as full arbitrary-project preview acceptance.

Likely owners: `apps/web`/server, `apps/desktop`, `platform-client`, workbench and
render adapters, browser/HTTP/native harness tests. If this becomes too large,
root splits it into sequential coding substeps with the same acceptance gate.
Acceptance: AC16–AC20 plus the final cross-stage regression set. Native Windows/
macOS execution, packaging, media playback and performance have separate evidence;
Linux browser success cannot close them.

## Dependency order and per-stage gate

Run OP1 → OP2 → OP3 → OP4 → OP5 → OP6 sequentially. Root may split a large coding
stage, but not bypass dependencies or move unresolved format choices into a later
consumer. Each stage follows this loop:

1. Root records exact branch/base, stage behavior, allowed files, contract changes,
   acceptance IDs, exclusions, fixtures and required checks in a self-contained brief.
2. One implementation agent reads the current source, codes and runs targeted
   behavioral tests. Contract generation/migration/dependency writes are serialized.
3. Agent hands off changed files, evidence, failures/limits and process ownership;
   all writes and owned checks stop.
4. Root reads the diff and surrounding callers, reviews data/recovery boundaries
   and independently reruns meaningful checks. Findings go back for correction.
5. Only after acceptance, root stages intended files, reviews the staged diff,
   makes an English Conventional Commit and pushes the same feature branch.
6. Root updates the PR progress/evidence and then dispatches the next stage.

No code is submitted merely because an agent says it is complete. No next-stage
writer runs during review. A format/behavior change updates the root-owned spec
before downstream work relies on it. Spec decisions and observed results stay
separate; unrun native/provider/performance checks remain open.

## Final delivery

Root runs applicable contracts, formatting, typechecks, Node/Rust tests, Clippy,
build, real-core integration and full browser gates on frozen final source.
Rendering changes additionally need actual frame/audio/playback evidence. Existing
S1–S4 and shared AI regressions remain required, especially five-step history,
locks, task identities and input ownership. Require Foundation checks on the
current prospective PR merge commit; verify its head/base rather than citing an
older checkpoint. Mark ready only after the implemented scope and checks match.

Final report lists actual functionality, migration/recovery evidence, platform
limits and deferred media/execution capabilities. Keep the PR unmerged and do not
tag, deploy the application or publish the cloud environment automatically.
