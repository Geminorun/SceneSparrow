# OP6-A2 preparation: Windows held handles and preserving three-name recovery

Status: root preparation, not dispatched. Freeze after accepted OP6-A1 APIs and
actual macOS CI. Root owns specifications, review, tests and Git. Read the OP6
parent, accepted native capabilities and OP5-C named native package boundary.
This checkpoint implements actual Windows behavior; compilation is not acceptance.

## Physical capabilities

Implement Parent/private directory operations with real Windows handles. Hold the
root and each relevant ancestor with deliberate sharing that prevents replacement
or detects it before writes; reject reparse points, nonregular files and extra
links. Use volume and full file identity (128-bit ID represented as validated
fixed-width private hex, not lossy JSON numbers). Preserve Unix delivered identity
and intent readers. Verify actual UTF-16/non-ASCII, case and portable-name behavior,
including NFC/NFD and Chinese names. No generic canonical-prefix path fallback.

A stable path can be used for legacy APIs only when retained handles actually make
its ancestors unmovable and all relevant children are separately proved. Do not
return an ordinary pathname from a supposedly held capability and assume Unix
semantics. File read/create/stage, immutable binary publication, directory traversal,
copy/preparation, cleanup, SQL and native delivery all use the accepted capability.

Handle sharing must permit owned operations. Disposable containers need an
initial role-specific DELETE-capable handle and handle-relative own rename; do not
close all identity handles and reopen by old pathname to avoid sharing errors.
Read-only inspection should not require DELETE ACL merely to view a project.
Verify actual parent directory flush behavior/error mapping and file sync. No
unchecked copy-delete or ReplaceFile fallback on unsupported filesystems.

## Version 4 replacement intent

Current source and graph callers assume Parent.exchange is a two-name swap. Do
not hide a Windows multi-step operation behind that assumption. Record version 4
platform-aware target, staged replacement and distinct displaced name/identities
before first native mutation. Keep v1/v2/v3 readable; unknown versions stay intact.

Default preserving protocol uses held-file handle-relative no-replace renames:
known target -> recorded absent displacement; held stage -> now-absent target.
Every source/graph/history/adoption normalization path uses a recorded protocol;
there is no unjournaled exchange exception for adoption. Record partial creation
ownership before normalization where an accepted project does not yet exist.
The target can be temporarily absent; recovery must classify that actual layout.

On pre-SQL recovery, restore proved before bytes with no-clobber moves. On committed
recovery, finish proved after bytes. Account for a third held file, unknown target,
unknown stage/displacement, changed identity with identical bytes, multi-file
partial progress and interrupted rollback. Verify the complete required closure
before touching first member. An error return does not imply no mutation. Cleanup
requires the existing one-shot live ownership; replay cannot reacquire deletion
authority from an old pathname/inode or remove an unknown member.

Do not use ReplaceFileW's backup option after only an existence precheck. It has
no documented backup no-clobber flag and 1176/1177 partial layouts differ. Root
selected explicit preserving no-replace steps before dispatch. FILE_RENAME_INFO
RootDirectory supports a handle-relative destination. Test the concrete API and
sharing semantics on real Windows rather than infer them from Wine or Unix.

## Complete target evidence

Extend the actual native PR workflow with pinned Windows runner/toolchain and
locked dependencies. Run source create/adopt/save, stale/replayed success/error,
BOM/mixed endings, history/locks/reopen, actual binary addition/removal/replacement,
each before-file/inside-native-step/after-file/after-SQL cut and multi-file recovery.
Exercise target/stage/displaced collisions, links/reparse, replaced ancestors,
locked destinations and own disposable-directory rename/cleanup replay. Verify
conversion, fixed packages, inspect/restore/return, and native new-file save on the
same physical implementation. Do not skip a relevant suite merely to make CI pass.

OP5-C native intake currently uses main-owned Linux file checks. Enable other
platforms only with actual accepted identity/no-link/bounded-read evidence; a cfg
removal or Number-valued Node inode check does not establish full Windows identity.
A private main-to-core chosen-file capability may perform the held native read if
needed. Renderer still receives only safe generated IDs/basename/outcome, never
native paths, generic fs, shell or custom size/hash policy.

Use sanitized fixtures, no providers or real projects. Stop all writes/checks/
processes and provide files/hashes/log manifest for root. Root independently runs
Linux retained regressions/static gates, reviews actual Windows and macOS CI,
documents and commits/pushes. Native core evidence is separate from Electron GUI
packaging/playback. No writer Git/worktree/delegation, merge/tag/deploy/cloud
publication. Preserve root docs and .agents.
