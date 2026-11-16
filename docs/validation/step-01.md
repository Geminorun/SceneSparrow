# Execution step 1: manual manuscript foundation

Status: root review passed on 2026-11-15; this is not completion of the whole S1 stage.
The branch is `feat/script-workbench`, based on
`7ff6b966efce308b1580a0d0eaa9d4da5832f786`. Later delivery steps remain planned.

## Delivered behavior and boundaries

The manual portions of S1-T01–S1-T06 provide an empty-draft start, shared Tiptap
editor, derived heading navigation, serialized debounced autosave, accurate state
feedback and recovery of local unsaved text. Canonical blocks support headings
1–6, nested bullet/ordered lists through depth 3, bold/italic/code combinations,
safe links, soft breaks and Unicode. Paragraph attributes are empty; other
attributes and link hrefs appear only when applicable. Only the core assigns
monotonic working/block revisions, including tombstones; proposed UUIDv4 IDs
cannot reuse project/manuscript/block identities.

Migration 002 adds concrete manuscript/block, identity/revision, immutable
snapshot/object, receipt, edit-group and outbox foundations. Immutable bytes are
promoted and verified under the writer coordinator before the short SQLite
transaction. Startup validates current snapshot and block references. Consistent
pre-upgrade SQLite backups are preserved across failed migration retries. Newer
schema versions are rejected before database pragmas/writes.

Known semantic rejections and successful outcomes have immutable request receipts;
transport ambiguity retains the original request identity. Commands validate the
complete batch and actual derived structure impact through an injected mutation
policy. Existing blocks whose derived ancestry changes also require revision
preconditions. The serialized UI supplies a valid revision superset; this does not
expand the actual mutation scope. S1 installs unrestricted production policy; tests
inject protected IDs.

T05's import entry/preview is intentionally deferred to step 3. No import, source,
undo/redo, review, lock, provider or export controls are exposed. Receipt history
fields are zero reservations, and edit-group metadata does not provide five-step
history. Grouping boundaries/history routing belong to step 2. There is no SSE,
retention policy or garbage collector yet; unreferenced promoted objects can remain
following a failed commit. They cannot become partial live references.

## Evidence mapping

| Acceptance | Evidence and boundary                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1-AC01    | Partial: manual outline-to-empty-draft transition, no persisted editor placeholder, empty draft reopen, acknowledged body reopen. Import and stage undo/redo await later steps.                                                                                                                  |
| S1-AC02    | Manual editor evidence: Chinese/English/emoji, combined marks and links, soft breaks, heading/list structure and stable IDs through actual Tiptap editing/reload; canonical invalid structure/control/URL/limit and grapheme split tests. Imported-format normalization awaits step 3.           |
| S1-AC03    | Manual primitive evidence: split/merge preserve surviving IDs, fresh inserts/tombstones, derived section moves and monotonic revisions; failed batches leave state unchanged. History restoration awaits step 2.                                                                                 |
| S1-AC04    | Bootstrap WAL-inclusive backup preserves title/identity, injected migration DDL failure rolls back and retries with original backup preserved, unknown schema leaves database bytes unchanged.                                                                                                   |
| S1-AC05    | Browser composition-event test sends no intermediate save; delayed receipt retains newer visible input and serializes requests. Controller tests verify 300 ms/2 s scheduling, composition, no-op reopened flush and disposal fencing. Real Windows/macOS IME remains unrun.                     |
| S1-AC06    | Partial: injected object-write/transaction faults and browser storage error retain local input; explicit retry and real competing-write conflict/copy/discard recovery. Desktop close/preload/timeout logic is compiled and unit-tested; actual host close/disk-full verification remains unrun. |
| S1-AC12    | Partial: lost response after real commit resolves one receipt; altered payload with reused ID fails; rejected outcomes, group validation and exhaustion are stable across replay. Import-preview staleness awaits step 3.                                                                        |
| S1-AC13    | Browser HTTP authentication/origin rejection and closed variants; scoped desktop client/preload, origin checks and sandbox allowlist checks. Actual target-host desktop flow remains unrun.                                                                                                      |
| S1-AC14    | Partial: injected object promotion and final receipt-transaction failure leave no partial state/receipt; missing live block objects prevent reopen; actual process restart restores acknowledged state/receipt. Abrupt power-loss and GC boundaries await later evidence.                        |
| S1-AC17    | Partial: injected policy rejects direct edits and inserted structural parents affecting protected descendants; independent sibling insertion and no-op moves pass. Import/undo/redo restrictions await those implementations.                                                                    |

Test sources (paths relative to the repository root): `crates/domain/src/manuscript.rs`,
`crates/infrastructure/src/manuscript_tests.rs`, `tests/unit/autosave.test.mjs`,
`tests/unit/desktop.test.mjs`, `tests/integration/core.test.mjs`, and
`tests/e2e/manuscript.spec.ts`. Existing project/localization tests remain active.

## Verification and limitations

Validation uses the pinned Node 24.22.1, pnpm 11.25.0, Rust 1.100.0,
Tiptap 3.34.0 and system Chromium selected by `scripts/cloud-env.sh`. The browser
suite drives the shared UI against a real authenticated core; storage failures
use injected error responses plus separate core fault tests. Composition events
exercise the editor save gate, not an installed OS input method.

Root independently ran these commands on the corrected tree after all subagent
writes stopped:

| Command                                 | Result                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                            | Passed: generated-contract drift, formatting, workspace types, 15 Node tests, 3 domain/18 infrastructure/1 service Rust tests, and Clippy with warnings denied |
| `pnpm build`                            | Passed: browser, Electron TypeScript and Rust builds; Vite retains a bundle-size advisory                                                                      |
| `pnpm test:integration`                 | Passed: 1 actual core-process restart test preserving acknowledged manuscript and receipts                                                                     |
| `pnpm test:e2e`                         | Passed: all 9 Chromium browser cases in 31.1 seconds                                                                                                           |
| `pnpm peers check` / `git diff --check` | Passed                                                                                                                                                         |

No provider calls,
video rendering or Windows/macOS desktop launches are required/claimed for this
step. Existing Electron sandbox settings remain enabled. The unit-tested
preload has a safe close handler before the draft mounts and cleans up scoped
handlers; an unresponsive renderer requires an explicit close/discard decision.

The 50 KB/500 KB/2 MB latency/memory budgets are unmeasured. Current bounded
snapshot serialization and object verification prioritize correctness; no
performance claim is made. There is no durable browser keystroke buffer: abrupt
exit can lose unacknowledged input, while controlled close/unload warns or waits.
The full stage fault, history, import, events and retention acceptance set remains
pending. Applied migration 002 must remain immutable; subsequent delivery steps
must append migrations rather than rewrite it. The shared AI ledger now reserves
003 history, 004 sources/import, 005 shared AI, 006 planning, 007 review,
008 finalization and 009 export. Only unused reservations were changed.

## Review corrections

Root inspected the contracts, domain/storage, autosave/editor and desktop changes,
with read-only storage and client audits. Corrections include final serialized
size validation after revision allocation; stable rejection receipts for group and
tombstone exhaustion; reserved project identities; structural descendant revision
preconditions and commit-boundary policy checks; live object verification; and
failed migration retry backups.

Client corrections preserve the original unresolved request, forbid no-op saves
after reopen, fence disposed controllers, retain invalid visible input across
timers/retry/late receipts/close, and resolve explicit discard during a pending
close. Actual editor regressions cover first-result split/merge identity and
pasted duplicate/tombstoned IDs. The root visually inspected the shared bilingual
workspace screenshot at `.artifacts/workspace.png`.
