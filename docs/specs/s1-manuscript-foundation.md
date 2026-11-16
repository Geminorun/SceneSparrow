# S1 specification: manuscript editing foundation

Status: execution steps 1–3 implement manual editing, bounded project history,
source intake/extraction and prepared manuscript import. See
[step 1](../validation/step-01.md), [step 2](../validation/step-02.md) and
[step 3 evidence](../validation/step-03.md). Full target-platform and performance
acceptance remains open. Version: 0.1. Scope: the first slice of the
[implementation plan](../design/implementation-and-acceptance-v0.1.md).

Read the [workbench design](../design/script-workbench-v0.1.md),
[architecture](../architecture.md), and [development workflow](../development-workflow.md).
The user confirmed the product rules. Numeric limits, command shapes and grouping
rules below are engineering defaults selected to make S1 implementable and testable;
change them with evidence and update this spec when needed.

## 1. Outcome and scope

A user can create/open a project, start an empty manuscript or import an existing
one, edit it, attach reference material, save it, and reopen it with the last five
undoable operations and current redo position intact. S1 requires no AI service.

| Included module        | User-visible result                                                           |
| ---------------------- | ----------------------------------------------------------------------------- |
| Document model/storage | One primary manuscript per project, stable block IDs, durable revisions       |
| Editor/navigation      | Paragraphs, headings, lists, basic text formatting, links, heading navigation |
| Autosave/recovery      | Accurate save status, responsive typing, local buffer retained on failure     |
| Project history        | Five reversible operations, continuous-input grouping, persistent cursor      |
| Sources                | Add/remove links and supported files; inspect extraction status and text      |
| Manuscript import      | Start a draft from pasted text or TXT/Markdown/DOCX/text-extractable PDF      |

The AI outline workspace belongs to S2; questions, revision notes, comparisons and
lock controls belong to S3; document export belongs to S4. S1 exposes none of these
unfinished actions. Ordinary editor copy/paste and copying an unsaved recovery
buffer remain available. There are no production AI requests, media jobs, or
provider settings in this stage.

## 2. Entry points and interaction

### 2.1 Project and document state

Keep the existing project create/reopen behavior. A new or migrated bootstrap
project begins with `workspaceStage = outline` and no body blocks. In S1 this shows
a simple document-start view with **Start writing** and **Import manuscript**;
it does not claim that the future outline editor exists.

**Start writing** transitions to `draft` with an empty canonical document. Render
one editor placeholder without persisting it as content. The first actual input
creates a block. Importing/pasting a manuscript as the start action likewise enters
`draft`. Both operations are undoable; undo can return to the document-start view,
and redo restores the saved document without rerunning the importer.

An empty draft remains a draft when reopened. It is not automatically returned to
planning or considered finalized. Existing drafts reopen directly in the editor.
All content is unlocked in S1 and readiness is always editing; reserve actual
approval/finalization transitions for S3.

### 2.2 Editor and sources

Provide a main document editor, heading navigation, source panel, save indicator,
and project undo/redo controls. Support keyboard editing, selection, paste,
paragraph split/merge, headings 1–6, ordered/unordered lists, bold, italic, inline
code, and links. Derive navigation from saved/locally edited heading blocks; do not
maintain an independent outline. Reordering a section moves its heading and the
following blocks up to the next heading of equal or shallower level as one action.

Distinguish **Add reference** from **Import manuscript** at the entry point. Adding
a file/link to sources never inserts its contents into the body. Importing into a
nonempty manuscript shows a preview and offers **Append** or **Replace manuscript**;
there is no implicit overwrite. Append adds newly identified blocks at the end.
Replace creates a new set of block identities in the same manuscript. Each is one
atomic history operation and can be undone while retained. Cancelling preview
leaves the body and history unchanged.

Default save states are `saved`, `pending`, `saving`, `error`, and `conflict`.
The initial state is saved only after a successful load. Pending means the screen
has newer local edits than the core. Saving means a specific batch awaits a receipt.
Error/conflict retain the local text with a retry/recovery action. Display the
remaining undo/redo availability and localized operation labels.

Use localization keys in shared `en`/`zh-CN` catalogs for all built-in text. Keep
document language/content independent of UI language. Keyboard undo is Ctrl+Z on
Windows and Cmd+Z on macOS; redo supports the platform's normal shortcut, including
Ctrl+Y on Windows and Cmd+Shift+Z on macOS. Native dialog/input undo applies only to
unsubmitted input; document and toolbar undo use the project history router.

## 3. Canonical document contract

### 3.1 Shape and validation

Use an application-owned document representation, with a Tiptap adapter at the UI
boundary. Never persist arbitrary editor extension JSON or HTML as authoritative
content. The logical schema is:

| Object            | Required fields                                                                     |
| ----------------- | ----------------------------------------------------------------------------------- |
| `ManuscriptState` | `manuscriptId`, `schemaVersion: 1`, `workspaceStage`, `blocks`                      |
| `Block`           | `id`, `revision`, `kind`, `attrs`, `runs`                                           |
| `TextRun`         | `text`, `marks`                                                                     |
| `Mark`            | Discriminator `bold`, `italic`, `code`, or `link`; link additionally carries `href` |

This is the persisted/read shape. New-block command inputs omit `revision`; the
core assigns it. Expected revisions for existing blocks are preconditions, never
replacement values supplied by the client.

`blocks` is a flat ordered array of content blocks. `kind` is `paragraph`,
`heading`, or `list_item`. Paragraph attributes are empty; headings have integer
`level` 1–6; list items have `listKind = bullet | ordered` and `depth` 0–3. A list
starts at depth zero; increases are at most one level and require a preceding
parent item. Consecutive compatible items form a list; ordered lists number from
one per run. Arbitrary list start numbers are outside S1 and produce an import
normalization warning. The editor adapter maps this representation to nested
Tiptap lists and back without changing content-block IDs.

Headings express derived section structure; they do not become persistent
container nodes. Both list nesting and derived section ranges contribute to the
affected set of structural operations. This is the concrete S1 representation of
the high-level design's parent/order relationships.

Concatenate runs to obtain a block's canonical text. A newline inside a run maps
to a soft break; block boundaries map to paragraphs/list items. Marks are unique,
sorted in a fixed order, and adjacent runs with identical marks are coalesced;
empty runs are omitted. Preserve user Unicode without normalization. Accept tabs
and line feeds; reject invalid Unicode, NUL and other unsupported control codes.
Links allow validated `https`, `http`, and `mailto` schemes only; no script/file
URLs or embedded executable content. Plain pasted HTML is sanitized and converted
to the same supported nodes/marks.

IDs are opaque UUIDv4 values. The editor/import pipeline can propose fresh IDs for
optimistic insertion; the core verifies uniqueness and that they have not been
allocated to another object. A supplied ID conveys no authority. Edits to a block
keep its identity; kind changes keep the ID. Split keeps the original ID for the
first result and allocates a fresh ID for the second. Merge keeps the first block's
ID and tombstones the second. Imported replacement uses new IDs. Undo can restore
deleted identities, but no new command can reuse a tombstoned ID as a new object.

Use positive monotonic object revisions, and preserve an allocation/revision
high-water mark for deleted blocks. A restored block receives a revision newer
than its previous incarnation even when its text hash is identical. Project
`workingRevision` is a monotonically increasing integer within JavaScript's safe
integer range; reject exhaustion instead of wrapping. Client commands never assign
authoritative revision numbers.

Every text range is half-open UTF-16 offsets within canonical block text, never
UTF-8 bytes or global ProseMirror positions. Validate semantic split/selection
boundaries with Unicode fixtures. Split/merge and future anchors must not bisect
surrogate pairs or grapheme clusters. During an IME composition, the UI keeps
intermediate text local and submits after composition completes.

### 3.2 Initial engineering limits

Enforce the same named limits at UI, service and core validation boundaries:

| Limit                              | Initial value                                       |
| ---------------------------------- | --------------------------------------------------- |
| Canonical serialized document      | 4 MiB                                               |
| Plain manuscript text, UTF-8 bytes | 2 MiB                                               |
| Content blocks                     | 10,000                                              |
| One block's text, UTF-8 bytes      | 1 MiB                                               |
| One edit command                   | 10,000 primitive operations, 8 MiB JSON envelope    |
| Imported/uploaded file             | 25 MiB                                              |
| Expanded DOCX archive              | 100 MiB                                             |
| Extracted source text              | 10 MiB per source                                   |
| Document worker run                | 60 seconds wall time, 512 MiB working memory budget |

Count actual bytes/items, not only file names or supplied content lengths. Size
failures leave the accepted document intact. Source extraction limits may be
larger than manuscript limits; the import preview explains when a reference can
be retained but cannot be imported as a body. Validate limits and parser process
enforcement on target platforms before claiming resource isolation.

## 4. Mutation pipeline and commands

### 4.1 Common envelope and receipt

Extend `packages/contracts/schema/protocol.schema.json` and its generator as
needed; public Rust and TypeScript DTOs must derive from that source. These
logical definitions guide implementation rather than creating a second DTO source.

Every user mutation has `requestId` (UUID), `projectId`, `expectedWorkingRevision`,
`type`, and a typed `payload`. A document edit also carries expected revisions for
all existing blocks it touches. Unknown fields and invalid enum variants are
rejected. S1 intentionally serializes user business mutations against the current
project revision; later AI candidate validation uses scoped dependencies instead
of treating every unrelated project edit as a stale model result.

Successful receipts contain `requestId`, `workingRevision`, resulting/tombstoned
block revisions for affected IDs, `historyRevision`, `cursor`, `undoCount`,
`redoCount`, committed event sequence and a flag indicating canonical normalization.
When normalization changes the submitted representation, the client reads the
canonical document before replaying buffered edits. Receipts contain metadata,
not old body/file payloads; querying an old receipt is not a historical document
read. Rebase only if the fetched revision matches that receipt; otherwise enter
conflict recovery rather than merging over an unknown base. No-op commands return
a receipt without advancing revision, creating history or clearing redo.

Store the canonical request digest and outcome keyed by request ID. Check an
existing receipt before expected-revision validation: an identical retry returns
the original outcome; a changed payload with the same ID returns
`REQUEST_ID_CONFLICT`. A network timeout never authorizes using a new ID for the
same unresolved mutation. The client queries its receipt or resends identical
bytes; a known-rejected operation is reissued with a new ID only after recovery.

### 4.2 Commands and structural primitives

| Command                       | Payload and result                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `StartManualDraft`            | No body payload; outline-to-empty-draft transition, only when no draft exists                    |
| `ApplyDocumentEdit`           | Atomic ordered primitive operations plus edit-group data; validate complete resulting document   |
| `CommitManuscriptImport`      | Prepared import ID/hash, mode `start`, `append`, or `replace`, expected document revision        |
| `AddSourceLink`               | URL and optional title; create one source membership entry without fetching                      |
| `AddSourceFile`               | Completed upload/import artifact ID/hash and display metadata; create source membership          |
| `RemoveSource`                | Source ID and expected source revision; remove membership, retain referenced objects             |
| `UndoProject` / `RedoProject` | Expected `historyRevision` and cursor in addition to project revision                            |
| `CloseEditGroup`              | Group ID and expected group sequence; close grouping metadata without another user history entry |

`ApplyDocumentEdit` uses a discriminated primitive set: `insertBlock` (fresh block,
preceding block ID or null for document start), `setBlockContent` (runs),
`setBlockAttributes` (kind/attributes), `deleteBlock`, and `moveBlocks` (ordered IDs
plus destination predecessor). Resolve all positions from IDs. Reject missing IDs,
duplicate insertion, cycles/invalid nesting, unknown fields or partial references.
Client split/merge/section movement becomes a single batch of these primitives.
Compute actual before/after differences and affected section/list blocks in the
core; do not trust a client-provided affected-ID list. A normalized no-op remains
a no-op even if the client claims it changed content.

Execute commands in this order:

1. Authenticate/validate the closed request envelope and find any prior receipt.
2. Validate expected project, history and touched-block revisions.
3. Load current business state, apply the batch in memory, validate the resulting
   canonical document and derive actual affected fields/IDs.
4. Run the shared mutation-policy port, including structural impact. S1 has no
   production user locks/leases; its policy has empty restrictions. Test injected
   restrictions to prove edits, import and history share this enforcement point.
5. Write/verify immutable payloads, then in one short database transaction recheck
   preconditions and commit state, counters, history, receipt and outbox event.
6. Acknowledge only after commit; publish events after commit.

The mutation policy is the seam later used by S3. Do not create a fake lock UI or
claim production locks passed S1 acceptance. The policy reports `CONTENT_LOCKED`
or `TASK_USING_CONTENT` when a configured restriction blocks an actual change.

## 5. Autosave, composition, and conflict recovery

### 5.1 Scheduling and ordering

Paint local edits immediately. Debounce saving by 300 ms after changes and flush
at most two seconds after the first unsent change, except while IME composition
is active. Do not send intermediate composition text. Queue at most one in-flight
business mutation per project/client; keep subsequent local edits in a buffer.
After acknowledgment, rebase that buffer over the canonical receipt and send the
next batch with current revisions. A late acknowledgment cannot clear newer local
changes or show saved prematurely.

Flush and close the active typing group before project undo/redo, a structure
command, import commit, source membership command, or controlled project switch
and close. If a source command is submitted while typing, queue it after the flush.
Blur triggers a flush; it does not have to create an extra history step unless it
ends the typing group. Loading, navigation, selection and save-status ticks do not
create history entries.

### 5.2 Failure and restart

On known storage/validation failure, keep the last acknowledged core state and
unsaved local buffer distinct. Leave text available for copying/recovery, show
the error and stop dependent commands. Explicit retry can resend recoverable
local changes; do not loop on a failing disk or silently overwrite the core state.

On a transport failure with uncertain commit, resolve the original request ID
before accepting new dependent mutations. If a stale client receives
`REVISION_CONFLICT`, keep its buffer and load the latest authoritative snapshot.
Offer to keep/copy local edits or reload the saved document; no automatic
whole-document overwrite or speculative multi-writer merge. Reapplying local edits
requires explicit user action against the new base.

On controlled desktop close, attempt a flush and wait for its receipt. If it fails,
offer retry, cancel close, or explicitly close with unsaved changes. Browser unload
uses the available unsaved-change warning; it cannot promise a final async save.
Unexpected process/browser failure can lose an unacknowledged local buffer. Do
not call an edit durable until its transaction is acknowledged.

On reopen, load core state, history, cursor and receipts. Close any interrupted
typing group at its last committed state; do not reconstruct or replay keystrokes
from browser storage. A successful restart test asserts only acknowledged edits.

## 6. Persistent five-step history

### 6.1 Bound and grouping

Represent history as entries `E1..En`, where `0 <= n <= 5`, with a cursor `c` in
`0..n`. Available undo count is `c`; available redo count is `n-c`. Example:

```text
S0 --E1--> S1 --E2--> S2 --E3--> S3 --E4--> S4 --E5--> S5
                          ^ cursor 2: undo 2, redo 3
```

At the end of history, the sixth new operation evicts the oldest transition and
advances the retained baseline. After undo, a new non-no-op user mutation removes
the redo tail before appending its own entry. Navigation, extraction completion,
autosave acknowledgments and no-ops leave the tail unchanged.

One structural action, source add/remove, or import commit is one entry. Continuous
typing in the same block is one entry until a 750 ms idle gap, selection/focus
movement, another command, composition boundary requiring a different scope, or
undo/redo closes it. Timing is a grouping policy; the 300 ms save interval does
not create separate entries. In-flight committed batches update the same group's
after-state while its original before-state remains fixed. Each batch gets its
own immutable receipt; later grouping must not rewrite previous command outcomes.

Use `clientSessionId`, `groupId`, `groupSequence` and `kind` (`typing` or `discrete`)
in edit commands. Each opened client generates a new session ID for grouping;
this ID is not an authentication or authorization credential.
The core verifies the group is current, sequential, from the same client session
and affected block, and still at the history endpoint. It may close an incompatible
group and require/start a new one; never let client labels merge unrelated changes.
The UI creates a fresh group after an idle boundary even if the previous group has
not yet been explicitly closed. An interrupted session cannot reopen an old group.
`CloseEditGroup` changes grouping metadata only, with no working revision, history
entry or redo-tail change. Closing an open group advances `historyRevision`; a
repeated close is an idempotent no-op. This invalidates stale history requests.

The implemented manual client tracks idle gaps from input events and captures
separate local action boundaries before transport. The core does not infer an idle
gap from receipt/commit arrival times: delayed transport and the two-second save
window can legitimately separate batches of continuous typing. Core grouping
still verifies session, sequence, actual single-block content scope, open status
and the current history endpoint. A no-op can acknowledge group sequence metadata
without closing any group, advancing history, or removing redo.

### 6.2 Snapshot and replay rules

Business snapshots contain workspace stage, current ordered document content and
source membership metadata; content/file/extraction payloads remain references.
Revision counters, events, receipts and worker status are not rolled back. Every
new business mutation or replay advances `workingRevision`; changed/restored blocks
get fresh revisions. History cursor changes also advance `historyRevision`.
Extending an open history group advances history revision even if its cursor and
entry count stay the same, so stale undo requests are detectable.

Retain at most six immutable business-state snapshots for five transitions, sharing
adjacent snapshot references. When an open group's after-state is replaced, release
its previous reference unless another retained/live operation needs it. Each entry
also records affected fields/IDs and before/after hashes. Undo/redo derives its
inverse/forward change only for those fields, validates the current expected side
and mutation policy, and commits atomically. Do not restore the entire database.

Derived extraction records and future AI replies/results remain outside snapshots.
Undoing an add-source operation removes membership but does not resurrect/cancel
an old parser process. Redo restores membership using retained objects and any valid
extraction result; if none exists, leave it interrupted until explicit retry. No
parser run is needed to redo an imported manuscript because its parsed body is
retained in the history payload.

Empty history returns `HISTORY_EMPTY`. A mismatched cursor/revision returns
`HISTORY_CONFLICT`. A policy/replay conflict returns `HISTORY_BLOCKED` with affected
IDs and reason. None changes state, skips an entry or advances the cursor. S3 will
add review/lock fields to this same machinery, not an independent history stack.

## 7. Sources, extraction, and manuscript import

### 7.1 Sources and upload

A source stores ID, revision, kind `link | file`, title/display name, URL or object
reference, MIME type/hash/size, and input provenance. A file's display name is not
a storage path. Extractions are keyed separately by source content hash and parser
version, with `queued`, `running`, `ready`, `failed`, or `interrupted` status and
warnings. Their completion does not create a user history operation.

Links accept `http`/`https` without embedded credentials. Store submitted metadata
and evidence level `link_only`; do not fetch, crawl, or imply verified full-page
access. Opening a link uses a validated external-link platform operation. Removing
a source changes membership only, never manuscript text.

Browser upload and desktop selection both copy bytes through a bounded intake
service into `staging/`. Use an intake ID for progress, completion and cancel. Verify
size and hash, promote to immutable objects, then attach by an explicit source
command. Cancelling/failing intake creates no source membership/history entry.
Desktop file access stays behind the file-picker/main-process capability; never
expose arbitrary filesystem paths to the renderer or generic core API.

Add-source commits quickly after intake. Extraction then runs outside the transaction
through `workers/document`. On failure keep the file source and show why extraction
failed; explicit retry may create another utility attempt. Restart marks ambiguous
running attempts interrupted. Removing a source fences applicability of late results;
they can be cached by content hash but cannot recreate removed membership. Re-adding
the same bytes may reuse verified extraction, while membership still has its own ID.

### 7.2 Format rules

| Format   | Required conversion and evidence                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TXT      | UTF-8, UTF-8 BOM, or BOM-declared UTF-16; reject undecodable data instead of replacing characters; blank lines divide paragraphs                           |
| Markdown | Parse an AST; map supported headings, paragraphs, lists, marks and links; preserve referenced-image metadata with warnings, never fetch image URLs         |
| DOCX     | Extract supported semantic text/structure using a tested parser; keep paragraph/heading references; no macro/embedded-object execution                     |
| PDF      | Extract available text in page order with page references; warn that columns/layout reading order may need correction; no claim of lossless reconstruction |

Unsupported tables, block code, styles and layout use a documented plain-text
fallback in the preview and extraction warnings. Ignore executable raw HTML and
never execute embedded content. Encrypted/unreadable files fail with a specific
code. A scanned-only PDF with no text remains a file source marked
`SOURCE_TEXT_UNAVAILABLE`; manuscript import is rejected instead of succeeding
with an empty body. Mixed PDFs retain extracted pages and identify pages without
text. No OCR is required in S1.

Keep original file bytes, embedded-image presence metadata and parser provenance.
S1 does not interpret images or insert them as spoken text. Images that have not
been extracted remain labeled unprocessed; S2's multimodal integration must add
explicit visual inputs and capability validation before claiming they were read.
The PDF/docx parser may not make outbound requests to resolve external resources.

### 7.3 Prepare and commit import

Parsing creates a prepared import with its ID, input hash, parser version,
canonical candidate document, warnings and preview. It does not change project
body or user history. A failed/cancelled preparation leaves current text untouched.
For an empty source file, show that no manuscript content was found and do not
replace current text. Starting an empty draft remains a separate explicit action.

After the user selects start/append/replace, validate the saved current document
revision, target scope and resource limits again, then commit once. If the body
changed during preparation, require a fresh preview/confirmation against the new
revision; never commit with the old revision or append into an unexpected document.
An import does not automatically add the file to reference sources. The operation
retains enough input provenance and parsed payload for recovery/undo independently
of external files. Retrying commit with its request ID cannot duplicate paragraphs.

Use content hashes to deduplicate byte payloads, not user operations: two intentional
imports can create different blocks; a duplicate receipt cannot. Retain prepared
imports while the preview is active; discard after cancel or successful promotion,
and reconcile abandoned preparations on reopen. Preserve all referenced payloads.

## 8. Persistence, migrations, and retention

The Rust core owns project writes. Domain/application modules do not depend on
Axum, Electron, Tiptap, concrete SQL or parser libraries. Infrastructure implements
repository, object-store, document-worker and platform adapters. Worker code never
opens `project.sqlite` or edits current body/history rows.

Applied migration `002_manuscript.sql` moves bootstrap schema version 1 to 2 for
the manual editing foundation. Append `003` for bounded history and `004` for
sources/import as delivery steps 2 and 3 land; do not rewrite applied 002. The
shared AI ledger reserves later stages. Each migration needs transactional
rollback/reopen evidence. Table responsibilities across the complete S1 stage are:

| Table                                      | Keys and invariant                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `manuscripts`                              | One row per project; unique project ID, stable manuscript ID, stage/schema version/document revision          |
| `blocks`                                   | Stable block ID, manuscript ID, position, kind/attrs, current revision/content hash; unique document position |
| `object_identities`                        | Unique ID, type, revision high-water mark and tombstone flag; never recycle identity                          |
| `content_revisions`                        | Unique object/revision, immutable payload hash; records only retained referenced content                      |
| `sources`                                  | Source membership and revisions; object/URL kind consistency                                                  |
| `source_extractions` / `document_attempts` | Source hash/parser identity and fenced utility-run state, independent of history                              |
| `history_entries` / `history_cursor`       | Ordered five transitions, snapshot hashes/touched fields, cursor and monotonic history revision               |
| `edit_groups`                              | Current group/session/sequence, before snapshot and current after reference                                   |
| `command_receipts`                         | Unique request ID plus digest/outcome/revision; unresolved-client replay support                              |
| `project_events`                           | Monotonic outbox sequence and safe typed payload                                                              |
| `prepared_imports`                         | Preview/input/canonical result references and applicability state                                             |

Persist object bytes under content-addressed `objects/`; use `staging/` for incomplete
files and `cache/` only for rebuildable derived data. Source extraction outputs still
used by review/history are referenced objects, not freely deletable cache. SQLite
foreign keys and application validation prevent dangling references. Position
updates must handle uniqueness without partially exposing moved documents.

Use WAL, explicit `synchronous=FULL` initially and short blocking database work off
the async request thread. Keep the existing project directory owner lock. Take a
consistent SQLite backup before upgrade; never copy only the live main file while
ignoring WAL. Reconcile and verify referenced objects on recovery. Migration from
the bootstrap preserves project ID/title, keeps `approved_baseline = null`, starts
empty manuscript/history state and never invents user content or approval. Reject
newer schema versions with a typed message and no writes.

Garbage-collection roots include current document/sources, up to six business
snapshots, in-flight command preparations, active imports/extractions, and
registered external provenance references. The high-water identity record does not
require keeping every old text payload. Five history entries do not bound total
database size or authorize deleting source bytes still in use. Test a fake external
artifact reference; do not implement media provenance UI in S1.

Garbage collection takes a consistent root set under the core writer coordinator,
so objects cannot disappear between validation and commit. Reclaim unreferenced
payloads after a safe grace period and reconciliation, not while an intake/command
is promoting them. Retain compact request ID/digest/outcome receipts throughout the
project lifetime in S1; they contain metadata only and do not pin old document
payloads after history expires. A future receipt compaction policy must preserve
duplicate-request rejection semantics.

## 9. API, events, and error contract

Keep existing health/project endpoints compatible. Extend authenticated loopback
HTTP and the narrow desktop bridge with these operations; names below specify
the proposed S1 transport mapping:

| HTTP mapping                                | Purpose                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/manuscript`                        | Current canonical document and working revision                         |
| `GET /v1/history`                           | Current working/history revisions, cursor, counts and operation labels  |
| `POST /v1/manuscript/commands`              | Closed union of user business commands                                  |
| `GET /v1/commands/{requestId}`              | Resolve an uncertain command by its receipt                             |
| `GET /v1/sources`                           | Source metadata and extraction summaries, cursor-paginated              |
| `POST /v1/intakes`                          | Stream one bounded input file into staging; return intake identity/hash |
| `POST /v1/document-jobs`                    | Explicit prepare-import/extract/retry/cancel utility action             |
| `GET /v1/document-jobs/{jobId}`             | Progress/result metadata for preview/extraction                         |
| `GET /v1/source-extractions/{extractionId}` | Scoped extracted text with pagination; no arbitrary object/path lookup  |
| `GET /v1/project/events?after={sequence}`   | Reconnectable SSE of committed changes/status                           |

An intake request is streamed as raw bytes with bounded metadata headers. It does
not use base64 inside the JSON command envelope. Accept a supplied intake UUID so
an interrupted transfer can be resolved/cancelled; incomplete data never becomes
a usable artifact. The initial implementation may restart a failed transfer rather
than support chunk resume. DELETE of the scoped intake cancels/removes staging.
Desktop bridges only these named operations and scoped streams/subscriptions.

Increase JSON request limits per route; the bootstrap's global 16 KiB body limit
cannot accept manuscripts/uploads. Keep small-route limits and use streaming
limits for files. The current client's fixed ten-second timeout must be split:
short commands remain short; extraction returns a job ID immediately and completes
asynchronously; uploads have explicit progress/cancel. Expand JSON Schema and the
desktop allowlist together; do not expose a general URL fetch or filesystem API.

Events are `manuscript.changed`, `history.changed`, `sources.changed`, and
`documentJob.changed`, with project ID, monotonic sequence, originating request ID
when present, revisions and affected IDs. Business commits advance working revision;
parser progress/status only advances event sequence and its own attempt metadata.
Events do not contain full file bodies. Keep at least the latest 1,000 events;
clients requesting an expired cursor receive `resync_required` and reload snapshots.
Replay never re-executes a command, upload or parser. Desktop subscription cleanup
must remove listeners when the view/project closes.

The error envelope has `code`, `requestId` when available, safe `details`, and
optional current revisions/conflicting IDs. Use stable codes:

| Status    | Codes and meaning                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| 400       | `INVALID_REQUEST`, `DOCUMENT_INVALID`, `INVALID_URL`, `REQUEST_ID_CONFLICT`                                           |
| 404       | `PROJECT_NOT_FOUND`, `OBJECT_NOT_FOUND`, `COMMAND_NOT_FOUND`                                                          |
| 409       | `REVISION_CONFLICT`, `HISTORY_CONFLICT`, `CONTENT_LOCKED`, `TASK_USING_CONTENT`, `HISTORY_BLOCKED`, `IMPORT_STALE`    |
| 413       | `INPUT_TOO_LARGE`, `DOCUMENT_TOO_LARGE`                                                                               |
| 422       | `HISTORY_EMPTY`, `SOURCE_UNSUPPORTED`, `SOURCE_ENCRYPTED`, `SOURCE_TEXT_UNAVAILABLE`, `TEXT_ENCODING_UNSUPPORTED`     |
| 500 / 503 | `STORAGE_UNAVAILABLE`, `WORKER_UNAVAILABLE`, `MIGRATION_FAILED`, `SCHEMA_UNSUPPORTED` where transport startup permits |

Long-running parser failures appear in job results as `DOCUMENT_PARSE_FAILED`,
`DOCUMENT_PARSE_TIMEOUT`, `DOCUMENT_RESOURCE_LIMIT`, or `DOCUMENT_JOB_INTERRUPTED`.
Localize their presentation. Invalid data, failed extraction and storage errors
must remain distinguishable. Never return raw SQL, paths outside the project,
private document content in diagnostics, or an arbitrary worker stack trace.

## 10. Development tasks and dependencies

T01–T12 have implementation evidence across steps 1–3, including T05 import entry
and T07–T08 history. T13 has Linux/browser/fault and measured performance evidence;
native target-platform and performance-budget acceptance remains open. See the
linked reports for concrete coverage and limitations.
Deliver small vertical changes with tests; task IDs
are units within this single stage spec, not separate documents or branches that
the current instruction asks to create. Tests/localization belong to each task.
In the table, `Tnn` means `S1-Tnn` and `ACnn` means `S1-ACnn`.

| Task   | Work and concrete deliverable                                                                                                   | Depends on              | Acceptance                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------- |
| S1-T01 | Define canonical document/command/error schemas and generate Rust/TS types; pin tested editor/parser dependencies as introduced | Existing bootstrap      | AC01, AC02                   |
| S1-T02 | Implement pure canonical validation, identity/revision rules, structural primitives and mutation-policy port                    | T01                     | AC02, AC03, AC17             |
| S1-T03 | Add migration 002, object store, repositories, snapshots and atomic receipt/outbox writes                                       | T01, T02                | AC04, AC14, AC15             |
| S1-T04 | Add user command dispatcher, replay receipts, revision checks and authenticated API/desktop command bridges                     | T02, T03                | AC03, AC12, AC13             |
| S1-T05 | Add start/import entry states and Tiptap canonical adapter with stable IDs, formatting, lists and heading navigation            | T01, T04                | AC01, AC02, AC03             |
| S1-T06 | Implement serialized autosave queue, composition support, status UI, flush and conflict recovery                                | T04, T05                | AC05, AC06, AC12             |
| S1-T07 | Implement five-transition history, group validation, inverse replay, cursor persistence and retention roots                     | T02, T03, T04           | AC07, AC08, AC09, AC17       |
| S1-T08 | Route editor/toolbar/keyboard undo to project history; integrate typing boundaries and controlled close                         | T05, T06, T07           | AC05, AC07, AC08, AC09       |
| S1-T09 | Implement link/file source commands, bounded intake, source panel and source-membership history                                 | T04, T06, T07           | AC10, AC11, AC16             |
| S1-T10 | Add document worker protocol/process supervision, extraction adapters, progress/cancel/fencing and parser fixtures              | T01, T03, T09           | AC10, AC11, AC16             |
| S1-T11 | Implement prepared manuscript preview/start/append/replace, atomic import and history integration                               | T05, T06, T07, T10      | AC01, AC09, AC11, AC12       |
| S1-T12 | Complete event subscriptions/reconnection, receipt reconciliation and reference-safe garbage collection                         | T04, T07, T09, T10, T11 | AC12, AC13, AC14, AC16, AC18 |
| S1-T13 | Run restart/fault/import/browser suites and performance fixtures; validate desktop-specific operations on target hosts          | T08, T11, T12           | AC01–AC18                    |

Suggested delivery checkpoints: T01–T05 provide durable manual editing; T06–T08
make autosave/history reliable; T09–T11 complete source intake/import; T12–T13
establish recovery and stage evidence. Tasks may be reordered when interfaces are
ready, but S1 is complete only when its whole acceptance set has evidence.

## 11. Acceptance cases and test mapping

`S1-AC*` IDs are specific to this spec. `SW-*` refers to the parent workbench plan;
partial mappings below do not claim that later AI/review/lock workflows have passed.

| ID      | Given / when                                                                          | Required observable result                                                                                                                | Level / parent mapping                   |
| ------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| S1-AC01 | New/bootstrap project; start empty or import existing manuscript                      | Correct draft transition; empty placeholder is not saved content; undo/redo restores stage/body without parser calls                      | Integration/browser; SW-04               |
| S1-AC02 | Chinese/English/emoji, marks, headings, nested lists; edit/save/reload                | Canonical/editor round trip retains supported content/IDs; Unicode offsets and schema limits validated; unsupported nodes rejected        | Domain/adapter/browser; SW-29 partial    |
| S1-AC03 | Split, merge, delete or move a section; fail one primitive                            | Correct surviving/new/tombstoned IDs, derived structure and fresh revisions; failed batch changes nothing                                 | Domain/integration; SW-16 partial        |
| S1-AC04 | Migrate bootstrap; inject migration failure; open newer schema                        | Preserve project identity, recover old usable state/backup, reject newer schema without writes                                            | Storage/restart; SW-28                   |
| S1-AC05 | Continuous typing/IME with delayed/out-of-order transport response                    | Responsive local text; no intermediate IME save; serialized writes; saved only after all visible edits acknowledged                       | Browser/integration; SW-05               |
| S1-AC06 | Disk full/save failure/conflict followed by controlled close                          | Keep unsaved buffer, block dependent commands, offer recovery; explicit decision required to lose unsaved input                           | Fault/browser; SW-05                     |
| S1-AC07 | Six or more distinct operations; five undos then five redos                           | Only five transitions retained; return to retained baseline and previous endpoint; saved typing batches remain one group                  | Domain/storage/browser; SW-17, SW-18     |
| S1-AC08 | Undo twice, navigate/save/no-op, then type a new edit                                 | Navigation/save/no-op preserve redo; first real new mutation discards tail; toolbar and shortcut agree                                    | Domain/browser; SW-18                    |
| S1-AC09 | Close/crash after acknowledgment while history cursor is in the middle                | Reopen same body/cursor/redo; close old group; undo/redo advances revision tokens and runs no parser                                      | Restart; SW-19, SW-22 partial            |
| S1-AC10 | Add/remove link or uploaded reference; edit original external file                    | Body unchanged; URL remains link-only; project retains imported original bytes independently of external paths                            | Integration/browser; SW-23               |
| S1-AC11 | Prepare valid/corrupt/encrypted/scanned/oversized imports, then append/replace/cancel | Useful preview/warnings; success atomic and one history entry; failure/cancel preserves body; no empty scanned-PDF success                | Worker/integration/browser; SW-04, SW-23 |
| S1-AC12 | Timeout after commit or edit while import preview is open                             | Original request resolves once; changed payload with same ID fails; stale import cannot overwrite changed body                            | API/integration; SW-26 partial           |
| S1-AC13 | Unauthenticated/invalid-origin calls or desktop request outside allowlist             | Reject without state change; scoped operations work in browser and desktop; renderer gets no generic file/API access                      | API/platform                             |
| S1-AC14 | Crash at object write, transaction commit, or garbage collection boundaries           | Either entire mutation/history/receipt committed or none; no incomplete reference or deleted live object                                  | Fault/restart; SW-27                     |
| S1-AC15 | Prune oldest history while fake external artifact holds an old payload                | Release unreferenced payloads; preserve referenced originals and identity high-water marks; no media feature required                     | Storage; SW-30 partial                   |
| S1-AC16 | Extraction completes after source removal/undo or worker crashes                      | No recreated membership/history entry; late attempt fenced; redo uses retained result or interrupted status, no implicit rerun            | Worker/storage; SW-21 partial            |
| S1-AC17 | Inject protected IDs into mutation policy; edit/import/undo/redo across them          | Consistent rejection including structural descendants; no partial mutation, cursor movement, or skipped history; no production lock claim | Domain/integration; SW-12, SW-20 partial |
| S1-AC18 | Reconnect beyond retained event cursor or replay already seen events                  | Snapshot resync when required; deduplicated UI updates; no re-executed business commands or parsers                                       | API/browser                              |

Additionally measure the 50 KB, 500 KB and 2 MB fixtures in the parent performance
plan. Record p50/p95 typing, flush/save and undo latency; retained snapshot/object
bytes; total process memory and environment. The target budgets there are unmeasured
until recorded. Investigate decoration updates/serialization/SQL before replacing
bounded snapshots with a more complex delta format.

## 12. Completion evidence

Run relevant existing checks as implementation lands: `pnpm check`, `pnpm build`,
`pnpm test:integration`, and `pnpm test:e2e`. Add meaningful domain, parser and
restart cases to these workflows. No provider request or video render is needed
to demonstrate S1 behavior.

The stage report must link S1 tasks/acceptance IDs to actual tests and outcomes,
state skipped cases, and include migration/restart evidence, import format fixtures,
bounded-history verification and performance measurements. Browser evidence does
not certify Windows/macOS dialogs, shortcuts or close behavior. Validate those on
the respective target systems, and label any remaining platform gap explicitly.
Shipping/distribution packaging remains a later milestone.

S1 handoff to S2 consists of the canonical editor/storage contracts, source evidence,
project history, mutation-policy seam, object intake and non-AI document worker.
AI integration consumes these interfaces; no provider imports or model configuration
are added to S1 manuscript/editor modules.
The [shared AI spec](shared-ai-integration.md) implements those infrastructure
ports through a common application unit of work without importing script models.
Its migration ledger follows S1's schema versions 2–4 with shared AI at version 5.
S1 editing/import/history must remain usable without any provider configuration,
even after later project migrations add AI execution tables.

## 13. Step 3 implementation limits

The document utility protocol is version 1 with pinned portable Node parsers.
One utility runs at a time, at most 16 jobs are queued/running, output is bounded,
and Linux supervision samples RSS against 512 MiB in addition to the 60-second
wall limit and V8 old-space setting. Windows/macOS still need actual working-memory
budget enforcement and native evidence; process separation/V8 settings are not full
OS isolation. Recovery abandons active previews and incomplete intakes, fences
attempts and collects unreferenced objects with a 60-second grace period on reopen.
Explicit artifact pins and prepared/import/source roots share the promotion writer
coordinator. Applied migration 004 and old immutable business roots remain immutable.
The [step 3 report](../validation/step-03.md) records supported format fallbacks,
measured budget misses and the exact remaining acceptance gaps.
