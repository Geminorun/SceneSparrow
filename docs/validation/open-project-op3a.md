# OP3-A validation: reconciliation and source delivery backend

Independently reviewed on Linux, 2026-11-19, following `9c59723`.
This accepts the backend checkpoint of OP3-T04–T06, not OP3-B editor/browser
acceptance or the final OPF-AC04/05/08/09/12/19 cross-stage gates.

## Implemented behavior

Named HTTP/preload capabilities provide lightweight source status, explicit
rescan, immutable candidates, accept/discard/proposal, same-process recovery and
scoped recovery evidence. Linux watch events are hints; quiet-period actual-byte
inspection and a bounded fallback rescan never accept external changes or add
prose history. Status does not parse or load the manuscript projection.

Intent v2 separates accepted metadata from physical before/after versions. Normal
saves and explicit resolutions use the same guarded writer, original DTO digest,
policy, history and receipts. V1 recovery remains readable. Missing files use
no-clobber restoration. Unexpected live/staged bytes refuse automatic recovery.
Explicit preserve-external recovery proves the original SQL outcome, retains
evidence and records a durable decision before clearing the fence. It does not
overwrite external content. Replaying an old decision cannot settle a newer one.

Succeeded AI results blocked by file conflicts retain their paid run/artifact.
Without a definite application outcome, only local application resumes after
resolution. A definitively rejected application requires an explicit new business
request to apply that retained result, with no new inference. Counted fixture
tests cover both paths and duplicate application.

Clean Markdown uses immutable raw-source snapshots and parser-owned metadata
ranges, preserving BOM, mixed line endings, unknown syntax and code literals.
Existing copy/export jobs and serializer identity remain the delivery owner.
Unsupported semantic plain/DOCX delivery refuses instead of omitting content.

## Review corrections

Root independently reviewed journal/recovery, observation retention, candidate
membership, source-aware delivery and shared command coordination. Three findings
were corrected by the same coding agent before this checkpoint:

- Passive candidates originally retained every source save indefinitely. The
  current observation, unresolved-intent candidate and explicitly retained
  recovery candidates are now protected; only five other recent automatic
  records remain. Collection reclaims unreferenced payloads. Receipt-first replay
  still works after a candidate is retired.
- Native file validation rejected integral JSON spellings accepted by the shared
  JavaScript validator. File-only schema integer normalization now accepts
  `1.0`/`1e0` and future integral versions without rewriting bytes or changing
  opaque extension values. Live DTO decoding stays strict. The shared corpus
  contains 80 cases.
- Preserved staged content was inaccessible through the named APIs. Read-only
  recovery evidence list/member operations now expose verified project/intent
  members, exact base64 bytes and honest UTF-8 previews. Foreign hashes and the
  journal JSON blob are excluded. Invalid UTF-8 staged evidence survives cleanup,
  collection and reopen.

## Verification

Root's final independent focused run on the corrected source:

| Check                                   | Result                                          |
| --------------------------------------- | ----------------------------------------------- |
| Domain tests                            | 27 passed, including 80 shared validation cases |
| Native `open_source::` tests            | 43 passed                                       |
| Rebuilt-service source HTTP integration | 9 flows passed                                  |
| File/source/client/preload Node suites  | 122 passed                                      |

The HTTP set includes integer-spelling inspection/adoption/reopen without a
manifest rewrite, native conflict settlement, missing-file restoration, clean
Markdown byte delivery and retained AI result application with one counted SDK
call. Root inspected the bounded-retention and staged-evidence regressions.
Logs are under ignored `.artifacts/op3a/root-review-*.log`.

The agent additionally passed the two backup/schema-upgrade tests, contracts,
typecheck, desktop build, Clippy and formatting after the corrections. Its broader
256-test Rust, 387-test Node and 20-flow integration checkpoint preceded these
corrections; it is not reported as a complete run on the final source. All owned
checks/processes stopped before root review. Shells sourced `scripts/cloud-env.sh`;
Rust-invoking checks used both zero-debug profile exports and four build jobs.

## Remaining gates

OP3-B must implement the source editor, shared save/IME ownership, review/lock
surface adapters and visible conflict/recovery/delivery interactions with real
browser evidence. No UI acceptance follows from backend tests. Native promotion
outside Linux remains an OP6 implementation gap.

Same-process recovery requires a running core. Unknown recovery evidence during
repository startup can still prevent HTTP startup; OP6 must provide a verified,
fenced recovery-only startup path. It must not initialize missing metadata or
start project jobs while recovery remains unresolved. Multi-file acceptance is
OP4; complete packages and migration are OP5. No arbitrary project-code execution,
production audio/video workflow, real-provider test or deployment was performed.
