# Step 7: protected content, finalization and review replay

Implementation evidence for `S3-T09`–`S3-T15`, following
[step 6](step-06.md), on `feat/script-workbench` based on
`4cacff7cf723bcdfcddccbdf581a2f252638e24c`.
This report records the implementation writer's checks. Independent root review
and the root's repeated delivery gate also passed; this is not self-approval,
full S3/platform/provider acceptance, or permission to release.

## Implemented boundary

`SetUserLocks` supports explicit block sets, unlock and atomic lock-all through the
existing command, durable receipt, history and event boundary. The production
SQL guard runs during preparation and again in the actual commit, alongside the
injected mutation policy and existing scoped review/planning task guards. It uses
actual affected identities, including structural ancestry, rather than revision
precondition supersets. Manual text/marks, section/list changes, import, AI
acceptance and history therefore share protection. An independent new sibling
preserves existing locks; changing a locked descendant's parent is protected.
Conflict details identify lock-all blockers and submitted acceptance candidates.

User locks bind exact current block revision/payload hashes and retain their
original action/time across unrelated commands. Lock/unlock changes the project
working sequence and business history, without changing body block revisions or
payload hashes. Unlock affects only user approval; task use persists until its
own cancellation/completion/fence. Questions read locked text without body
reservations. Revision tasks may read locked text and propose changes; their
arrival preserves existing approval and readiness. New locks reject pending or
stale candidate claims and active task use; locking an already locked target is a
no-op. Ordinary open comments do not block locking. Acceptance never locks work.

Finalization requires a draft with at least one nonempty paragraph/list body and
matching user locks on every persisted content block, including headings and
empty paragraphs. Heading-only and empty documents remain unfinalized. A version-1
immutable manifest records manuscript identity and exact ordered block IDs,
revisions and payload hashes. Current readiness points to its opaque baseline ID;
`Project.approvedBaseline` exposes its registered sequence. Review-only mutations
reuse the same body manifest/baseline. Unlock or an independent new unlocked block
clears the current baseline while preserving other locks. Actual baseline changes
emit `manuscript.readinessChanged`; ordinary comments do not.

The named `/v1/manuscript/finalization` read is available through HTTP and the
matching desktop bridge. The shared bilingual UI provides a separate far-right
lock column, keyboard lock/unlock, readable lock-all/readiness in the manuscript
header and a distinct task-use indicator. Viewport controls are bounded with
intersection observation and reconcile after DOM/structural changes. Protected
textblocks reject editor transactions and native DOM/IME edits, including a list
join that would change a locked descendant's parent identity. Selection and
review remain available. The core remains authoritative.

Unsent review text/IME prevents stage-changing history/close adoption, including
input arriving after dispatch. A committed command with a newer private body
buffer retains that buffer. Explicit cancel/unlock can recover a known protection
rejection without pretending the buffer was saved. Unknown body receipts fence
new metadata operations; uncertain metadata receipts fence other controllers.
Proven metadata receipts release their fence even if a subsequent read fails.
The real-browser held-lock-response case verifies private input → explicit unlock
→ successful save, without discarding the private buffer.

## History, recovery and retention

Migration `008_finalization.sql` appends to unchanged migrations 001–007 using the
existing unique, verified SQLite/object backup and fsync procedure. Failure leaves
the old version and object bytes intact; retry uses another backup. Legacy
provisional approval numbers are cleared, without inventing user locks or an
approved body. Business snapshot version 4 gains an optional compact sorted lock
membership field. Existing immutable snapshot bytes and retained history entry IDs
are preserved; old roots decode with empty lock membership.

Asynchronous artifacts, answers, arrivals and execution remain outside business
snapshots. Explicit undo of acceptance/discard/deletion may restore the exact
immutable candidate with a recorded validated binding to fresh current request
and body tokens. Binding checks preserve original quote/IDs, request semantics,
scope, body content/order, context/evidence and current claims. An applicability
mismatch restores stale evidence; a current claim/task/lock conflict blocks replay
atomically. Manual edit followed by undo to the same wording never automatically
revalidates a stale proposal. Newer candidate B from the same thread cannot be
stolen by undo discard, redo acceptance, or undo acceptance after an intermediate
request restore. Blocked replay preserves cursor, body and review decisions.

Undo/redo of thread creation/deletion uses the durable cancellation coordinator
and anti-restore watermark, hides proposals, releases only its own use/claims and
never restarts calls. Restored requests receive fresh tokens and retain original
user-message/answer provenance. Status-only question replay preserves its existing
request/run. A candidate arriving after its thread-creation snapshot is linked to
that exact retained entry, so undo → prune/reopen → redo can restore it locally.
Accepted fill-section insertion IDs can be restored only through the exact
validated candidate binding, using revisions above their tombstone high water;
manual reuse still fails. Reacceptance receipts remain idempotent.

Manifest retention follows current approval, actual downstream references and
actual retained history-entry identities. Pruned/branched entries release their
baseline roots; repeated edit/lock/unlock cycles do not retain all old bodies.
Current/history quotes, visual evidence, original answers and candidate provenance
remain rooted through the existing collector. Reopen validates lock tokens,
manifest version/manuscript/order/payloads, current pointer and project sequence;
corruption or a missing manifest is rejected without fabricated repair.

A Rust-only local future-consumer fixture freezes exact ordered scoped input
hashes plus the originating baseline. It exercises the same serialized repository
and mutation guards, idempotent start identity, a scoped use fence, terminal or
cancelled completion, expiry and restart interruption. It creates no real media
job or provider request. Unlock alone keeps its completed artifact valid; a
consumed content/order/token change makes it outdated, while an unrelated edit
does not. Original inputs/baseline survive beyond five history transitions.

## Task and acceptance mapping

| Task   | Implemented/tested evidence                                                                                                                                       | Acceptance coverage                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| S3-T09 | Production guard, marks/delete/attributes, locked descendants, independent insert, prepared replace/append import, task and history guards                        | AC16/17/19                                                                                             |
| S3-T10 | Explicit/set/all locks, candidate/task blockers, no-op existing locks, keyboard/native DOM/IME and far-right bilingual controls                                   | AC08/13/16/18/19/25                                                                                    |
| S3-T11 | Empty/heading-only rules, exact manifest/current pointer, scoped future-consumer fence/invalidation, bounded baseline roots and corruption rejection              | AC18/20/26                                                                                             |
| S3-T12 | Valid/stale decision restoration, exact candidate A/B ownership, fill insertion resurrection, request aliases, history-entry evidence roots, middle-cursor reopen | AC15/21/22/23                                                                                          |
| S3-T13 | Durable undo/delete/cancel fences, saved-result local recovery, late result suppression, restart and existing SSE receipt/dedup/resync suites                     | AC07/22/23/24/27                                                                                       |
| S3-T14 | Expanded browser interaction plus explicit 500-comment/10-candidate measurement below                                                                             | AC25 measured on Linux; AC28 budgets remain open                                                       |
| S3-T15 | Counted actual-SDK localhost workflows, complete edit/review/accept/lock and fault/API/browser gates                                                              | Portable integration coverage across AC01–28; real provider/native/performance acceptance remains open |

Core behavioral cases are in `crates/infrastructure/src/review_tests.rs`, including
`production_locks_guard_content_marks_structure_import_and_history_without_body_tokens`,
`proposal_arrival_on_locked_body_preserves_baseline_and_accept_requires_explicit_unlock`,
`explicit_decision_undo_rebinds_immutable_candidate_but_manual_edit_undo_does_not`,
`undo_acceptance_cannot_steal_same_thread_new_candidate_after_request_restore`,
`candidate_arriving_after_thread_creation_survives_undo_prune_reopen_and_redo_without_call`,
`stale_evidence_restores_decision_and_body_but_never_revalidates_candidate`,
`approved_baseline_retention_is_bounded_by_exact_history_entries_and_downstream_roots`,
and the migration/reopen/downstream cases. The existing fill-section test now also
checks undo/reaccept, monotonic resurrection and manual ID reuse rejection.
Frontend receipt/composer/IME barriers are in `tests/unit/autosave.test.mjs` and
`tests/unit/review-commands.test.mjs`. The expanded `tests/e2e/review.spec.ts`
uses the actual core and local counted SDK endpoint, not a simulated body store.

## Performance experiment

The explicit fixture creates 500 valid review threads on a small 500-block body,
then appends large content while preserving the reviewed block identities. Ten
scoped candidates use ten actual SDK requests to a controlled localhost endpoint;
there are no real/paid calls or 500-call setup. Review pages remain 40 cards, with
viewport lock controls bounded independently. Local transactions map decorations;
highlight reconciliation no longer serializes the whole document on each local
keystroke. Its fenced post-canonical microtask remains, preserving fresh-card
highlights when an undo response is delayed. This does not remove the remaining canonical autosave/history costs.

Environment: Linux 6.18.57 x86_64, five exposed AMD EPYC 9V74 CPU cores, about
33.3 GiB exposed memory, Node 24.22.1, pnpm 11.25.0, Rust 1.100.0 and Chromium
156.0.8078.79. The measurement uses a debug core and Vite development browser.
The effective cgroup limits are four CPU equivalents and 32 GiB
(`cpu.max=400000 100000`, `memory.max=34359738368`).
These are exploratory observations: five samples per operation/size, so the
reported p95 is the sample maximum, not a robust production percentile. Save
measurements exclude the debounce; scroll measures two animation frames after
scroll-to-top. RSS is one positive process sample per size, not peak RSS or an OS
memory limit; zero-RSS defunct processes are excluded.

Performance command:
`SCENESPARROW_REVIEW_PERFORMANCE=1 pnpm exec playwright test tests/e2e/review-performance.spec.ts`.
Raw local output is `.artifacts/review-performance.json` (ignored).

| Body / reviews                                     | Open     | Typing p50 / p95 | Save p50 / p95   | Undo p50 / p95   | Scroll p50 / p95 | Positive sampled core RSS |
| -------------------------------------------------- | -------- | ---------------- | ---------------- | ---------------- | ---------------- | ------------------------- |
| 503,395 text bytes; 500 comments / 10 candidates   | 1,710 ms | 53.6 / 67.2 ms   | 443 / 905 ms     | 806 / 847 ms     | 33.4 / 40.6 ms   | 48,068 KiB                |
| 2,003,395 text bytes; 500 comments / 10 candidates | 2,968 ms | 107.2 / 144.7 ms | 1,467 / 1,537 ms | 2,064 / 2,333 ms | 17.9 / 32.1 ms   | 86,780 KiB                |

The final observed run took about 1.7 minutes; setup took 53.8 seconds. Canonical
JSON sizes were 564,511 and 2,064,511 bytes respectively. Each size
showed 40 visible cards and eight visible lock controls. Typing p95 exceeds 50 ms;
save p95 exceeds 250 ms; undo exceeds both the 500 KB 150 ms and 2 MB 500 ms
budgets. S3-AC28 and the earlier large-document S1 budgets remain open. Step 8
receives these misses and should profile more observations and individual phases.
No claim of hard memory enforcement, native worker peak RSS or Windows/macOS
performance follows from this experiment.

## Commands, corrections and limits

Final writer gate results are recorded below after completion. Earlier development
failures are not passing evidence: legacy downgrade fixtures initially retained
new tables; the controlled extraction fixture initially failed to claim its job;
queue saturation required sequential candidate preparation in the performance
fixture; temporary unit fixtures needed an independently resolvable follow-up
read; test slice clones failed warnings-denied Clippy; a held lock exposed
metadata reconciliation/protection timing; and viewport lock observation needed
DOM replacement reconciliation. These were corrected with behavioral regressions.
Two full browser attempts passed 16 cases and then left the source-extraction UI
at processing while the core result was ready; four later source cases did not run.
The initial restart hypothesis was incorrect. The new lock/readiness event names
were absent from the closed event contract, which aborted event-page decoding and
SSE projection updates. Both variants and generated consumers now include them,
with a lock/readiness event-page regression. A subsequent source browser barrier
also exposed initial editor protection arriving after visible editability. The
editor now exposes its editable role only after protection is ready; the six-case
review/source closure passed. The final runtime tree is held stable for the
repeated gate. A later performance rerun retained a private buffer because its
fixture typed before the prior Redo had finished reconciliation. The fixture now
waits for the exact history response and settled toolbar state; the final rerun
passed. The failed attempt is not used as passing performance evidence.

- `pnpm check`: passed generated contracts, formatting, TypeScript, 73 Node tests,
  137 Rust tests (12 domain, 123 infrastructure, 2 service), and warnings-denied Clippy.
- `pnpm build`: passed browser build, desktop TypeScript and locked Rust build;
  the existing Vite large-chunk advisory remains (about 1.125 MB / 349 KB gzip).
- `pnpm test:integration`: 5 passed.
- `pnpm test:e2e`: 21 passed; the two dedicated S1/review performance fixtures
  are intentionally skipped in the ordinary run.
- Explicit review performance fixture: passed with the measured budget misses above.
- `pnpm peers check`: passed; React DOM/types use the already pinned workspace
  versions for the lock-header portal.
- `git diff --check`: passed; applied migrations 001–007 are unchanged.

Root independently inspected the production guard, migration, candidate rebinding,
approval retention/integrity, generated events, dependency changes and screenshots,
and reviewed the two read-only core/UI audits. All identified blockers were
corrected. After the writer stopped, root updated the overview/status documents and
strengthened the narrow-toolbar browser assertion: it now selects actual text,
requires both floating action buttons to be visible, and checks their viewport
bounds instead of conditionally skipping the assertion. Root then independently
ran `pnpm check`, `pnpm build`, `pnpm test:integration`, `pnpm test:e2e`,
`pnpm peers check` and `git diff --check`; all passed with 73 Node, 137 Rust,
5 integration and 21 browser tests, with the two dedicated performance fixtures
intentionally skipped. Root inspected the raw performance artifact; the separate
performance measurements above were run by the writer, not repeated by root.

Fresh ignored screenshots are `.artifacts/locks-wide.png`,
`.artifacts/locks-narrow-first.png`, `.artifacts/locks-narrow-nested.png` and the
review screenshots. Viewport screenshots accompany browser bounding-box checks;
full-page capture does not make offscreen virtualized lock controls visible.

`not_run`: real providers/multimodal provider capability, native Windows/macOS
IME/lifecycle/dialogs/credentials, packaging/worker shipping, native RSS/OS limits,
and manual user acceptance. No media changed, so render validation was not
repeated. No paid call, automatic release, merge, audio/video job or export was
added. Full S3, SAI-T14/15 and platform acceptance remain open; S4/export and the
performance follow-up belong to step 8.
