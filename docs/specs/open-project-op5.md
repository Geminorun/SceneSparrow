# OP5: explicit migration and complete portable packages

Status: root-owned contract, 2026-11-19. OP5-A is frozen after accepted OP4-B
`77c0044`; see its separate brief/handoff. OP5-B/C remain preparation until their preceding checkpoints pass. Parent: open-project-format.md,
OPF-AC13–AC15/17/19. Root owns design/specs, one writer per checkpoint and Git.

## Delivery tasks and sequential checkpoints

OP5-T01: read-only legacy inspection and consistent verified backup.
OP5-T02: staged conversion preserving project/business identities and evidence.
OP5-T03: validation, copied-job fencing and explicit activation.
OP5-T04: immutable fixed-generation complete package capture and streaming ZIP.
OP5-T05: bounded ZIP intake/inspection and independent verified restore.
OP5-T06: returned work-copy intake through OP4's recorded candidate base.
OP5-T07: named platform operations, accessible UI and interoperability evidence.

Use OP5-A for T01–T02 and T03 native conversion/verification/fencing plus named operations needed
to exercise it, then [OP5-B](open-project-op5b.md) for the package backend and
[OP5-C](open-project-op5c.md) for visible workflows/streaming platform adapters.
The exact assignment brief follows the prior accepted checkpoint. OP5 is not
accepted at A alone; actual host activation/session switching has the OP6 gate. Append migrations after delivered versions; no old SQL edits.
No destructive conversion of real projects, autoactivation, inference or code
execution during inspection. Root owns docs and acceptance summaries.

## Read-only inspection before mutation

Identify legacy storage without calling mutable repository open, running schema
migrations, closing edit groups, reconciling jobs or collecting objects. Inspect
the existing SQLite snapshot, schema and retained closure. A read-only connection
must include committed WAL state rather than inspect only the main file; fixtures
exercise a still-open WAL producer. Do not claim filesystem immutability for
SQLite's necessary read locks, but preserve all source bytes/business state.

Before conversion, create a verified consistent SQLite backup and copy its entire
retained object/export closure. Hash/verify every required member. Existing
consistent backup machinery may be extended; a bare SQLite main-file copy is
invalid. Keep backup and failed staging outside the source's active files and
exclude recursive backup trees from closure. Missing retained objects fail before
activation. A backup completion marker is written last and flushed.

Capture the SQLite read snapshot before deriving its object inventory. Backup
and inventory must describe that same committed WAL snapshot; a later independent
read of the live source can mix generations. Copy and verify immutable closure
against the backed-up database. If concurrent source collection removes a needed
object, fail the new target before activation rather than filling it from a newer
generation. Inspection must not create a source lock file merely to claim it is
read-only. Apply schema upgrades and copied-origin fencing only to the staged copy.

Migration uses an explicit operation ID, captured source project/revision/schema
and a new distinct target. Desktop chooses a native destination capability;
Web uses an app-selected server-side registered location, not a renderer path.
Target must not exist. Replaying the same operation returns its original result;
changed target/base with the same ID conflicts. No failure is automatically retried
as a new migration ID. The original directory remains intact and usable.

## Conversion and identity preservation

Produce standard project.json/manuscript.md plus .scenesparrow management and a
complete verified closure in a staging sibling. Preserve project/manuscript/block
UUIDs, high-water revision tokens, user locks, approvals, source/evidence identities,
review conversations/decisions/candidates, original receipts, five-transition
Undo/Redo cursor and stable history entry identities. Migrating does not create
new content approval or resolve pending feedback. Metadata is not an Agent edit.

Write legacy-derived Markdown once for each retained source state through a
marker-aware adapter around the pinned legacy CommonMark AST writer, then prove
the OP1 marker/leaf mapping natively. The adapter preserves explicit empty root
paragraphs and empty/nested list items, which a plain unmarked Markdown projection
can omit. A simple legacy list
item maps its ID to its paragraph leaf; test nested and empty items. A complex
one-to-many mapping must refuse with a precise unsupported result until proved;
never silently allocate replacement unlocked IDs. This is an explicit migration,
so unavailable original Markdown spelling cannot be reconstructed. Record that
provenance and retain the verified legacy backup; do not claim byte fidelity to
source that never existed.

Use a trusted application document worker/pure serializer module, never project
scripts or dependency hooks. Keep its optional migration entry separate from the
legacy public module so bare-Node export imports remain compatible. Node is a
conversion-worker capability; ordinary new-format text open/save remains native
and Node-independent. The existing native semantic writer deliberately refuses
many newline/code/link shapes and is not a universal legacy migration serializer.

For every derived state, reparse with trusted original IDs and require exact
canonical order, kinds, attributes, runs/marks and identity equality. Preserve
revision tokens in management. Never silently drop trailing breaks/whitespace,
empty paragraphs or marks to make proof pass. Unsupported representation or source
size expansion fails explicitly before target promotion, keeping original/backup.
Retained approved states derive from their actual ordered immutable block payloads,
not current prose or a guessed historical template.

Retained current/history/approved/review/downstream states receive verified raw
source evidence and graph association compatible with source-aware replay. A
historical approval must still prove the same normalized text/IDs/locks; adding
raw evidence is not a new user approval. Do not leave old history hashes pointing
to missing objects or make Undo unable to traverse the prior five transitions.
Preserve compact original request outcomes and definite failures. Metadata receipts
may retain old revision numbers; migration cannot replay them as new commands.

Original command payload digests and persisted receipt outcomes are immutable.
Adding source evidence may create new retained snapshot objects and update the
target's history references while preserving stable entry identities. Keep any
original referenced objects required by replay/evidence. Do not rewrite an old
receipt into a claim that raw Markdown existed before migration. The verified
legacy backup records the original normalized representation and source generation.

Augment source-bearing target history/approval representations with derived raw
evidence while retaining original immutable objects/provenance and stable history/
baseline IDs/sequences. Current approval verification must match the derived current
raw source; retained historical approvals keep their original IDs/sequences and
immutable ordered payload meaning. History replay still uses monotonic block
revision tokens: restoring changed text may create the existing new exact-revision
baseline binding, rather than reusing an incompatible old manifest hash. Lock-only
replay with identical tokens/source can reuse the same baseline. Preserve the
original retained approval evidence; do not reset revisions to force ID reuse.
Original downstream/export captures keep their original immutable input identity;
do not relabel past media inputs as having used newly derived Markdown spelling.
Planning/review task contexts use canonical IDs/revision tokens, so preserve those
contexts, input/artifact hashes and paid-run identities without a shared-AI rewrite.
Test retained succeeded/pending results and review applicability with mock call
counts; metadata representation migration is not a new inference or user approval.

Treat the target as an independent recovered origin under ADR 0002. Fence copied
nonterminal AI/document/export/downstream tasks before target service activation.
Do not infer that a queued run was undispatched on this machine. No imported
dispatch intent, process ID, session token or active file lock can resume execution.
Retain succeeded evidence as appropriate and require explicit new user retry for
copied work. Global AI settings/keys remain in the application data directory,
outside project migration and packages.

Validate the new manifest, physical files, object graph, policy/history/approval
invariants and copied-origin fences before marking conversion complete. Flush
staged files and completion metadata, then promote target with no-clobber semantics.
After success the UI offers activation through the normal close/dirty-input guard.
Cancel/failure keeps the original selected. Same UUID does not mean the old mounted
session may be silently reused for a different root; activation resets ownership
only after the old session settles. Native registry updates occur after activation.

## Fixed snapshot and package closure

Package export names one captured saved revision/source/graph generation. The UI
settles only its captured pending input, then root/core snapshot capture occurs
under the writer. Consistent SQLite backup, immutable creative objects and retained
management closure belong to that generation. Compression proceeds from those
verified immutable inputs after releasing the writer. Concurrent later edits stay
out. External live changes/pending intents must be resolved or export explicitly
uses the accepted snapshot with an accurate label; never mix live and accepted.

Include manifest, marked manuscript, optional audio/video declarations, all allowed
creative sources/dependency lockfiles/scripts, local media/fonts/captions/reference
files and trusted management state/current/history/approval/candidate closure.
Unknown TSX imports require the allowed creative tree rather than an unjustified
minimal dependency slice. Do not include node_modules. A media renderer ignores
management and uses public dependencies. A package must not import application
workspace modules to render. Keep licensed fixture assets/provenance in the tree.

Management packaging includes consistent project.sqlite, managed identity and
required immutable objects/artifacts. Exclude active locks, WAL/SHM, temporary
journals/stage files, cache/build/output/recursive backup directories and private
global app data. Durable recovery evidence is retained by its declared closure;
a still-pending unresolved operation cannot be packaged as a clean saved state.
Use OP4's exact authored path exclusion policy; do not apply broad exclusions
that drop arbitrary media. Describe package metadata/version and verification
inventory separately from the user's Remotion package.json.

## Frozen ZIP resource and path policy

Use ordinary ZIP with `project.json` at the archive root, no wrapper-directory
search/guessing, no symlinks/special entries and deterministic portable names.
Work-copy exchange has its own explicit envelope containing `project/` and
`context/`, bound to an existing recorded work item; it is not guessed from an
arbitrary nested manifest. Native code streams create/inspect/extract using 64 KiB buffers.
Limits apply to actual bytes, not only attacker-declared metadata:

| Budget                                            | Limit                                       |
| ------------------------------------------------- | ------------------------------------------- |
| Entry count, including explicit directory entries | 20,000                                      |
| Single expanded regular file                      | 4 GiB (4 × 1024^3 bytes)                    |
| Aggregate expanded regular bytes                  | 16 GiB                                      |
| Compressed uploaded/archive file bytes            | 8 GiB                                       |
| Aggregate expansion                               | expanded <= 200 × compressed + 1 MiB        |
| Individual entry expansion                        | expanded <= 200 × entryCompressed + 1 MiB   |
| Manifest/control JSON document                    | 4 MiB, with independent schema/depth checks |

Use checked arithmetic; exceeding a limit fails explicitly and leaves source and
active project intact. A smaller injected policy exercises actual compression/
streaming bounds without allocating GiB in CI. Expanded counters are updated as
bytes inflate. Verify CRC, declared sizes and hashes, including truncated/corrupt
central/local headers. Bound preview/control parsing separately from binary I/O.

Validate every path before extracting: UTF-8 relative '/' names only; no absolute,
drive/UNC/backslash/NUL/traversal/Windows reserved names, duplicate Unicode portable
keys, folded prefix collisions or file/directory overlaps. Reject archive links
and special modes even if their payload looks ordinary. Exact .scenesparrow is
allowed only for verified package management, while Unicode aliases and .git are
refused. No extraction through existing filesystem links. Validate/project into a
new private staging directory and promote only to a new destination. Completion
is written last; failed staging must not appear as a valid finished project.

Do not execute dependency hooks, install packages, run TSX, render previews or
contact a provider during inspection/import. A package's instructions/files are
data and cannot select a server path, shell command, credentials or acceptance.

## Transport and user choices

Use generated named operation/status DTOs and authenticated same-origin download
streams. Browser ZIP upload streams/chunks into a registered intake with exact
offset/length/final hash and bounded storage; do not collect a multi-GiB request
or archive in a JS Uint8Array, JSON/base64 envelope or Rust Vec. Download is a
bounded attachment stream with a safe filename. Electron uses named file chooser/
save capabilities and streamed copying, not arbitrary renderer filesystem access.
Cancel/expiry cleanup respects active readers and original operation identities.

Inspection offers distinct explicit outcomes:

- Independent verified restore: validate metadata/closure, preserve project
  provenance and fence copied nonterminal jobs before activation in a new folder.
- Returned work-copy edit: require matching recorded OP4 work-item/base identity;
  inspect creative actual diff and ordinary scoped acceptance. Ignore/reject
  supplied management replacements; never replace current locks/history.
- Unmanaged ordinary project: explicit adoption with unavailable prior metadata
  explained. It cannot be presented as a recovered managed state.

Absent a trusted recorded base, do not manufacture a returned-edit base from a
package file. Offer independent restore/adoption instead. Inconsistent/tampered
managed closure refuses verified restore. Same-project package import is not an
implicit force overwrite. Existing targets remain untouched.

A complete project ZIP may also be edited by an external Agent. When its export
ID matches this core's retained export/base record, explicit returned-edit intake
can create a scoped OP4 item from that trusted saved graph and the user's chosen
grant; a preexisting work-copy envelope is another supported route. Require the
current accepted graph to match that base before inspection/acceptance, preserving
the ordinary stale-base rules. The archive's claimed base/grant/DB never supplies
authority. Without the matching core record, do not guess a base from its fields.

Keep transfer metadata inside the management namespace, distinct from Remotion's
root package.json, with a versioned export/work-item identity and fixed generation.
Verified restore checks every declared member. Returned-edit mode instead validates
the archive structure and original management evidence while treating changed
creative files as candidates against the core-owned baseline; supplied DB changes
are rejected or explicitly ignored and never replace current metadata. Preserve the
uploaded bytes and show that mode explicitly, rather than calling an edited tree
a verified unchanged saved package. Root freezes the exact descriptor before B.

The 4 MiB public transfer/manifest/audio control limit does not reinterpret private
immutable graph objects: their existing 16 MiB native schema bound still applies.
Archive total entry/expanded limits count management/history objects too. A valid
native project can exceed a portable package's combined resource budget; export
must refuse with counts and leave it intact, never omit retained closure to fit.

UI uses existing app menu/project controls and focused operation/recovery dialogs,
with stage/progress labels, readable verification errors and English/Chinese
catalogs. No workspace/name form on ordinary start. Capture owning input/context
before awaits; a late export/activation response cannot clear new input or activate
a different chosen project. Three-second top notices expire; operation status and
recovery remain reachable. Old ambiguous mutation IDs remain owned.

## Required verification

Migration fixtures span every supported legacy schema and real WAL state. Test
IDs/locks/review/pending candidates/approvals/history cursor and five-step replay,
receipts, source references, backup closure and normalized-syntax provenance.
Fault injection before backup completion, conversion, verification, target
promotion and activation leaves the original intact. Missing objects and complex
unproved mapping refuse. A copied nonterminal run never calls the mock SDK.

ZIP tests cover traversal, Unicode/prefix/file-directory collisions, links/special
files, duplicate entries, truncated headers, CRC/size lies, actual expansion,
aggregate/file/count/ratio budgets, interrupted/cancelled intake, existing target
and concurrent later edits. Verify global credentials and cache/process data are
absent, but referenced ordinary media and retained trusted evidence are present.
Returned DB tampering cannot change current approval/history; stale base fails.

Freshly extract a package outside the application checkout, install only its
public pinned dependencies and render/play the licensed standalone fixture.
Inspect actual frames/audio if present and ffprobe metadata, not just process exit.
No arbitrary project execution capability is enabled by this trusted CLI proof.
Run relevant native/contract/client/browser/legacy/source gates. Root independently
reviews and reruns the material acceptance paths before each commit/push.

Every shell sources scripts/cloud-env.sh; every Rust-invoking command/wrapper uses
both zero-debug profiles and CARGO_BUILD_JOBS=4. No concurrent Cargo. Preserve
.agents/ and root docs/specs. Stop all writes/owned processes before handoff.
No merge, tag, deployment or cloud-environment publication.
