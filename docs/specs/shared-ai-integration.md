# Shared AI specification: configuration and execution

Status: step 4 implements the generic T01–T13 boundary; see
[step 4 evidence](../validation/step-04.md). Steps 5–7 implement text-consumer T14;
[step 8 evidence](../validation/step-08.md) and the
[acceptance matrix](../validation/acceptance-matrix.md) record cross-stage T15
evidence. Target-platform/real-provider readiness remains open. Version: 0.1.
This independent spec supports the
[S1–S4 stage specifications](README.md) and refines the
[shared AI technical design](../design/shared-ai-v0.1.md).

The user's confirmed choices take precedence: user-supplied API access, one global
text/audio/video configuration, task-start snapshots, manual failure recovery and
no automatic model/provider switching. Engineering defaults below require actual
validation. `SAI-*` identifies this spec; `AI-01`–`AI-18` identifies the parent
[acceptance plan](../design/implementation-and-acceptance-v0.1.md).

## 1. Outcome, scope, and ownership

Implement reusable provider configuration, secure credentials, capability/model
metadata and durable AI execution. A caller submits normalized messages and a
versioned output contract, observes a run and receives a generic result. It need
not construct a manuscript, outline, comment, lock, scene or render project.

| Shared module         | Owns                                                            | Consumer owns                                                |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| Settings              | Provider profiles, models, category bindings, revisions         | Workflow selection of category/capability                    |
| Credentials           | Secure storage, revision references, scoped execution lease     | Explicit user key entry/settings navigation                  |
| Runtime/adapters      | Normalized input/output, SDK transport, streaming/cancel/errors | Prompts and output schemas for its operation                 |
| Core execution        | Run/attempt/fence/dispatch state, artifacts/events/recovery     | Business binding, target dependencies and write restrictions |
| Source discovery port | Actual URL/title/snippet result contract and availability       | Selecting/adding references to a project                     |

Business acceptance is always separate from provider success. Only the core
commits authoritative project state; workers return output and never write a
project database. Source parsing, image extraction, DOCX export and rendering
remain utility/media responsibilities, not provider functions.

Implement only `text.generate` now, using OpenAI-compatible Chat Completions.
Text covers planning, drafting, questions and revisions. Reserve global audio and
video bindings as unavailable future capabilities. Later video script generation
may use `text.generate` through its video category; Remotion/Chrome/FFmpeg remain
separate render executors. Native vendor protocols, audio synthesis, generated-code
execution, tool agents, embeddings and hosted multitenancy are outside this release.

## 2. Structure, dependencies, and implementation order

| Location                                 | Responsibility / dependency restriction                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `crates/domain/src/ai/`                  | Generic IDs, states and capability/config value rules; no SDK/SQL/UI types                    |
| `crates/application/src/ai/`             | Settings/execution/credential ports and generic use cases                                     |
| `crates/application/src/script/ai/`      | Consumer prompts, evidence, domain validators and bindings; no provider SDK                   |
| `crates/infrastructure/src/ai/`          | Settings file, SQLite execution repository and worker transport                               |
| `crates/infrastructure/src/credentials/` | Platform credential-store adapters and session-only development implementation                |
| `packages/contracts/schema/ai/`          | Planned schema organization for generic DTOs, integrated into the existing protocol generator |
| `packages/ai-runtime/`                   | New Node/TypeScript library, normalized request/result and provider adapters                  |
| `workers/agent/`                         | Thin supervised process host for that library, without database access                        |
| Shared settings UI                       | Global provider/model/category forms through restricted platform client operations            |

These paths are planned. Evolve the provisional bootstrap `AgentProvider` interface;
do not turn `allowedObjectIds` into a provider concern. Keep business scope in the
consumer binding. Generated contracts remain sourced from the repository's JSON
Schema entry point; implementation must update generation/checking if schemas are
split into referenced files. Worker protocol version 1 is separate from `/v1` HTTP.

| Dependency                   | Required handoff                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| SAI-DEP01: bootstrap         | Local core, authenticated client/desktop bridge, pnpm/Cargo boundaries and schema generation |
| SAI-DEP02: S1 infrastructure | Immutable objects, transaction/receipt/outbox ports, project owner lock and recovery hooks   |
| SAI-DEP03: target platforms  | Credential Manager/Keychain adapters, controlled process/IPC and application-data paths      |

Settings and the runtime library can be developed against fakes before S1 finishes.
Durable project execution uses the S1 repository/object abstractions. Shared AI
does not depend on S2 or S3; those consumers depend on its public ports.

The eight-step delivery sequence uses append-only project migrations:
`001` bootstrap, `002_manuscript.sql` manual editing (step 1),
`003_history.sql` bounded history (step 2), `004` sources/import (step 3),
`005` shared AI execution (step 4), `006` S2 planning (step 5),
`007` S3 review (step 6), `008` S3 finalization (step 7), and
`009` S4 export (step 8), and `010` project metadata rename receipts. The latter
supports default-workspace onboarding without changing manuscript revisions or AI
execution. Compact rename receipts remain for the project lifetime so ambiguous
retries cannot overwrite a later rename, including an intervening title cycle.
Applied `001`/`002` retain their original numbers and
bytes. Steps 2 and 3 append applied 003 and 004 with their migration/recovery tests.
Migrations 005–009 are implemented with their delivery evidence in steps 4–8. Each
delivery adds its own migration instead of rewriting an earlier step. Additional migrations append
to the sequence; never renumber an applied migration or reuse a version for another
layout. Global settings have their own JSON `schemaVersion`, not a second database.

## 3. Global settings and capability contract

### 3.1 User flow and records

One application-wide settings page adds/edits/removes provider profiles, enters or
replaces a key, discovers or manually enters model IDs, tests inference explicitly,
and selects the text binding. Audio/video categories are visible as reserved or
disabled without pretending to generate media. No per-project override or separate
outline/review/prose model selector is introduced.

| Record             | Required fields                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `ProviderProfile`  | Stable UUID, label, adapter `openai_compatible`, base URL, auth mode, credential revision reference, profile revision     |
| `ModelEntry`       | Provider/model identity, label, capability declarations/evidence, optional context/output limits                          |
| `CategoryBinding`  | `text                                                                                                                     | audio | video`, provider/model reference, common generation parameters and binding revision |
| `AiSettings`       | Schema version, monotonic settings revision, providers/models/bindings and execution-policy defaults                      |
| `ResolvedAiConfig` | Immutable provider/model/category/adapter versions, URL/auth reference, validated parameters/capabilities and fingerprint |

Write nonsecret settings atomically to an app-data file. Use an application-level
file lock, expected settings revision and complete validation. A conflicting write
returns `SETTINGS_CONFLICT`, preserving the previous file. Replace through a
temporary file/atomic finalize; never partially update a binding and its profile.
Removing a profile clears dangling bindings in the same settings revision. Profile
IDs are never silently recycled. Settings are outside project undo/redo and backups.

Normalize the explicit API root without guessing/appending `/v1`. Presets may
offer OpenAI, DeepSeek, Qwen-compatible, Gemini-compatible, Groq and local Ollama
roots after URL verification during implementation; manual custom roots always
remain possible. A placeholder Claude URL is not a working native adapter. Keep
the BiliNote reference/limitations in the technical design; no Python stack is added.

Validate URL syntax and reject user-info or secret-bearing query parameters.
Honor an explicitly configured HTTP endpoint where needed; HTTPS always verifies
TLS with the configured system trust. Generation, discovery and connection tests
use the same proxy/trust transport. Do not forward authorization through redirects:
disable automatic redirects and surface an endpoint/configuration error. Keys and
proxy credentials never become URL/debug-log fields.

### 3.2 Models, parameters, and evidence

Model listing is an explicit safe request to the configured compatible endpoint;
listing failure does not prevent a manually entered model ID. It is not an
inference test. Preserve an actionable listing error rather than silently replacing
the selected model with a suggested model or static list entry.

Capabilities are `supported`, `unsupported`, or `unknown`, plus evidence source
such as provider metadata, user declaration or a scoped successful test. Include
image input, streaming and native structured-output support. A model name, model
list or successful text ping proves none of its untested capabilities.

Unknown optional streaming/native-JSON capabilities default to the conservative
non-streaming/prompt-JSON path before dispatch. A user declaration can enable an
attempt without relabeling it verified. Unknown image capability requires an
explicit attempt declaration or a deliberate text-only choice in consumer preflight;
never drop images and claim they were understood.

Validate temperature/output/context parameters before dispatch. Omit unset or known
unsupported optional fields. A compatibility declaration selects token-limit field
`max_tokens` or `max_completion_tokens` and response-format/stream options; freeze
that choice. Never send a failed request again with parameters removed or another
transport/model. Unsupported parameters are an explicit failure to fix in settings.

Connection testing is an explicitly labeled inference action and may consume the
provider's quota. Use the selected model/root/key and a small compatible output
budget, without assuming temperature zero or one output token works for all models.
Record the tested tuple, scope and time, not an invented price/latency guarantee.
Test failure changes neither the binding nor other model defaults automatically.
Give an app-scoped connection test its own action ID/digest and session receipt,
so duplicate submissions share that one call. After app-session loss its status
can be unknown; never automatically replay an uncertain test. A fresh explicit
test action is separate from retrying a transport request with the same identity.

## 4. Credentials and configuration snapshots

### 4.1 Credential lifecycle

Use a `CredentialStore` port with put-new-revision, acquire-scoped-lease, delete and
presence/status operations. Validate a maintained implementation such as Rust
`keyring` on Windows Credential Manager and macOS Keychain before pinning it.
The UI can submit a newly entered key, then clears its input; read operations
return presence/masked status only, not saved key characters.

Store an immutable opaque credential revision reference in settings. Never persist
raw keys in project/app JSON, SQLite, browser storage, prompts, command receipts,
logs, CLI arguments, exports or environment variables passed to workers. Keys
are sent to the authenticated core only through the restricted settings operation.
Do not record raw key submissions in the normal request-receipt/event mechanism.

On key replacement, create the new secure entry first, then atomically commit its
reference under the settings revision check. If settings commit fails, remove the
unused new entry. Retire the old entry after successful replacement; do not keep
an archive of deleted keys just to make queued work run. Reconcile orphan secure
entries by reference, without reading/logging their values. A deletion clears the
current reference/presence and retires its secure entry.
Logical retirement takes effect with the settings commit: new lease acquisition
checks the active credential reference, not just whether an old Keychain/Credential
Manager entry still exists awaiting physical cleanup.

An already issued in-memory execution lease may finish with its pinned revision.
A queued task whose revision has been retired fails `CREDENTIAL_UNAVAILABLE`;
it never substitutes the new key. Settings edits/removal affect future resolution,
not accepted run snapshots; a user cancels an active task through the task action.

When no supported secure store is available in browser/Linux development, use a
clearly labeled process-memory-only store. Restart loses that key and queued work
must report its absence. No plaintext fallback. Explicit local `authMode = none`
requires no fictitious stored key; any SDK-required placeholder is nonsecret and
internal to that adapter.

### 4.2 Freeze at accepted start

Consumer preflight calls `resolveConfiguration(category, capability)` to obtain
safe readiness/capability metadata and a configuration fingerprint. No model call
or credential readback occurs. The consumer assembles bounded immutable input and
records the fingerprint in its prepared request.
Fingerprint the resolved category/profile/model/credential/adapter/policy tuple,
not unrelated application display settings. Keep the global settings revision
separate for update conflict checks.

At accepted start, a shared `withResolvedConfiguration` port briefly holds the
settings lock, rereads/validates that fingerprint and resolves the exact current
configuration. Under it, the core coordinator commits run/input/receipt and any
consumer binding/reservation in **one project unit of work**, before releasing
the lock. If settings changed since preflight, fail `CONFIGURATION_STALE` without
enqueue; S2 may present this as `PREFLIGHT_STALE`.

The lock order is settings lock, project writer coordinator, then short SQLite
transaction. Other project commands never acquire settings while holding a project
transaction. Settings writes need no project lock. Credential backend calls, object
serialization, process/network waits and provider work stay outside that short
critical section; prewrite objects and pin/recheck them at commit.

This provides a definite start boundary even when global settings change in another
local instance. Freeze category/model/root/parameters, adapter/output-contract
versions, credential revision and caller input references. Settings changes after
that commit leave queued/running snapshots unchanged. A project retains only a
redacted resolved snapshot for provenance, never editable project provider defaults.

## 5. Public ports and generic contracts

### 5.1 Core-facing operations

| Port operation                                      | Contract                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `readSettings`, `updateSettings`                    | Safe global records and expected-revision atomic update                                       |
| `resolveConfiguration`, `withResolvedConfiguration` | Readiness/fingerprint and task-start consistent snapshot boundary                             |
| `discoverModels`, `testConnection`                  | Explicit app-scoped actions; no project history or invisible inference                        |
| `enqueueInUnitOfWork`                               | Validate/freeze a request and stage one queued run using the caller's transaction context     |
| `readRun`, `readResult`, `observeRun`               | Generic state/artifacts/events scoped to run/project identity                                 |
| `cancelInUnitOfWork`                                | Fence execution; coordinator also fences consumer applicability in that same command          |
| `prepareManualRetry`                                | New run/request identity, current config/input and `retryOfRunId`; does not execute by itself |
| `reconcileExecution`                                | Original-database restart versus restored-copy recovery, without hidden resubmission          |

Unit-of-work interfaces belong to the application boundary and expose no concrete
SQLite connection to domain code. Infrastructure stages each owning module's
writes in the same project transaction. Consumers do not directly update AI tables;
generic AI code does not directly update outline/review/lock tables.

Generic runtime enqueue is an internal application port. Public model calls enter
through the authorized business command or explicit settings-test action; do not
add a raw arbitrary-prompt HTTP route that bypasses consumer guards. A non-script
test caller can use the internal port with its own opaque input/schema.
Enqueue requires the core-issued configuration guard from the accepted-start
boundary; a client-supplied `resolvedConfig` object is never trusted as that guard.

### 5.2 Request and result envelopes

| Request field                         | Meaning                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `runId`, `attempt`, `protocolVersion` | Core-owned identity, claim number and worker protocol version                        |
| `category`, `capability`              | Global category and implemented operation; only text generation enabled now          |
| `inputSnapshotId`, `inputHash`        | Immutable generic input identity/hash, not a paragraph ID contract                   |
| `resolvedConfig`                      | Frozen nonsecret settings/adapter tuple                                              |
| `messages`                            | Ordered `system`, `user`, `assistant` messages with text or scoped image references  |
| `inputArtifacts`                      | Brokered identity, MIME type/hash/size; no arbitrary filesystem paths                |
| `outputSpec`                          | MIME type, schema ID/version/digest, optional scoped schema artifact and byte budget |
| `limits`, `traceId`                   | Deadlines/resource budgets and safe correlation                                      |

Business target IDs, lock lists, review versions and allowed mutation scopes stay
in the consumer binding. A consumer's schema can travel as an opaque validated
artifact; the runtime need not import that consumer's types. Schema references
must resolve locally from core-owned definitions, never fetch external `$ref` URLs.
Bound schema depth/complexity and reject untrusted schema injection.

Text image references resolve through a run-scoped input broker. Only selected,
verified bytes can become provider-compatible data/image parts. Never send local
paths as URLs or fetch a website because a text message contains a link. The
document worker prepares images; the AI adapter only maps supported inputs.

Normalize `started`, `progress`, `output_delta`, `usage` and a terminal completed/
failed/cancelled result. Results carry run/attempt/input identity, output content
or artifact manifests, output-spec version/hash, finish reason and optional reported
usage/provider request ID. They contain no approve/unlock/resolve/finalize command.
Ignore unsupported vendor-private fields rather than exposing raw SDK responses.

The runtime validates text encoding, output size, finish reason, JSON syntax and
the caller-supplied structural schema where required. The core verifies artifact
hashes and exact dispatch/input binding. The consumer then validates semantics,
scope, versions and locks. Valid JSON/provider success is not business acceptance.
Unsupported tool calls or unusable/refused/truncated output are typed outcomes,
not an instruction to execute generated code or continue with another request.

### 5.3 Limits and IPC

Initial engineering limits: 128 messages, 1 MiB aggregate text input, 8 MiB visible
output, 8 image inputs up to 4 MiB each/16 MiB aggregate, and a 256 KiB UI preview
buffer per run. Apply stricter consumer/provider limits first. Context token limits
can be estimates; exceeding them never authorizes silent target/source truncation.
Provider errors remain possible despite an estimate.

Use dedicated framed JSON pipes between core and worker, with bounded 4 MiB control
frames and smaller output-delta chunks. Large/schema/image/output bodies use scoped
artifact streaming rather than unlimited JSON/base64 IPC frames. Reserve stdout
for protocol and stderr for redacted diagnostics; a separate controlled credential
lease message is never echoed to either stream. Validate protocol/frame/schema
versions and associate every message with its run/attempt/fence.

The worker remains trusted application code, not an operating-system sandbox for
arbitrary generated code. Keep shell/source execution disabled. Supervise bounded
queues, output accumulation, worker exit and abort handling. Do not pass renderer
objects or database handles into that process.

## 6. Compatible adapter and request policy

Use the official JavaScript OpenAI SDK behind `openai_compatible`; pin a tested
version at implementation and keep its types within the adapter. All inference,
connection-test and listing paths use the same endpoint/auth/transport builder.
Set SDK `maxRetries: 0`, disable wrapper/job retry loops, and assert actual counted
generation requests in tests. No model/provider fallback is configured.

Choose streaming/non-streaming and native-schema/prompt-JSON mode from the frozen
capability profile before calling. Normalize either response path into one result.
Streaming failure never triggers a non-streaming request; invalid native-schema
parameters never trigger a second prompt-only request. Collect only supported
visible text and safe metadata, not raw provider payloads.

Initially use one completion choice and no provider-side tool execution. Parse
structured output once; malformed/truncated output fails without model-based
repair or continuation. Preserve previous user-visible valid business state under
the consumer rules. The adapter does not silently adjust a user's selected model,
token budget or temperature after a failure.

Default request deadlines are 15 seconds for explicit model discovery, 30 seconds
for a connection test, 180 seconds overall and 60 seconds without stream progress
for ordinary generation. Persist the selected limits in the run; a user can change
the policy for future tasks. A timeout stops local waiting/aborts and produces one
failure. It does not establish that remote work was unbilled or never executed.

## 7. Durable runs, dispatch, and cancellation

### 7.1 Queue and states

Use `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, and
`interrupted`. Terminal generic records are immutable except safe diagnostic/
retention bookkeeping. One active generation per project and eight pending runs
are initial limits. Consumer guards may be stricter, such as one planning run or
nonoverlapping review scopes. A full queue returns `QUEUE_FULL` before enqueue.

Persist `ai_runs`, `ai_attempts`, `ai_input_snapshots`, `ai_dispatches`, `ai_artifacts`
and `ai_events` in the existing project database. Generic attempt leases track
worker ownership only. Paragraph-use reservations/user locks are consumer-owned;
AI runtime code has no knowledge of them.

Accepted start commits the receipt, queued input/config, consumer binding and any
consumer reservation together through the unit-of-work port. No provider call
starts before commit. A repeated request ID/digest returns that original run;
reusing the ID with another payload fails. No-op/rejected starts create no job or
stranded business reservation.

### 7.2 At most one dispatch per run

Every worker claim has an attempt number and unforgeable fence. Before the worker
may issue generation, it requests a dispatch permit; the core durably inserts a
dispatch marker with unique `runId`, attempt/fence/input identity, then authorizes
that one call. Mark before opening the network request, not after receiving bytes.
An attempt without a valid permit cannot call the provider.

After a dispatch marker exists, no recovered worker/attempt may issue generation
for that run again. A crash between marker commit and actual HTTP send may leave
work unissued; classify it conservatively as interrupted and wait for manual retry.
This intentionally favors avoiding duplicate spending over guessing at remote
execution. A heartbeat is not proof that a call succeeded or did not occur.

An original-database restart may continue a queued run known never claimed/
dispatched, with its original config. Lost claimed/dispatched work becomes
interrupted; do not automatically reassign/replay it. Manual retry creates a new
run with fresh input/config and `retryOfRunId`; an attempt counter is a fence,
not permission for another paid call. Count inference tests as their own explicit
app action, not a free hidden connectivity request before each task.

### 7.3 Results, cancellation, and consumer applicability

Persist verified completed output, terminal run state and event in one transaction.
Duplicate identical receipts return the committed result; reject old fences or
altered receipts. A consumer applies that durable result once through its separate
application record. Crashing after generic completion but before business application
can recover locally without a provider request.

Cancellation revokes the active fence/dispatch applicability and aborts the HTTP
operation, then releases generic attempt ownership. The coordinator also revokes
the consumer binding/reservation in that command so a late locally stored result
cannot mutate business state. The generic service exposes this transaction hook
without importing manuscript models.

If a generic run already succeeded, preserve that fact. Its result may still be
unapplied: S2/S3 cancellation can fence that consumer's application while leaving
generic success immutable. If business application won the serialized race, return
already applied; if consumer cancellation won, never apply afterward. Task-list
cancel actions route through the registered owning coordinator, not a bypass.

Remote cancellation/billing reversal is not guaranteed. Report local cancellation
honestly without promising refund. Terminal cleanup releases only task ownership;
it never unlocks/approves content or closes a user's review thread.

## 8. Restart, restored copies, and retention

Startup reconciles the original-database run state, dispatch markers, worker leases,
promoted artifacts and consumer application records. Fence dead attempts before
releasing related business reservations. Known unissued queued work may continue;
ambiguous calls wait for explicit user retry. Already applied results cannot be
applied again just because a user undid the resulting document change.

Restoring a backup/imported project copy is a distinct recovery mode. An older
snapshot's queued run might have executed afterward in the original project. Fence
**all copied nonterminal runs**, including queued runs, and require manual retry.
The infrastructure establishes original versus restored/unknown execution origin;
an untrusted renderer flag cannot declare copied work safe to dispatch. Opening
an unknown-origin existing project treats its nonterminal calls conservatively.
Persisted metadata and valid local completed artifacts remain usable as evidence.

Runs/events/leases are outside the five-step project undo history. Consumers may
restore user decisions and reference retained result artifacts, but never restore
a running network request. Event reconnection/status polling cannot enqueue work.

Keep artifact roots for queued/active runs, the consumer's active/latest projections,
retained history, recovery slots and current/downstream provenance. The consumer
reports roots through an opaque artifact-reference port. Once no root needs a
superseded prompt/output payload, reclaim it safely under the core writer/GC
coordinator. Keep compact run/input hashes, safe statuses and command digests for
idempotency without preserving every prompt/alternative as a manuscript archive.

Retain at least the latest 1,000 durable project status events; raw streaming deltas
are bounded transient preview, not an unbounded replay log. Expired cursors require
state resync. A restarted view can show durable status/result even if old preview
chunks are unavailable. Project backup includes referenced task input/output bytes,
never application-global raw secrets or a promise that old queued work can run.

## 9. Source discovery and future capability boundaries

Define a separate `SourceDiscoveryPort.search(query, limits)` returning actual
URL/title/snippet/provider/time entries, or explicit unavailability. Default to
unavailable unless a tested adapter is configured. Plain Chat Completions does not
imply web access; model-invented links are not verified search results. Search does
not download a website body or auto-add references to a project.

Search configuration can reuse the global credential abstraction without inventing
another manuscript model category. Its concrete provider integration is optional;
the acceptance baseline always supports manual links/uploads. Business use cases
select results and add them through ordinary source/history commands.

Add future audio/native provider operation variants through versioned capability
schemas and adapters, not many media-specific optional fields on a text request.
A future non-script caller reuses settings/tasks/credentials while owning its own
context/result interpretation. Rendering/FFmpeg execution does not become a chat
adapter. Missing capabilities report unavailable; imported external artifacts remain
a future business fallback, never a fake successful provider generation.

## 10. UI/API, errors, and observability

| App-facing operation                         | Ownership and behavior                                           |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Read/update provider/model/category settings | App-wide revision check, safe fields only                        |
| Submit/replace/delete credential             | Restricted transient secret input; return presence/revision only |
| Discover models/test connection              | Explicit actions and scoped diagnostic results                   |
| Read run/result or subscribe                 | Project/run-scoped state and artifact identity, safe SSE         |
| Cancel task                                  | Route to its owning coordinator and generic fence operation      |

Use authenticated loopback `/v1/ai/settings`, named settings actions and scoped
`/v1/ai/runs/{runId}` reads/events. Public start remains the consumer's business
command. Settings tests are app-scoped ephemeral actions, separate from project
undo and durable business task history. Enforce existing source/frame validation
and narrow desktop bridge methods; never expose saved-key readback or generic shell.

Normalize `AUTH_REQUIRED`, `AUTH_REJECTED`, `CREDENTIAL_UNAVAILABLE`,
`MODEL_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `CONFIGURATION_STALE`,
`SETTINGS_CONFLICT`, `QUEUE_FULL`, `RATE_LIMITED`, `CONTEXT_LIMIT`,
`OUTPUT_TRUNCATED`, `INVALID_OUTPUT`, `PROVIDER_REFUSED`, `NETWORK_FAILED`,
`REQUEST_TIMEOUT`, `WORKER_INTERRUPTED`, `CANCELLED`, `PROTOCOL_MISMATCH`, and
`INPUT_TOO_LARGE`. Return safe action hints and correlation IDs. Do not mislabel
missing visible output as authentication failure or domain stale output as a
provider outage. Domain codes such as `CANDIDATE_STALE` remain consumer-owned.

Keep a persistent task error/status with settings/manual retry actions; a toast
alone is insufficient for recovery. HTTP input/config/state errors return 400/422,
409 or 413 as appropriate; asynchronous provider failure is a terminal run outcome.
Server-local storage and protocol errors have their own safe diagnostic mapping.

Log run/attempt, queue/request duration, safe model/category/adapter identity,
output sizes and reported usage. Usage/cost can be unknown; do not invent values.
No raw prompts, source text, API keys, authorization headers, proxy credentials,
lease messages or full provider bodies in logs/screenshots/ordinary diagnostics.
Persist user-intended input/output artifacts only as scoped project data. Tests
must exercise failure logging as well as successful redaction paths.

## 11. Development tasks and dependencies

T01–T13 have step 4 implementation and local fake-endpoint evidence. T14 is staged
across S2/S3/S4; T15 remains open for native credentials and actual provider evidence.
`Tnn`, `ACnn` and `DEPnn` mean `SAI-Tnn`, `SAI-ACnn` and
`SAI-DEPnn`. This is one independent spec, not a new application service fleet.

| Task    | Concrete deliverable                                                                                                     | Depends on              | Acceptance                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------- |
| SAI-T01 | Define generic settings/messages/capability/run/worker schemas and generated contracts; explicit dependency restrictions | DEP01                   | AC01, AC08, AC09             |
| SAI-T02 | Implement atomic global settings file, revision locking, profile/category/model validation and URL/transport policy      | T01                     | AC01, AC02, AC05, AC06       |
| SAI-T03 | Implement secure credential port/revision lifecycle, platform adapters and session-only development store                | T01, T02, DEP03         | AC03, AC04, AC07             |
| SAI-T04 | Build localized shared settings UI and safe platform endpoints, manual/discovered model selection                        | T02, T03                | AC01, AC02, AC03, AC05       |
| SAI-T05 | Add reusable runtime library and deterministic fake adapter with normalized bounded text/image/output contract           | T01                     | AC08, AC09, AC10             |
| SAI-T06 | Implement compatible SDK adapter, shared transport and explicit discovery/inference test with zero retries               | T02, T03, T05           | AC05, AC06, AC11, AC12, AC13 |
| SAI-T07 | Add migration 005, input/artifact/run/attempt/dispatch repositories and idempotent execution receipts                    | T01, DEP02              | AC14, AC15, AC16             |
| SAI-T08 | Implement task-start config locking and shared unit-of-work enqueue with fake consumer transaction participant           | T02, T03, T07           | AC14, AC15, AC17             |
| SAI-T09 | Add supervised worker IPC, scoped input/credential broker and bounded protocol validation                                | T03, T05, T06, T07      | AC07, AC09, AC10, AC18       |
| SAI-T10 | Implement queue/dispatch permit and at-most-one generation invariant, deadlines and worker-loss handling                 | T08, T09                | AC16, AC18, AC19, AC20       |
| SAI-T11 | Add generic result promotion/validation/receipts and separate consumer application/cancellation hooks                    | T08, T10                | AC21, AC22, AC23             |
| SAI-T12 | Implement original/recovered-copy restart modes, retention roots, event resync and manual retry lineage                  | T07, T10, T11           | AC20, AC24, AC25, AC26, AC27 |
| SAI-T13 | Define optional search availability/results port and future capability rejection/extension fixtures                      | T01, T05                | AC28, AC29                   |
| SAI-T14 | Connect S2/S3 fakes/live ports and S4 evidence hooks while preserving dependency ownership                               | T04, T08, T11, T12      | AC08, AC17, AC22, AC30       |
| SAI-T15 | Complete redaction/resource/race tests and actual target credential/compatible-provider smoke evidence                   | T06, T09, T12, T13, T14 | AC01–AC32                    |

Checkpoints: T01–T04 settings/credentials; T05–T06 reusable adapter; T07–T12 durable
execution/recovery; T13–T15 integration and evidence. S1 does not wait for this
runtime to deliver manual editing. Complete the shared core before claiming real
S2/S3 AI workflows; run export/manual checks independently.

## 12. Acceptance cases and parent mapping

Use fake endpoints with counted requests, deterministic barriers and synthetic
secrets. Ordinary CI makes no paid calls and has no real user credentials.

| ID       | Given / when                                                                | Required observable result                                                                                        | Parent mapping      |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| SAI-AC01 | Configure categories across two projects                                    | One global text binding, reserved audio/video, no project/per-substep override; settings outside project undo     | AI-01, AI-15        |
| SAI-AC02 | Competing settings writes, profile deletion or interrupted atomic save      | Revision conflict or complete valid update, no dangling bindings or partial settings file                         | AI-01               |
| SAI-AC03 | Store/replace/delete key and inspect UI/files/logs/receipts                 | Presence-only readback, no plaintext fallback/key leak, secure revision lifecycle and orphan cleanup              | AI-09               |
| SAI-AC04 | Rotate/delete credential while queued/running, or restart memory-only store | Issued lease may finish; missing pinned revision fails without new-key substitution; session loss explicit        | AI-02, AI-10        |
| SAI-AC05 | Models list missing/manual ID/test ping succeeds or fails                   | Manual ID remains usable; explicit test counts one inference; success proves only tested scope                    | AI-03               |
| SAI-AC06 | Custom root, TLS/proxy failure, redirect to other origin                    | Correct configured root/transport, verified HTTPS, no authorization forwarding or guessed endpoint fallback       | AI-04, AI-09        |
| SAI-AC07 | Inspect worker arguments/env/IPC and local no-auth profile                  | Secret only through scoped lease channel, no stored fake key, local keyless call works                            | AI-09, AI-18        |
| SAI-AC08 | Fake non-script consumer plus import/dependency checks                      | Generic runtime works without manuscript types; script UI/domain contains no provider SDK/secret implementation   | AI-11               |
| SAI-AC09 | Invalid frames/versions/remote schema refs/arbitrary artifact paths         | Bounded protocol rejects input, no unscoped file/network/schema fetch or DB access                                | AI-11, AI-12        |
| SAI-AC10 | Unknown/unsupported images, excessive message/image/output size             | Explicit capability/limit decision, no silent omission or claimed visual understanding                            | AI-16; SW-24        |
| SAI-AC11 | Stream/non-stream and native-schema/prompt-JSON output                      | Same normalized result, mode chosen before one call; partial/truncated data not accepted as complete              | AI-05               |
| SAI-AC12 | Auth/rate/network/timeout/parameter/schema failure                          | Count one inference, no SDK/wrapper/job retry, model/provider/parameter switch or repair request                  | AI-04               |
| SAI-AC13 | Inference returns unsupported tool call/refusal or wrong schema             | Safe typed failure, no execution, no automatic continuation and no business approval action                       | AI-04, AI-12        |
| SAI-AC14 | Settings change after preflight and after accepted start                    | Stale preflight rejects enqueue; accepted queued/running config remains fixed                                     | AI-02               |
| SAI-AC15 | Start transaction fails or command/receipt is duplicated                    | Run, consumer binding/reservation and receipt commit together or none; duplicate does not create another run      | AI-06               |
| SAI-AC16 | Crash before/after dispatch marker or attempt reassignment                  | At most one dispatch per run; uncertain work waits for manual retry, never guesses remote execution               | AI-06, AI-08        |
| SAI-AC17 | S2/S3 use shared transaction/config ports                                   | Correct lock order and atomic start without module table bypass, network wait or SDK in business code             | AI-02, AI-11        |
| SAI-AC18 | Worker dies, protocol overflows, queue fills or deadline expires            | Bounded state/resource failure, fenced attempt and safe actionable outcome; no hidden call retry                  | AI-04, AI-08        |
| SAI-AC19 | Multiple projects/queued tasks run under limits                             | Per-project bounds, frozen queued inputs and visible progress; consumer-specific scope guards still apply         | AI-02               |
| SAI-AC20 | Original database restart with known unissued queue versus ambiguous call   | Only known unclaimed/undispatched original queue can continue; ambiguous call interrupted                         | AI-08               |
| SAI-AC21 | Duplicate/altered/late completion or missing output artifact                | Idempotent verified output, fence/input/hash checked; no double result or consumer mutation                       | AI-06               |
| SAI-AC22 | Cancel races generic success and separate consumer application              | Generic terminal fact preserved, consumer fence prevents late mutation, no user lock/handled state changes        | AI-07, AI-12        |
| SAI-AC23 | Crash after generic result before business application                      | Recover durable local result once under consumer validation, zero extra provider calls                            | AI-06, AI-08        |
| SAI-AC24 | Restore old backup with queued run already executed in original             | Fence all copied nonterminal runs, no automatic dispatch, explicit retry uses new run                             | AI-08               |
| SAI-AC25 | Undo/redo consumer work or reconnect expired event cursor                   | Results/status resync without resurrected job or generation; no redo-tail change from arrival                     | AI-17; SW-21        |
| SAI-AC26 | Manual retry after config/input failure                                     | New identity/current config/input with retry lineage; old run immutable, request digest checks intact             | AI-02, AI-04        |
| SAI-AC27 | Prune superseded payload with live history/review/media reference           | Keep all live opaque roots, reclaim only unreferenced payloads; compact receipts/events avoid full prompt archive | SW-30               |
| SAI-AC28 | Search unavailable or adapter returns real URL/snippet entries              | Manual sources work, no invented verified link/full-page reading/crawler or automatic source addition             | AI-14               |
| SAI-AC29 | Request unimplemented audio/video/native operation                          | Explicit unsupported capability before dispatch; future typed extension test independent of script/render code    | AI-15               |
| SAI-AC30 | S2 outline/draft and S3 question/candidate use one global text config       | All return through business validators; generic success cannot accept/unlock/finalize/resolve                     | AI-01, AI-12, AI-13 |
| SAI-AC31 | Success/error logs, provider response bodies and unavailable usage          | Safe correlation only, no key/prompt/source/body leak, unknown usage/cost not fabricated                          | AI-09               |
| SAI-AC32 | Explicit real compatible endpoints and Windows/macOS credential checks      | Record actual endpoint/model/SDK/OS evidence; fakes/Linux cannot certify untested capability/platform             | AI-03, AI-09, AI-11 |

## 13. Verification and completion evidence

Introduce meaningful contract/domain/storage/worker tests into existing `pnpm check`,
`pnpm build`, `pnpm test:integration`, and `pnpm test:e2e` as implementation lands.
Dependency checks, counted fake HTTP requests, credential-store fakes and dispatch/
cancel/crash barriers must verify actual behavior rather than mirror DTO fields.
No SDK/network call is needed to validate this documentation delivery.

Before real-runtime readiness, record task/acceptance-to-test links, migration and
recovery evidence, safe settings/credential behavior, one non-script caller,
streaming/structured-output paths, at-most-one dispatch and explicit retry behavior.
Measure queue/IPC/output-memory costs separately from model latency. Record fixture
sizes/tool versions and real endpoint/target OS gaps; do not infer compatibility
from BiliNote popularity, a model list or a single successful prompt.

S4 cites this spec's independent evidence; it does not duplicate the AI implementation.
The user-facing delivery remains the manuscript workbench first. These documents
authorize neither paid smoke calls with unknown credentials nor automatic release;
actual implementation/verification follows the user's requested scope.

## 14. Step 4 implementation decisions

The [execution decision](../decisions/0002-shared-ai-execution.md) records the
application UOW participant, external native-identity/watermark origin proof,
credential orphan inventory and bounded schema subset. Public DTOs additionally
include explicit settings-test target preparation: this freezes the selected saved
provider root/manual model without changing the global text binding. Its session
receipt includes tested target/root and cannot replay across application sessions.

The source worker host streams up to an 8 MiB escaped input envelope in bounded
artifact chunks; the semantic input and 4 MiB control-frame limits above remain
unchanged. Unsupported regex/recursive/combinatorial schemas reject before dispatch.
Consumer registration drains deferred failure/recovery applicability cleanup.
`execute_next_ai` is the controlled host tick for a consumer coordinator; read/status
ports never schedule it. No manuscript consumer or raw public generation route is
added in step 4.

## 15. S2 consumer integration (execution step 5)

The script planning consumer uses the same frozen configuration, SDK/runtime,
durable queue, dispatch marker and origin-fenced recovery. Infrastructure's module
transaction participant commits script confirmation/binding/receipt with generic
enqueue; result application reuses the existing manuscript/history business commit.
No manuscript models or SDK imports enter the generic runtime. See
[step 5 evidence](../validation/step-05.md) for counted SDK/image requests,
configuration freeze, script applicability, cancellation and retention coverage.
Native/provider readiness remains independently open.

## 16. S3 consumer integration (execution step 6)

The script-owned review adapter reuses `accept_ai_module` and the registered
`script-review` coordinator. It prepares immutable prompt/schema/context/evidence
before start, then rechecks compact SQL dependency tokens while atomically staging
run/binding/claim/reservation/receipt. Generic result persistence precedes local
idempotent answer/candidate projection. Questions acquire no body reservation.
Cancellation/deletion/request fencing shares the execution-origin watermark;
manual retries carry validated lineage and current global configuration.

The generic runtime, SDK adapter and worker remain independent of editor types.
No read/status query starts inference. The localhost counted SDK and restart/race
coverage is described in [step 6 evidence](../validation/step-06.md); this is partial
SAI-T14/15 integration, not real-provider/native or full S3 acceptance.
