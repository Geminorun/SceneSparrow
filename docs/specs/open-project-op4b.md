# OP4-B: recorded Agent work copies and protected acceptance

Status: root-frozen assignment after accepted OP4-A `2823f6a`, 2026-11-19.
Concrete native and generated-contract requirements are frozen in the
[B handoff](open-project-op4b-handoff.md), which is part of this assignment.
Parent [OP4](open-project-op4.md) owns the product contract. B implements
OP4-T04–T07 and must not replace A's journal/receipt/history coordinator.

## User workflow

From the existing application menu, choose external Agent work. If this is an
existing pre-registration format project, offer explicit inventory registration
after settling captured input and showing its meaning. Registration is neither
approval nor a hidden Save. The work-copy flow chooses allowed paths/subtrees,
optional manuscript block scope and Library context, then creates one core-owned
record. The ordinary creative copy is edited by an external tool. SceneSparrow
does not host that tool, issue provider calls or execute its output.

Also offer explicit inspection of live external changes at the registered creative
root. Record a work item with a distinct live origin and a core-produced physical
observation, rather than silently accepting the current filesystem as a new base.
It uses the same scope/diff/policy/receipt workflow. Live accept can confirm already
present candidate bytes; discard restores the captured accepted graph through A's
checked journal. Both refuse a later changed observation. No renderer-selected
server path and no automatic adoption of media/manifest edits are introduced.

Changes shows the recorded scope, base, files added/removed/replaced and bounded
readable text differences. Inspect is explicit. Accept applies the inspected batch
once; discard affects only that copy/candidate. No autoaccept or raw JSON dashboard.
Keep one existing auxiliary-pane owner, a durable compact recovery entry and
three-second localized notices. Do not add a permanent new navigation column.

Desktop reveals only the named registered work-copy location. Web creates and
inspects its server-side registered copy; local browser files do not grant a
server directory. Full portable ZIP exchange is OP5. The final delivery must not
leave Web exchange permanently unavailable merely because B precedes OP5.

## Named contracts to freeze against A

Generate matching JSON Schema, TypeScript and Rust DTOs; HTTP/preload consumers
must share names and stable codes. Native paths stay behind core/main-process
capabilities. These are operation families, not permission to expose generic I/O:

| Operation                     | Required identity and result                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Read accepted graph summary   | Project ID, graph hash/generation, registered status; bounded paginated file inventory                                                          |
| Register graph                | Original request, project ID, expected working/source revision/hash; receipt + current graph summary                                            |
| Create work item              | Original request, project/base graph, copy/live origin, explicit grant, selected Library IDs; recorded ID/base/scope/status                     |
| List/read work items          | Project-scoped page cursor or recorded ID; compact status, immutable base identity, latest inspection                                           |
| Inspect work copy             | Original request, item ID, expected base graph and work-copy epoch; immutable candidate ID/digest, current policy revision, bounded change page |
| Read candidate changes/member | Recorded item/candidate/member ID and page cursor; bounded text or streamed exact bytes                                                         |
| Accept candidate              | Original request, item/candidate/digest, inspected graph and current working revision; ordinary graph receipt + current snapshot                |
| Discard                       | Original request, exact item/candidate/disposition; definite receipt, never a later live-file overwrite                                         |
| Reveal work copy              | Named item ID through native bridge only; cancel/expired-session outcomes                                                                       |
| Set production file locks     | Original request, project/current revision/graph and exact path/hash targets + locked flag; shared history receipt                              |
| List recovery members         | Recorded operation evidence identity and page cursor; path/role/hash/size/member identity                                                       |
| Download recovery member      | Recorded operation/member identity; authenticated bounded stream                                                                                |

Common command request IDs/digests retain original payload identity. Mutations
must participate in the existing project writer and definite receipt mechanism;
no parallel graph coordinator. Read original receipts before looking up candidate
payloads. Reused IDs with changed payload conflict even after payload pruning.
All new durable business codes must pass receipt-lookup and exact-replay tests.

For acceptance, the ordinary receipt digest covers the full external action,
including item/candidate/observation identities, rather than only an equivalent
graph hash pair. Update candidate disposition within A's same SQL commit, not
after returning its receipt. Extend that existing coordinator with the business
validation/disposition hook; do not wrap it in a second transaction or reacquire
its mutex. Receipt replay precedes pruned work-item/candidate lookup.

Bound pages to 100 records, opaque project/operation-bound cursors and explicit
continuation. Never return all media bytes or a 20,000-file diff in one JSON body.
Text previews are UTF-8 only, at most 128 KiB/member and 120 visible diff lines;
otherwise show hash/size and exact download. Exact binary streams use 64 KiB
buffers. Downloads authorize recorded membership before opening immutable bytes;
relative paths are descriptive, never the resource authority. Equal hashes at
different paths remain distinct members.

Serve arbitrary member files as attachments with safe filenames and a download
content type; do not inline-render uploaded HTML/SVG/code in a privileged app view.
This is a byte-download capability, not a project execution or preview host.

Capture an authorized immutable handle/reader lease under the writer, then release
the project mutex before network backpressure or a native save dialog/copy. Active
readers retain their exact members and close/cancel predictably; collection cannot
remove an in-use version. A slow multi-GiB download must not hold the project writer
for its entire transfer. Extend A's native stream boundary if needed, preserving
membership and session revalidation rather than exposing an object path.

## Core-owned scope and retention

A work item stores immutable base graph/generation, creation revision/provenance,
grant and selected context identities. Grant paths are exact files and subtrees
with segment boundaries; empty grant permits no change. Optional manuscript IDs
narrow actual source impact in addition to its path. A text instruction or edited
base file cannot widen scope. Pin all grant/base/candidate members required for
verification and receipts under the existing collector.

Represent whole-project creative scope with an explicit grant flag/variant,
mutually exclusive with individual paths. It is not the default interpretation of
an empty list and cannot include core metadata. The manuscript scope distinguishes
all permitted source blocks, a nonempty exact ID set, and no manuscript edits;
path permission is still required. Root freezes concrete generated field names
against A before dispatch.

Use an app-selected private work-item root and ordinary independent file copies,
never hardlinks to immutable objects. It contains `project/` and separate
`context/`. Context has the recorded safe scope/base summary and selected retained
Library files; link-only references remain an index of links. Do not fetch links
or invent their contents. Preserve user-owned AGENTS/CLAUDE files in project;
additional core guidance belongs in context, without trusted DB/secrets/tokens.
This directory is not an OS sandbox and is never automatically executed.

Permit at most five retained mutable work-copy roots per project. A user can
explicitly discard an old copy to make room. Completed compact receipts/identities
remain replayable; bulk candidate roots can be released only after definite
disposition and all history/evidence pins are accounted for. Do not silently
delete an externally changed post-accept copy as cleanup. A candidate is immutable;
only the latest inspection is actionable, while original uncertain requests keep
their required evidence. A changed physical copy requires a new inspection.

## Native marker preparation

External tools can add ordinary unmarked paragraphs. At inspection, use A's native
proved binder to materialize an immutable prepared candidate. Retain both original
raw graph/digest and prepared graph/mapping; the original mutable work-copy or live
observation remains the physical revalidation authority. Display actual source
changes and identity preparation before acceptance. Apply only that inspected
prepared graph, with the ordinary text/identity/scope policy.

Persist/reuse preparation by captured raw candidate digest. A lost inspection
acknowledgment or metadata-only reinspection cannot silently assign new random IDs
to the same candidate and retarget acceptance. Invalid/ambiguous existing markers
refuse; do not normalize them into new unlocked identities. Acceptance itself does
not invent new marker bytes. A later changed raw copy requires new inspection.

## Inspection and policy

Compute actual add/delete/replace differences from native hashes. A unique exact
hash pair can be displayed as a rename hint; ambiguity remains add/delete. Verify
the whole candidate namespace, not just claimed changed filenames. Reject grant
escapes, identity/manuscript relocation, protected management/Git aliases and
credential injections. Do not execute dependency imports or trust an Agent's
change list, dependency graph or supplied management database.

An ordinary live root contains its actual core management directory and may have
optional Git state; these stay outside creative inventory and retain their verified
session identities. That presence differs from injecting management/Git into a
submitted private creative copy. Reject aliases and supplied replacements without
claiming that a filesystem owner cannot alter every trusted record externally.

Creative base equality is separate from project metadata revision. Reinspection
may capture newer question/comment/lock state if the immutable creative base is
unchanged. A changed accepted creative graph makes the old work item stale; do not
silently rebase content. A physical-only restoration can also advance operational
graph/source generations while leaving accepted graph content unchanged. Reinspection
may capture those newer generations against the identical immutable base; acceptance
must match the inspected generation. Accept compares the immutable base, current policy/revision,
captured candidate digest, actual work-copy bytes and physical-before graph again.
A lock or downstream use added after inspection can block it. No partial acceptance.

For live-origin items, bind A's immutable physical observation and its full allowed
inventory. Recheck later additions/deletions/replacements and member identities;
an old discard cannot restore accepted files over a newer live edit. Physical-only
restoration leaves accepted prose/locks/approvals/history intact. A live-origin
record does not consume a mutable private-copy slot but does retain its candidate
and uncertain-operation evidence under the same deliberate disposition policy.

Actual Markdown changes use A's native identity/affected-ID proof and current
text locks/reservations. Unchanged locked prose stays at the same revision/anchor
during media-only work. A scoped manuscript grant never permits modifying unknown
unproved structure beyond its IDs. Unknown code/shared production dependencies
expand production scope instead of widening prose editing permission.

Minimal production locks are core metadata keyed by exact accepted portable path
and content hash. Only existing non-manuscript creative files can be locked.
Manifest identity/path remain structurally protected; name-only changes have no
production impact. Explicit lock/unlock operations are versioned project history,
without source edits or automatic prose/production approval. Candidate bytes can
never unlock files. An empty text-locked project has no implicit production locks.

In the absence of a proved production dependency graph, any non-manuscript content
or declaration change conservatively affects the production file set (including
shared components/dependencies). It refuses while a production lock or active
downstream consumer intersects that scope. An AI question/review reservation alone
does not block unrelated media. A graph transition, Undo and Redo revalidate this
policy. Undoing an explicit lock/unlock follows the same deliberate history policy
as existing text locks; it is not an Agent candidate permission.

Narration declarations report source-ID/revision availability and divergence as
provenance, without claiming current synthesis/alignment. Historical references
and adapted spoken text do not imply permission to rewrite locked Markdown.

Report A's unsupported file/directory prefix transition with a localized specific
capability explanation. Inspection/acceptance cannot claim it succeeded or offer
an automatic destructive workaround. The original files and candidate remain
available for an explicit external restructure; ordinary supported changes still
use the same candidate flow.

For pre-registration manifest-name/display-title mismatch, offer an explicit
choice to use the manifest's name for display through the existing pre-registration
rename/CAS receipt, then register after verified readback. Retain that original
request on uncertain outcome. Do not silently bless a mismatch or change a live
untracked manifest as an unjournaled automatic fix. After registration, normal
rename uses A's one graph/name/history operation.

Registered normal rename also belongs to the shared ProjectSession queue. The
current App rename handler assumes metadata does not own manuscript revisions;
A's registered graph rename now advances working/history/source generations.
Settle only captured input, preserve the original rename DTO, consume its ordinary
receipt and current snapshot/history, and retain newer local input. Legacy rename
retains its previous metadata behavior. A generic metadata storage response alone
cannot prove nonapplication: inspect original command receipt/recovery state before
retiring an uncertain request. Test rename during pending input, lost readback,
later typing and source/name history; no remounted editor or duplicate queue.

Capture native candidate preparation and its stable pins under the same writer
transaction before releasing inputs to collection. Do not compose a public
mutex-taking inventory/preparation call and a later separate pin write across a
collector gap. B can extend A's writer-held seams without introducing a parallel
project coordinator.

## UI input and uncertain outcomes

Keep work-copy presentation outside the Markdown buffer. Settle only captured
pending source/planning input through ProjectSession before base capture or
acceptance. Revalidate session/root/input generation after every prerequisite
await; later input cannot be erased or dispatched early. Typing/composition cannot
globally disable unrelated controls. Preserve focus/caret and native IME keys.

Original uncertain request IDs/payloads remain owned until ordinary receipt or
durable rejection proves outcome. A failed postcommit readback cannot submit a
new accept or duplicate history. Display original receipt separately from the
possibly newer current snapshot. A candidate/member read completing late cannot
retarget accept, clear a new proposal or close a newer recovery choice.

## Verification and frozen handoff

Real-core fixtures cover captured grants/context, management aliases/injection,
stale creative base versus metadata-only reinspection, candidate modification
after inspection, locked prose A plus media acceptance, locked A edit rejection,
separate production shared-file protection, late lock/task, grouped five-history
Undo/Redo/reopen, approved evidence and unchanged mock SDK count. Exercise duplicate
and lost-ACK acceptance, changed-payload collision and durable rejection replay.

Test paging/member authorization, identical-content different paths, foreign cursor,
binary streaming, work-copy retention, no mutable hardlinks and no inspection
execution. Browser tests cover real creation/inspection/acceptance, held reads and
late outcomes with newer input, stable IME/caret, localized top feedback and
durable recovery. Desktop capability tests cover cancellation/session expiry.
Run affected contracts/type/format/native/HTTP/Node/source and legacy regressions;
broaden shared-writer tests only for material new changes/failures.

One fresh gpt-6.1-sol/high writer; root owns specs, reports and Git. No child agents,
staging/commit/push/branch/worktree/deploy/provider or environment publication.
Preserve `.agents/`. Source scripts/cloud-env.sh every shell; every Rust-invoking
command/wrapper sets both zero-debug profiles and CARGO_BUILD_JOBS=4, no parallel
Cargo. Freeze all writes/owned checks/processes before `.artifacts/op4b/HANDOFF.md`
and root's independent review. Exact accepted A seams and protocol names remain
to be inserted by root before dispatch.
