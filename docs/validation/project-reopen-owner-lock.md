# Project reopen owner-lock regression

## Scope and evidence

The release check in [run 43810111912](https://github.com/Geminorun/SceneSparrow/actions/runs/43810111912)
failed in
`exports::worker_tests::promotion_rename_and_directory_flush_failures_settle_and_unblock_queue`.
The rename failure, queue continuation and forced directory-flush failure assertions
passed; reopening the dropped repository returned `Storage` at `exports.rs:1769`.
The historical log contains no underlying storage error, so it cannot by itself
identify an OS error or establish a deployed-server problem.

Investigation used release commit `7338da95e0fd12904c77e2537756ea745aa1630a`
on Linux with Rust 1.100.0 and Node 24.22.1. A test-only storage diagnostic records
only the source call site; it does not print error payloads, SQL, project content,
credentials or project paths. Production error codes remain unchanged.

The original test passed alone, and all 143 infrastructure library tests passed
with default parallelism. A further 32-thread run under syscall tracing also
passed. Those successful runs did not disprove a timing race.

To widen the interval between a utility fork and exec, `strace` delayed exec entry
by 50 ms while four export tests ran concurrently. The unchanged original test
then failed at the same reopen assertion. Its diagnostic identified
`owner.try_lock()`, before SQLite open or recovery. The trace for that test thread
showed SQLite descriptors closing, the owner descriptor closing, and a fresh
`flock(LOCK_EX | LOCK_NB)` returning `EAGAIN` 123 microseconds later. An unrelated
test's utility child had forked before that close and was still awaiting exec.

On Unix, a duplicated/inherited descriptor refers to the same open file
description and retains its flock until every descriptor closes or an explicit
unlock occurs. Close-on-exec does not cover the interval before exec. This is a
reproduced cause of the exact observed failure mode; the historical CI log alone
cannot prove that its particular failure had the same syscall ordering.

Local investigation artifacts are retained outside the repository:

- `/tmp/scenesparrow-export-ci-failed.log`: historical CI log.
- `/tmp/scenesparrow-export-delayed-4.{log,strace}`: exact original test failure;
  thread 518140, owner close and failed reacquisition at trace lines 8004–8005.
- `/tmp/scenesparrow-reopen-delayed.{log,strace}`: 32-thread run with 20 ms exec
  delay; eight additional reopen failures, all at owner-lock acquisition.
- `/tmp/scenesparrow-reopen-regression-before.log`: deterministic regression fails
  before the fix; no timing injection is required.
- `/tmp/scenesparrow-reopen-regression-after.log`: the same regression passes.

## Fix and regression coverage

`ProjectOwner` explicitly unlocks its successfully acquired file lock on drop.
The guard exists immediately after acquisition, including startup error paths,
and is the final repository field so the connection and consumers drop before
ownership is released. Read-only preflight uses the same guard; its inventory
repository has no owner guard instead of pretending an unlocked SQLite file is
an owner lock.

The deterministic Unix regression retains a duplicated owner descriptor across
repository drop, then reopens successfully. It also verifies that a live owner
still excludes another repository and that closing the stale descriptor cannot
unlock the replacement owner's lock. A second test verifies guard cleanup on an
early initialization error with a retained descriptor. Existing export recovery
assertions are unchanged.

## Validation

All Cargo commands used the locked dependencies and a shared bounded target:

```sh
source scripts/cloud-env.sh
export CARGO_TARGET_DIR=/tmp/scenesparrow-reopen-target
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_BUILD_JOBS=4
```

| Check                                                                               | Result                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Baseline focused original export test                                               | 1 passed                                                                |
| Baseline full infrastructure library, default parallelism                           | 143 passed, 49.15 s                                                     |
| Baseline full library, 32 threads under strace                                      | 143 passed, 56.12 s                                                     |
| Baseline full library, 32 threads, 20 ms exec delay                                 | 135 passed, 8 owner-lock reopen failures                                |
| Baseline exports, 4 threads, 50 ms exec delay                                       | 13 passed, 2 owner-lock reopen failures, including the original CI test |
| Deterministic retained-descriptor regression before / after fix                     | Failed at reopen / passed                                               |
| Fixed full infrastructure library, default parallelism                              | 145 passed, 46.58 s                                                     |
| Fixed exports, 4 threads, 50 ms exec delay                                          | 15 passed, 5.23 s                                                       |
| Fixed full library, 32 threads, 20 ms exec delay                                    | 145 passed, 55.94 s                                                     |
| `cargo clippy --locked -p scenesparrow-infrastructure --all-targets -- -D warnings` | Passed                                                                  |
| `cargo fmt --all -- --check` and report Prettier check                              | Passed                                                                  |

The controlled export command was identical before and after the fix, apart from
the output artifact names:

```sh
strace -f -ttt -yy -e trace=flock,clone,execve,close \
  -e inject=execve:delay_enter=50ms -o /tmp/scenesparrow-export-fixed-delayed-4.strace \
  cargo test --locked -p scenesparrow-infrastructure --lib exports:: \
  -- --test-threads=4 > /tmp/scenesparrow-export-fixed-delayed-4.log 2>&1
```

This validation covers Linux storage/recovery behavior. Windows/macOS execution,
the full deployment pipeline and the deployed instance have not been validated
by these tests. No migration, public protocol, deployment configuration or retry
policy changed.

## Independent root review

Root reviewed the exact failing syscall trace, ownership acquisition/error paths,
field destruction order, read-only preflight and regression assertions. The fix
retains nonblocking rejection of a second owner and leaves export fault/recovery
assertions intact.

Using the same bounded Cargo settings, root independently ran:

- `pnpm check`: passed contracts, formatting, types, all 107 Node tests, all
  159 Rust tests (145 infrastructure, 12 domain and two service), and
  workspace/all-targets Clippy with warnings denied.
- `pnpm build`: passed Web, desktop TypeScript and the production core build.
  The existing large Web chunk warning remains.
- `pnpm test:integration`: all seven actual-core integration tests passed,
  including project restart, verified backup/recovery, exports and shared AI
  configuration across independent cores. Provider responses used local fakes.

Logs are `/tmp/scenesparrow-reopen-root-{check,build,integration}.log`. An ignored
debug-output symlink let the existing integration fixtures use the bounded target
without recompiling into a second cache. No source, user project or deployment
data was removed. Local browser and Docker image checks were not repeated for
this storage-only change; GitHub workflow results are separate evidence.
