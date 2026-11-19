# OP2: file-backed manuscript storage and recoverable promotion

Status: independently reviewed on Linux on 2026-11-19. This stage follows the
accepted OP1 contracts and native-worker correction at `04ca8e4`. Root owns this brief; implementation follows
[the execution plan](../open-project-execution.md) on `feat/open-project-format`.

## Deliverables

- OP2-T01: explicit format inspection, new text-only create, unmanaged adoption,
  and existing managed open. A legacy project keeps its old loader. Creating a
  blank format-v1 directory is supported without Node, Remotion, an AI key or a
  name form. A manifest UUID and management project UUID must agree.
- OP2-T02: native source parsing/ownership and checked patches, tested against
  both OP1 identity corpora, with no normalized whole-document rewrite. The
  native core must establish bindings itself rather than trust a UI projection.
- OP2-T03: immutable raw source snapshots and source-aware command coordination.
  App source edits and existing accepted planning/review/history content changes
  use the same writer, receipts, policy and revision guards.
- OP2-T04: durable file/metadata promotion and recovery with injected cut points.
- OP2-T05: named typed source read/save/inspection APIs over the authenticated
  core, generated transport contracts and client boundary. UI adoption is OP3.
- OP2-T06: preservation/retention, failure and legacy regression evidence.

## Storage and source authority

Creative sources live at the registered project root; management state lives
under `.scenesparrow/`. Keep these paths distinct from the existing repository's
`directory` (which owns objects, staging and exports). Existing legacy paths are
never relocated automatically. Migrations 001–010 are immutable; append any
schema version to the shared ledger and update inspection/backup version checks.

Raw Markdown is the editable authority. SQLite stores trusted identities,
capabilities, projections, history, approvals and receipts. Current/historical
semantic blocks are not an independently editable prose master. Preserve raw
unsupported syntax. Commands that cannot safely patch an unsupported node fail
explicitly instead of normalizing it; metadata-only commands still work. A new
complete draft may replace a verified empty source, while editing a populated
document must preserve all unrelated bytes and bindings.

Use a pinned native CommonMark parser and the frozen OP1 marker grammar. Prove
read/binding agreement against the shared bound-source and failure corpus,
including BOM/CRLF, nested containers, empty leaves and literal comments in code.
Native source offsets are UTF-8 bytes. If the parser differs from mdast, resolve
the concrete counterexample with root before shipping a divergent binding rule.
Insertion must preserve meaning; no regex-only comment ownership inference.

All manuscript mutations on format-v1 projects pass through the source-aware
commit seam, including S2 drafting, S3 accepted edits, imports and Undo/Redo.
Retain raw before/after source identities for grouped history; metadata history
must not rewrite or normalize source. Existing five-transition history and lock/
active-task guards remain in force. Legacy routes retain existing semantics.

## Frozen promotion/recovery protocol

One repository writer owns preparation, promotion and SQL commit. A durable
operation intent records its request ID/digest, project ID, expected generation,
and a list of relative file changes with before/after hashes and immutable blob
references. This list supports a later multi-file change set even if OP2 only
changes the manuscript. Absence/deletion is explicit, not an empty-file hash.

1. Replay the existing receipt before side effects; reject a reused ID/digest.
2. Validate base revision/hash, physical paths, native bindings and actual policy
   impact. Capture immutable before/after bytes and flush them. Retain them
   independently of caches and collection.
3. Write and flush the complete operation intent before the first live promotion.
   Stage files on the target filesystem. Revalidate paths and captured identity
   immediately before promotion. Preserve displaced bytes; a mutex cannot stop an
   external editor and does not constitute filesystem compare-and-swap.
4. Apply the full existing guarded SQL transition and source snapshot references
   in one short transaction with the operation identity and ordinary receipt.
   Promote staged creative files before committing that transaction. All changed
   files must be durable before acknowledging success.
5. After committed SQL, clean up the intent only after verification. Failed
   cleanup must remain recoverable and cannot apply the operation twice.

On restart, recover before loading projections, startup job reconciliation or
object collection. A committed operation finishes/validates its after generation;
an uncommitted operation restores its before generation. Recovery may replace a
live file only when its verified bytes/identity are still the operation's known
before/after version. Unexpected content is preserved as a conflict artifact and
blocks mutation until explicit reconciliation; never erase it as cleanup. A file
changed or replaced during promotion must have preserved bytes and a truthful
conflict, not be reported as successfully saved over an unseen edit.

No mixed generation is reported as saved. A failed or uncertain operation retains
its original receipt/request identity. An acknowledged operation can be replayed
without reapplying file or history changes. Root reviews the concrete journal
states and restart tests before acceptance; an atomic rename alone is insufficient.

## Inspection and physical access

Manifest inspection precedes mutable open. Future versions remain inspectable
read-only and do not initialize management state. An unmanaged directory requires
explicit adoption. A known managed project whose DB/snapshot disappears requires
recovery; never initialize a fresh unlocked replacement over it.

Use OP1 portable validation plus actual physical containment/link/special-file
checks at each read/stage/promotion. Reject escaping links and protected namespace
aliases. Test ancestor replacement and file replacement, rather than asserting
that a prior canonicalization prevents later races. Native platform limitations
must be stated; do not infer Windows/macOS behavior from Linux.

External live bytes differing from the accepted source are pending changes, not
new approvals. Reading them cannot silently update blocks, release locks or add
history. Return accepted bytes/hash plus a safe external-change status so OP3 can
preserve local buffers and reconcile explicitly. A missing/partial read cannot
replace accepted text with blank content. Source read/save are named capabilities,
not arbitrary file reads/writes or a shell endpoint.

## Retention and verification

Pin raw source for current state, unresolved intents, candidates, retained
before/after history and approved baselines. Cache deletion and normal collection
cannot remove accepted evidence. Keep consistent backup/recovery behavior and
do not break legacy loading, typed errors, task identities or credential storage.

Required behavioral checks: new create/adopt/reopen without Node; UUID mismatch;
future version no writes; required binding loss/duplicate; stale base; lock and
active-job rejection; source preservation for supported edits and honest refusal
for unsafe semantic conversions; source-aware Undo/Redo and accepted AI changes;
cache deletion/collection; receipt replay; stage/flush/rename/SQL/cleanup failures;
restart on both sides of SQL commit; concurrent external replacement; symlink
escape; missing/corrupt metadata. Run affected unit/native/service integration
checks, contract generation/check, typecheck, formatting and Clippy. Broaden tests
when shared coordination changes warrant it. Capture exact commands and limits.

Acceptance: OPF-AC01, AC03, AC06, AC07, AC19 and the native source proof needed by
AC04/05. No real project conversion, UI rewrite, watcher, archive import/export,
paid provider calls, production TTS/video pipeline or arbitrary code execution.

Root may divide this substantial stage into sequential coding substeps with the
same acceptance gate. Use one `gpt-6.1-sol` high-effort writer. Source
`scripts/cloud-env.sh` in every shell; every Rust-invoking command uses
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
Preserve `.agents/`; do not stage/commit/push/switch branches/create worktrees or
delegate. Stop all owned checks/writes before root review and provide a handoff
with changed owners, exact evidence and unresolved limits.

## Reviewed implementation boundary

Named generated APIs are `GET /v1/project/format`, `GET /v1/manuscript/source`
and `POST /v1/manuscript/source`, with matching HTTP/preload clients. Native CLI
inspection is `--inspect-format`; explicit initialization modes are
`format-create` and `format-adopt`. Normal startup still preserves legacy defaults
until OP6 integration. Source snapshots return accepted source/hash/generation,
UTF-8 bindings/capabilities and actual live external status/hash. A replayed save
returns its original receipt plus the current snapshot; consumers must distinguish
them and never overwrite newer local input with an old acknowledgment.

Migration 011 adds authored source, operation identity and retained raw pins.
Intent v1 uses a list envelope but OP2 registers/recovers one manuscript file.
Linux descriptor-relative no-follow access and atomic exchange capture displaced
bytes/identity; SQL commits source generation, ordinary receipt and operation
identity together. Known interrupted states recover before jobs/collection.
Unknown live/staged bytes are preserved and block recovery. New commands,
fast edit-group closure and paid-task UOW entry reject while an intent remains;
original receipts replay first. Same-process recovery/status UX is OP3.

Known-leaf scaffold proof narrows independent raw edits. Locked A remains at the
same revision/anchor when B is edited or undone. Unproved structure/unknown effects
widen protection. Simple nested lists/empty leaves are supported; unknown parent
subtrees stay raw. Full approval and semantic export refuse incomplete ownership.
Native batch insertion matches frozen bytes; debug parser cost remains substantial
and is not full large-document performance acceptance.

Text-only verified backups reconstruct the declared source/management layout and
retained history. Complete creative/media/dependency packaging is OP5. Physical
promotion is currently Linux-only; Windows source access also refuses. These are
missing product capabilities to implement in OP6, not merely unrun native tests.
See [validation](../validation/open-project-op2.md) for actual checks and limits.
