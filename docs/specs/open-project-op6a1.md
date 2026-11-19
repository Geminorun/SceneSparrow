# OP6-A1 preparation: macOS native files and portable capability seams

Status: root preparation, not dispatched. Freeze after accepted OP5-C. This is
the first sequential native implementation checkpoint of OP6, not final platform
acceptance. The next checkpoint implements Windows and its three-name journal.
Root owns this specification, review, validation and Git.

## Scope and invariants

Implement actual macOS creative-file read/stage/stream/enumerate, preserving
addition/replacement/removal, graph/history recovery, work-copy disposal, conversion,
package preparation/inspection/restore and native package save. Preserve Linux
behavior and every original receipt/schema. Do not merely remove platform guards,
cross-compile, add an untested path fallback or relabel missing implementation.

Use descriptor-relative native filesystem access, held directory/file identity,
no-follow plain regular files, one link where required, exact portable aliases,
bounded streams and directory traversal. A root/ancestor rename cannot redirect
actual preparation or cleanup into another tree. Unknown versions remain intact
and fenced. New target publication is no-clobber; ordinary replacement preserves
the displaced member until identity/content and SQL settlement prove the outcome.

Implement `renameatx_np` with RENAME_SWAP and RENAME_EXCL on macOS, retaining the
existing short intent/file/SQL protocol. Refusal on a filesystem that cannot
provide required semantics is truthful, never an ordinary overwrite fallback.
Document/test actual file/directory flush behavior and error mapping. Do not
claim a runtime success implies durability on every filesystem.

## Descriptor enumeration and tree preparation

Current Parent.entries/check_alias and one-shot cleanup assume Linux procfs.
Implement descriptor-based macOS enumeration and cleanup too. Repeated enumeration
must return the same complete entries; fdopendir on a dup shares directory offset,
so use a fresh descriptor-relative directory description or otherwise reset safely.
Keep the shared depth/entry budget and no-follow child traversal. A cleanup replay
never reacquires ownership from a persisted pathname/inode; preserve old receipts
and consumed-ownership states. Fix the whole primitive class, not one caller.

Do not implement bound_directory_path as `/dev/fd/<directory>/.` without actual
native evidence. Apple's XNU FDESC open duplicates a file descriptor, while its
descriptor vnode lookup is an error operation; this is not Linux procfs directory
traversal. F_GETPATH followed by an ordinary mutable path also does not bind I/O.
The present package/conversion code uses this helper for both tree operations and
SQLite snapshot files; audit every caller.

Refactor these callers to a portable private held-directory capability where
necessary. A pinned established capability library is acceptable if its concrete
operations meet the same contract and tests. SQLite private snapshots need an
explicit file/capability bridge with bounded I/O and controlled sidecars; do not
serialize a possible multi-GiB DB into memory, change process-wide cwd, or pass
process-local FD paths to workers/durable journals. File-leaf FD access is distinct
from directory traversal and must be proved on the actual target before use.
Preserve the same-snapshot SQL capture and short writer/bulk-outside boundary.

Official implementation reference consulted by root:
https://github.com/apple-oss-distributions/xnu/blob/main/bsd/miscfs/devfs/devfs_fdesc_support.c

The resulting abstraction must permit the following Windows checkpoint to supply
real handles; it must not assume every platform is a Unix procfs tree. Avoid
premature Windows fake implementations. Keep public renderer/HTTP contracts
unchanged unless a concrete generated capability addition is necessary.

## Target-platform evidence

Add a focused native PR workflow on a pinned supported macOS runner/toolchain,
Node/pnpm and locked dependencies. Preserve the existing Foundation workflow.
Run real native filesystem tests rather than only compiling target types. Include:

- Native create/adopt/open/source save; unchanged exact Markdown, stale/replayed
  success and rejection, locks, grouped history and reopen.
- Add/remove/replace and each pre-file/post-file/post-SQL cut; partial multi-file
  graph settlement, actual displaced version and preserved unknown stage.
- Symlink/hardlink/alias/replaced ancestor and new destination collision cases.
- Repeated directory enumeration and no-follow bounded cleanup; discarded-copy
  replay preserves a later directory and does not reacquire deletion authority.
- Actual immutable binary publication/copy/read, fixed package export/inspect/
  verified restore, conversion and new-file native package save.
- A deterministic replacement inside promotion and inside conversion/package
  preparation. Verify the original/source and unknown target bytes remain intact.

Reuse existing semantic tests where applicable, with actual target fault tests for
the new primitives. Do not disable the relevant source/graph tests to make CI
green. OS-specific tests may assert a held native handle prevents a rename or that
the changed identity fences the operation, with the concrete behavior documented.
Keep native core tests distinct from Electron GUI packaging/playback acceptance.

On frozen source run Linux focused native regression, affected full Rust/static
checks and real target CI. Stop all writes/checks/processes for root review and
provide exact intended-files/SHA-256/log manifest. Root independently checks,
documents evidence and commits/pushes before OP6-A2. No Windows acceptance is
claimed from this checkpoint. No real projects, provider spend, arbitrary-code
execution, Git mutation/worktree/delegation by the coding agent, merge/tag/deploy
or cloud publication. Preserve root docs and .agents.
