# OP5-B: complete portable package backend

Status: independently reviewed Linux backend checkpoint, 2026-11-19. Assignment
baseline is OP5-A `b51673669ada92e20bf7ca983289e23fcf407645`; read the
[exact handoff](open-project-op5b-handoff.md) and final
[validation](../validation/open-project-op5b.md). This document covers
OP5-T04–T06; a sequential OP5-C owns visible transfer workflows and native/browser
streaming adapters. OP5 remains incomplete until both pass. Parent: OP5 and the
common open-project specification. No change to activation/default startup yet.

## Ownership and fixed capture

Reuse the accepted same-snapshot backup and schema-only staging primitives from
OP5-A. Do not introduce a second project writer, lossy manuscript writer, generic
file/shell service or project-local credentials. Append migrations after the
delivered ledger if durable project export/base or copy-availability facts require
them. Delivered SQL is immutable.

An export request captures the registered accepted file graph hash/generation and
project history revision expected by the caller. Under the existing writer,
validate that captured base, fence pending recovery and capture consistent SQL,
its immutable object/export closure and the exact creative graph. Pin the whole
capture and record the export/base identity before releasing the writer. Compression
and object streaming run outside the writer. Later edits, external live files and
later runtime updates do not enter the capture. Status/cancel/source editing/global
settings stay responsive while a large file is copied or archived.

The start acknowledgment means that fixed capture exists. Do not acknowledge an
export and defer its first SQL/source capture until a background worker sees a
newer project. Expose a small consistent package-base read (project working/history
revision plus source/graph hashes/generations) for the request. Capture the SQL
snapshot/pins during the start boundary; derive/hash/copy its immutable inventory
outside the live writer. Recover a start/SQL/journal crash by its original capture
record, never a fresh current snapshot. A later edit must neither enter the ZIP
nor make an already captured export fail as a stale start.

Export requires a registered graph. Existing pre-registration native projects use
the explicit registration action; do not auto-adopt live unknown media. OP6 owns
automatic initial registration only for genuinely new app-owned empty projects.
Legacy projects explicitly migrate first. An unresolved source/graph intent is
not a clean saved export. No bare main-file SQLite copy or subsequent live
inventory substitutes for consistent capture.

## Archive envelope and descriptor

Complete project ZIP files have `project.json` at their root. Creative members are
the exact captured allowed graph, including public dependency manifests/lockfiles,
scripts, local media/fonts/captions, and reference files already authored in that
graph. Retained Library evidence also remains available through verified management
object closure; packaging does not invent extra accepted creative reference files
from database labels or fetch link contents.

Include consistent `.scenesparrow/project.sqlite`, managed identity, required
immutable objects/artifacts and declared durable recovery evidence. Exclude active
locks, WAL/SHM, staging, mutable work copies, process handles, recursive backups,
global app data, credentials, authentication, `.env`, node_modules, cache and
temporary output. Reuse OP4's exact path policy rather than broadly dropping
arbitrary media. Private graph objects retain their existing 16 MiB bound; the
public control limit does not shrink them.

The versioned descriptor is `.scenesparrow/transfer.json`, distinct from a Remotion
`package.json`. It declares format version 1, kind `project`, project/export UUIDs,
fixed source/graph/history generation and a sorted exact inventory of regular
member path, SHA-256 and size. The inventory excludes only the descriptor itself.
Use the existing Unicode portable key and path rules. Every actual regular member
must be declared and every declaration must exist. Explicit directory entries
are structural, count toward limits, and may not create file/prefix collisions.

A work-copy exchange has an explicit wrapper with `project/`, `context/` and a
root `transfer.json` of kind `work-copy`, bound to the core's existing OP4 work
item. Do not search nested folders for a likely manifest or reinterpret an
arbitrary project ZIP as this envelope. Core-owned context and grants in the
original record remain authoritative. Initial implementation may export a
recorded work copy through named operations; mutable local copy paths are never
accepted from a browser.

Descriptor hashes establish integrity and provenance, not authentication or
approval. A malicious author can recompute them. Verified restore additionally
proves all SQL/manifest/source/graph/history/lock/approval/receipt/object invariants
through trusted native validators. No descriptor field grants execution,
filesystem selection, user acceptance or access to secrets.

## Streaming and resource policy

Keep OP5's frozen limits: 20,000 entries including directories, 4 GiB expanded
per file, 16 GiB expanded total, 8 GiB compressed archive, entry and aggregate
`expanded <= 200 * compressed + 1 MiB`, 4 MiB public controls, checked arithmetic,
and 64 KiB I/O buffers. Count management objects/history too. A valid native
project may exceed the complete portable package budget: refuse explicitly before
Ready, without truncation or omitted retained evidence.

Additionally bound central-directory metadata to 32 MiB before allocating the
ZIP library's complete entry index. Preflight EOCD/ZIP64 offsets/counts/record
lengths using bounded reads and checked ranges. Support ordinary bounded ZIP64
and data descriptors; the frozen size budgets exceed classic 32-bit offsets.
Accept Store and Deflate only, no encryption or multivolume archives. Validate
central/local consistency with data-descriptor/ZIP64 rules, actual inflated byte
counts, CRC, size, hash and truncation. Hostile declared sizes never skip actual
limits. Exercise injected tiny policies instead of allocating GiB in CI.

Export must produce a package its own inspector accepts. Store is a valid initial
policy and avoids rejecting legitimate silence/zero/repetitive data under ratio
limits. Compression selection must not mark an incompatible archive Ready. Test
the aggregate allowance as well as individual allowances.

Validate all archive paths and types before extraction: UTF-8 relative '/' names,
no absolute/drive/UNC/backslash/NUL/traversal/reserved Windows names, no duplicate
portable Unicode keys, no folded prefix/file-directory collision, links or special
entries. Exact `.scenesparrow` is allowed only in the declared verified management
envelope; aliases and `.git` remain refused. Extract into an exclusive private
staging directory with no link traversal, then no-clobber promote a new target.
Never run dependency scripts, install, render, invoke a provider or execute
imported code while inspecting or restoring.

## Intake and durable operation ownership

Extend closed generated transfer schemas with named export, intake, inspection,
restore-target, restore-operation and returned-edit requests/views. Root freezes
exact names against OP5-A before dispatch. No untyped JSON command envelope or
path-bearing browser DTO. Use request UUIDs, safe integer counters, bounded pages,
stable safe failure codes and original DTO digest replay before fresh validation.

Reuse global app-data atomic JSON transfer journals, separate short record locks
and long operation leases, one worker and five admissions. Current-source root
ownership is distinct from the result project's UUID: restoring project B while
A is open cannot make B's identity authorize actions on A. A purpose-bound target
capability records its owner/source locator, inspected immutable intake identity,
result project UUID and new app-owned location. Preserve that archived business
UUID even when it matches the owner project; separate root/target identity owns
the new filesystem context. Do not reuse a migration target
as an unrestricted import target or return imported project metadata as though
it were the active project's current snapshot.

Intake registers declared archive length/digest, writes bounded chunks at exact
offsets and checks each length/hash. An identical acknowledged chunk replays
without appending; a changed same-offset chunk conflicts. Verify final length and
SHA-256 before inspection. Retain uploaded bytes for explicit recovery/returned
edits. Ready archive cache and terminal export captures awaiting their original
retry have a seven-day retention window; an accepted explicit retry renews the
capture window. Active operations/readers remain protected. Unused or canceled
intake expires after 24 hours, while returned candidate evidence extends its
retention as specified in the exact handoff. Expired capture retry reports
PACKAGE_EXPIRED, preserving original outcomes without recapturing newer content.
Cancellation, expiry and collection respect active readers. Never recreate
deletion authority from an old pathname or replay; preserve unknown residuals.
Quiesce tracks/cancels workers. Restart marks unfinished work interrupted and
requires an explicit control/retry against the original capture/target; no silent
recapture from newer project state.

Read/download exposes an immutable authorized archive/member stream and safe
attachment filename. It must not return multi-GiB Vec/JSON/base64. The native save
adapter later needs a resource-specific 8 GiB archive cap; do not raise the 4 GiB
ordinary-member cap globally or accidentally reject valid archives between them.

## Independent restore and returned edits

Independent restore verifies the complete descriptor, management and object
closure before any normal startup. Use OP5-A schema-only staging and copied-origin
fences. Preserve original terminal command/run evidence and identities. Copied
nonterminal AI/document/export/downstream work never dispatches. Global settings
and credentials remain independent.

Mutable work-copy directories, copy locations, preparation/deletion leases and
native reveal tokens are not portable. Revoke target-side copy availability
without rewriting an original successful operation into a failure. Expose truthful
current availability and reject reveal/inspect against a copied location. An
explicit discard of an unavailable copied item can release its slot without
opening/deleting a guessed path. Retained immutable candidates/context remain
readable. No later path that happens to match can resurrect the authority.

For returned work-copy edits, require the existing item/base/grant. For an edited
complete project package, require its export ID to match this source core's
retained export/base record and an explicit user-selected OP4 grant; current
accepted graph must still match that base. Archive-claimed base/grant/SQL is never
authority. Validate structure and original management evidence, reject or explicitly
ignore changed management, and compare creative changes as OP4 candidates. Preserve
uploaded bytes. Accept through the existing one-operation history/locks/receipts;
do not build a second acceptance path or reset metadata. Missing recorded base
offers independent restore/adoption instead of guessing.

## Backend acceptance and frozen handoff

Tests cover fixed generation during concurrent later edits, required closure and
excluded secrets/cache/handles, missing objects, inconsistent metadata, cancelled
intake, duplicate chunks, changed DTO replay, bounded reads/status during bulk I/O,
existing targets, promotion/result-journal cuts and copied-origin mock SDK counts.
Test every resource/path/header/CRC/ratio case, including a self-compatible
compressible export/inspect/restore under tiny budgets.

Returned edits must prove trusted base lookup, stale graph refusal, grants/locks,
one acceptance/Undo/Redo, original receipt replay after artifact pruning and DB
tampering that cannot change current metadata. Restore tests retain actual history
entry IDs, current/different historical approval, pending review and original
success/failure outcomes. Reopen independently and verify backup/collection.

Run focused Rust/Clippy, generated contracts/types, real-core HTTP integration and
named preload guards. UI is OP5-C; no broad unrelated browser reruns yet. Freeze
all intended files/checksums and evidence in `.artifacts/op5b/HANDOFF.md`; stop
writes, checks and owned processes before root review. Root alone reviews, writes
validation docs, stages, commits and pushes. Preserve root docs and `.agents/`.

Every shell sources `scripts/cloud-env.sh`; Rust-invoking commands/wrappers set
both debug profiles to zero and `CARGO_BUILD_JOBS=4`, with no concurrent Cargo.
No child delegation, Git mutation, worktree, real-user conversion, paid provider,
merge, tag, deployment or environment publication.
