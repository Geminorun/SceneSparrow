# OP5-C implementation handoff: visible transfers and bounded delivery

Status: root preparation; dispatch only after OP5-B is accepted and committed.
Read `AGENTS.md`, architecture/workflow, `open-project-format.md`, OP5 parent,
`open-project-op5c.md`, accepted OP5-A/B handoffs and validation first. This brief
narrows the existing OP5 scope; OP6 owns actual project activation/default startup.
Root freezes the accepted B commit and this brief in the coding assignment.

## C1: one visible owner per operation

Use App's existing application menu, Workbench's existing ProjectSession, existing
WritingDialog and top-layer NotificationPresenter. Add focused conversion,
export/import operation presentation under a small transfer feature owner. Reuse
the SourceChanges/work-copy actual-diff and candidate acceptance owner. Do not add
a second Changes owner, project settings in the gear, a workspace/name gate,
dashboard, raw JSON details or a Word toolbar.

Menu actions are Convert legacy project, Export project and Import project
package, localized in English/Chinese. A ready recorded work copy offers Export
work copy in its existing context. Unknown/unavailable capabilities explain the
specific required action; they do not silently adopt or pretend to switch roots.
Keep current global settings independent.

Use the existing off-white workbench palette, compact 14px system/CJK typography,
visible focus and existing panes. A dialog has a concise title/summary, safe
filename, fixed generation or source facts, phase/progress, and explicit actions.
Use normal-width and narrow screenshots for root visual review. Trap/return focus
with the existing dialog, reduced motion, labels, keyboard and reachable controls.
Menu-launched dialogs return focus to the visible menu trigger, rather than a
hidden item inside the now-closed details menu.

Conversion reads the current legacy inspection, explains normalization and the
verified backup/new target, issues its opaque target and starts once. It tracks
the original operation and offers explicit cancel/retry/status. Success leaves
the source active and describes the prepared target. Until OP6, activation is an
honest unavailable action rather than App state/path mutation.

Import inspection does not mutate the current document and is allowed while its
input is dirty. The result distinguishes complete project, recorded work copy and
unmanaged creative package. Offer independently verified restoration only where
B permits it; offer return as edits only with an original local trusted base.
A complete-package integrity failure never becomes automatic unlocked adoption.
Return uses the existing actual candidate diff/grant/lock/accept/discard flow.

## C2: captured saved generation

The full capture action is ONE ProjectSession queue operation:

1. Capture owning manuscript/planning input, context and composition intent.
2. Settle only those captured checkpoints through the existing owners.
3. Read PackageBase and compare with the intended saved source/history checkpoint.
4. Submit the original export DTO once and retain it through capture ACK.

Do not call prepareInput, release the queue, then read/start independently. A later
autosave must not interpose newer input between captured flush and backend SQL
snapshot. Extend the existing final-input owners with the compound capture helper;
do not add another save queue or pretend a read-only snapshot has a manuscript
mutation receipt. Current planningAdapter.flush itself enters the shared queue:
do not await that ordinary queued entry recursively from inside the same queue.
Provide an explicit captured planning participant/inside-queue execution seam and
test it with actual PlanningAutosave, preserving its original pending command and
newer local input. Reuse the helper in related copy/export entry points where the
same interposition class applies, while retaining their selected-scope contracts.
Hidden planning/outline input participates. IME waits use the existing bounded
composition action; ordinary typing and background saving remain enabled.

After ACK, newer input stays local and pending; it cannot be marked Saved by the
old result. A later accepted foreign checkpoint must cause an explicit stale/read
conflict, never silently export that checkpoint. Once backend capture exists,
later edits cannot stale it or change its contents.

Capture operation/request IDs, original DTO, client/context, selection generation
and AbortController before awaits. Late progress/readback cannot close another
dialog, replace another controller, clear input or change a later decision. Reuse
scoped read ownership and monotonic revisions. Separate original command outcome
from current status. Unknown response offers lookup/reconcile of the SAME ID;
never automatic resubmission with a new ID. Passive polling is quiet; each explicit
failure reports one localized three-second notice plus compact durable status.
Closing a dialog is distinct from backend cancellation.

## C3: Web intake and download

Use B's named typed methods. Select a browser File, never a native/server path.
Hash via File.stream/bounded slices using a pinned maintained incremental SHA-256
dependency. A bounded first hash pass followed by upload is acceptable. Do not
implement a bespoke cryptographic hash or use whole-file arrayBuffer/WebCrypto.
Use at most B's 1 MiB chunk size, exact offset/length/hash and its original bounded
ack/replay protocol. Native I/O's 64 KiB buffer is a separate policy. Keep File and
owner captured across hashing/upload; switching selection invalidates old UI work.
Abort, failure and explicit resume retain truthful intake identity/received extent.
Do not persist file bytes, user prose or keys in transport hints.

Provide a typed same-origin authorized attachment URL/delivery adapter for Ready
archives. Use a browser download anchor or stream; never navigate the editor's
document away to an attachment/error response. Never aggregate
openPackageArchive's Response into a multi-GiB Blob/Uint8Array. Preserve operator
auth, exact-origin writes, no-store, safe generated filename, length and digest.
Only the exact package-archive route gets the 8 GiB resource policy. OP6 binds it
to activation context, including anchors that cannot set custom headers.
Check current authorized availability before starting, keep input mounted through
failure/expiry, and label a browser-managed transfer as Download started rather
than Saved. The browser owns final network/download progress. Test an unavailable
archive response without replacing the editor or losing its unsaved buffer.

## C4: named native intake/save

The public renderer bridge gains only named purpose-bound capabilities, with
generated safe request/result contracts where appropriate. No paths, shell,
generic fs, arbitrary object IDs or renderer-provided size/hash/cap overrides.

Native intake captures the actual owning core/session BEFORE the chooser, validates
sender/args, and rechecks after every prerequisite await. Main holds a plain regular
chosen file with deliberate no-link/identity checks, computes SHA-256 and uploads
with bounded reads through B's same protocol. Return safe file/intake/operation
facts. Chooser cancel is benign and truthful. Quiesce tracks pending streams; a
late chooser must never call a later host.session() to retarget the operation.

Native ZIP save is NEW-FILE-ONLY in this slice. The existing export-files.ts
check-then-rename overwrite path is insufficient for package containment; do not
raise its limit and call it safe. Use B's authorized PackageArchiveReader and a
narrow native core operation to stream into an exclusively created private stage
under an actually held destination Parent, flush/hash/size verify, then descriptor-
relative no-clobber publish and verify the resulting member. Preserve existing or
unknown destination/stage bytes. Report delivery-status-unknown after publication
uncertainty; do not silently repeat a chooser/write or delete by old pathname.

Suggested private seam: a native-token-only named route accepting archive ID and
main's private chooser destination, delegating to a trusted library helper. Its
destination DTO is NOT a public PlatformClient/preload business capability. The
Web gateway must deny this entire private namespace before proxying; add a test
that an authenticated browser cannot reach it. Main validates/captures the core,
looks up core-owned Ready artifact facts, chooses a safe ZIP filename, then calls
only the captured core. The renderer receives saved/cancelled/exists/unknown facts
and a safe basename, never the destination path. A concrete alternative must meet
the same held-parent and capability boundaries before root acceptance.

Keep ordinary member 4 GiB and package 8 GiB policies separate. Only the core owns
expected length/hash. Reuse its stream_copy/Parent primitives and tiny injected
limits, not a second JS filesystem security implementation. Linux is exercised
here; actual macOS/Windows physical implementation is OP6 and remains unavailable
until implemented/tested. Do not publish an unchecked Node fallback on those OSes.

## C5: required evidence and freeze

Add meaningful actual-core browser scenarios for conversion, fixed-generation
export, inspected restore-ready, recorded work-copy export/return and one Changes
acceptance. Exercise unsafe input, original unknown request identity, interruption/
cancel, duplicate chunk, changed selected File, a late old read/dialog completion,
localized three-second error, keyboard focus and narrow layout.

Explicitly hold a source save/capture ACK, type newer input/IME, and prove stable
DOM/caret, no unrelated disable, no early newer flush, correct Unsaved status and
original exported contents. Include hidden planning input and a foreign accepted
checkpoint. Native tests cover sender/closed shape, cancel, old core after chooser,
stream/cap/hash, destination replacement and private-route gateway denial.

Run affected contracts, formatting, types, build, Node/HTTP and focused browser
gates. Keep legacy and source suites distinct; do not change default bootstrap in
C. Stop every owned writer/check/process before root review. Provide exact intended
file manifest, SHA-256 freeze manifest, commands/counts/logs and screenshots under
`.artifacts/op5c/`. Root independently reviews/tests, writes validation, commits
and pushes before OP6. No Git mutation/worktree/delegation by this coding agent.

Every shell sources scripts/cloud-env.sh. Every Rust-invoking wrapper sets
CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0 and CARGO_BUILD_JOBS=4;
no parallel Cargo. Preserve root docs/.agents and existing dirty work. No real user
conversion, provider spend, arbitrary code preview/install, merge/tag/deploy or
cloud environment publication.
