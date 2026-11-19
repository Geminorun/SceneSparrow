# OP6: platform capability implementation and final readiness

Status: root preparation, 2026-11-19; not dispatched. Freeze accepted OP5
contracts/commits before assigning coding. Parent: open-project-format.md,
OPF-AC16–AC20 and final cross-stage gates. No automatic merge/tag/deploy or cloud
environment publication. Desktop remains primary; Web validates the same project
format/UI/core on its configured server filesystem.

## Sequential coding checkpoints

OP6-A implements native macOS/Windows creative-file I/O/promotion/recovery and
target-platform CI tests. OP2 currently lacks these capabilities; adding tests or
documenting them as unrun does not implement them.

OP6-B implements default new-format startup, configured Web/native folder lifecycle,
verified recovery-only startup and visible migration/package/capability routing.

OP6-C, if needed after B, supplies the licensed package/render interoperability
fixture and remaining integration/test harness changes. Root performs final review,
full frozen-source checks, prospective merge CI verification and validation docs.
No next writer overlaps a review. Root freezes an exact substep brief before each
fresh gpt-6.1-sol high-effort assignment.

## Native physical access and preservation

Retain Linux descriptor-relative no-follow access and checked exchange/no-replace.
Implement the same observable semantics on macOS and Windows, including streaming
creative binaries and multi-file intents. All source/graph mutation paths use the
same platform primitive; no unchecked fallback for work copies/import/Undo.

On macOS, use descriptor-relative `renameatx_np` with `RENAME_SWAP` for exchange
and `RENAME_EXCL` for no-clobber creation, preserving ancestor/regular-file identity
checks, file flushes and directory flush policy. Validate actual native syscall
behavior and interrupted recovery. Reject unsupported filesystem capabilities
with an honest error instead of overwriting with a nonpreserving fallback.

On Windows, open and retain the root/ancestor directory handles, reject reparse
points, and deny delete sharing on held ancestors throughout read/stage/promotion.
Verify volume/file IDs and regular-file/link-count constraints. String-prefix or
prior canonicalization checks alone are not containment. Handle reserved names,
Unicode/case collisions, locked destinations and long portable paths deliberately.

Use `ReplaceFileW` with a recorded distinct displaced backup path for replacement;
the journal must represent target, staged replacement and displaced backup as
separate members/states. Do not pretend this is Linux's two-name exchange.
No-clobber addition/removal uses native preserving renames with checked known
targets. Flush actual file handles; do not depend on `REPLACEFILE_WRITE_THROUGH`,
which the API documents as unsupported. Errors 1176/1177 can leave different name
layouts, so inspect/recover actual identities and bytes after failure. Unknown
members remain preserved and fenced. A failure return never implies no mutation.

This choice requires platform-aware intent recovery, including interruption inside
the replacement primitive, before any wrapper has restored its preferred stage
name. Keep all displacement paths derivable/recorded before first promotion. Never
delete an unknown third file as cleanup or leave it outside the evidence closure.
Retain v1/v2 and subsequently delivered intent readers. Root reviews concrete
native states and fault tests before accepting platform support.

Official reference for Windows behavior:
https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew

Add focused PR CI matrix jobs on Windows and macOS if the Linux-only Foundation
job cannot run these cases. Pin toolchain/dependencies; use no providers/private
projects. Test actual create/adopt/save, source and graph history, stale/replayed
receipts, missing/add/remove/replace, locked destinations, link/reparse/ancestor
escape, partial multi-file promotion and recovery. Native target CI is distinct
from native GUI packaging/playback acceptance; neither proves the other.

## Verified recovery-only startup

Known intent recovery still runs before ordinary startup jobs and collection.
Unknown preserved live/staged versions must not make a valid accepted project
permanently inaccessible through Web. Add a recovery-only repository/service state
for a verified accepted SQL/object/source/graph/history/lock/approval closure with
an unsettled physical operation. Corrupt/missing accepted metadata still refuses
and offers verified restore; never initialize blank replacement state.

Before serving recovery, prove management project identity, accepted graph/source
and all retained trusted roots. Use accepted manifest/graph evidence when live
creative files are the pending conflict; do not treat their bytes as accepted.
Expose accepted read model, small status, scoped recovery evidence and exact
recovery operations. The bootstrap UI stays usable with a durable localized
recovery entry and local copy/download. An endlessly restarting core/502 page or
SSH-only remedy does not satisfy this gate.

Recovery evidence must be discoverable from project management after the fence
clears, not only from the last intent hash in one browser's localStorage. Add a
bounded, paginated, project-scoped read-only recovery index over durable decisions
and connect the existing evidence UI to it. List only safe operation/hash/
generation facts, no raw source or arbitrary paths. Existing list/member APIs
still validate membership. A fresh browser/profile and native reopening must find
retained staged versions without a copied local hint. Hints may improve defaults,
but do not own the record. Test two recoveries, pagination, foreign project/cursor
rejection and fresh-client discovery after collection/reopen.

Fence project business mutations, intake/application, jobs, paid dispatch and
collection while startup recovery is unresolved. Global AI settings remain
independent. Service background loops must not start/continue project work merely
because the HTTP health endpoint responds. Quiesce/close remains bounded.

After scoped recovery proves settlement, complete deferred ordinary startup
reconciliation once, under the writer/lifecycle gate, before allowing mutation or
dispatch. There must be no window between clearing the intent and completing
startup where ordinary writes race unfinished reconciliation. Avoid recursively
locking the repository mutex. Failures keep recovery visible/fenced. Replaying a
recovery does not rerun startup or dispatch an ambiguous provider call.

Test persisted unknown intent across actual process termination/restart, not only
same-process API calls. Count mock SDK calls and verify unchanged accepted locks,
history and receipt identities. Known committed/uncommitted operations still
recover automatically. A late old recovery cannot settle a newer operation.

## New project and folder lifecycle

Default truly new app-owned locations use format-v1, with no project-name gate.
An absent target can be exclusively created by the core; a pre-created empty
app-owned directory may be handled only by an explicit verified empty-location
protocol. Do not pre-mkdir it and accidentally route through the legacy loader.
Existing legacy roots retain legacy behavior until explicit OP5 migration.
Unknown nonempty/unmanaged roots require inspect/adopt, never a blank reset.

Web startup receives one configured project root. Preserve operator authentication,
exact-origin writes, loopback core tokens and global encrypted credential key.
A cloud development checkout and deployed server are different filesystems;
application release does not synchronize creative files. Keep deployment volume
backup offline/whole-volume, not a bare live SQLite copy. Do not deploy as a test.

Desktop folder choices and recent roots use named main-process capabilities,
isolation/sandboxed renderer and existing close/dirty-input guards. Read-only
preflight must not reject a recoverable pending project before its recovery UI can
start. A genuinely invalid root leaves the prior project active. Migration to a
new root with the same project UUID still has an activation identity: do not keep
the old mounted session/uncertain commands attached to a different filesystem.
Registry writes occur only after successful activation.

The trusted native registry/configured Web locator records the expected managed
root/project identity. If a previously registered root loses its entire
`.scenesparrow` directory, existing-open must require recovery instead of offering
fresh unlocked adoption. A standalone creative-only copy can be explicitly
adopted with its unavailable management history explained; this is a different
choice from verified restoration. Do not claim to recover knowledge after a
filesystem owner deletes every independent record. Test the concrete remembered
root and explicit-copy flows.

Retain session identities/handles for creative and management roots, not only
per-operation parents. Replacing a whole plain directory with a cloned tree
between saves while SQLite retains an old database descriptor must fence/reopen
the session. Never write creative/object paths into the clone while committing
SQL to the old root. Exercise an ordinary rename-and-clone replacement of each
root, in addition to symlink/ancestor swaps during a single promotion. Native
platform handling must preserve this rule without claiming universal protection
against an unrestricted filesystem owner.

HTTP and preload share generated named contracts for source, work copies,
migration, package inspection/download and recovery; renderer gets no generic
path/shell/object capability. Downloads/large media stay streaming. Browser file
intake never pretends to grant a server folder. Native file reveal/save/cancel and
missing remembered folders have explicit tested outcomes.

## Execution and media truthfulness

Arbitrary imported TSX/dependency code remains disabled in the product without a
separately reviewed/tested isolation boundary. A directory, worker process or
trusted fixture does not establish isolation. Show an honest unavailable capability
and external CLI instructions. No auto-install, Agent SDK, production TTS/ASR or
full audio/video editor is introduced by this work.

Use a small licensed/public-dependency Remotion fixture in the ordinary project
format. Its manifest, source, lockfile, media and instructions must survive a
fixed-generation package, extraction outside the app checkout, dependency install
and normal CLI render. No private workspace imports/app API/AI keys. If audio is
added, use a self-authored small WAV/tone with explicit provenance and verify
rendered sample/channel/duration metadata and actual playback alongside frames.
Do not claim subjective listening/visual review from a process exit or screenshot
alone. Preserve fixture license/attribution.

## Final gates and handoff

On frozen final source root runs contracts, formatting, workspace typecheck,
Node/Rust tests, Clippy, build, real-core integration, legacy/source/work-copy/
migration/package browser suites and the full existing browser regression set.
Use one Cargo build at a time. Investigate new failures, do not repeat broad gates
after an unchanged success without a reason. Inspect affected UI screenshots and
play media produced by the final package scenario.

The end-to-end scenario creates an ordinary project, edits via external work copy,
inspects actual differences, accepts once, traverses grouped Undo/Redo/reopen,
verifies locks/evidence, exports fixed ZIP, extracts independently and renders with
its own public dependencies. Include migrated legacy replay and returned package
management tampering/copy-origin fencing. Preserve held-ACK/IME/caret, shared save
preferences, five transitions and paid-task identities throughout.

Verify Foundation and added native checks on the current prospective PR merge
head/base, not an older checkpoint. Record actual counts, command/env, screenshots,
media/hash metadata, failure fixes and native/platform/performance/provider gaps
separately. A Linux browser pass cannot close native GUI/package/hardware tests.
Mark ready only when implemented scope and current evidence match; otherwise keep
draft with the concrete remaining blocker. Do not silently relabel missing code
as an unrun test or claim full audio/video workflow completion.

Every shell sources scripts/cloud-env.sh; every Rust-invoking command/wrapper uses
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4. No parallel
Cargo, real user conversion, paid provider, subdelegation, Git/branch/worktree by
coding agents, or mutation of root docs/specs/.agents/. Stop all owned writes and
processes/checks before root review. Root alone submits reviewed checkpoints.
