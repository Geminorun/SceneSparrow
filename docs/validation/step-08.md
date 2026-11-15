# Step 8: manuscript delivery and acceptance evidence

Status: independently reviewed code checkpoint. Root checks, builds, integration
and browser gates passed. Interaction performance budgets remain failed; native
platform/provider acceptance and manual user acceptance remain open. This report
does not certify full stage readiness, a release or a merge.
Reviewed prerequisite: `219b4ce1ff3ff0fc322f721a0de8fd20a3b30649` on
`feat/script-workbench`.

The [acceptance matrix](acceptance-matrix.md) maps all 130 S1/S2/S3/S4/shared-AI
acceptance IDs individually, plus the separate S1 performance gate. Earlier
reviewed evidence remains linked; portable results do not establish target-host
or actual-provider readiness.

## Implemented delivery boundary

Migration 009 adds utility generation, exact control requests, temporary copy
preparations and external-delivery receipts. Applied migrations 001–008 remain
unchanged. These records are outside business undo and generic AI execution.

Current clients close and acknowledge typing groups before capture, then fence
visible input and composition again immediately before dispatch. Ordered body
IDs/revisions define `bodyHash`, independently of the global project sequence;
lock/comment-only changes do not create a new body identity. `expectedBodyHash`
is the current capture precondition; the earlier global sequence remains a
compatible fallback. Capture stores the exact immutable canonical body, current
project sequence and approved-baseline metadata, together with its generation
pin, job identity and event in one writer transaction. The worker verifies the
snapshot hash again before parsing it. Output generation runs outside SQL.

TXT, maintained Markdown AST writing and pinned DOCX generation traverse canonical
body nodes only. Review messages, candidates, source notes, locks, settings and
configuration are not serializer inputs. Genuine body-authored symbols/links and
Unicode remain. Independent Markdown/OOXML checks include literal syntax,
contiguous links, nested/restarted lists, marked code soft breaks, hyperlinks,
numbering/styles and privacy. Canonical-invalid C0 controls are rejected by all
formats. Canonical UTF-8 U+FFFE/U+FFFF remain in TXT/Markdown; DOCX rejects them
explicitly because XML cannot represent them. No body character is silently deleted. Text formats use UTF-8/LF and one terminal
LF. DOCX creator/last modifier is explicitly SceneSparrow; no fonts or OS-user
properties are imported.

One export generation runs per project, with four pending jobs. Attempts, explicit
retry and cancellation are fenced. A promotion intent precedes registration;
verified promoted files recover after restart. Ready output wins cancellation.
Generated files are intentional outputs retained independently of five-step
history. Failed/interrupted captured inputs have a ten-minute retained-retry
window; explicit recapture is a distinct request and retires the old input.
Compact request/snapshot identities survive input release. Expiry never removes
an intentional generated output.

Copy uses a separate ten-minute bounded preparation, not an export job or a
permanent file. Native clipboard consumes preparation identity/body hash; browser
permission/activation rejection retains text for a fresh copy or manual selection.
No export or copy requires AI configuration or makes a provider request.

## Platform and recovery boundary

Native main owns the selected destination as an operation-scoped capability;
renderer data contains job/artifact/delivery/preparation identities, never paths.
The named save operation combines native selection and commit within that scoped
main closure. It validates primary webContents, the loaded main frame, project
process, format and artifact. Each core activation rotates transport/native tokens,
so old in-flight requests cannot authorize writes against a switched project.

The separately injected file committer creates an exclusive same-directory temp,
flushes/closes it, reopens the same native identity, verifies stored bytes, and
checks parent/temp/target identity immediately before atomic finalization. It
never deletes or overwrites the old target in place. Detected replacements reject;
cleanup does not follow a replaced parent or substituted temp. External writers
can still race the final native check/rename; exclusive ownership of arbitrary
external destinations is not claimed. Actual Windows/macOS behavior is unrun.

Delivery intent is durable before external finalization. Acknowledged replay has
no second dialog/fetch/write. Lost acknowledgment after finalization is unknown;
public job/list metadata reports that uncertainty after restart. A separate explicit
check/reselect action uses the same ready artifact with new native consent. Browser
feedback distinguishes generated from download requested and never claims an OS
save. Replayed status events do not copy, download or invoke inference.

Trusted project selection inspects supported schemas without activation or queue
dispatch. Invalid/cancelled selections keep the current project. Activation failure
attempts to restore the previous owner and directory. Controlled close freezes
editor/forms through final flush/quiesce; cancellation/failure restores input.
Owning coordinators fence running work and reap utility/AI workers before the child
core is terminated. Known original undispatched AI work remains queued; copied
nonterminal work is interrupted, including queued work.

A shared backup helper takes a consistent SQLite/WAL snapshot, copies the exact
version-aware rooted object/registered-export inventory, verifies the source and
copied graph, and writes/fsyncs its completion manifest last. Unregistered human
files and corrupt unreferenced orphans remain untouched and are not declared part
of the backup. Restore verifies manifest completeness and graph before creating a
new copy, validates that copy before normal ownership/migration/reconciliation,
and syncs child/root/parent directories. It never replaces the original project.

## Performance experiment and changes

Environment: Linux x86_64, AMD EPYC 9V74 host model, four effective CPU equivalents
and 32 GiB cgroup limit. Node 24.22.1, pnpm 11.25.0, Rust 1.100.0 and Chromium
156.0.8078.79. Exact tool/OS output and final build labels will be recorded with the
completed gate.

The isolated before run uses a read-only Git archive of the reviewed prerequisite,
its own frozen/offline pnpm installation with workspace links inside the archive,
and a separate Cargo target. Only observational coarse storage counters/timers and
the deterministic fixture harness were added. The active checkout was not reverted.
No other builds/tests ran during this 9-minute measurement. It used 50 samples per
size, 500 short reviewed blocks plus four long paragraphs, supported lists/marks,
Chinese plus ASCII `x`/`z` body text, 500 comments and ten pending candidates from ten
counted actual-SDK localhost calls. This main comparison has **no attachments**;
source/2000-block/cold/Redo/export/resource supplements are recorded separately below.
Emoji/combining text is covered in correctness fixtures, not in this main latency body.

| Before debug fixture | Actual text bytes | Longest text block | Typing p50 / p95 | Save p50 / p95       | Undo p50 / p95       |
| -------------------- | ----------------- | ------------------ | ---------------- | -------------------- | -------------------- |
| 50 KB                | 53,440            | 11,300             | 18.5 / 27.6 ms   | 276.8 / 329.7 ms     | 393.6 / 494.6 ms     |
| 500 KB               | 503,440           | 123,800            | 35.6 / 46.4 ms   | 858.5 / 964.4 ms     | 690.0 / 889.1 ms     |
| 2 MB                 | 2,003,440         | 498,800            | 97.9 / 167.5 ms  | 1,446.0 / 1,533.8 ms | 1,993.6 / 2,458.6 ms |

The same debug fixture after optimization recorded 50 samples per size:

| After debug fixture | Typing p50 / p95 | Save p50 / p95     | Undo p50 / p95       |
| ------------------- | ---------------- | ------------------ | -------------------- |
| 50 KB               | 16.7 / 27.3 ms   | 266.0 / 308.9 ms   | 348.0 / 457.0 ms     |
| 500 KB              | 29.4 / 38.9 ms   | 398.3 / 901.0 ms   | 641.3 / 765.5 ms     |
| 2 MB                | 81.6 / 194.0 ms  | 988.6 / 1,549.8 ms | 1,824.4 / 2,086.1 ms |

Median 500 KB save improved from 858.5 to 398.3 ms, but the save and undo tail
budgets still fail. The 2 MB typing p95 worsened from 167.5 to 194.0 ms despite
an improved median. This is a measured limitation, not a performance acceptance
pass. The comparable harness reports sample counts and order-statistic quantiles;
its per-sample browser latency arrays were not retained and cannot be recovered.
The separate supplemental harness retains raw arrays and Redo timings.

Ignored raw artifacts are `.artifacts/step-08-before-50.json`, its `.log`, and
`step-08-before-50-phases.json` (1,105 parsed storage rows), plus
`step-08-after-debug-50.json`, `.log` and `-phases.json` (955 parsed rows).
The compact group-close fast path bypasses the full body operation phase logger,
so the reduced row count is not a lost body transition.

The separate optimized-core/production-UI run used the same main fixture and
50 samples per operation. It is a build-profile comparison, not the same-build
optimization attribution:

| Release core + production UI | Typing p50 / p95 | Save p50 / p95   | Undo p50 / p95   |
| ---------------------------- | ---------------- | ---------------- | ---------------- |
| 50 KB                        | 7.1 / 17.0 ms    | 101.8 / 128.9 ms | 160.3 / 184.7 ms |
| 500 KB                       | 20.6 / 27.9 ms   | 109.2 / 144.5 ms | 223.5 / 292.7 ms |
| 2 MB                         | 62.8 / 87.4 ms   | 193.5 / 263.4 ms | 431.1 / 544.5 ms |

500 KB typing and save meet their budgets; 500 KB Undo misses 150 ms. The 2 MB
50 ms typing, 250 ms save and 500 ms Undo p95 budgets all miss. These failures
remain open performance limitations. The measured binary SHA-256 is retained in
`.artifacts/step-08-release-core.sha256`, with the report/log at
`step-08-release-production-50.json`/`.log`. All three main fixture hashes, text
bytes, JSON sizes and block shapes match. The production UI was built by its
normal Vite production build and served by preview; it is not a packaged desktop.
RSS is a positive live
PID sample per size, not peak/PSS; Chromium sums would double-count shared pages.
The phase clocks are coarse: they exclude mutex wait, envelope digest/receipt
lookup and service encoding/network/browser work. Domain-transition includes
history reads; immutable-objects includes serialization/hash/fsync. Counters cover
instrumented object reads, not all kernel I/O. Core-versus-browser differences
include transport, other reads, reconciliation and layout, not exclusively DOM.

Changes under validation include immutable ProseMirror-node projection/count caches,
indexed ID diff/restore/acknowledgment, bounded operation-local verified object reuse,
reuse/reverification of unchanged payloads, compact metadata-only group closing,
and exact checked canonical diff transactions that preserve unchanged DOM subtrees.
The Review post-canonical microtask remains. Late input/IME is fenced through the
last history metadata await. Cheap ordered-body identity reads and coalesced,
owned-task Planning refresh eliminate the unchanged manuscript-resync/source-refresh
path. Planning task previews still read retained result objects; this is not a
universal constant-cost metadata path.

HTTP subscribers now share one refcounted project stream with exception-isolated
fanout, resync and reader/listener cleanup. Planning mounts only in Outline; Draft
has App/Review/Locks/Sources (four baseline consumers), with Export adding a fifth
only for an active job. An inevitable six-stream deadlock was not reproduced.

## Supplemental measurements

The separate release/production supplement uses 2,004 blocks (2,000 short blocks
plus four long paragraphs), 529,900 body text bytes, 500 comments and ten pending
candidates. Ten samples per operation retain raw latency arrays, Redo and a
pre-measurement content-only SHA-256
`603e47a4e881c7ca762edfe36eaf86eb0e3123732063969f4c33fe8746276a72`.
Typing/save/Undo/Redo p95 were 62.0/318.6/621.0/550.6 ms. This harder shape misses
those interaction budgets; it is separate from the comparable 504-block main run.

Associated sources are a 6,029,312-byte TXT retained as original file bytes
(summary status `interrupted`, no extraction requested) and 36-byte Markdown,
569-byte DOCX and 598-byte PDF independently extracted to `ready`. Exact source
hashes and readiness states are in `.artifacts/step-08-release-2000-sources-10.json`.
The setup timer including sources covers upload and the three explicit extractions.

| 529,900-byte / 2,004-block generation | Samples | p50      | p95      |
| ------------------------------------- | ------- | -------- | -------- |
| TXT                                   | 10      | 211.8 ms | 263.3 ms |
| Markdown                              | 10      | 245.4 ms | 299.8 ms |
| DOCX                                  | 10      | 380.3 ms | 488.4 ms |

Generation includes capture, queue/worker work and 10 ms status polling; it excludes
external save/download. These near-500-KB generation observations meet the initial
1 s text / 3 s DOCX budgets. They do not establish target Word or filesystem behavior.

After latency and export samples, separate 3.5-second Draft windows observed zero
non-SSE GET requests/response bytes when idle after a drain interval and while an
unrelated review question was confirmed `running` behind a provider barrier. This
is traffic evidence, not typing latency under active work. Planning is unmounted in
Draft, so this does not validate Outline idle/owned-task polling behavior, which
remains `not_run` as a measured traffic scenario. Avoidance of unchanged full
manuscript/source refresh does not make all Planning task metadata reads constant
cost; retained result previews can still be read.

Positive live core RSS samples (not peaks/PSS) for 50/500/2,000 KB were
40,440/51,288/94,436 KiB before, 37,204/63,464/123,952 KiB after in debug, and
33,312/50,396/86,160 KiB in release. The 2,004-block/source supplement sampled
90,448 KiB. Debug resident memory increased at the larger sizes; operation-local
cache release does not force the allocator to return pages to the OS. Browser,
worker and coordinator live PID samples are retained separately in each artifact;
summing Chromium RSS would double-count shared pages. Native platform peak/RSS
measurements remain `not_run`.

The matching debug attachment pair uses 503,400 text bytes / 504 blocks, ten
samples and four unextracted files with matching hashes. P95 typing/save/Undo
before → after was 77.8 → 68.0 ms / 1,949.3 → 1,912.1 ms / 1,053.1 → 795.4 ms.
Median save was effectively unchanged (909.7 → 909.6 ms). Coarse Undo median
verified-object read/hash volume fell from 21.53 MB to 8.70 MB and operation time
from 625.8 to 381.0 ms. Edit read/hash volume remains 7.93 MB and time
419.7 → 384.2 ms: each body write still verifies the referenced 6 MB source file.
Operation-local deduplication removes repeated verification inside a transition;
it does not eliminate this remaining per-write source cost. These attachment
interaction budgets **fail**. Raw reports/logs and parsed phases use
`step-08-before-sources-10` / `step-08-after-sources-10` artifact prefixes.

Twenty new release-core processes reopened the existing 2 MB / 504-block main
fixture with the OS page cache retained. A 5 ms health polling loop measured
health readiness p50/p95 248.1/587.2 ms and readiness plus manuscript/history/first
review page/export-list reads 297.7/641.9 ms. This measures repeated startup and
stability against the first reopened state, not a pre-close/full-review/finalization
recovery proof. Separate recovery fixtures provide correctness evidence. Core
RSS samples p50/p95 were 39,580/39,716 KiB. Directory totals after these starts were
543 object files / 17,794,323 bytes, SQLite 1,970,176 bytes, and zero export/staging
files; no WAL remained when accounting ran. These are directory/SQLite totals,
not root-live/prunable accounting or a whole-project size bound. Existing bounded
history tests verify five transitions and six snapshot references independently.
The full raw startup samples and build hash are in
`.artifacts/step-08-cold-reopen.json`.

## Repeatable commands

Every shell first sources `scripts/cloud-env.sh`. The comparable current debug run:

```sh
SCENESPARROW_PROFILE_WRITES=1 SCENESPARROW_REVIEW_PERFORMANCE=1 \
SCENESPARROW_PERF_LABEL=step-08-after-debug-50 \
SCENESPARROW_PERF_PID_FILE=/tmp/step08-debug-pids.json \
pnpm exec playwright test tests/e2e/review-performance.spec.ts
```

The main release run used `cargo build --release -p scenesparrow-service --locked`
and this command (the pnpm script supplies `npm_execpath` for the production build):

```sh
SCENESPARROW_CORE_PROFILE=release SCENESPARROW_PRODUCTION_UI=1 \
SCENESPARROW_PROFILE_WRITES=1 SCENESPARROW_REVIEW_PERFORMANCE=1 \
SCENESPARROW_PERF_LABEL=step-08-release-production-50 \
SCENESPARROW_PERF_PID_FILE=/tmp/step08-release-pids.json \
pnpm test:e2e tests/e2e/review-performance.spec.ts
```

Measured release core SHA-256:
`c9e858314f5e1a6e3ff5ddcbe487e831b72f86848d229087a400ab059a06b8ee`.
The supplementary command adds the explicit smaller sample count and shape:

```sh
SCENESPARROW_CORE_PROFILE=release SCENESPARROW_PRODUCTION_UI=1 \
SCENESPARROW_PROFILE_WRITES=1 SCENESPARROW_DELIVERY_PERFORMANCE=1 \
SCENESPARROW_PERF_SHORT_BLOCKS=2000 SCENESPARROW_PERF_SAMPLES=10 \
SCENESPARROW_PERF_SIZES=500000 SCENESPARROW_PERF_SOURCES=1 \
SCENESPARROW_PERF_LABEL=step-08-release-2000-sources-10 \
SCENESPARROW_PERF_PID_FILE=/tmp/step08-supp-pids.json \
pnpm test:e2e tests/e2e/delivery-performance.spec.ts
```

The historical before run requires the reviewed base archive **plus** its
observational storage instrumentation, this exact harness and the launcher/PID
support files. Their local hashes are retained in
`.artifacts/step-08-baseline-method-files.json` (operation/manuscript/documents/lib,
launcher, Vite configuration and harness). The observed baseline executable SHA-256
is `923e2934c3ef2dcfd32b912a5b4af820583de48371227d7b8efe1c238c993c4e`.
It cannot be reproduced by checking out the base alone. The local
archive path is recorded in `.artifacts/step-08-baseline-path.txt`; it has its own
frozen/offline dependencies and isolated Cargo target, never current workspace
package links. The before-source supplement uses that archive, its original
compatible review harness, `CARGO_TARGET_DIR=/tmp/scenesparrow-step08-baseline-target`
and `SCENESPARROW_CORE_BIN=/tmp/scenesparrow-step08-baseline-target/debug/scenesparrow-service`.
Source-pair runs add `SCENESPARROW_PERF_SAMPLES=10`,
`SCENESPARROW_PERF_SIZES=500000`, `SCENESPARROW_PERF_SOURCES=1` to the debug
command, with before/after labels. They keep all four attachments unextracted to
match each other, unlike the three extracted small files in the release supplement.

The repeated-start command used the completed main fixture at its recorded local
path (a fresh run produces a new fixture path):

```sh
SCENESPARROW_CORE_PROFILE=release SCENESPARROW_REOPEN_SAMPLES=20 \
node tests/performance/reopen.mjs .local/e2e-1794752840511
```

## Commands and current evidence

All shells source `scripts/cloud-env.sh`. No Git staging/commit/push/branch/worktree
operation, delegation, real/paid provider call, publishing, merge or release was
performed by the implementation writer.

Passing intermediate checks include focused export/storage/backup upgrades,
queued-AI copied-origin fencing, native file/delivery/clipboard/activation contracts,
serializer/SSE tests, the offline actual-core recovered-copy workflow and both
browser delivery cases. New actual running-worker barriers cover capture/edit/GC,
cancel-versus-finish, rename and directory-flush failures, startup deadline and
sampled Linux memory killing. Native tests cover temp/target/parent substitution,
post-close metadata publication, already-signalled and failed-spawn core lifecycle,
and nonce-scoped cancellation. A recovered copy preserves the exact pending
candidate after history rebinding, independent lock, middle cursor, history root
hashes and entry IDs. The composed actual-core workflow now reaches question,
individual and batch acceptance, locks, copy/all formats and cold reopen in one
project with six counted SDK calls; two actual cores share global configuration
and independently enforce one active/eight pending. A rejected queue-full request
now leaves the external origin watermark unchanged until validation succeeds. A pre-supplement workspace Rust checkpoint passed 12 domain,
128 infrastructure and two service tests. Later focused tests add more coverage;
those counts are not the final tree gate.

Development failures were corrected or are still being verified: Markdown emphasis
edge whitespace, mixed DOCX numbering, empty DOCX comment parts versus actual
comment content, legacy fixture schema reconstruction, clipboard/preparation versus
permanent export ownership, stored ID/path validation, native temp/parent/acknowledgment
races, late history-GET input, an IME mock coupled to premature client adoption, and
an asynchronous crypto test barrier. Final style checks found three unformatted
files; TypeScript also required preserving the narrowed accepted-close nonce
before clearing it. Those fixes do not alter behavior. Performance-launch setup
needed the pnpm script environment; supplemental harness mistakes (readiness
without extraction, a paged review lookup and an overbroad edit) were corrected
before counting a complete successful measurement. New browser controls also required exact status
selectors and test ordering/visible-selection setup. Failed attempts are not passing
evidence.

Writer final-tree validation:

| Command / scope                                                           | Actual outcome                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                              | Contracts, formatting, TypeScript, 99 Node tests and 157 Rust tests passed; the pipeline then found two Clippy style warnings. Those equivalent guard rewrites were fixed and Clippy was rerun separately. The entire command was not rerun after these lint-only changes; root subsequently reran the complete command successfully, as recorded below. |
| `cargo test --workspace --locked` within that pipeline                    | Passed: 12 domain, 143 infrastructure, two service tests (157 total).                                                                                                                                                                                                                                                                                    |
| `cargo test -p scenesparrow-infrastructure exports::` after lint rewrites | Passed: all 15 export/core/worker/backup fault tests.                                                                                                                                                                                                                                                                                                    |
| `cargo clippy --workspace --all-targets --locked -- -D warnings`          | Passed on the final runtime source.                                                                                                                                                                                                                                                                                                                      |
| `node --test tests/unit/export-serializers.test.mjs`                      | Passed: six independent serializer tests, including canonical noncharacters and DOCX XML rejection. Also included in the 99-test Node pass.                                                                                                                                                                                                              |
| Native injected contracts                                                 | File/delivery/clipboard/activation cases passed; final signal/failed-spawn/nonce subset passed six tests. Included in the full Node pass. Real Electron/Windows/macOS execution remains unrun.                                                                                                                                                           |
| Standalone integration workflows                                          | Offline recovered copy, composed six-call planning/review/delivery and two-core shared configuration/queue fixtures passed. Latest full integration suite is reserved for root.                                                                                                                                                                          |
| Targeted browser delivery                                                 | All three passed, including failed save, lost capture/control receipts, denial/download fallback, heading-only/empty, locale/keyboard and injected native unknown-receipt reselection. Earlier editor/review targeted pass remains intermediate evidence.                                                                                                |
| `pnpm peers check`                                                        | Passed: no peer dependency issues.                                                                                                                                                                                                                                                                                                                       |
| `git diff --check`                                                        | Passed; applied migrations 001–008 have no edits.                                                                                                                                                                                                                                                                                                        |
| Latest full `pnpm build`, `pnpm test:integration`, `pnpm test:e2e`        | `not_run` by writer on this final tree, by explicit root coordination to avoid duplicating its required independent gates. Optimized core and production web builds used for measurements passed.                                                                                                                                                        |

The first final-check attempt found three formatting issues and the close nonce
TypeScript narrowing issue. A subsequent full test run found the old origin-ahead
regression expectation: it assumed ordinary rejection advanced the external fence.
The corrected test proves rejection preserves known queued work and separately
simulates a durable external fence ahead of SQL to preserve conservative restart
coverage. The next full test pass then exposed the two Clippy style warnings above.
These failed attempts are recorded separately from passing reruns.

No media changed, so a render rerun is not required. Real providers, target Word opening,
Windows/macOS vaults/IME/dialogs/filesystems/lifecycle/RSS, packaged worker shipping,
installers and manual user acceptance remain `not_run`.

## Independent root review and final gate

Root reviewed the final contracts, migration, serialization, capture/copy/delivery
boundaries, retained recovery graph, lifecycle changes and performance evidence,
together with the read-only core, native, UI, performance and evidence audits.
All blocking findings were corrected and source-reviewed. Root aligned overview
and spec status, repaired the case-to-test citations and verified all 130 unique
original acceptance IDs. Applied migrations 001–008 have no edits; 009 is the new
delivery migration.

Root independently ran the following on the corrected implementation:

- `pnpm check`: passed contracts, formatting, TypeScript, 99 Node tests, 157 Rust
  tests (12 domain, 143 infrastructure, two service) and warnings-denied Clippy.
- `pnpm build`: passed web production, desktop TypeScript and locked Rust builds.
  Vite retains its existing large-chunk advisory.
- `pnpm test:integration`: seven passed, including the offline recovered-copy
  workflow, composed six-call SDK workflow and actual two-core queue/settings case.
- `pnpm test:e2e`: 24 passed; three dedicated performance fixtures intentionally
  skipped in the ordinary browser suite. The writer's explicit measurements are
  recorded above; the skip does not turn failed budgets into passing acceptance.
- `pnpm peers check` and `git diff --check`: passed.

Root added wide/narrow export screenshots to the existing browser fixture. Visual
inspection found intrinsic recent-file select width overflowing the narrow panel;
root bounded export selects and placed labels on their own line. Root also made
the heading-only keyboard case wait for the exact newly captured job, selected UI
identity and ready state, and verify that artifact's body, before taking the narrow
capture. The test asserts the select stays inside the panel. These small layout
and test integration changes received a read-only UI review, formatting checks,
a repeated full build and a repeated three-case delivery browser run; all passed.
No further runtime changes followed. Root inspected the final captures at
`.artifacts/export-wide.png` and `.artifacts/export-narrow.png`.

Root independently compared the raw main measurement summaries: fixture hashes,
text/JSON byte counts and block counts match across the baseline, debug-after and
release runs. Root also inspected the source, short-block and 20-start supplements.
Performance measurements were run by the writer and were not repeated by root.
The failed budgets, per-write source verification cost, quantile-only main data
and platform/provider limits remain as recorded above.

Root logs are `/tmp/scenesparrow-step08-root-check.log`, `-build.log`,
`-integration.log`, `-browser.log`, `-final-build.log` and `-delivery.log`.
The code checkpoint passes review for the feature branch. Full S1–S4/shared-AI
acceptance remains open where the matrix records failed or unrun cases.
