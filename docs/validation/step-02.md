# Step 2: bounded project history

Root review passed on 2026-11-15. Implementation evidence for `S1-T07`–`S1-T08`
on `feat/script-workbench`, based on `8db33b791febb5263a8ba6c40ee572ccc6a21fe6`, following
[step 1](step-01.md). This covers the existing manual workflow and does not mark
all of S1 complete. Sources/import, physical GC and later business stages remain
outside this delivery. Root review/commit/push is a separate gate.

## Implemented behavior

The core retains one linear history of at most five transitions and a persistent
cursor, sharing at most six business snapshot roots. Initial manual draft creation
is reversible back to the outline/empty canonical state. Undo/redo restores stored
stage/content/identities without calling a parser. Restores allocate fresh working,
history and affected block/tombstone revisions through the permanent high-water
identity ledger. Independent stationary siblings keep their tokens; actual moved
blocks and structurally reparented descendants receive fresh tokens and policy
checks. Receipts, events and runtime/system rows are never restored from history.

Typing groups validate session, sequence, open status, actual single-block scope
and the current history endpoint. The client measures 750 ms inactivity from
input events; delivery gaps between the 300 ms/two-second save batches do not end
continuous typing. Selection/focus movement and discrete structure/format actions
start new groups. No-op acknowledgments can advance group sequence metadata, while
preserving working/history revisions, cursor and redo. Actual group closure
advances history revision without changing working state or the redo tail.
Earlier receipts remain immutable when a group extends.

Migration `003_history.sql` appends to immutable applied migrations 001/002.
Acknowledged version-2 drafts migrate with empty history and unchanged old receipt
outcomes. Before upgrading, SQLite's backup API captures committed WAL state and
object files are copied, verified and pinned alongside that database. Failed
migration transactions roll back and retries preserve prior backup directories.
Startup verifies current and retained history objects and closes interrupted
sessions. At the maximum history token, startup still fences groups and permits
reading acknowledged content; further mutations requiring a new token reject.

Closed `UndoProject`/`RedoProject`/`CloseEditGroup` commands include working/history
revision and cursor preconditions. `GET /v1/history` and the named desktop history
read expose initial metadata and operation-label codes. Optional receipt labels
preserve compatibility with old successful receipts. History rejection receipts
retain safe typed reasons/affected IDs. Immutable objects are prepared before the
short SQL transaction, which rechecks preconditions and injected policy guards.

The shared editor has one serialized mutation queue for autosave, group closure
and project history. Toolbar and shortcuts share that router; local document
history stays disabled. Native unsubmitted inputs retain browser undo, paragraph
Tab retains focus navigation, and composition events do not dispatch intermediate
text/history operations. Native caret selection is reconciled before forwarding
structural keys. Canonical reloads suppress updates and preserve identity guards.
Current-editor refs keep asynchronous callbacks valid with stable editor options.

Distinct local action snapshots preserve typing before/after a delayed structural
save. Unchanged selection captures coalesce. A later visible edit during project
history enters recovery instead of being overwritten, including edits arriving
while an earlier save drains before history dispatch. Controlled close repeats
flush/group closure if newer valid input arrives during closure. Invalid visible
structure remains unsaved, permits local correction, and requires explicit retry;
uncertain commands retain their original identity until reconciliation.

## Acceptance mapping

| Case          | Evidence added or retained                                                                                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-AC07       | Seven discrete edits prune to five transitions/six shared roots; exactly five undo/redo boundary; browser toolbar/shortcut agreement; continuous typing across multiple saved batches remains one operation.                                                   |
| S1-AC08       | No-op/group sequence acknowledgment and navigation preserve redo; first new mutation clears the tail; browser branch/reload verifies availability.                                                                                                             |
| S1-AC09       | Repository reopen and actual core process restart preserve body/cursor/redo in the middle; restored tokens are newer; interrupted group continuation fails while original receipts replay.                                                                     |
| S1-AC17       | Injected direct/structural policy guards block undo/redo atomically, including a policy change after object preparation; safe rejection details persist. Independent protected siblings remain unchanged. Production locks/import guards remain later work.    |
| S1-AC01, AC03 | Manual stage undo/redo in core and browser; deleted IDs restore only through history with increasing high-water tokens; fresh insertion cannot recycle them; existing split/list/merge/paste identity cases pass. Import remains step 3.                       |
| S1-AC05, AC06 | Delayed receipts, serialized discrete actions, IME events, local-input routing, pending-close valid/invalid buffers, structural correction/retry and explicit discard regressions pass. Native OS/disk-full behavior remains unverified.                       |
| S1-AC12       | Success/rejection replay precedes preconditions; changed reused request fails; ambiguous committed undo retries the original identity without a second undo. Import-preview applicability remains later work.                                                  |
| S1-AC04, AC14 | Version-2 migration/backup/failure/retry and future-version refusal; history object/receipt-transaction faults leave state/cursor/receipt atomic; missing retained history objects prevent reopen. Abrupt power loss/physical GC boundaries remain unverified. |

Test sources: `crates/infrastructure/src/manuscript_tests.rs`, existing domain and
service tests, `tests/unit/autosave.test.mjs`, `tests/unit/desktop.test.mjs`,
`tests/integration/core.test.mjs`, and `tests/e2e/manuscript.spec.ts`.

## Final verification

Commands ran with `scripts/cloud-env.sh` (Node 24.22.1, pnpm 11.25.0, Rust 1.100.0,
Tiptap 3.34.0, system Chromium). The final source tree stayed unchanged throughout
the complete gate; this evidence document was added afterward.

| Command                                | Result                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                           | Passed: contract drift, formatting, workspace types, 23 Node tests, 3 domain/28 infrastructure/1 service tests, and warnings-denied Clippy. |
| `pnpm build`                           | Passed: browser, desktop TypeScript and Rust builds. Existing Vite bundle-size advisory remains.                                            |
| `pnpm test:integration`                | Passed: one actual core-process fixture, including two restarts and midcursor body/history/receipt/redo recovery.                           |
| `pnpm test:e2e`                        | Passed: all 13 Chromium cases in 52.1 seconds.                                                                                              |
| `pnpm peers check`, `git diff --check` | Passed.                                                                                                                                     |

Root independently passed `pnpm check`, `pnpm build`, the restart integration and
all 13 Chromium cases (51.2 seconds) after integrating overview documentation.
The root visually inspected the resulting bilingual workspace screenshot.

Final source review corrected backup flush handles to request write permission,
as Windows `FlushFileBuffers` requires it. After this narrow infrastructure change,
root reran `cargo test -p scenesparrow-infrastructure --locked migrat` (2 passed),
`cargo clippy --workspace --all-targets --locked -- -D warnings`,
`pnpm format:check`, `pnpm test:integration`, `pnpm peers check` and
`git diff --check`; all passed.
Frontend source was unchanged; this does not establish native Windows behavior.

Earlier targeted runs exposed closed-envelope, queued-close and caret-routing
issues; the final gate above includes their corrections. No providers, video
rendering or native Windows/macOS application launches were performed.

## Retention and remaining limits

Closed groups retain compact identity/sequence fences and release their payload
references. Branching/pruning releases unused business roots. The repository's
`retained_object_roots` seam includes current canonical/block objects and retained
history roots; it explicitly requires a future collector to capture/reclaim under
the same writer coordinator. Backup directories own separate pinned copies.
Physical object deletion and external artifact retention fixtures belong to step 3;
this step does not delete objects or claim full S1 retention completion.

Business snapshot version 1 contains only implemented stage/document fields.
Sources and S3 review/lock fields must extend this same project history and cursor;
they must not create independent stacks or include runtime/provider state.

The 50 KB/500 KB/2 MB latency, retained-byte and process-memory budgets remain
unmeasured. Coalescing repeated unchanged captures is tested with a 500 KB buffer,
but no performance threshold is claimed. Distinct pending local actions still use
snapshots. Actual Windows/macOS shortcuts, native IME, dialogs/close, filesystem
locking and power-loss durability require target-host evidence. Chromium and the
simulated preload bridge establish only the tested browser/contract behavior.
