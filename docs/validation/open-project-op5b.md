# OP5-B: fixed portable packages and verified returned edits

Status: independently reviewed Linux backend checkpoint, 2026-11-19.
Baseline: accepted OP5-A `b516736`. This Linux backend checkpoint covers OP5-T04
through T06 and OPF-AC14/15/19. Transfer UI/chooser adapters remain OP5-C; default
format, actual activation and macOS/Windows physical capabilities remain OP6.
Read the [stage spec](../specs/open-project-op5b.md) and
[exact handoff](../specs/open-project-op5b-handoff.md).

## Delivered boundary

Complete project ZIPs have an ordinary project root and a versioned
`.scenesparrow/transfer.json` inventory. Recorded work-copy ZIPs use the explicit
`project/`, `context/` and `transfer.json` envelope. Both use the same named typed
HTTP/preload capabilities, authenticated core and bounded transfer worker.
Inspection does not install dependencies, execute code or call a provider.

A complete export fixes SQL/source/graph/history at the original start boundary.
SQL and managed identity bytes are bound by hashes/sizes after portable snapshot
sanitization, before acknowledgment. Verified control traversal installs precise
original closure pins outside bulk payload work; a transient coarse fence cannot
retain unrelated future objects indefinitely. Materialization reads the immutable
SQL-owned roots object, not mutable staging metadata. Original retry reuses that
capture; it cannot silently choose a newer saved generation.

The complete allowed creative tree, public dependencies/lockfile, media and
required management/current/history/approval/candidate/paid-result/export closure
are included. Global settings, credentials, auth, process handles, mutable work
copies, node_modules, caches and recursive backups are excluded. Work-copy context
comes from the original recorded reference/grant evidence; mutable extra context
files cannot enter the package.

ZIP preflight bounds metadata before library indexing and checks both raw/effective
interpretation, local/central fields, names/prefix aliases, types, CRC, actual
expanded sizes/hashes and ratio. Store/Deflate, bounded ZIP64 and data descriptors
are supported. Budgets are 20,000 entries, 4 GiB/member, 16 GiB expanded total,
8 GiB archive, 32 MiB central metadata and 200:1 plus 1 MiB individual/aggregate
expansion. Public controls are 4 MiB; private graph/transfer records are separately
bounded. Export uses Store and must pass its own inspector. An oversized complete
closure refuses explicitly without omission.

Upload is raw binary in at most 1 MiB chunks, with exact offset/length/hash and
stable acknowledged end. A repeated committed chunk verifies its original bounded
range without appending. Seal/hash/inspect retain one original operation. File
copy/hash/download uses 64 KiB buffers, cancellation and reader leases; no whole
archive Vec/base64/JSON result is returned.

Independent restore validates the complete trusted closure in a new no-clobber
target, preserving the archived project UUID separately from owner/root identity.
Copied nonterminal jobs, preparations, work-copy paths, cleanup capabilities and
capture custody are fenced before Ready and ordinary collection, including native
verified backup reopening. Original terminal outcomes remain unchanged. Returned
edits require the original local export/work base and use the existing OP4 actual
diff/grant/candidate/lock/acceptance/history owner. An uploaded DB cannot replace
current management state.

## Recovery, retention and review corrections

Original full DTO/digest lookup precedes fresh validation. Five combined migration/
package admissions and one transfer worker preserve A's lifecycle journal. Pending
publication is reconciled only by exact own Ready proof. Terminal failures and bad
interrupted proof remain readable with their original revision/outcome; explicit
retry can recover a proved published result without changing its SQL bytes.

Ready archives and known complete terminal Project/Work export captures retain a
seven-day retry window; an accepted explicit retry renews it. Active work/readers
remain protected. Unused or canceled intake expires after 24 hours; pending return
candidates extend retention and terminal decisions retain uploaded bytes for seven
further days. Expired captures return stable PACKAGE_EXPIRED without recapture.
Original compact outcomes survive cache expiration. Restored roots and verified
migration backups are not cache.

Expiry releases only original custody/pins and uses one fresh descriptor-bound
proof/cleanup attempt. File/symlink replacement, failed proof and interrupted
cleanup preserve unknown residuals. A later replay cannot delete bytes recreated
at an old pathname. Status expiry is read-only; whole-intake updates share the
same lease/fresh record, so an old poll cannot overwrite a newer chunk or seal.

Independent review corrected ZIP interpretation mismatches, capture/pin crash and
GC races, original receipt decoding/collision, copied authority, publication/status
gaps and finite canceled-capture custody. The final large-record regression uses
800 actual one-byte files: its WorkCapture exceeds 64 KiB and expires through the
same bounded 16 MiB atomic writer used by its producer. The small 64 KiB journal/
index limit is unchanged; large record writes stay outside the short journal lock.

## Evidence

Every command sources scripts/cloud-env.sh. Rust commands/wrappers use
CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0 and CARGO_BUILD_JOBS=4.
Cargo runs are sequential; full Rust runs without heavy concurrent Node checks.
All projects/providers are sanitized local fixtures; no real user conversion or
provider spend occurred.

| Owner | Check                                         | Result                                                                                                     |
| ----- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Root  | Final full Rust workspace                     | 392 passed: domain 29, infrastructure 358, service 5; all remaining targets/doc tests passed               |
| Root  | Full Node unit suite                          | 455 passed                                                                                                 |
| Root  | Web/desktop/workspace build                   | Passed                                                                                                     |
| Root  | Rebuilt real-core HTTP integration            | All 34 passed, including seven package cases and retained AI/planning/review/source/backup/migration flows |
| Agent | Final native package selection                | 45 passed                                                                                                  |
| Agent | A conversion selection after SQL015 additions | 16 passed, before only final private Work/bounded-save changes                                             |
| Agent | Final affected client/desktop/gateway         | 19 passed                                                                                                  |
| Agent | Final related real-core HTTP                  | 26 passed, including seven package cases                                                                   |
| Agent | Final Clippy/build/contracts/types/format     | Passed on frozen implementation                                                                            |

Final implementation manifest: 54 files, SHA-256
`39dae989518542387a9ce552106853102295b81db93b2006cba64358bfca6b90`.
Root verified these hashes before and after independent checks. Logs and exact commands are
under `.artifacts/op5b/`, indexed by HANDOFF.md. Two earlier root full-workspace
runs were deliberately interrupted for review corrections; they are not full
success claims. The second completed domain 29 and infrastructure 357 before the
localized large-work-record correction, without service/doctest completion.
Earlier loaded-run failures and isolated unchanged AI supervision proof remain
distinguished in the handoff; no timeout behavior was changed to mask them.
Final root commands were `cargo test --workspace --locked`,
`node --import tsx --test tests/unit/*.test.mjs`, `pnpm build` and
`node --test tests/integration/*.test.mjs`; their logs are root-rust.log,
root-node.log, root-build.log and root-http.log. Root also reviewed the actual
diff and both read-only correction reviews before staging. Backend-only changes
do not claim a new browser/GUI acceptance result.

## Remaining gates

This is backend-only Linux evidence. Browser transfer flows, incremental File
hash/upload, authenticated browser download and named native chooser/save are C.
Actual macOS/Windows file primitives, startup recovery-only mode, default native
creation, configured-root activation/context fencing and final standalone rendering
remain OP6. These are later implementation gates, not claimed unrun passes.

Tiny policies/crafted archives prove boundaries; there is no GiB-scale throughput/
RSS or physical power-loss claim. No Electron GUI packaging, live provider,
deployment, release or cloud-environment publication occurred. Current prospective
PR merge-head CI remains a separate final gate. No automatic merge/tag/deploy.
