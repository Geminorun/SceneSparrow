# OP5-A: verified legacy conversion backend

Status: independently reviewed Linux backend checkpoint, 2026-11-19. Base is reviewed
OP4-B `77c0044`; current SQL ledger remains 001–014. This checkpoint covers
OP5-T01–T02 and T03 conversion verification/fencing, OPF-AC13/15/19. Package ZIPs,
visible transfer workflows, activation and native platform delivery have later
gates. See [OP5](../specs/open-project-op5.md),
[A](../specs/open-project-op5a.md) and the
[frozen handoff](../specs/open-project-op5a-handoff.md).

## Implemented boundary

The trusted native library inspects unopened legacy schemas 001–014 read-only,
including committed WAL and without creating a source owner lock. Public named
HTTP/preload operations inspect only the currently owned legacy source, issue an
opaque persisted target, start conversion, read status and explicitly cancel/retry.
They accept no browser filesystem path. The source stays active after success.

Conversion materializes one read snapshot, takes a SQLite backup and derives its
retained inventory from that same backed-up database. Complete required object and
ready-export closure is streamed and hashed with 64 KiB buffers. Completion is
written last. Missing/collected members fail rather than substitute newer state.
The verified original backup and any failed staging remain outside the source.

Schema-only staging applies the existing delivered SQL without normal startup,
copied job execution or redundant migration backups. A trusted isolated Markdown
serializer reuses the pinned legacy inline writer, adds existing leaf identities
and proves exact native canonical projection for every current/history/approved
state. Empty root/list leaves, nesting, marks, Unicode and representable breaks
survive. Unproved spelling refuses; original Markdown never existed in legacy
storage and is not reconstructed or claimed.

Migration preserves project/manuscript/block IDs, high-water revisions, five-step
history entry identities/cursor, locks, approval IDs/sequences and original success/
failure outcomes. Target history and approvals gain derived raw evidence; original
immutable objects remain generic provenance pins. Historical approval source uses
its actual ordered payloads. Ordinary text-changing Undo/Redo retains monotonic
tokens and may derive its existing new exact-revision baseline binding; migration
does not overwrite historical manifests to force reuse. Exact lock-only replay
can reuse the same baseline.

Before Ready, copied nonterminal AI/document/visual/export/downstream work is
interrupted or canceled, old preparation/process/copy capabilities are revoked,
and a recovered execution origin is established without overwriting the source's
origin proof. Succeeded planning results and pending review candidates retain
their actual context/run/input identities and remain usable without new inference.

Lifecycle receipts live in app-data atomic JSON records, separate from project
content/approval SQL and shared AI. The bounded pending journal makes original
target/start/control outcomes recoverable across multi-file write cuts. Five
admissions, one worker, short record locks and direct terminal lookup keep ordinary
source/global-setting operations independent of bulk I/O. Original request replay
precedes fresh base validation. Interrupted work requires explicit retry against
its original base/target. Ready reconciliation proves target closure and physical
creative hashes, and final installation preserves newer control facts.

Actual Linux output I/O is bound to continuously held directory descriptors,
including backup, SQLite staging and creative scans. Original mutable aliases
are never reused after canonical validation. Phase boundaries revalidate parent
identity; publication uses descriptor-relative atomic no-clobber rename. Existing
or unknown targets and interrupted residual bytes remain preserved. The in-process
descriptor paths are not persisted or sent to the serializer.

## Review corrections

Independent review corrected copied queued exports and planning preparations,
multi-file original-receipt crash gaps, marker-only false Ready, stranded terminal
queue entries, heavy verification under the journal lock, and stale worker/status
installation overwriting newer cancel/control state. Actual owner tests exercise
retained planning/review use with counted mock calls.

The first frozen version passed root's full Rust and focused Node checks, but
review still reproduced native output redirection: swapping a previously validated
backup/target alias, or replacing a plain canonical parent, could write inside the
selected source. The held-parent correction has preserved RED/GREEN regressions
for all three cases and a late unknown target. No code was submitted before this
correction. Root's clarified approval replay wording preserves existing monotonic
semantics rather than introducing a finalization redesign.

## Evidence

All commands source `scripts/cloud-env.sh`. Rust-running commands/wrappers set
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
Cargo runs are sequential. Fixtures use sanitized temporary projects and local
mock providers; no real user conversion or paid service is used.

| Owner | Check                                         | Result/checkpoint                                                                                            |
| ----- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Root  | Full Rust workspace                           | 344 passed: domain 29, infrastructure 310, service 5, before the final three containment regressions/helper. |
| Root  | Named transfer/desktop and legacy serializers | 27 passed; JavaScript/TypeScript unchanged by final native containment correction.                           |
| Root  | Final native transfer and backup selections   | 22 / 22 passed on final bytes; selections overlap.                                                           |
| Root  | Final related real-core HTTP                  | All 16 passed on rebuilt final service, covering migration, source, external work and exports.               |
| Agent | Final native transfer / backup selections     | 22 / 22 passed, overlapping selections; includes deterministic alias/parent replacement tests.               |
| Agent | Final all-target Clippy/service rebuild/HTTP  | Passed; all 3 migration HTTP tests passed on rebuilt final service.                                          |
| Agent | Earlier broad Node/build                      | All 452 Node tests and combined Web/desktop/Rust build passed before final localized native correction.      |

Root also passed final all-target Clippy, generated contract consistency, full
workspace typecheck and formatting. The final 35 code hashes matched the frozen
manifest after testing. Root reviewed the actual diff and both read-only reviews
before staging.

Root logs are `.artifacts/op5a/root-rust.log`, `root-node.log`,
`root-node-export.log`, `root-native-containment.log` and
`root-http-containment.log`. The writer's exact commands, checkpoint distinctions,
failure fixes and 35-file hashes are indexed by `.artifacts/op5a/HANDOFF.md`.
Original pre-containment evidence is preserved separately. Prior OP4-B Foundation
run [44512734493](https://github.com/Geminorun/SceneSparrow/actions/runs/44512734493)
passed. Immutable A run
[44522712124](https://github.com/Geminorun/SceneSparrow/actions/runs/44522712124)
passed its complete second attempt, including legacy/source browsers. Attempt1
failed before browser execution because Ubuntu package mirrors returned HTTP503
during dependency installation; no code change was made for that transient.
These checkpoints are not final OP6 proof.

## Remaining gates

This is a Linux backend checkpoint. `Parent` descriptor-bound preparation and
promotion remain unsupported outside Linux until OP6 implements them; this is
missing capability, not merely an unrun native test. There is no new default
format, folder activation, ZIP exchange or transfer UI in A. Existing legacy
authoring/export behavior remains available. No browser UI was changed or claimed
retested by this backend-only checkpoint.

Conversion requires the trusted Node worker; ordinary native text authoring works
without Node. Source output is limited to 4 MiB, worker JSON separately to 32 MiB,
with 30 s wall, 384 MiB Node heap and Linux 512 MiB RSS guards. Unsupported exact
representations refuse without trimming or new unlocked IDs. No full GiB-scale
performance or native GUI/provider acceptance is claimed. Fault cuts and process
restart are tested, not physical power failure. Verified migration backups have
deliberate retention; no pathname-based deletion retry is invented.

No merge, tag, application deployment or cloud-environment publication occurs.
