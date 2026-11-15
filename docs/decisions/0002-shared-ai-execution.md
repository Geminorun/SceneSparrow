# Shared AI execution boundaries

Status: implemented in execution step 4; native/provider readiness is separate.

The reusable Node library owns normalized text generation, structural output
validation and the compatible SDK. The Rust application owns ports; infrastructure
owns global settings, scoped credential leasing, project transactions, immutable
objects and supervised worker hosting. Consumers own their prompts, module records,
reservations and applicability. No public arbitrary-prompt generation route exists.

A consumer registers its cancellation/terminal-failure coordinator and stages its
opaque application binding using `ProjectUnitOfWork` in the same transaction as
`enqueue_in_unit_of_work`. The first independent caller is a numerical test fixture.
The shared application binding table contains only opaque payload/applicability;
future module adapters extend their transaction participant without exposing a
SQLite connection to domain/application consumers. Startup queues owning-coordinator
cleanup for interrupted work; registration drains it before new consumer starts.
Generic success and later consumer application remain separate durable facts.

Accepted-start lock order is settings file lock, project writer, short SQL
transaction. Verify/promote objects and write the next execution-origin watermark
before SQL. The origin registry lives outside project backups and binds canonical
path, native file identity (`file-id` 0.2.3), origin UUID and durable watermark.
A registry written ahead of a rolled-back transaction deliberately causes conservative
interruption on the next reopen. A copied/unknown origin or older restored watermark
fences every nonterminal run, including queued work. No renderer origin declaration
is accepted. The dispatch marker commits before the worker receives its single
network permit; an ambiguous attempt never receives another permit for that run.

Global settings use `atomic-write-file` 0.3.1 and an OS file lock. Keyring 3.6.3
provides Windows Credential Manager/macOS Keychain source adapters; neither target
backend has been run here. Linux uses an explicit session-only in-memory store.
A nonsecret revision inventory is persisted before secure insertion and retains
failed cleanup IDs for startup reconciliation. Logical retirement checks current
settings references before acquiring a lease. Already issued leases may finish.

The OpenAI SDK is pinned at 7.57.0 with retries and SDK logging disabled. A shared
transport rejects all redirects. The controlled host explicitly enables Node system
CA trust/environment proxy support and preserves configured proxy/trust inputs.
Selected endpoint templates are editable roots from the pinned design reference;
syntax validation does not establish real endpoint interoperability. Explicit test
preparation freezes the selected saved provider root, manually entered model and
token-field choice; it never changes the global text binding. Session action IDs
and receipts prevent duplicate tests. A prior session's uncertain test cannot replay.

The worker receives no database/project path or service/API-key environment. Input
and output bodies move as bounded artifact chunks over framed pipes; a separate
scoped lease frame carries the secret. The supervisor covers process startup and
blocked pipe writes, overall deadline, cancellation and Linux sampled RSS. This
trusted-code process is not an OS sandbox; no generated-code executor is installed.
Native Windows/macOS RSS enforcement and application packaging remain open.

Structural schemas use an intentionally bounded subset: objects, arrays, primitive
types, properties/required/additionalProperties, length/item/numeric bounds, primitive
const/enums and nullable alternatives. Local acyclic definition references are
allowed. Regexes, recursive references, external retrieval and combinatorial schema
alternatives are rejected before dispatch. Output nesting/node budgets and the
external process deadline bound validation work. Semantic/business validity remains
consumer-owned.

Input snapshot identity is its canonical SHA-256 `inputHash`, matching the immutable
object identity; it does not need an additional mutable lookup identifier. Reported
usage is retained in the compact completion receipt after payload pruning.
