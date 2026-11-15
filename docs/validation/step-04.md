# Step 4: shared AI configuration and durable execution

Implementation handoff for `SAI-T01`–`SAI-T13` on `feat/script-workbench`, based on
`302dcea2cf7234a537a38ccca6e3f7c3cdf38ee5`. Root review/commit/push is a separate
gate; the independent root review below records that gate's result. This does not complete S2/S3 consumers, SAI-T14, SAI-T15 or production provider
readiness. No real credentials, paid inference or target-host launches were used.

## Implemented scope

JSON Schema generates generic Rust/TypeScript settings, configuration, messages,
artifacts, runs, test actions and worker frames. `packages/ai-runtime` has no editor,
manuscript, render or repository dependency. It uses OpenAI 7.57.0/Ajv 8.20.0; the
agent is its plain Node 24 host with no transform-only TypeScript syntax. Only
`text.generate` is active. Audio/video and search are explicitly unavailable.

Global settings are locked, expected-revision, atomically replaced app-data JSON.
Deleting profiles atomically removes dangling models/bindings and permanently
retires profile identities. Semantic fingerprints exclude unrelated display labels.
Credentials use keyring 3.6.3 source adapters on Windows/macOS and clearly labeled
session memory on Linux. The nonsecret inventory precedes secure insertion; failed
retirement/orphan cleanup remains retryable. Readback is presence only; rotating a
key invalidates queued old-revision leases while an issued lease stays pinned.

The bilingual shared settings view adds/edits/deletes providers and keys, discovers
or manually enters models, selects the single global text binding and explicitly
tests inference with a quota notice. Test preparation freezes the selected saved
provider/manual model independently of the global binding. Receipts identify the
actual tested tuple. Exact duplicate action IDs return one app-session outcome;
a prior session's uncertain action cannot replay. All named HTTP/desktop operations
retain authentication/origin checks and bounded blocking work slots separate from
manual project operations. There is no public arbitrary-prompt enqueue operation.

Migration 005 appends run/input/attempt/dispatch/artifact/event, preparation,
application binding and deferred coordinator-cleanup records. Applied 001–004 are
unchanged. The internal UOW accepts a core-issued locked configuration, commits
consumer binding/reservation and queued run together, and replays an existing
request before current preconditions. One project generation and eight pending
runs are allowed. Frozen inputs/configurations remain immutable after settings edits.

Inputs, preparations, retained outputs and opaque consumer/history pins participate
in existing backup/GC roots. Object verification, input deserialization and native
origin watermark replacement precede short SQL writes. Claim/fence plus a unique
durable dispatch marker authorize one worker call. After the marker, loss never
causes redispatch. The external origin registry verifies canonical DB path, native
file identity and monotonic watermark. Known original unclaimed queues survive;
claimed/lost attempts and every copied/unknown/old-restored nonterminal run are
interrupted. A failed transaction after the registry write can conservatively fence
other pending work on reopen; it cannot create a duplicate call.

The supervisor covers blocked startup/input pipe writes, deadlines, cancellation,
protocol overflow and Linux sampled 512 MiB RSS. Control frames are at most 4 MiB;
artifact chunks are at most 24 KiB before base64. The escaped input envelope has
an independent 8 MiB bound; semantic text is still 1 MiB/128 messages, images
8 × 4 MiB/16 MiB aggregate, output 8 MiB and transient preview 256 KiB. Schema
validation excludes regex/recursive/external/combinatorial work. Runtime checks
UTF-8/scalars, finish/refusal/tool calls, JSON/schema and byte limits, including adapter-added instructions/schema/message overhead before dispatch, with no repair.
Generic result success is immutable and separate from once-only consumer application.
Registered owning coordinators serialize cancellation/failure applicability fences.

## Acceptance and task evidence

Paths below are relative to the repository root. The numerical fixture owns opaque
reservation/application records and does not import manuscript types.

| Acceptance       | Tasks         | Evidence and limits                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC01–02          | T01–04        | `ai::tests::global_revision_lock_atomic_profile_delete_url_and_semantic_fingerprint`; actual browser/global HTTP settings flow; settings remain outside project history/backup. Competing revisions, retired IDs and complete JSON verified.                                                                                                            |
| AC03–04, AC07    | T03, T09      | Credential rotation/issued lease/logical retirement, failed secure insert/delete cleanup/reopen, injected atomic reference commit failure and session restart tests. HTTP/UI key clear/presence and file/DB/log/process canaries. Native adapters unrun.                                                                                                |
| AC05–06          | T02, T04, T06 | Counted local compatible HTTP routes, manual ID after failed listing, selected A/B test targets without changing text binding, exact duplicate session receipt, custom root/no guessed `/v1`, bearer redirect target sees zero calls, keyless endpoint sends no Authorization. Real TLS/proxy/native provider smoke remains open.                       |
| AC08–10          | T01, T05, T09 | Independent runtime fake and numerical UOW participant; dependency checks; scoped identity/hash/MIME artifacts, unknown-image explicit attempt, image/context bounds, escaped 1 MiB text, remote/recursive/regex schema rejection and oversized frames.                                                                                                 |
| AC11–13          | T05–06        | Official SDK stream/nonstream, prompt/native schema, max token field freeze; auth/rate/model/parameter/server errors, SDK-only timeout and dribbled discovery body deadline. One counted call per inference, no retries/fallback/repair/tool execution; malformed content/scalars/truncation/refusal fail. Actual framed Unicode-boundary workers pass. |
| AC14–17          | T07–08        | Fake consumer injected mid-transaction rollback leaves no run/input/receipt/binding/event; stale config rejects, label edits do not stale, accepted config freezes. Altered request IDs fail and exact replay precedes settings/consumer guards. S2/S3 integrations are later steps.                                                                    |
| AC18–19          | T09–10        | One-active/eight-pending tests; actual nonreading shim with a 4 MiB artifact is killed/reaped on timeout/cancel with zero permits; oversized worker stdout rejected. Linux RSS sampling implemented; native RSS remains open.                                                                                                                           |
| AC20, AC24, AC26 | T10, T12      | Original claimed/dispatched versus queued restart; copied queued DB; same-file-identity old snapshot restore; conservative write-ahead mismatch; new manual retry lineage/current config; unique dispatch marker refuses a second permit.                                                                                                               |
| AC21–23          | T11           | Duplicate/altered/hash-mismatched/late receipts; cancellation-before-complete, succeeded-unapplied cancellation and already-applied winner; actual SDK worker completes once and result applies locally after reopen with no additional network.                                                                                                        |
| AC25, AC27       | T12           | Durable AI/project events use existing read-only replay/resync. GC retains live preparation/active/shared historical pins; explicit terminal pruning preserves compact request/receipt identity. Existing history/SSE suites exercise no task resurrection.                                                                                             |
| AC28–29          | T13           | `UnavailableSearch` and runtime unavailable search return no invented entries; unsupported audio capability rejects before dispatch. Existing manual source/editor flow stays provider-independent.                                                                                                                                                     |
| AC31             | T03, T06, T09 | SDK logging forced off even with `OPENAI_LOG=debug`; actual worker error body/prompt/key canaries absent from stdout/stderr; settings/SQLite/log/UI readback checks; absent usage stays null.                                                                                                                                                           |
| AC30, AC32       | T14–15        | Deferred: real S2/S3 validators, Windows Credential Manager/macOS Keychain and multiple actual compatible endpoints require their own evidence. No claim based on fakes/Linux.                                                                                                                                                                          |

## Verification

Targeted implementation checks passed: workspace type checking; eleven initial
Node runtime cases; eleven initial shared-AI Rust cases; actual core settings HTTP
integration; selected A/B bilingual browser settings; and the service test holding
the settings file lock while health/project reads remain responsive. Historical
v2/v3 migration fixtures now remove later 005 tables when reconstructing those
old states; applied migration bytes were not modified.

The final production-source gate completed in the managed Linux environment with
Node 24.22.1, pnpm 11.25.0, Rust 1.100.0 and system Chromium. Ordinary checks used
only synthetic credentials and counted loopback endpoints.

| Command                                   | Actual outcome                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source scripts/cloud-env.sh; pnpm check` | Passed: contract drift, formatting, workspace types, 48 Node tests, 4 domain / 54 infrastructure / 2 service Rust tests, warnings-denied Clippy. |
| `pnpm build`                              | Passed: browser, desktop TypeScript and Rust. Existing bundle-size advisory remains.                                                             |
| `pnpm test:integration`                   | Passed: all 3 real core-process fixtures, including settings selected A/B/session/credential behavior.                                           |
| `pnpm test:e2e`                           | Passed: 19 active cases in 1.1 minutes; dedicated performance case skipped in this normal run.                                                   |
| `pnpm peers check`, `git diff --check`    | Passed; applied migrations 001–004 have no changes.                                                                                              |

After that full gate, the actual SDK worker fixture was strengthened to transfer
one full MiB of escaped text through IPC/SDK, and the settings browser fixture
saved `.artifacts/step-04-ai-settings.png`. Both targeted cases passed (the browser
case in 3.5 seconds); the screenshot was visually inspected, including Chinese
labels, empty key input, masked presence and explicit tested B target.

The last production correction makes Node `--use-system-ca` and `--use-env-proxy`
explicit in the supervised launch instead of relying on developer environment
activation. The actual SDK/escaped-input Rust case, warnings-denied Clippy and
all 3 integration cases passed with those flags. A subsequent test-only Linux
process inspection checks synthetic keys/service tokens are absent from actual
worker arguments/environment; it does not print those process buffers. Its first
thread-child enumeration was unsuitable for this managed PID environment and was
corrected to inspect only the known application worker executable; the final single
settings integration case passed in 1.3 seconds with both worker inspections. No unchanged
slow document-worker fixtures were repeatedly run for these last targeted fixes.

Safe generic terminal logs contain correlation, category/adapter/model, duration,
status, output size and nullable reported usage. Reported usage is retained in the
immutable completion receipt; neither usage nor cost is invented.

## Independent root review

The root inspected the final implementation, migration/dependency changes and
review corrections, then ran the complete gate on the handed-off tree. `pnpm check`
passed with 48 Node tests and 60 Rust tests (4 domain, 54 infrastructure, 2 service),
including warnings-denied Clippy and contract drift/format/type checks.
`pnpm build`, all 3 integration fixtures, all 19 active browser cases,
`pnpm peers check` and `git diff --check` passed; the dedicated performance case
was skipped. The existing browser bundle-size advisory remains.

The root also visually inspected `.artifacts/step-04-ai-settings.png`: Chinese
labels, session-only credential notice, empty key input, masked key presence and
the explicitly selected B inference target are visible. All identified blocking
review findings were corrected before this independent gate. The code checkpoint
passes review; the provider/native readiness and later consumer evidence below
remain open.

## Remaining evidence and platform limits

Windows/macOS credential behavior, desktop launch/IME/close, native RSS enforcement,
OS power-loss durability and packaged worker/resource location have not been tested.
The development host resolves installed source workers from the build-time repository
root and requires pinned Node/workspace dependencies. This is not a packaged desktop
runtime claim. HTTPS uses system verification and Node's configured proxy/trust;
real endpoint trust/proxy interoperability remains unrun. Endpoint templates are
syntactically verified editable roots, not provider certification.

No real search adapter is configured. S2/S3 consumers and task presentation follow
in steps 5–7; S4 cites these independent ports/evidence. Step 3's measured 500 KB
save/undo and 2 MB typing/save/undo budget misses remain open for step 8. This step
makes no new large-document performance claim and does not redesign history.
