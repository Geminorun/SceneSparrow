# S4 specification: delivery and validation

Status: implemented on the step-8 work branch; validation and independent review
are tracked in [step-08](../validation/step-08.md) and the
[acceptance matrix](../validation/acceptance-matrix.md). Target-platform and actual-provider
cases remain separately unvalidated, and interaction performance budgets remain
unmet. Version: 0.1. This completes the stage specifications
for the first [manuscript workbench plan](../design/implementation-and-acceptance-v0.1.md).

Read the [S1](s1-manuscript-foundation.md),
[S2](s2-outline-and-initial-draft.md), and [S3](s3-review-and-finalization.md)
specs, the [workbench design](../design/script-workbench-v0.1.md), and
[development workflow](../development-workflow.md). Engineering defaults below
require implementation evidence; none of the acceptance tables are test results.

## 1. Outcome, scope, and dependencies

A user can copy the saved manuscript or export Markdown, TXT and DOCX in either
editing or finalized state, then reopen the project with its acknowledged content,
reviews, locks and five-step history intact. The full workflow has reproducible
tests, recovery evidence, measured local performance and actual platform results.

| Module                            | Required result                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| Snapshot delivery                 | One saved canonical body captured consistently, independent of ongoing editing            |
| Format serializers                | Clean Markdown/TXT/DOCX with defined formatting and Unicode behavior                      |
| Platform delivery                 | Explicit clipboard write, browser download and desktop save capabilities                  |
| Export jobs                       | Progress/cancel, durable verified artifacts and idempotent generation                     |
| Recovery validation               | Verified migration backups, restored copies, interrupted-task and object integrity checks |
| Desktop and interaction           | Real Windows/macOS file/clipboard/lifecycle checks, locale and keyboard coverage          |
| Workflow and performance evidence | Traceable stage acceptance, representative fixtures and honest completion report          |

S4 does not create audio/video production workflows, a cloud backup/sync service,
accounts, social publishing, an export template designer, or a visible version
manager. Installer distribution, code signing, notarization and automatic updates
remain later release work. A development build passing S4 is not a published app.

| Dependency                  | Required handoff                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| S4-DEP01: S1                | Canonical document/serializers input, object store, save queue, receipts, document worker, history and migration/backup ports |
| S4-DEP02: S2                | Complete initial drafts, evidence kept outside body, task/start/restart state, fake AI integration                            |
| S4-DEP03: S3                | Current body versus proposals, derived readiness/baseline, persistent review/locks and shared mutation guards                 |
| S4-DEP04: platform adapters | Named file-picker/save/clipboard operations and browser/desktop process lifecycle                                             |
| S4-DEP05: shared AI         | Independent spec and actual generic runtime validation for the AI workflow; provider/credentials remain outside export        |

All four stage specs are documentation inputs, not proof that these dependencies
exist. The [independent shared AI spec](shared-ai-integration.md) fixes the generic
runtime and recovery contract. Export and manual-workflow tests need no model call; full
AI-flow readiness also depends on that independently implemented and tested runtime.

## 2. User interaction and saved snapshot

### 2.1 Entry points and scope

In the draft workspace, provide **Copy manuscript** and **Export** with Markdown,
TXT and DOCX choices. Allow both editing and finalized manuscripts. Show that
pending AI proposals are excluded, without forcing acceptance, discard or locking.
Do not require a second finalization gate to copy/export work in progress.

Outline-only projects have no manuscript to export and return `STAGE_CONFLICT`.
An empty draft shows a localized no-content message without clearing the clipboard
or creating an empty file. A heading-only manuscript can export as work in progress
even though it cannot become finalized under S3 rules.

Save feedback and task progress use stable localization keys with `en`/`zh-CN`
strings. Distinguish **File generated**, **Download requested**, **File saved**,
**Copied**, **Cancelled**, and **Delivery status unknown**; they refer to different
observable actions. Export status must not imply that current manuscript wording
was approved or that another AI run finished successfully.

### 2.2 Flush, capture, and concurrent editing

Before starting, flush/acknowledge the current client's editor buffer and close its
typing group through S1. A failed or unresolved save blocks preparation; preserve
the unsaved buffer and existing files. Never export an older server body while
presenting it as the text currently visible in that editor.

The core captures a `ManuscriptExportSnapshot` in a short consistent read under
the project writer coordinator. Verify the expected manuscript/document revision;
capture its ordered canonical blocks and immutable payload references, schema,
document revision, current project sequence, content hash and readiness/baseline
at that moment. A concurrent body change before capture returns `REVISION_CONFLICT`
and requires refresh. A later change does not alter this snapshot.

Record an object pin with the export job in the same coordinated operation so
garbage collection cannot delete its inputs. Serialize outside the database read
transaction. Readonly snapshot capture does not reserve paragraph edits: the user
can continue working while a file is generated. Task status can state that the
file contains an earlier captured document if a subsequent edit occurred.

Comments/lock changes alone do not redefine its body hash. Exporting while a
revision-generation task reads the same text is allowed because both operations
read immutable inputs. A candidate arriving or being accepted later is excluded
from the captured body unless acceptance happened before capture.

## 3. Clean content and format contract

### 3.1 Canonical input and exclusions

Serialize S1 canonical blocks, not editor DOM, a screen selection, review-rendered
HTML or a project database dump. Include only current manuscript text and its
supported document structure/marks. Do not add a project title as a spoken heading
unless it is already a body block.

Exclude review messages/quotes, AI answers, candidate text, comparisons, lock icons,
task previews, source attachments, production notes, verification hints and model
configuration. User-authored text that happens to contain an emoji, the word
"comment", or a literal lock symbol remains text; filtering is by schema ownership,
not a character-removal heuristic. A source reference intentionally written into
the body remains body; separate source metadata is not appended automatically.

Supported links must follow S1 schemes and be encoded as document hyperlinks, not
executed or fetched during export. No image embedding, remote resource resolution,
macro, generated script execution or OCR is needed. Basic DOCX formatting is
supported; reproducing the page layout of an originally imported Word/PDF file is
not promised by the canonical text model.

### 3.2 Format mapping

| Element             | TXT / default plain clipboard                               | Markdown                                        | DOCX                                            |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Heading             | Heading text on its own block                               | ATX heading at its stored level                 | Heading 1–6 paragraph style                     |
| Paragraph           | Text, with blank line between blocks                        | Escaped paragraph text                          | Normal paragraph                                |
| Bullet/ordered item | Indented `- ` or numbered prefix                            | Valid nested list syntax from stored depth/kind | Proper list numbering definitions and levels    |
| Bold/italic/code    | Plain text retained                                         | Appropriate escaped inline syntax               | Supported run formatting / code character style |
| Hyperlink           | Text plus destination when different from its visible label | Escaped label/destination                       | Valid external hyperlink relationship           |
| Soft break          | Line feed within the block                                  | Explicit Markdown hard break                    | Word line break                                 |

TXT and Markdown use UTF-8 without BOM, normalized LF line endings and exactly one
terminal LF for nonempty output. Clipboard uses the TXT serializer. Preserve user
Unicode without normalization, including Chinese, emoji and combining sequences.
Ordered-list runs restart from one according to S1; serializers derive list depth
without exposing block IDs or internal counters. TXT intentionally flattens marks.

Use a Markdown AST/stringifier or equivalently tested escaping, not ad hoc string
concatenation that turns body text into unintended headings/links. Test literal
Markdown characters, backticks, brackets, URLs and nested lists by parsing the
result with an independent parser. Markdown export does not include YAML project
metadata or review data.

Generate macro-free `.docx` with a tested library such as the candidate `docx`
package from the technical design; pin maintained versions/licenses at implementation.
Use a small built-in style set and supported font fallback, without depending on
cloud-only fonts. Do not embed system fonts or private OS-user properties. Set
application identity explicitly for document creator metadata, not machine account
names. Do not emit Word comments, tracked revisions, provider data or external
templates. Compare semantic contents in tests rather than assuming ZIP bytes are
deterministic across generation timestamps/library versions.

### 3.3 Names, output limits, and validation

Suggest a filename based on the project title, sanitized for both platforms while
preserving Unicode. Remove path separators/control characters, Windows reserved
names and trailing dots/spaces; fall back to `manuscript` if empty. Bound the suggested
basename to 120 UTF-16 code units and 180 UTF-8 bytes, trimming at grapheme boundaries,
then append the selected format extension. User-chosen names are validated by the
trusted save adapter and OS, not used as project-relative paths.

Do not silently save DOCX bytes under `.txt`. Display/normalize the chosen extension
before the file dialog's overwrite choice. Export artifact MIME types are
`text/plain; charset=utf-8`, `text/markdown; charset=utf-8`, and
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`.

S1 document limits remain in effect. Initial export limits are 32 MiB per generated
artifact and 60 seconds generation time, using the document worker's 512 MiB memory
budget. Validate actual byte count, content hash, format and basic output structure
before marking ready. Invalid/oversized output becomes a safe failure, not a partial
successful document. These are engineering limits to verify on target hosts.

## 4. Export generation, delivery, and cancellation

### 4.1 Job state and artifact ownership

`ExportJob` contains ID, originating request/digest, format, serializer version,
snapshot reference/hash, status, output artifact reference and safe error metadata.
Use `queued`, `running`, `ready`, `failed`, `cancelled`, and `interrupted` states.
A ready artifact is a generated file; delivery is a separate platform action.

The utility worker receives only scoped immutable snapshot input and a staging
output identity. It has no provider configuration or database access. The core
verifies and promotes output into project `exports/`, then records ready state and
outbox event atomically. Handle a crash between file promotion and registration
by reconciliation; an existing complete unregistered file is not a missing-input
repair license. Incomplete output remains staging and is never downloaded.

Use one running document-export job per project and a small bounded queue initially
(four pending jobs). This is separate from the shared AI queue. Each explicit start
can request another file; duplicate receipt replay returns the same job/artifact.
No export creates a project undo entry, clears redo, changes user locks, sets
readiness or advances the current approved body baseline.

Completed generated export files are intentional outputs and remain until explicit
cleanup; do not silently delete them because undo history is full. Release temporary
input pins once generation no longer needs them unless other live references exist;
retain snapshot hash/version metadata without keeping a new full body history for
every export. Failed/cancelled incomplete staging output is safely reclaimable.

### 4.2 Desktop save capability

Use a named platform operation to open the native save dialog with suggested name
and selected format. The trusted main process stores the chosen destination in a
scoped capability bound to that delivery/artifact. The renderer sees an opaque
token and display basename, never a general filesystem-write interface. Cancelling
the dialog performs no target write and preserves any already generated artifact.

Generate the artifact in the project first. On explicit save, stream verified bytes
through a trusted file committer to a temporary file in the destination directory,
flush/close it and use the platform's atomic finalize/replace operation. A target
overwrite requires the normal save dialog's explicit overwrite choice. Never
delete the old destination first or fall back to partially overwriting it in place.
If atomic replacement is unavailable or Word/another process locks the file, fail
with a usable message and keep the old target and generated artifact intact.

Check a changed destination identity immediately before finalization and reject
detected external replacement instead of silently treating it as the earlier
overwrite choice. Do not claim exclusive control over arbitrary external writers.
Keep temporary files on the same filesystem as the destination; test native rename,
locked-file and disk-full behavior on both target operating systems.

Delivery requests carry unique IDs and artifact hashes. Repeating an acknowledged
save returns its receipt without another overwrite. If the application dies after
file finalization but before acknowledgment, report delivery status unknown after
restart and let the user check/reselect the destination; never automatically repeat
an uncertain external write. Destination capabilities do not survive restart and
paths/credentials are not added to portable project exports or ordinary logs.

### 4.3 Browser download

Use the authenticated artifact-identity download endpoint and safe attachment name.
Support bounded bytes/progress and cleanup of temporary browser object URLs. A
browser may choose its own directory, prompt, rename or deny a download; the app
can report file ready/download requested, not guaranteed disk-save completion.
It cannot choose or overwrite arbitrary client paths.

Reconnecting the event stream does not automatically start another download. The
user can explicitly download the same ready artifact again without regenerating
it. Do not require browser filesystem APIs that are unavailable on a supported
validation browser, and do not label a cancelled/blocked request as a file saved.

### 4.4 Clipboard and user activation

Prepare clean plaintext from a flushed captured body and write it only on explicit
copy action. Desktop clipboard access stays behind a named main-process operation
validated against the loaded app frame; the renderer gets no unrestricted IPC.
Browser clipboard uses normal secure-context/user-activation rules.

If awaiting flush/preparation consumed browser activation or permission is denied,
keep the prepared text and offer an immediate **Copy prepared manuscript** user
action or a selectable manual-copy view. Do not claim success on rejection, weaken
browser permissions globally, or clear clipboard contents for an empty manuscript.
Copy has no history/lock/task side effect and never sends text to an AI provider.

### 4.5 Cancellation and restart

Cancel queued/running generation by fencing its attempt and terminating its utility
work as needed. It may reclaim incomplete staging output; a late worker receipt
cannot mark the cancelled job ready. If ready commit won the race, keep the ready
artifact and return that actual state. Dialog cancellation cancels delivery, not
the canonical manuscript or a separately running AI task.

A desktop delivery can cancel before external finalization. If finalization already
committed, cancellation returns the completed/unknown state rather than deleting
a saved file. On restart, retain verified ready artifacts; interrupted generation
can be manually retried as a utility job with the same captured input if retained,
or recaptured explicitly if unavailable. Never reissue AI calls, browser downloads,
clipboard writes or uncertain external saves during export recovery.

## 5. Recovery, migration, and integrity validation

### 5.1 Consistent backup and restored-copy evidence

Exercise the backup/migration ports already required by S1. A migration backup
contains a consistent SQLite snapshot and every immutable object referenced by
that snapshot, including retained history, pending review/task inputs and baselines.
Pin that root set while copying; a concurrent GC pass must not remove it. Verify
hashes and backup completeness before declaring the backup usable.

Use SQLite's backup API or an equivalent tested consistent mechanism; copying
only a live database main file while ignoring WAL is invalid. Generate a small
backup manifest with schema version, snapshot identity and object hashes. Keep
application-global credentials/settings out of the project backup; nonsecret
execution provenance remains project data under the existing design.

Restore into a new recovery directory, validate references and open that copy
through the normal owner-lock/migration path. Do not overwrite a user's live
project while testing recovery. The product can offer an existing verified backup
as a recovered copy when normal open fails; an automatic backup scheduler, cloud
backup service and historical backup browser are outside this stage.

### 5.2 Failures and recovery behavior

| Failure point                           | Required observable behavior                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Unsaved local buffer / controlled close | S1 flush decision; acknowledged edits remain durable; explicit discard is distinguishable from saved                       |
| Unknown newer schema                    | Refuse content mutation/downgrade and explain supported project format                                                     |
| Migration interruption                  | Old usable state or verified backup remains; no half-upgraded project                                                      |
| Missing/corrupt referenced object       | Report integrity failure with scoped IDs; keep original data, offer verified recovered copy rather than fabricated content |
| Crash during AI/utility job             | Reconcile attempt/fence/result status per owning spec; no automatic ambiguous paid retry                                   |
| Crash after candidate or lock commit    | Restore committed decisions/claims/locks/history; cleanup does not clear approval                                          |
| Staging/object promotion crash          | Reconcile unreferenced staging/promoted objects without deleting live roots                                                |
| Corrupt/unverified backup               | Reject restore as usable; preserve source project and other verified copies                                                |

Restoration preserves the last five history transitions/cursor and pending review
state from that snapshot. Jobs interrupted by restoration are fenced/reconciled,
not resumed by restoring an old process lease. No new approval is invented. Actual
acknowledged-content and decision hashes, not just a successful startup, establish
recovery correctness.
Restoring a backup is different from restarting the original live database: even
a run marked queued in that older snapshot might already have been dispatched
after the backup was taken. Fence all copied nonterminal AI runs, including queued
ones, and require explicit user retry in the recovered copy. Do not reuse copied
execution leases or dispatch them as known-unissued work. Preserve run metadata
for evidence; already completed local artifacts can be recovered without a call.
Pass the trusted restored-copy/unknown-origin mode to shared AI reconciliation;
its `SAI-AC24` verifies this behavior independently of the S4 recovery UI.

S4 may fix failures discovered in S1–S3, with tests and the owning spec updated.
It does not defer those earlier stages' basic correctness until final testing.
Fault injection uses synthetic projects and explicit barriers at file/transaction
boundaries; never test recovery by damaging a real user project.

## 6. Desktop, localization, and lifecycle validation

Use the same business core/protocol and shared UI in the browser and Electron.
Platform adapters handle native dialogs, clipboard, external links and lifecycle.
Core-side identity/revision/lock rules remain mandatory on both paths.

| Area                  | Required Windows/macOS validation                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| File access           | Select/import references, open project directory, save/cancel/overwrite exports, read-only/locked targets          |
| Path semantics        | Unicode/spaces/emoji, Windows reserved names, case behavior, long paths and basename normalization                 |
| Clipboard             | Explicit canonical plain-text copy with correct Unicode; no reported success on failure                            |
| Keyboard/IME          | Undo/redo, selection, paragraph editing and comments with Ctrl/Cmd variants and Chinese composition                |
| Lifecycle             | Open/reopen, unsaved close decision, core/worker shutdown, restart and single-owner project lock                   |
| Shared AI credentials | Cite independent runtime tests on Credential Manager/Keychain; no plaintext fallback inferred from browser testing |
| App boundary          | Context isolation, sandbox, renderer Node disabled, sender/frame validation, named IPC and loopback authentication |

In desktop controlled close, wait for save acknowledgment and initiate the owning
task coordinator's shutdown/fencing protocol before terminating child processes.
Do not advertise successful save while immediately killing the core. Running remote
calls become interrupted if completion cannot be established; queued work retains
its persisted status. An OS kill cannot guarantee survival of unacknowledged text.

Browser unload retains normal unsaved-change semantics and cannot guarantee an
async final save/download. Listener cleanup on window/project switch must prevent
cross-project events, duplicate dialogs and stale task updates.
Opening another project uses the trusted directory picker and existing core
create/open ports. Flush and close the current project before switching the active
core; cancelling the picker keeps the current project intact. A selected unknown
or unsupported directory must not be initialized over existing data. This is one
active project at a time, not a new multi-window collaboration feature.

Validate localized save/export/error/task/lock/review labels in both languages,
long-text layout and keyboard focus/accessible names. Native OS dialog language
may follow the OS. UI locale does not rewrite manuscript content or change exported
text. Match supported formatting and behavior across platforms; identical font
rendering or DOCX pagination across different word processors is not required.

Keep Electron sandboxing enabled. The current managed Linux environment's desktop
launch limitation is not a reason to certify desktop behavior from browser tests
or introduce an insecure launch workaround. Record target-host evidence separately.

## 7. Commands, events, errors, and persistence

Use JSON Schema-generated public contracts and existing authentication/desktop
allowlists. Job commands have unique IDs/digests and queryable receipts. They are
utility operations outside project undo even when stored in the project database.

| Application operation    | Required payload / effect                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `PrepareManuscriptCopy`  | Expected saved document revision; return scoped plaintext snapshot/payload and provenance         |
| `StartManuscriptExport`  | Expected document revision, format, request ID; capture/pin once and return job ID                |
| `CancelManuscriptExport` | Job ID/attempt expectation; cancel utility generation only                                        |
| `RetryManuscriptExport`  | Failed/interrupted job plus explicit captured-input or recapture choice; no provider use          |
| `ReadExportJob`          | Generation state, snapshot/hash, artifact ID and safe error; no arbitrary file paths              |
| `RequestExportSave`      | Ready artifact ID, format/hash, unique delivery ID; desktop returns scoped destination capability |
| `CommitExportSave`       | Delivery/capability and verified artifact; trusted native finalization only                       |
| `RequestExportDownload`  | Ready artifact identity from explicit user action; browser download request                       |
| `WritePreparedClipboard` | Scoped prepared plaintext identity and explicit user action through the platform                  |

Expose `POST /v1/manuscript/exports`, `GET /v1/manuscript/exports/{jobId}` and named
cancel/retry actions. Serve artifacts through an authenticated job/artifact-bound
download operation, never an arbitrary-path route. Preparation/copy routes return
bounded body content intentionally requested by the user, not provider/source data.
Desktop save/clipboard operations are platform bridge capabilities, not general
HTTP filesystem commands available to a web page.

Extend `project_events` with `exportJob.changed`; desktop delivery uses a correlated
platform receipt with generated/saved/unknown distinctions. Reuse SSE sequence
deduplication/resync; status replay cannot trigger external side effects. Completed
file delivery does not emit manuscript/approval changes.

Persist `export_jobs`, `export_snapshots` metadata/pins, and verified artifact
records under core ownership. Link serializer version and content hash for audit.
Compact terminal snapshot payloads when input pins are released; current/generated
files remain referenced as applicable. Destination capabilities are app-session
state, not portable project paths. Reserve `009_exports.sql` and project schema
version 9 after S3 versions 7–8, following the shared AI migration ledger, and test
upgrade/recovery together. Export utility queues never use AI dispatch permits.

| Error                                                                  | Required presentation / behavior                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `NO_MANUSCRIPT_CONTENT`, `STAGE_CONFLICT`                              | Explain no current draft body; no clipboard/file mutation                |
| `SAVE_FAILED`, `REVISION_CONFLICT`, `COMMAND_UNRESOLVED`               | Preserve local buffer; do not start export of an unknown body            |
| `EXPORT_FORMAT_UNSUPPORTED`, `EXPORT_TOO_LARGE`, `EXPORT_INVALID`      | Preserve current manuscript/target, show useful format/limit explanation |
| `EXPORT_FAILED`, `EXPORT_INTERRUPTED`, `WORKER_UNAVAILABLE`            | Keep input/artifact state honest; explicit utility retry                 |
| `DESTINATION_UNAVAILABLE`, `DESTINATION_CHANGED`, `DESTINATION_LOCKED` | Keep existing target intact; offer another destination or explicit retry |
| `DELIVERY_STATUS_UNKNOWN`, `CAPABILITY_EXPIRED`                        | Check/reselect destination; no automatic uncertain overwrite             |
| `CLIPBOARD_UNAVAILABLE`, `DOWNLOAD_UNAVAILABLE`                        | Preserve prepared output and offer an explicit alternative action        |
| `PROJECT_INTEGRITY_FAILED`, `BACKUP_INVALID`, `SCHEMA_UNSUPPORTED`     | Preserve originals; verified recovered-copy path or readable failure     |

Return 400/422 for invalid/no-content requests, 409 for revision/state/capability
conflicts and 413 for size ceilings. Long generation/save failures are job/platform
outcomes. Reuse safe error envelopes; no raw SQL, private source text, OS account
paths or credential data in diagnostics.

## 8. Full-workflow and performance validation

Run at least two complete representative workflows against actual core storage:

1. Topic and selected files/links, outline generate/adjust, confirm, complete draft,
   question, revision candidate, individual/all acceptance, explicit paragraph locks,
   lock-all, copy/export all formats, close/reopen and verify current state/history.
2. Manually entered/imported manuscript with no AI configuration, edit/save/reopen,
   five-step undo/redo, lock/unlock, and every export format. Fake AI may separately
   exercise review without requiring real credentials; manual delivery must work
   offline and without configured provider access.

Use deterministic fake execution for repeatable end-to-end failure/cancel/stale
cases and counted requests. A deliberately initiated provider smoke test supplies
additional actual-endpoint evidence; never run paid calls in ordinary CI or treat
one endpoint as proof of universal compatibility. Shared AI owns its separate
acceptance and credential tests.

Use the parent plan's approximately 50 KB, 500 KB and 2 MB document fixtures,
including many small paragraphs, one long block and up to 500 comments. Include
TXT/Markdown/DOCX/PDF sources and larger referenced files to prove editor/export
does not repeatedly load all source bytes. Record cold/warm conditions, hardware,
OS, tool/library versions, operation counts, p50/p95 and total process memory/disk.

| Local metric                         | Initial budget to measure, not a verified claim                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Ordinary typing-to-paint             | p95 below 50 ms                                                                                       |
| Undo/redo at 500 KB / 2 MB           | p95 below 150 ms / 500 ms                                                                             |
| Flushed ordinary save acknowledgment | p95 below 250 ms, excluding debounce                                                                  |
| TXT/Markdown generation at 500 KB    | p95 below 1 second                                                                                    |
| DOCX generation at 500 KB            | p95 below 3 seconds                                                                                   |
| Export UI                            | Enqueue/progress off the typing path; no synchronous parsing/serialization in renderer input handlers |

Measure provider/network time separately. Missed budgets require an identified
cause, fix or explicit documented limitation; do not infer performance from Rust
alone or add delta history/microservices without evidence. Validate five transitions
and six snapshot references separately from total project size, which also includes
intentional sources, reviews and export files. Expand stress sizes only within
documented limits and record any rejected case honestly.

## 9. Development tasks and dependencies

Step 8 implements T01–T08 and the portable portions of T09–T14. Native-host and
real-provider checks remain unrun, and interaction performance budgets remain
failed. The validation report separates these limits from the code checkpoint. `Tnn`, `ACnn` and `DEPnn` mean `S4-Tnn`, `S4-ACnn` and
`S4-DEPnn`. Earlier-stage fixes keep their original acceptance IDs and add regression
coverage; S4 tasks integrate and demonstrate them rather than relabeling them done.

| Task   | Concrete deliverable                                                                                       | Depends on                         | Acceptance                   |
| ------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| S4-T01 | Define export/copy/job/platform receipt schemas, clean-content rules, filename and format fixtures         | DEP01, DEP03                       | AC01, AC03, AC07, AC08       |
| S4-T02 | Implement saved snapshot capture, revision checks, object pins and utility command receipts                | T01, DEP01                         | AC01, AC02, AC12             |
| S4-T03 | Implement canonical TXT/clipboard and Markdown serializers with independent-parser tests                   | T01, T02                           | AC03, AC04, AC05             |
| S4-T04 | Add pinned DOCX writer/document-worker path, bounded validation, semantic round-trip fixtures              | T01, T02, DEP01                    | AC03, AC06                   |
| S4-T05 | Implement export job queue/cancel/retry, verified artifacts, download API and restart reconciliation       | T02, T03, T04                      | AC02, AC12, AC13, AC15       |
| S4-T06 | Add explicit desktop/browser clipboard adapters, activation/permission fallback and localized copy state   | T02, T03, DEP04                    | AC08, AC09, AC20             |
| S4-T07 | Add native save capability, destination temporary/atomic commit, overwrite/unknown-state handling          | T05, DEP04                         | AC07, AC10, AC11, AC12, AC15 |
| S4-T08 | Add browser download/export UI, generated/requested/saved distinctions and event deduplication             | T05, T06, T07                      | AC08, AC13, AC14             |
| S4-T09 | Verify consistent migration backups, integrity checks and recovered-copy open; fix owning-layer failures   | DEP01, DEP02, DEP03                | AC16, AC17, AC18, AC19       |
| S4-T10 | Complete target desktop lifecycle/file/bridge regression checks and necessary adapters                     | T06, T07, T09, DEP04               | AC20, AC21, AC22             |
| S4-T11 | Finish shared UI locale, keyboard/focus/accessibility checks across export/review/save states              | T08, T10                           | AC09, AC23                   |
| S4-T12 | Add complete AI/fake/manual workflows with state/hash/export verification across restart                   | T08, T09, T10, DEP02, DEP03, DEP05 | AC19, AC24, AC25, AC26       |
| S4-T13 | Measure representative editor/history/export resource costs and fix demonstrated bottlenecks               | T05, T11, T12                      | AC27                         |
| S4-T14 | Produce acceptance/test/platform evidence matrix, delivery limitations and reproducible verification notes | T11, T12, T13                      | AC01–AC28                    |

Checkpoints: T01–T05 generate correct files; T06–T08 deliver them through platform
capabilities; T09–T11 validate recovery/desktop interaction; T12–T14 establish
complete-workflow and performance evidence. Fixes/tests belong alongside behavior,
not solely in the final reporting task.

## 10. Acceptance cases and test mapping

These are required outcomes, not completed checks. Parent IDs come from the
workbench implementation plan. Link earlier stage cases to actual evidence in
the completion report rather than duplicating their entire specifications.

| ID      | Given / when                                                                                   | Required observable result                                                                                                                  | Level / parent mapping                      |
| ------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| S4-AC01 | Visible unsaved text, failed flush or body race at export capture                              | Export waits for acknowledgment or fails honestly; no file from an unknown/older visible body                                               | API/browser; SW-05, SW-25                   |
| S4-AC02 | Edit or accept candidate after capture while export/GC runs                                    | File contains one complete captured version; editor remains usable; pinned inputs survive until generation finishes                         | Barrier/storage; SW-25, SW-27               |
| S4-AC03 | Body plus comments/proposals/locks/source notes and literal review-like characters             | Export schema includes only current body; genuine user text retained; no metadata/privacy leakage                                           | Serializer/fixture; SW-25                   |
| S4-AC04 | Chinese/emoji, headings, nested lists, links and soft breaks in TXT/copy                       | Deterministic plain text, UTF-8/LF and meaningful flattening; no lost text or block IDs                                                     | Serializer/clipboard                        |
| S4-AC05 | Literal Markdown punctuation/code/URLs and supported marks                                     | Independent parse recovers intended supported structure/text; no accidental injected syntax or metadata                                     | Serializer/independent parser               |
| S4-AC06 | Generate DOCX then inspect/open it independently                                               | Correct text/headings/lists/links, no comments/tracked changes/macros/private properties; opens in a target word processor                  | Worker/parser/manual                        |
| S4-AC07 | Unicode/reserved/long title and mismatched chosen extension                                    | Safe suggested filename and correct format extension, preserving supported Unicode; no path traversal                                       | Domain/native filesystem                    |
| S4-AC08 | Editing/finalized/heading-only/empty/outline document                                          | Export valid body without lock gate; clear no-content/stage state; no empty clipboard clearing                                              | Domain/browser; SW-25                       |
| S4-AC09 | Clipboard preparation loses activation or permission fails                                     | No false copied status; explicit prepared-text/manual-copy fallback; no AI call or permission weakening                                     | Browser/platform                            |
| S4-AC10 | Cancel native save dialog or select existing target                                            | Cancellation writes nothing; overwrite occurs only under selected normal overwrite choice                                                   | Native/manual                               |
| S4-AC11 | Disk full, locked target, changed target or finalize failure                                   | No partial overwrite/deletion of existing file; preserve artifact and offer useful action                                                   | Native/fault; SW-26                         |
| S4-AC12 | Duplicate export/save request or uncertain receipt                                             | Same generation result/receipt, no repeated acknowledged overwrite; uncertain external save never replays automatically                     | API/platform fault; SW-26                   |
| S4-AC13 | Cancel races ready/publish state or late worker result                                         | One honest result, no cancelled late ready transition, no deletion of already saved file/body/history                                       | Barrier/integration                         |
| S4-AC14 | Browser download blocked/repeated or SSE reconnects                                            | Distinguish ready/requested from saved; explicit redownload reuses artifact; no replay-triggered side effect                                | Browser/API                                 |
| S4-AC15 | Restart during generation/promotion/external save                                              | Verified ready artifacts recovered; interrupted/unknown states honest; lost save capability requires reselection                            | Restart/fault; SW-27                        |
| S4-AC16 | Backup live WAL project while GC runs, then open restored copy                                 | Consistent DB plus all referenced objects verified; recovered text/history/locks match captured snapshot                                    | Storage/restart; SW-27, SW-28               |
| S4-AC17 | Missing/corrupt current object or incomplete backup                                            | No fabricated content or silent repair; original preserved, invalid restore rejected, verified copy available when present                  | Fault/storage                               |
| S4-AC18 | Upgrade failure/newer schema and existing S1/S2/S3 project                                     | Correct supported migration or safe refusal; recoverable prior state without in-place downgrade or invented approval                        | Migration; SW-28                            |
| S4-AC19 | Reopen/restore with middle history cursor, pending candidate, user lock and interrupted AI run | Durable body/reviews/claims/locks/history recovered; old leases fenced; no ambiguous paid retry                                             | Restart/history; SW-19, AI-08               |
| S4-AC20 | Browser/direct IPC caller exceeds scoped operations                                            | Authentication/frame/capability checks reject arbitrary paths/write/clipboard execution; normal operations retain sandboxing                | API/desktop                                 |
| S4-AC21 | Chinese composition/unsaved edits while closing or core/worker shutdown                        | Correct save decision/acknowledgment, no promised durability for unacknowledged input; restart reconciles tasks                             | Native/browser/restart; SW-05               |
| S4-AC22 | Import/open/save on real Windows/macOS paths with locks/case/Unicode                           | Correct native behavior and single-owner handling; record actual OS/architecture and remaining gaps                                         | Target-platform/manual                      |
| S4-AC23 | Locale switch, long translated strings, keyboard-only narrow-window flow                       | Content unchanged, focus/accessible labels correct, review/save/export controls usable in both locales                                      | Browser/native interaction                  |
| S4-AC24 | Complete topic-to-outline-to-draft-to-review-to-lock-to-export flow with fake AI               | Exact state transitions, current-body output all formats, correct five-step history/locks after reopen                                      | Full end-to-end; SW-01–SW-30 relevant cases |
| S4-AC25 | Manual/imported draft with no configured provider or network                                   | Edit/history/locks/copy/export remain usable; no hidden generation request or AI requirement                                                | Offline end-to-end                          |
| S4-AC26 | Deliberate actual-provider smoke and independent runtime verification                          | Record selected endpoint/model/capabilities and shared-AI results; ordinary CI makes no paid request; untested compatibility not claimed    | Controlled provider/platform                |
| S4-AC27 | 50 KB/500 KB/2 MB documents plus comments and referenced sources                               | Measured local latency/resources against budgets; no whole-source/per-keystroke serialization or duplicate history payloads                 | Performance                                 |
| S4-AC28 | Review final stage report and PR evidence                                                      | Every required stage/AI acceptance is passed, failed or explicitly unrun with artifacts; platform gaps block corresponding readiness claims | Evidence/review                             |

## 11. Verification evidence and completion gate

Use relevant existing commands as implementation lands: `pnpm check`, `pnpm build`,
`pnpm test:integration`, and `pnpm test:e2e`. Add export/parser/native/recovery checks
to executable workflows as capabilities arrive; do not cite a nonexistent command
as validation. No Remotion render is needed to prove manuscript export. Keep actual
provider tests explicitly initiated, separate from normal CI.

Maintain a stage report under `docs/validation/` when implementation evidence exists.
This documentation change does not create a report claiming results. The report
contains commit/tool/OS/architecture, fixture definitions, test commands/outcomes,
artifact locations/hashes, performance results, native/manual checks and limitations.
Reference all S1/S2/S3/S4 acceptance IDs plus `SAI-AC01`–`SAI-AC32` independently.
Browser-only evidence is labeled browser-only; generated files need semantic/open
checks, not screenshots or file existence alone.

Critical gates are acknowledged-data recovery, lock enforcement on every write
path, candidate acceptance atomicity, no hidden paid retries, clean snapshot-based
outputs, safe destination handling and persistent bounded history. Failures in
these gates need fixes before calling the corresponding workflow usable. A skipped
target platform/provider remains an unvalidated scope, not a silently passed case.

Present the completed manuscript capability and its measured limits for user review.
No merge, environment publication, binary release or installer distribution is
authorized by the existence of this completion checklist; follow the user's actual
delivery instruction and repository PR workflow.

## 12. Implemented engineering interfaces

Migration 009 owns utility jobs, exact control receipts, temporary copy preparations
and external delivery receipts. It does not modify applied migrations 001–008 or
add these utility records to business history or generic AI execution.

`POST /v1/manuscript/copies` prepares bounded plain text without an export job or
permanent artifact; `GET /v1/manuscript/copies/{id}` replays the same preparation.
Preparations expire after ten minutes. `POST/GET /v1/manuscript/exports` captures or
lists jobs; named job, cancel, retry and artifact routes complete the utility API.
Capture accepts an ordered-body hash precondition independent of comment/lock
sequence changes; expected global revision remains a compatibility fallback.
`GET /v1/manuscript/identity` supplies that cheap ordered body identity. Generated
contracts are authoritative for request/response fields, including baseline
metadata and the latest delivery receipt on each job.

The native main process owns the save dialog and its selected-destination
capability in one scoped operation. Renderer code receives neither an absolute
path nor a reusable filesystem handle. Delivery IDs bind the job and verified
artifact hash, replay a known acknowledgment, and report unknown after a lost
external acknowledgment or restart. An explicit new delivery ID and normal dialog
consent can reuse a ready artifact. Named clipboard operations consume only a
prepared copy and never accept arbitrary renderer text or code. Native delivery,
backup and quiesce routes require a separate native token.

Project inspection is read-only and version-aware before activation. Consistent
backups include only referenced immutable objects and registered ready artifacts,
plus SQLite and a completion manifest. Restore verifies required roots and creates
a new copy; it never overwrites the selected source. Unknown-origin queued AI work
is fenced in that recovered copy. Picker switch and close share a frozen-editor
handshake, native admission fence, worker quiescence and rollback to the previous
owner if candidate activation fails.

Browser export requests a download and never claims a saved external file. Browser
clipboard denial retains selectable prepared text. Both clients distinguish
captured body identity from later local input. All feedback uses English/Chinese
localization keys. The exact runnable evidence and remaining native/provider cases
belong to the linked validation documents, not this normative acceptance table.

## 13. Desktop recent-project follow-up

The shared workbench conditionally exposes desktop recent projects through
`readRecentProjects` and `openRecentProject`. Entries use opaque host locator IDs
and titles; paths stay outside renderer contracts. The desktop host restores a
remembered project and controls switching through the original flush/close path.
Cancellation or failed opening leaves the current editor available. Explicit
verified-backup recovery and backup creation remain separate actions; recents do
not turn ordinary opening into recovery or synchronize project databases.

Settings and rename dialogs dismiss through the existing manuscript close handler
before its recovery decision is shown. Browser bridge fixtures cover this
composition; native Windows/macOS lifecycle and restore acceptance remain open.
See the [follow-up evidence](../validation/workspace-onboarding.md).

## 14. Compact workspace delivery controls

The [editor-first workspace](../design/editor-workspace.md) moves clean copy,
format selection, export history and native delivery controls into one compact
Export disclosure. Clipboard failure still exposes localized manual-copy text.
Project rename/recent/open/recovery actions belong to the project menu; global
settings and released diagnostics retain their existing boundaries. The single
manuscript close owner still dismisses settings before guarded close/recovery.

Responsive auxiliary preferences are non-authoritative browser storage. Narrow
drawers retain editor DOM while excluding covered manuscript controls from keyboard
focus. Keyboard tab navigation, resizing, close/opener focus and Escape behavior
join the existing cross-stage browser acceptance evidence. Linux Chromium and
synthetic composition do not establish native Windows/macOS IME or lifecycle
acceptance; see [the validation report](../validation/editor-workspace.md).
