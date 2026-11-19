# OP4: scoped external work copies and protected batch acceptance

Status: root preparation following reviewed OP3-B, 2026-11-19. Not dispatched.
Root will confirm the accepted OP3-B commit before assigning a writer. Parent:
[open project contract](open-project-format.md), OPF-AC10–AC12/19. No embedded
Codex/Claude SDK, paid generation or execution of imported code is included.

## Task boundaries and sequential checkpoints

OP4-T01: verified creative inventory and immutable file-graph snapshots.
OP4-T02: multi-file intent, shared receipt/SQL coordination and recovery.
OP4-T03: file-aware five-transition project history and retention.
OP4-T04: recorded work items, scoped copies and actual candidate diffs.
OP4-T05: policy/lock/task revalidation and explicit accept/discard.
OP4-T06: named HTTP/preload operations and existing Changes UI integration.
OP4-T07: real-core/browser evidence and legacy/source regressions.

This stage has two sequential coding checkpoints because the existing intent
contains one manuscript and cannot safely be treated as a general file journal:

1. OP4-A implements T01–T03 and native tests. Root reviews and submits the native
   coordination checkpoint. No Workbench rewrite or work-copy UI in A.
2. OP4-B implements T04–T07 using accepted A primitives. Root freezes the exact
   API/UI handoff after A. OP4 remains incomplete until both pass.

Each assignment has one fresh gpt-6.1-sol high-effort writer, no subdelegation/Git,
and a complete freeze before root review. Migrations 001–012 are immutable; append
013 and later versions. Root owns this spec and any design changes.

## Creative inventory and immutable graph

A graph is a sorted, versioned inventory of portable root-relative regular files,
with SHA-256, exact byte size and content-object identity. The registered manifest
and manuscript remain mandatory. Include optional audio plans, TS/TSX/components,
package/lockfiles, captions, local public media/fonts, references and tooling.
Do not infer closure by executing code or guessing unknown import dependencies.

Inventory never follows symlinks/reparse points, device files or hardlinked files.
Apply the OP1 Unicode portable key to the complete inventory, including prefix
collisions and reserved namespace aliases. Revalidate descriptor/native handles
at reads and promotion. Reject management and Git entries in a submitted creative
tree rather than merely skipping potentially malicious replacements.

Exclude application-owned `.scenesparrow`, `.git`, dependency installations,
derived cache/build/output and process files from an authored graph. Exclusions
are path components: `node_modules`, `.cache`, `.next`, `.turbo`, `dist`, `build`,
`output`, and native stage/displaced files. Root `.gitignore` may remain authored.
Credential/config files `.env`/`.env.*`, `.npmrc`, `.netrc`, `.pypirc` and private
key files are not work-copy/package inputs. Global AI settings/vault/authentication
live outside the project and are never traversed. This policy is not a claim to
detect secrets embedded in arbitrary authored prose or code.

Use streaming hashing/copying with fixed-size buffers for creative binaries.
The manuscript parser's 4 MiB input limit is not a video/media limit. Freeze native
inventory budgets at 20,000 files, 4 GiB per file and 16 GiB aggregate, checked with
overflow-safe arithmetic and injected smaller-budget tests. Control/manifest
documents retain their own tighter validation bounds. No archive is implemented
in A; OP5 shares these resource values for ZIP. Binary graph members must not
flow through the existing whole-Vec read_object verification/cache path during
retention, reopen or backup; add verified streaming object access for those members.
Small source/control objects retain their existing bounded parsing APIs.

New format create/adopt can initialize a graph as part of their verified operation.
Existing OP2/OP3 projects require an explicit registration action before the first
work copy. Verify manuscript physical bytes equal accepted source and manifest
identity/path match the registered source. Capture other present creative files
as an unapproved baseline for comparison; registration does not approve media,
unlock prose, add a content Undo entry or reinterpret prior approvals. An external
MD conflict/pending intent blocks registration. Never silently bless a later
external file update as accepted during a status scan.

The accepted graph is core-owned and immutable. A passive filesystem inventory
is an observation. A working-copy `base.json` is guidance only, never authority.
Accepted graph identity/generation is part of every work-item base and mutation.
Normal app source saves, AI applications and Undo/Redo update the manuscript entry
in the accepted graph through the same writer. Existing legacy projects retain
legacy semantics and do not require a graph.

## Multi-file transaction and recovery protocol

Extend the existing journal with a new explicit version, preserving v1/v2 readers.
Record full accepted-before/after graph identities separately from physical
before/after files. Bind original request/digest, project/revision/graph generation,
trusted candidate identity and exact inspected payload hashes. Renames are modeled
as checked removal/addition; directories have no independent authored identity.

Preparation verifies all base/live files, materializes complete immutable content,
creates/flushed sibling stages, then durably writes the complete intent before
the first promotion. Promote individual files through native checked operations.
Recheck any displaced file and preserve unexpected bytes. Only after all physical
versions match may the short shared SQL transaction commit the graph generation,
manuscript/projection/policy state, one history entry, candidate disposition,
ordinary receipt and operation identity. A partial physical promotion is never
reported as a completed saved graph. No second independent receipt/history owner.

Deletion must move the verified old file into a retained sibling/displaced slot,
not unlink it before SQL commits. Addition uses no-clobber rename. Replacement
preserves displaced bytes. Parent directory creation is core-selected, checks
portable prefix collisions and keeps handle/identity containment; rollback may
leave a harmless empty created directory but cannot remove unrelated files.

Known uncommitted recovery restores the complete physical-before set and keeps
accepted-before SQL. Known committed recovery finishes/verifies all after files
and accepted-after SQL. Recovery determines each change's actual stage/live state,
not a global last-index hint. Unknown bytes anywhere preserve all evidence and
fence the whole operation; no partial success/reset. Explicit preserve-external
settles the proven SQL outcome while retaining all affected live/staged versions,
using the same durable decision semantics and named evidence boundary as OP3.
An old recovery choice cannot settle a newer graph operation.

The single manuscript source remains registered at its original path in v1 of the
product workflow. A candidate cannot delete/rename it or replace project identity.
Manifest optional declarations may change only if the resulting manifest and
referenced files validate. A declared media entry missing from the candidate
refuses. Arbitrary undeclared creative files may be retained without executing or
claiming semantic understanding of them.

## Shared history, revisions and policy

An accepted graph batch is one project operation with at most five retained
transitions. Files and prose restore together. Media-only edits still advance the
monotonic project revision and history cursor, without bumping unrelated prose
block revisions or fabricating text edits. Undo/Redo is a new guarded journaled
operation and never restores running jobs or metadata supplied by an Agent.

Integrate graph roots with existing stable history entry identities, either as a
verified sidecar keyed by those identities or a versioned business snapshot
extension. Preserve old retained history and receipt identities. If an old history
entry predates graph registration, its non-manuscript files remain unchanged;
its manuscript source still follows its original retained raw snapshot. Do not
relabel a historical media baseline as approved or blindly restore current media
over an intervening graph edit. Verify graph continuity at reopen and replay.

Current graph, retained history/redo, work-item base/candidate, approved/downstream
evidence and pending journals pin the complete referenced closure. Metadata pruning
and collection use the writer; no unbounded passive inventory payloads. Explicit
discarded work items may release no-longer-needed candidate payloads after their
definite receipt, while retaining compact replay identity. Do not delete original
receipts merely to bound bulk content. Retained recovery evidence is deliberate.

Known manuscript differences use native IDs/scopes. Independently changed B must
not affect locked A. Separate actual manuscript impact from production-file and
dependency impact: locked text must remain usable to create audio/video whose
changes do not alter that source. Text locks protect actual text/identity changes;
they do not implicitly create production-file locks. Unknown code/shared dependency
effects conservatively expand production scope, not every prose revision.

OP4-B supplies minimal core-owned path/hash production-file locks and their explicit
named operations/history for AC11; a full video editor is outside this slice.
Direct/shared production changes must honor those locks and active downstream
usage. Unproved production impact may cover the entire production tree. An AI
text-review reservation does not block independent media files. Narration source
references/divergence are reported as provenance/staleness; this declaration-only
delivery does not invent a synthesis/alignment or exact-narration-equality rule.
Never claim synchronization without evidence or rewrite the manuscript from it.

All applicable locks/reservations revalidate at inspection and commit, including
Undo/Redo. Agent files cannot unlock, approve, resolve reviews or replace database
state. A lock added after inspection can block acceptance. Preserve approved raw
evidence. Root freezes the exact production-lock DTO/storage contract before B.

## Recorded work items and actual diff

Creating a work item records project identity, accepted revision/graph hash and
generation, request identity and explicit grant. Grants consist of exact portable
file paths, directory subtrees with segment boundaries, and optional manuscript
block IDs. An empty grant permits no creative mutation. Main manuscript edits
revalidate both path and actual block scope. Grant guidance cannot enlarge itself.

Materialize an app-selected private work-copy directory, containing an ordinary
`project/` creative tree plus a separate `context/` summary. Include manifest,
required sources and safe protected-state guidance. Copy immutable reference
inputs from the current Library as named context files/index, not a second
editable reference master. Existing project AGENTS/CLAUDE instructions stay user
files; additional work-item scope guidance lives in context. No trusted database,
vault, live process token or writable approval records are supplied to the Agent.
A separate directory is not OS isolation; never autoexecute it.

Desktop opens only the core-registered work-copy location through a named
capability. Browser uses named file intake/download operations; complete portable
work-copy ZIP exchange is added by OP5. Never accept an arbitrary server path from
a renderer. A cloud checkout and deployed server remain independent locations.

Inspection hashes actual candidate files and compares against the core-owned
base, showing additions, deletions, replacements, exact-hash rename hints and
binary hash/size. Unpaired ambiguous identical files remain additions/deletions;
a rename hint never changes the actual operation. Text diff previews are bounded,
with explicit truncation and full download; binary previews never execute code.
Persist an immutable candidate identity/digest. Editing the work copy after
inspection invalidates acceptance until a fresh explicit inspection.

Reject out-of-grant changes, portable aliases/traversal, `.scenesparrow`/`.git`
injections and project identity changes. Accept none of a rejected set. A scope
boundary instruction in a text file is explanatory, not enforcement.

Inspection compares the immutable creative base with the current accepted graph
and captures the current project revision/policy state for its candidate. A
question/comment-only revision does not destroy the creative work copy: reinspection
may capture the newer metadata state while the creative graph remains identical.
A changed creative graph is stale; no silent content rebase is allowed.
Acceptance revalidates that graph, inspected current revision, work-copy bytes
against the inspected digest, physical before versions, scope and all policy guards. Full DTO
digest and original request bind the receipt. Receipt-first duplicate acceptance
works after later changes or candidate payload pruning; same ID/different payload
conflicts. Failed readback keeps the original uncertain request. Discard is also
explicit/idempotent and only affects that registered copy/candidate; it cannot
overwrite a later live external edit.

## UI and final verification

Reuse OP3's compact Changes/recovery entry and focused auxiliary/dialog surfaces.
Show scope/base, actual changed files and readable text differences. Clear actions
are inspect changes, accept batch and discard copy/candidate. Show conservative
impact or blocked locks with localized next steps. No raw JSON results dashboard.
Capture local input before every await; settle only captured input before starting
a work item/acceptance, or keep local input and refuse stale mutation. A later
response cannot clear newer source/planning input or close a later conflict.

Use English/Chinese strings, keyboard-safe dialogs, compact row overflow behavior,
three-second top notices and durable recovery. Arbitrary TSX preview/execution is
visibly unavailable. No new settings gate/project-name form or duplicate pane owner.

Native fault cases cover each per-file promotion, before/after SQL, cleanup,
mixed addition/removal/rename and nested parent replacement. Include unexpected
bytes at the second file, known rollback/rollforward, explicit preservation,
stale recovery, interrupted cleanup and old intent compatibility. Verify no
reported mixed saved graph and no loss of third-party bytes.

Required business evidence: one batch/one history entry; five-step grouped
Undo/Redo/reopen; metadata-only/media-only operation; lock A/edit B; locked
deletion/rename; unknown shared TSX impact; scope escape/alias tampering; candidate
changed after inspection; base change/late lock/task; retained approved snapshots;
duplicate/lost ACK/different payload; reference context fidelity; large-file
streaming via injected small buffers/budgets; no script execution on inspection.
OP4-B adds real-core HTTP/preload/browser interaction and legacy/source regression
evidence. Root freezes its exact operation DTOs/handoff after reviewing A.

All shells source `scripts/cloud-env.sh`. Every Rust-invoking command/wrapper uses
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
No parallel Cargo. Each writer stops all writes and owned checks/processes before
handoff; root independently checks, documents, commits and pushes the checkpoint.
No merge, tag, deploy, environment publication or real user project conversion.
