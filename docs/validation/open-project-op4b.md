# OP4-B recorded external work validation

Date: 2026-11-19. Base: `2823f6a` on `feat/open-project-format`.
Status: independently reviewed on Linux for OP4-T04–T07. This completes the local
OP4 gate with [A](open-project-op4a.md); OP5 migration/packages and OP6 platform /
lifecycle acceptance remain separate. Specification: [OP4-B](../specs/open-project-op4b.md)
and its [frozen handoff](../specs/open-project-op4b-handoff.md).

## Resulting behavior

The existing application menu and Changes dialog create recorded private work
copies or inspect live external changes. Grants bind the original core-produced
base, allowed files/subtrees, manuscript all/none/exact blocks and selected Library
context. Copies contain ordinary creative files and selected reference bytes/link
indexes, with separate protection guidance. They contain no project database,
global credentials or executable preview capability. Context links are not crawled.

Creation/inspection are durable bounded operations with one preparation worker,
five queued/running admissions and five mutable-copy slots. Capture/pin under the
existing writer, perform bulk copy/hash/preparation outside it, then revalidate and
pin results before acknowledgment. Preparation/reader leases protect collection.
Concurrent same-hash publication retains descriptor/content verification. Restart
interrupts incomplete work until explicit retry; it never silently recaptures a base.

Actual file differences include additions/deletions/replacements, bounded readable
text and binary hash/size facts. Raw-to-prepared Markdown identity mapping persists
before inspection is acknowledged. Acceptance binds the full original DTO, current
base, scope, observation, policy and exact candidate. Original outcome lookup comes
before payload lookup; disposition, graph/history and ordinary receipt share the
same SQL transaction. Scope grants cannot modify management, unlock prose, approve
content or cause another provider call. Media-only work remains possible beside
independently locked text. Production path/hash locks have their own five-step
history and unknown production dependencies remain conservative.

Named generated HTTP/preload capabilities expose pages and exact candidate/recovery
member streams without arbitrary paths. Native reveal accepts an item ID only.
Streams use 64 KiB buffers and authenticated membership/reader leases outside network
backpressure or native save dialogs. A durable paginated recovery index and explicit
full-graph recovery fingerprint complement the earlier source-only recovery API.
Ordinary source status polling does not hash all media.

ProjectSession owns registered rename and external mutations alongside manuscript
input. Original receipt/result and newer current source/project metadata remain
separate. Unknown application/readback fences newer writes while retaining typing,
IME and the exact DTO. A proved applied text result that conflicts with later raw
input installs a fully verified accepted checkpoint, preserves exact raw input and
caret, and enters an explicit conflict with autosave paused. Existing Changes
supports download/comparison, a new normal-policy combined proposal or guarded
reload. No original accept is resubmitted; post-click reload input is protected.
New explicit read failures have localized three-second notices and owned compact
retry; passive polling does not repeat them. UI remains the compact offwhite shared
workbench, with no permanent extra panel or raw JSON dashboard.

Only migration 014 is added; delivered 001–013 are unchanged.

## Independent review and corrections

One gpt-6.1-sol/high writer implemented the checkpoint. Root owned design, specs,
frontend/platform review, independent checks and Git. A read-only implementation
reviewer examined native scopes, receipts, concurrency, retention and cleanup without
running tests or changing files. Writers stopped for each review and root check.
Review reproduced and corrected these material defects before acceptance:

- An ordinary source-only observation fingerprint could not preserve a v3 media
  intent. The explicit named full-graph inspection now captures/revalidates intent,
  root and project with a collection lease outside the writer.
- Replaying discarded-copy cleanup could delete a later directory after inode reuse.
  Interrupted stage replay had the same flaw; pathname recursion could also follow
  a stage replacement after verification. Cleanup is now one-shot with continuous
  held descriptors, no-follow descriptor-relative traversal and no deletion on
  business replay. Depth/entry bounds prevent stack/descriptor exhaustion.
- Inspect and explicit retry bypassed the shared queue limit. Every admission now
  checks the same bound, and original QUEUE_FULL replays stay rejected after space
  becomes available.
- Source/window/timer/manual/planning/proposal/start entry points could dispatch or
  capture another owner during uncertain external work. They now share the fence,
  preserve newer buffers and resume only through the original outcome.
- A definite legacy metadata rejection could remain unresolved forever; an older
  rename result could overwrite newer displayed metadata. Submit ownership and
  readback failures are distinct, and verified current metadata is monotonic.
- New page/selection reads could omit top feedback or produce an unhandled rejection.
  Scoped read ownership retains rows/retry and ignores later-revoked results.
- A known applied text acceptance could remain permanently uncertain after later
  input, preventing both merge and reload. Verified applied-conflict recovery now
  preserves raw/IME input and enables explicit resolution. Reload also captures
  input/context before queueing instead of discarding later typing.

RED/GREEN evidence includes deterministic original/staged identity reuse after
reopen, actual after-verification stage swapping, tiny cleanup budgets, held-worker
queue admission, actual autosave timers, old/new rename results and held text/IME
browser acknowledgments. No timeout, skip or behavior count was weakened.

## Actual evidence

Every root shell sourced `scripts/cloud-env.sh`; Rust-running wrappers exported
`CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=4`.
Cargo operations were sequential. All service/provider fixtures were sanitized
local instances; no real projects or providers were used.

| Owner | Check                                      | Result and exact checkpoint                                                                                                               |
| ----- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Root  | Final native work/copy/reader/lock suite   | 27 passed on final bounded cleanup bytes.                                                                                                 |
| Root  | Final rebuilt-service HTTP suite           | All 24 passed on final bounded cleanup service.                                                                                           |
| Root  | Related Node/session/source/preload tests  | 125 passed on final UI; last correction changed only physical.rs and native tests.                                                        |
| Root  | Complete source/work browser suite         | All 25 passed in one final UI run; exact UI bytes unchanged by the last native bound.                                                     |
| Root  | Legacy workspace/editor-workspace browsers | All 21 passed after ownership/metadata/read corrections; later text conflict is source-specific, native cleanup has no legacy UI changes. |
| Agent | Workspace/all-target Clippy, service build | Passed on final native bytes.                                                                                                             |
| Agent | Contracts, types and formatting            | Passed; final localized Rust bound also passed cargo fmt.                                                                                 |
| Agent | Earlier broad Rust/Node/build              | Rust 311, Node 435 and combined build passed before localized review corrections; not represented as final broad runs.                    |

Root logs: `.artifacts/op4b/root-native-bounded.log`, `root-http-bounded.log`,
`root-node-final.log`, `root-browser-final.log`, `root-browser-legacy.log` and
`root-bounded-checksums.log`. Agent exact commands, failed/green checkpoints and
manifests are indexed by `.artifacts/op4b/HANDOFF.md` and its three preserved review
rounds. Final code manifest has 52 entries. Root viewed actual diff/accepted/recovery
and applied-text-conflict screenshots, checked current contracts/types/formatting
and reviewed the staged diff before delivery.

An earlier immutable A Foundation run 44484633236 failed one continuous-typing
clock-boundary assertion; its exact-head second attempt passed. B's unchanged
selection passed once plus three repeats, and root's legacy 21 passed it too. No
root-cause fix is claimed for that initial intermittent result. Current PR CI remains
a separate checkpoint; a prior head is not final OP6 evidence.

## Remaining limits

Linux filesystem/core behavior and browser/VM/IPC hosts are exercised. Native
Windows/macOS access/promotion, persistent root identity, recovery-only startup,
default-format activation and actual native GUI dialogs retain OP6 gates. Browser
ZIP exchange, complete packages and verified legacy conversion are OP5. No arbitrary
project-code execution, embedded Agent SDK, production TTS/ASR or video editor is
introduced. The trusted standalone fixture does not provide an execution sandbox.

Interrupted physical cleanup deliberately retains residual original/stage bytes;
logical slot release does not claim physical deletion. There is no automatic
pathname-based cleanup retry or fresh residual-cleanup capability. Cleanup is
bounded to 64 descents/100,000 entries, independently of creative graph limits.
Graph inventory remains 20,000 files, 4 GiB/member, 16 GiB aggregate; text/control 4 MiB,
private graph/intent 16 MiB. Text previews are 128 KiB/120 lines for one page of at
most 100 entries. Held binary I/O uses a 5 MiB fixture; no full-size latency/RSS claim.
File/directory-prefix transitions and inherited CRLF empty-quote/nested identity
placement remain explicitly refused. The existing full S1–S4 regression baseline
and real-provider/native performance gaps retain their own acceptance categories.

No merge, tag, deployment or cloud-environment publication occurred.
