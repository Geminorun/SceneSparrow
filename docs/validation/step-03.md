# Step 3: sources, document utilities and manuscript import

Implementation evidence for `S1-T09`–`S1-T13` and deferred `S1-T05` import entry,
following [step 1](step-01.md) and [step 2](step-02.md), based on
`05e568a3a297857352324c2c5588f5864b3d81b0` on `feat/script-workbench`.
Root code review passed on 2026-11-15. This delivery supplies the manual
source/import code path; it does not claim full S1 platform or performance acceptance.

## Behavior and decisions

References and manuscript imports are separate actions. Link references retain
submitted HTTP/HTTPS metadata with `link_only` evidence and never fetch a page.
Validated external opening is a named platform operation. File references copy
original bytes into the project through a 25 MiB streamed intake with an opaque
identity, verified SHA-256, complete-object promotion and explicit membership
command. Browser upload reports progress and supports cancellation; desktop main
owns file selection/copy and exposes scoped selection cancellation/progress without
returning paths to the renderer. Cancelling an intent queued behind autosave is
fenced immediately before dispatch. Once dispatch begins the UI stops offering
cancellation of the business mutation. Ambiguous commands keep their original
request and required intake until reconciliation.

`workers/document` is a non-AI Node utility with a versioned closed protocol,
60-second wall limit, bounded output, 384 MiB V8 old-space setting and a sampled
512 MiB Linux RSS limit. The core permits one utility process at a time and at most
16 queued/running jobs. The environment excludes the service token and other
unlisted environment variables. Child cleanup kills/reaps the process on errors;
cancellation/removal/reopen increments attempt fences. This is process supervision,
not full OS isolation. Linux tests exercise actual child timeout, RSS termination
and running cancellation. Windows/macOS RSS enforcement remains unimplemented;
the V8 setting alone does not establish the full working-memory budget there.

Pinned parsers are `mdast-util-from-markdown` 2.0.2, `fast-xml-parser` 5.3.6,
`yauzl` 3.2.0 and `pdfjs-dist` 5.4.624. TXT uses fatal UTF-8/BOM UTF-16 decoding.
Markdown uses an AST, supported headings/lists/marks/links, first-definition
resolution and explicit fallback warnings; raw HTML is ignored and image URLs are
metadata only. DOCX checks actual decompressed bytes against 100 MiB, entry sizes
and CRCs, rejects DTD/entity declarations, validates strict XML encoding, and maps
paragraphs/headings/basic numbering/direct marks. Unsupported styles and layout
become plain text with warnings. PDF extracts page-order text/page references,
identifies images and pages without text, warns about layout, and distinguishes
encrypted/unreadable files. Scanned files remain usable references with
`SOURCE_TEXT_UNAVAILABLE`; they cannot become empty successful imports. No parser
resolves external resources, executes document code, performs OCR or interprets images.

Paste/file preparation preserves body/history and returns a preview, warnings,
parser provenance and candidate hash. Core canonical limits are checked before a
candidate becomes importable and again at commit. Start/append/replace allocate
fresh block IDs, apply the current mutation policy and create one history entry.
Stale previews reject; cancel/empty/error paths preserve accepted text. Import
provenance retains original input and parsed results independently of external
files. Receipt replay and undo/redo never rerun the parser.

Migration `004_sources_import.sql` appends to immutable 001–003. Business roots
version 2 add source membership, while the closed version-1 decoder preserves the
meaning and original bytes of old roots. A new transition reuses its verified
retained cursor endpoint, preserving adjacency and the six-root limit across an
upgrade/branch. Source identities share the permanent high-water ledger; extraction
status is outside business snapshots. Redo reuses retained valid text, otherwise
shows interrupted status until an explicit retry. Reopen verifies retained objects,
fences ambiguous work, cancels abandoned previews/intakes and reconciles generated
staging files. Pre-upgrade backups own separately verified pinned object copies.

Authenticated fetch SSE and the named desktop subscription replay monotonic events,
deduplicate client delivery and request snapshot resync for an expired cursor.
Resync rechecks local input after asynchronous reads and never overwrites newer
valid/invalid/composing input. Source reads fence older overlapping responses.
Replay is read-only and never invokes commands, uploads or parsers.

The collector captures roots and prunes metadata under the same writer coordinator
as promotion/commit. Only after that transaction commits does it unlink unreferenced
objects. Roots cover current content/sources, six business roots, completed intakes,
active preparations/extractions, imported-block provenance and explicit external
artifact pins. Identity high-water records and lifetime receipts survive pruning.
Collection runs on reopen with a 60-second grace period; the tested explicit port
also supports coordinated collection. Backup directories are never traversed.

## Acceptance evidence

| Task / cases                                | Concrete evidence and boundary                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T09; AC10, AC13                             | Core source/history tests, actual streamed HTTP overflow and independent desktop copy, browser link/file source flow, scoped preload/main operations and validated external URLs. Native dialogs remain unrun.                                                                                                                                                 |
| T10; AC02, AC11, AC16                       | Seven parser cases and real utility integration cover UTF-8/UTF-16, Markdown AST/reference images, DOCX headings/marks/numbering/entities/CRC/expanded limit, PDF ordered/encrypted/scanned/mixed/corrupt files, actual supervisor limits, cancellation and attempt fencing.                                                                                   |
| T11/T05; AC01, AC03, AC09, AC11, AC12, AC17 | Start/stage undo, append/replace/fresh IDs, cancellation/staleness, duplicate receipt, retained provenance, no parser replay, canonical failure, injected policy and commit fault tests. Two maximum-block documents can replace in one import.                                                                                                                |
| T12; AC04, AC12–AC16, AC18                  | Real v3 upgrade preserves old bytes/cursor/redo and immediately reopens after its first v4 mutation; failed 004 retry preserves a referenced backup. GC pin/prune, preparation promotion race, metadata-before-unlink fault, missing-reference recovery, source late-output fencing, authenticated SSE and client reconnect/dedup/resync regressions pass.     |
| T13; AC05–AC09                              | Existing editor/IME-event/history/close recovery regressions remain in the full gate. New browser cases cover actual file intake/preview, stale/scanned rejection, cancellation after completed upload while autosave is held, and uncertain file command retry with the same identity/intake. Native IME, target OS close and abrupt power-loss remain unrun. |

Self-authored fixtures in `tests/fixtures/documents.mjs` are CC0 and contain no user
or third-party document content. Tests are in `crates/infrastructure/src/documents_tests.rs`,
`crates/domain/src/manuscript.rs`, `tests/unit/document-parser.test.mjs`,
`tests/unit/events.test.mjs`, the existing autosave/desktop suites,
`tests/integration/documents.test.mjs` and `tests/e2e/sources.spec.ts`.

The final production-source gate passed `pnpm check` (contract drift, formatting,
workspace types, 36 Node tests, 4 domain / 42 infrastructure / 1 service tests and
warnings-denied Clippy), `pnpm build`, and both `pnpm test:integration` process
cases. The new five-case browser source/import suite also passed, including the
deterministic queued cancellation and uncertain file command retry. The existing
controlled-close browser fixture was then updated to the current named desktop
bridge contract; the final complete browser/format/peer/diff outcomes are recorded
in the implementation handoff and independently reviewed by root. No production
source changed for that fixture correction.

## Root review and verification

Root independently ran these checks after all subagent writes stopped:

| Root command                           | Outcome                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                           | Passed: contracts, formatting, workspace types, 36 Node tests, 4 domain/42 infrastructure/1 service Rust tests and Clippy |
| `pnpm build`                           | Passed: browser, desktop and Rust; existing bundle-size advisory remains                                                  |
| `pnpm test:integration`                | Passed: both actual process fixtures                                                                                      |
| `pnpm test:e2e`                        | Passed: 18 active cases in 1.0 minute; the dedicated performance case is skipped in this normal run                       |
| `pnpm peers check`, `git diff --check` | Passed                                                                                                                    |

Root inspected the actual performance JSON and bilingual sources screenshot.
Final integration localizes the desktop document filter and bounds aborted-intake
cleanup requests to ten seconds so their file handles can be released. These
changes preceded all root checks above. Read-only parser, storage and client
audits were resolved, including mixed-version history adjacency, safe XML and
Markdown interpretation, pretransaction provenance preparation, synchronized
resync/cancellation and immutable uncertain-command reconciliation.

## Linux measurements and open budgets

`pnpm perf:s1` runs the committed Playwright harness in
`tests/e2e/performance.spec.ts`. The completed warm run took 1.6 minutes, with ten
samples per fixture. It uses synthetic Playwright keyboard input captured from
`keydown` to the next animation frame; this is a browser rendering proxy, not
human input/IME latency. Flush measures blur-to-saved, excluding the normal debounce;
undo measures click-to-redo-available, including receipt/canonical reconciliation.
The harness waits for undo/redo HTTP acknowledgments before issuing later input.

Environment: Linux 6.18.57 x86_64, five visible AMD EPYC 9V74 vCPUs, Node 24.22.1,
Rust 1.100.0 debug core, Vite development server, system Chromium 156.0.8078.79.
The same browser/core stays warm between fixtures. Values are observations of this
cloud environment, not release guarantees.

| Plain-text fixture / blocks | Keydown→frame p50 / p95 ms | Blur→saved p50 / p95 ms | Undo p50 / p95 ms   |
| --------------------------- | -------------------------- | ----------------------- | ------------------- |
| 49,998 bytes / 50           | 6.20 / 14.20               | 101.86 / 115.84         | 108.78 / 133.27     |
| 499,998 bytes / 500         | 17.40 / 22.60              | 332.82 / 375.97         | 590.27 / 662.30     |
| 1,999,998 bytes / 2,000     | 50.30 / 83.80              | 1,402.11 / 1,432.23     | 2,545.08 / 2,733.27 |

The 500 KB/2 MB save and undo budgets are missed; the largest typing proxy also
misses the 50 ms target. Code-path inspection identifies full canonical cloning and
serialization, repeated per-block immutable-object reads/verification, linear
searches inside per-block diff loops, complete block-row rewrites and client
canonical reloads. A one-block mutation in the 2,000-block fixture still verifies
and processes all 2,000 block payloads; undo additionally reloads the canonical
state in the client. These are inspected work counts, not a sampled CPU profile.
S4 must profile and optimize these paths before claiming the budgets; this delivery
keeps durability/history semantics and introduces no CRDT/delta redesign.

Sampled core RSS was 12.1 / 27.6 / 75.5 MB, Chromium process RSS sums were
734.5 / 888.0 / 1,056.6 MB, and the separate Playwright test runner was
311.2 / 338.4 / 342.2 MB. These are post-fixture RSS samples, not peaks or unique
physical-memory totals; Vite, Electron and already-exited document workers are
outside that sum. DB-mentioned immutable payloads before collection occupied
0.60 / 6.15 / 25.67 MB; these include prunable provenance rows. A separate
root walk of the final 2 MB project found six business roots, 2,009 retained
objects and 23,962,644 bytes. Total object-directory bytes before collection were
2.59 / 28.17 / 130.37 MB, showing the grace/reopen collection boundary. There are
no AI tool contexts or provider calls in this workflow. Raw metrics and the
bilingual screenshot remain ignored artifacts under `.artifacts/`.

Windows/macOS native dialogs, Unicode filesystem/locking/close behavior, installed
IME, complete RSS enforcement, abrupt power-loss and full release/performance
acceptance remain `not_run` or open. Linux/browser evidence does not close them.
