# Execution step 5: saved planning and complete initial draft

Status: implementation validation and independent root review passed; commit/push
follows the execution workflow.
Branch: `feat/script-workbench`. Reviewed prerequisite base:
`2b932dcb31081b300c8493021c9e789b034ec195` (step 4).

## Implemented scope and ownership

S2-T01–T12 implement a saved brief, a four-level ordered outline with stable node
identities, selected evidence, context preparation, outline generation/adjustment,
confirmation and one complete initial draft. S2-T13 implements the explicit
unavailable discovery/manual-source path; no search adapter is configured.
S2-T14 has Linux/browser/fake-provider evidence below; target desktop and real
provider acceptance remain unrun. SAI-T14 gains the S2 consumer integration.
There are no S3 comments/production locks or S4 export changes.

The script application owns version-1 prompts and closed output schemas. Outputs
carry `schemaVersion: 1`; task bindings also record prompt/interpreter versions.
The outline wire representation is an ordered flat preorder with depth 0–3; the
core validates hierarchy, node limits, stable identity and per-node revision
allocation. `language-tags` 0.3.2 validates saved BCP 47 tags. New operations use a
unique immutable command/task identity and scoped monotonic brief, outline,
evidence and instruction counters. An adjustment consumes instruction; initial
writing and empty-outline generation do not. UI locale never rewrites that field.

Migration 006 appends script-owned planning/preparation/task/confirmation,
provenance and visual records; migrations 001–005 are unchanged. Business roots
are version 3; version 1/2 roots upgrade in memory, leaving immutable bytes and
existing draft identities/history intact. Planning edits and selected-source
removal use the existing S1 transition, history plan and atomic commit path.

An infrastructure-only transaction participant extends generic `accept_ai`:
accepted start commits the generic run/binding, confirmation, reserved applicability,
command receipt and event in one project SQL transaction. Configuration is locked
before the project writer. Input/artifact promotion precedes SQL, and commit-time
checks use current SQL identities/counters. Complete result application uses the
same S1 prepared mutation/history transaction; it records script application,
generic applicability, the whole document/stage and provenance atomically. No
streamed partial document is saved. Shared AI remains independent of script models
and the official SDK remains only in `packages/ai-runtime`.

Draft reservations are derived from their owning pending script/generic binding.
All affected mutation paths share the guard, including manual start/import/history,
selected-source removal and local use of an older result. Unrelated sources/settings
remain editable. The core keeps unused adjustment text independent of draft inputs;
the UI disables planning text during a reserved stage transition to preserve input.
Cancellation writes the external origin
watermark before its transaction, fences owning applicability and preserves generic
success if it was already durable. Already-applied cancellation is distinct.

Exact context lives in immutable generic input objects; SQL manifests retain compact
metadata without excerpt bodies. Current/history draft provenance pins confirmed
plan, original sources, extraction results, selected visual bytes and complete
result. Recovery keeps the latest terminal result per operation. Superseded payloads
and expired preparations release pins; compact task/receipt identities persist.
Ready unselected visual previews are bounded to eight and ten minutes. Cancelled,
failed or interrupted visual preparation releases its own temporary pins. Maintenance
runs after terminal transitions and at a 60-second expiry cadence; idle/queued
250-ms host polling performs no manuscript/history scans and skips missed ticks.

Visual preparation uses the document worker and pinned `@napi-rs/canvas` 0.1.100:
explicit 1-based DOCX embedded PNG/JPEG/WebP selection or PDF page rasterization,
actual MIME/magic checks, PNG normalization, dimensions/byte ceilings, provenance,
progress and cancellation. DOCX indexes supported media by sorted embedded filename,
not drawing occurrence/layout order; the UI labels this and shows the selected
filename/transformation. PDF indices are actual 1-based pages. Unsupported DOCX
image formats are not claimed as prepared. Unknown image capability requires explicit user attempt;
text-only is explicit. Text extraction neither implies vision nor triggers OCR.

## Evidence mapping

| Tasks / acceptance                 | Actual local evidence                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01–T04; AC01–03, AC17             | Rust validators/storage/history; browser generated outline, direct multiline editing/new section, locale independence and manual alternative                                                                                                    |
| T05; AC04–06                       | Exact source choices/ranges, evidence readiness/budgets, stale preparation/configuration rejection, link-only labels and unavailable discovery/manual input                                                                                     |
| T06; AC07                          | Actual selected DOCX red-pixel PNG and scanned PDF page raster tests; mislabeled SVG rejection; HTTP visual utility -> explicit unknown-capability choice -> actual SDK PNG data URL                                                            |
| T07; AC10–12                       | Versioned closed schema, foreign/invalid sections rejected, exact node-to-block mapping, marked Unicode draft, validated evidence IDs and nonspoken hints/notes                                                                                 |
| T08–T10; AC08–09, AC13–15, AC21–22 | Counted local compatible endpoint through actual worker/SDK, frozen configuration during global change, atomic start/application rollback, receipt replay, scoped staleness and reservations                                                    |
| T11; AC16, AC19–20                 | Actual cancel/application thread race, cancellation before/after generic success, failed-task cleanup, original-database result recovery and same-inode pre-cancel restore fencing; shared step-4 retry/dispatch suites remain in the full gate |
| T12; AC17–18, AC23                 | Undo/redo without model calls or resurrection, redo-tail local result use and reservation guard, provenance after source removal and five-entry eviction, bounded recovery and preparation/visual pin cleanup                                   |
| T14; AC24                          | Browser task/status reload with SSE unavailable, delayed snapshots and event/receipt ordering guards; existing event replay/resync suites                                                                                                       |

The new Rust planning suite additionally injects a failure while inserting the
confirmation and while committing application status, asserting no partial generic
run/reservation or document/history/application receipt. The cancellation race runs
both coordinators across a shared barrier. Idle/queued reconciliation instrumentation
asserts zero manuscript/history snapshot reads across repeated ticks.

Seven composed `Autosave` + `PlanningAutosave` tests cover IME, intermediate input
during an older receipt, multiline content, delayed close grouping, older read
snapshots, exact uncertain-command replay, corrected known validation rejection,
queued action intent and controlled-close late input. Known errors require explicit
retry; timers and blur do not submit new rejected identities. Stage-changing
manual/import starts disable planning inputs only after dispatch, while ordinary
planning saves preserve IME input.

## Commands and results

All shells source `scripts/cloud-env.sh`. Ordinary tests use no real credentials or
paid providers. Initial targeted commands found and corrected: legacy test-fixture
downgrades retaining new planning tables, missing request identity on background
events, a content-comparison property-order mismatch for newly added outline nodes,
ambiguous broad language selectors, and composed save/IME retry edge cases.
The first full gate additionally exposed S1 gesture-capture/builder-evaluation
regressions, a desktop fixture missing the new named planning method, and Clippy
cleanup; all were corrected and their relevant suites rerun.
These failures are not passing evidence; the final commands below are the gate.

- `pnpm typecheck`: passed during implementation.
- `cargo test --locked -p scenesparrow-infrastructure planning::tests`: 22 passed;
  two additional pure domain planning tests passed in the full workspace gate.
- `node --import tsx --test tests/unit/planning-autosave.test.mjs`: 7 passed.
- `node --test tests/unit/planning-visual.test.mjs`: passed actual PNG pixels and PDF raster.
- `node --test tests/integration/planning.test.mjs`: passed actual SDK path with
  selected scanned-PDF PNG, a global-model change behind a held draft response,
  frozen configuration, and exactly two outline/draft calls.
- `pnpm exec playwright test tests/e2e/planning.spec.ts`: passed topic/outline,
  multiline/manual structure, locale, complete draft/hints, undo and manual route.
- Final `pnpm check`: passed contracts, formatting, TypeScript, 56 Node tests,
  84 Rust tests (6 domain, 76 infrastructure, 2 service) and warning-denying Clippy.
- Final `pnpm build`: passed browser, desktop TypeScript and locked Cargo build.
  Vite reported its existing large-chunk warning (about 1.087 MB minified,
  338.69 KB gzip); this is not desktop packaging evidence.
- Final `pnpm test:integration`: 4 passed.
- Full `pnpm test:e2e`: 20 passed; 1 performance fixture intentionally skipped.
  A final targeted planning browser rerun also passed after the last evidence UI
  changes. No large-document performance re-baseline was run.

Screenshots are local ignored artifacts:
`.artifacts/planning-outline-zh.png` and `.artifacts/planning-draft.png`.
They are browser evidence, not native desktop evidence.

## Local timing observations

Linux 6.18.57 x86_64 cloud workspace on an AMD EPYC 9V74 host, cgroup CPU quota
4 equivalents (400000/100000), 32 GiB memory limit; Node 24.22.1, pnpm 11.25.0,
Cargo 1.100.0. The Rust local fixture uses one outline node, Unicode, no external evidence,
264-byte saved plan and 315-byte complete output, 20 iterations. Provider/network
work is excluded. One measured run (microseconds) reported save p50/p95
2,739/3,007; no-call preparation 2,704/2,887; complete result validation/application
6,247/6,758. These are small development observations, not target-platform or
large-document performance acceptance. The isolated final timing command passed.

## Limits and handoff

Real compatible endpoints, Windows/macOS credentials, native desktop lifecycle,
file dialogs, packaging and native RSS enforcement were not run. Search remains
unavailable. Linux sampled RSS and worker limits do not establish an OS sandbox.
S1's previously missed 500 KB/2 MB budgets remain deferred to step 8; this step does
not re-baseline or claim those budgets passed. Supporting result previews are
bounded; durable exact inputs/results and compact provenance remain core-owned.

## Independent root review

The root reviewed the final code, contracts, migration/dependencies, correction
tests and the two browser screenshots. The Chinese planning view preserves
multiline key points and manuscript language; the draft view renders the complete
marked body with evidence and verification hints in a separate panel.

After all implementation writes stopped, the root independently ran `pnpm check`
(56 Node tests; 6 domain, 76 infrastructure and 2 service Rust tests; contracts,
formatting, types and warnings-denied Clippy), `pnpm build`, all 4 integration
fixtures and all 20 active browser cases. All passed. The dedicated performance
case was skipped; the existing Vite bundle-size advisory remains. `pnpm peers check`
and `git diff --check` passed. Applied migrations 001–005 are unchanged.

No blocking finding remains for this code checkpoint. Real-provider/native and
large-document evidence remains open as described above. The implementation agent
performed no staging, commit, push, branch changes or additional delegation.
