# Step 6: anchored review, answers and candidate decisions

Implementation evidence for `S3-T01`–`S3-T08`, following
[step 5](step-05.md), on `feat/script-workbench` based on
`03fc75ff74708f56702607fd907094141d21cd84`.
Independent root review and the root's final gate passed. This checkpoint
is not full S3, SAI-T14/15, native-platform or production-provider acceptance.
Production user locks/finalization belong to step 7; export belongs to step 8.

## Behavior and boundaries

Drafts expose exactly Question and Revision note actions, including a selection
context toolbar, whole-block fallback, adjacent cards, a handled/orphan/offscreen
list, comparison pages and a narrow-window layout. Saving a comment or follow-up
never starts inference. Explicit Ask AI/Generate change freezes the saved request,
manuscript language, chosen conversation messages, selected evidence and global
text configuration. Manual/imported drafts need no topic, outline or prior AI draft.
Links remain `link_only`; file excerpt and visual choices reuse the Rust script
manifest builder and existing local document/visual utility. No crawling, project
AI override, provider fallback, automatic paid retry or output repair was added.

Questions produce only bounded plain-text answers with checked evidence references.
Answers retain their own run/request identity. A failed or running regeneration
leaves the previous successful answer accessible under that answer's identity.
User messages have business-visible membership; AI messages/results are asynchronous
state outside snapshots. Restored requests use a fresh monotonic request token and
an explicit original user-message association, preserving historical labels.

Revision output is a closed version-1 `replace_ranges` or `fill_section` object with
bounded explanation metadata. The explanation never enters the body. The core
materializes text runs, preserves all outside content/marks/kinds/IDs, and validates
the resulting actual change. Filling is restricted to an explicitly selected empty
heading slot with exact neighboring boundaries; new block IDs are assigned once
and the group is indivisible. Existing nested list fragments validate their run
payload without pretending the fragment is a standalone list; final acceptance
normalizes the complete current manuscript. Invalid inserted list structure is
rejected before candidate projection.

Revision start atomically creates the generic run/binding, whole-block or slot
claim, scoped task-use reservations, receipt and event. Questions reserve no body.
Another note can always be saved; conflicting generation cannot steal the claim.
Same-request failure/typed `NO_CHANGE` preserves an applicable previous candidate.
Changed instructions immediately stale it. Cancellation fences the old attempt;
deleting a thread with a candidate requires the explicit discard flag. Discard
while regeneration is active requires cancellation or completion.

Individual and exact-set batch acceptance validate candidate/version, request/run,
immutable input/output, actual scope and diff, current target/evidence/adjacency
and insertion-slot tokens, live claims, task use and the injected mutation policy.
Each candidate is checked against the same pre-accept body. Conflicts identify
submitted candidate IDs/versions and safe reasons; no member is silently skipped
and later arrivals are not included. Prepared body, decision, handled state,
comparison cleanup, claim release, one history transition, receipt and events commit
together. Acceptance does not lock content. The production lock policy/UI is not
installed in this step; injected policy protection remains effective at commit.

One comparison slot exists per block. A pending/stale candidate occupies it;
manual changes retain only the latest source pair behind that overlay. Discarding
or replacing the candidate releases its overlay without erasing a pair still needed
by an active thread. Handling the last referencing comment clears the source pair.
There is no manuscript comparison version browser.

## Anchors, storage and execution

Selection capture occurs synchronously before asynchronous settlement. The adapter
pairs the actual S1 canonical textblock order with ProseMirror positions, including
nested list items and soft breaks; it does not guess an identity from arbitrary
ancestor attributes. UTF-16 offsets and global grapheme boundaries are checked in
Rust. Slicing marked runs uses scalar boundaries after global grapheme validation,
including regional-indicator flags, ZWJ and combining sequences crossing mark runs.
Decorations are transient plugin state, never persisted marks. Unsaved transactions
map existing decorations; saved projection/revision checks and a transaction-fenced
reconciliation restore them after canonical replacement. Loaded-page geometry reads
do not serialize every review thread on each keystroke.

The full-run S1 edit envelope does not prove every character operation. Mapping is
therefore conservative: unique outside splices and proven adjacent split/merge
identity are mapped; ambiguous repeated text, multiple changed spans, reordered or
merged ranges that cannot remain valid become `source_changed`/`orphaned`. There
is no quote-search relocation. Current-request quotes are preserved exactly.

Migration `007_review.sql` appends to unchanged migrations 001–006. A five-row
history-entry identity side table binds decisions to actual retained entries across
cursor moves, typing-group extension and branch replacement; content hashes and
chronological decision order are not used as history-membership proof. The existing
unique, verified and fsynced SQLite/object backup procedure is reused. Business
snapshot version 4 adds compact review user state and message visibility; v1–v3
objects decode compatibly without rewriting their bytes. Answers, task execution,
reservations and candidate artifacts stay outside business snapshots, so arrival
creates no history entry, clears no redo tail and resurrects no task.

Quotes above 1 KiB are deduplicated immutable UTF-8 objects referenced by `quoteHash`;
SQL and business snapshots carry the reference, and bounded reads/task preparation
hydrate exact text. Candidate/context/source-pair payloads are immutable objects.
Current state, retained history, decision manifests bound to actual retained history-entry identities, tasks,
answer provenance and comparisons root
needed objects. Pruning clears superseded unreferenced candidate/context/input/
output payload roots and deleted message text while retaining compact identities,
receipts and outcomes. Physical collection follows the shared collector's grace
period. Current/history review visual choices also root the shared script visual
preparation metadata, so preview expiry does not invalidate unchanged review evidence. Referenced-object verification remains part of reopen/collection.

Preparation and object verification precede short SQL transactions. Start and
acceptance recheck compact SQL request/content/source/extraction/visual/adjacency/
slot tokens at commit. Generic results persist first and review projection applies
once locally; reopening never needs another provider request to apply a saved
result. Cancellation/deletion/instruction changes that fence execution advance the
same anti-restore origin watermark in their transaction. Status/GET queries enqueue
no work. Explicit retry creates a new run with current inputs/configuration and
validated `retryOfRunId` lineage.

Engineering ceilings are 2,000 active threads, 16 KiB user/answer text, 100 selected
blocks, 100 groups per acceptance, 200 retained messages per thread, and at most 20
explicitly selected messages/64 KiB per AI context. Reaching a message ceiling
rejects a new append instead of silently trimming user text; a no-op save still
succeeds. Thread lists have at most 40 cards and an 8 MiB response budget. Candidate
and source-pair previews are bounded. Candidate detail pages target 1 MiB, allowing
one canonical block up to the existing 4 MiB document ceiling; source detail is one
bounded before/after block pair. These are engineering bounds, not performance
measurements.

The UI retains exact pending command identity across uncertain receipts, including
pre-dispatch double submissions. Known business rejection is distinct from a
proven receipt followed by local reconciliation failure. New body input, IME,
comment generations and changed selections survive late acknowledgments. A known
blocked history operation produces an operation tip and permits an explicit task
cancel without clearing a real body/conversion error.

## Task and acceptance evidence

| Task   | Evidence and acceptance scope                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3-T01 | Generated closed schemas, request/candidate/message/answer/detail contracts, Unicode and malicious-output domain cases; AC01/02/06. User-lock schema/commands follow in step 7.                                       |
| S3-T02 | Migration 007, unique claims, immutable quote/context/candidate/source evidence, compact decisions, transactional fault and pruning tests; AC03/23/24 partial. Approved baseline/downstream retention remains step 7. |
| S3-T03 | Unicode/marked-run boundaries, exact quotes, conservative repeated-text/multi-span/split/merge/reorder mapping, prefix-edit undo/redo/reopen; AC02–04.                                                                |
| S3-T04 | Direct selection actions, cards/list/decorations, save/follow-up/handled/delete, evidence choices, English/Chinese/narrow browser screenshots; AC01/04/05/25 partial. Native/performance interaction is unverified.   |
| S3-T05 | Counted actual SDK local endpoint, question-only output, selected conversation context, manual draft/no-topic, old-request fences, answer provenance, redo-tail/reopen; AC05/06/07/22 partial.                        |
| S3-T06 | Whole-block/slot claims and reservations, conflicting notes, empty-slot structural guard, invalid fill depth, changed/unchanged regeneration and typed NO_CHANGE; AC08–11. Production locks remain step 7.            |
| S3-T07 | Latest comparisons, individual accept/discard, shared pair retention, stale/deleted/result races, exact scoped reconstruction, storage rollback and injected commit policy; AC10–13 partial.                          |
| S3-T08 | Exact-set rollback/success, later-arrival exclusion, duplicate receipt, conflict identities and one batch history step with basic undo/redo; AC14/15. Full S3 replay/rebinding/lock races remain T12–T15.             |

Behavioral fixtures are in `crates/domain/src/review.rs`,
`crates/infrastructure/src/review_tests.rs`,
`tests/unit/review-commands.test.mjs`, `tests/integration/review.test.mjs` and
`tests/e2e/review.spec.ts`.

## Commands and corrections

Targeted implementation runs exercised the real shared queue and official SDK
against a counted localhost fixture without credentials. Question, follow-up,
revision and acceptance used three requests; a controlled provider failure followed
by a changed global binding and explicit retry brought the total to five. Reopen,
read, user save, acceptance and duplicate receipts added no requests.

Initial development runs exposed and corrected: snapshot-version/legacy-fixture
migration assumptions; recursive repository locking while reading a saved result;
request restoration mapped twice; scoped nested-list normalization; run-local
instead of global grapheme assumptions; slot insertion guards; shared comparison
ownership/overlay cleanup; missing answer provenance/restore aliases; no-op saves
at message capacity; large response previews; pre-dispatch duplicate submissions;
and known receipt/rejection/IME/decorations races. Some browser assertions also
needed the actual existing Start writing label and identification of the intended
highlight among two valid overlapping decorations. These failed attempts are not
passing gate evidence.

Final implementation-tree commands completed:

- `pnpm check`: passed generated contracts, formatting, TypeScript, 64 Node tests,
  119 Rust tests (12 domain, 105 infrastructure, 2 service), and warnings-denied Clippy.
- `pnpm build`: passed browser, desktop TypeScript and locked Cargo build. Vite
  reported the existing large-chunk advisory (about 1.115 MB minified/346 KB gzip);
  this is not native packaging evidence.
- `pnpm test:integration`: 5 passed, including the counted actual-SDK review flow,
  controlled provider failure, global-binding change and explicit retry lineage.
- `pnpm test:e2e`: 21 passed; 1 dedicated performance fixture intentionally skipped.
  The review case covers direct actions, a preflight-barrier double submission,
  Unicode/cross-block and nested-list selection, undo/resync highlights, bilingual
  cards, scoped acceptance and narrow layout.
- `git diff --check`: passed. Applied migrations 001–006 are unchanged.

The final browser reruns also corrected a fixture wait that matched unsaved composer
text before the card was persisted. Production code was unchanged by those final
selector/wait corrections.

The root independently inspected the implementation, migration/history identity
changes and screenshots, and reviewed the two read-only core/UI audits. All
identified blocking findings were corrected before handoff. Root also updated the
overview documents and added the real review-read interface to the existing
desktop-close browser fixture. After the writer stopped, root independently ran
`pnpm check`, `pnpm build`, `pnpm test:integration`, `pnpm test:e2e`,
`pnpm peers check` and `git diff --check`: all passed with the same 64 Node,
119 Rust, 5 integration and 21 browser tests above; the dedicated performance
fixture remained intentionally skipped. These are Linux cloud checks, with the
platform/provider limits below unchanged.

Screenshots are ignored local artifacts:
`.artifacts/review-question-zh.png`, `.artifacts/review-candidate-en.png` and
`.artifacts/review-narrow.png`.

## Limits and next step

Full review history rebinding remains conservative: restored decisions may expose
stale evidence; history changes that remove an active request/candidate can be
blocked until its explicit cancellation/discard. Unchanged independent question
threads retain their version/task. Step 7 completes the full S3 history/lock/race
contract, production locks, derived finalization and approved baselines.

The 500 KB/2 MB S1 typing/save/undo budget misses remain step 8 work. This checkpoint
adds bounded pages, quote deduplication and decoration guards; it does not establish
S3-AC28 or native memory/performance acceptance. Linux sampled worker RSS is not a
cross-platform hard limit or OS sandbox. Windows/macOS credential stores, native
Electron lifecycle/dialogs, packaging/worker shipping and real providers were not
run. Review visual evidence is supported through the shared manifest path but no
real multimodal provider capability is asserted. No media changed, so render
validation was not repeated. SAI-T14/15 and full S3 remain open.
