# Model services and durable credentials

Status: implementation checkpoint validated on 2026-11-17; see the
[validation report](../validation/ai-model-services.md). The feature starts from
`origin/release/1.0.0` at `22cb413`; it targets that release by a new PR. This
follow-up refines the shared AI spec's settings presentation and credential
adapter without changing manuscript orchestration or task-start semantics.

## Settings and service ownership

Settings navigation becomes General, Model services, Default models. Desktop
uses a settings navigation column, a compact OpenAI/DeepSeek service list and a
detail region. Narrow layouts navigate list/detail without squeezing three
columns. Use the existing warm-neutral workbench tokens, quiet separators,
compact controls, bilingual text, keyboard focus and independent scrolling.

Only OpenAI and DeepSeek are new-service presets. Default API roots are
`https://api.openai.com/v1` and `https://api.deepseek.com/v1`; users may edit roots
for compatible proxies. Both use the existing OpenAI-compatible Chat Completions
adapter. New profiles use bearer authentication and standard names without asking
users to choose a protocol/template or invent a profile name. The API-root contract
continues to avoid adding another `/v1` automatically.

Add optional `servicePreset: openai | deepseek` to AiProvider in the schema, generate
both consumers and validate at most one assigned profile per preset. It is
nonsecret presentation metadata, not a different adapter or task fingerprint.
Existing records remain readable. Recognize unambiguous official-root profiles
for initial presentation, preferring the bound provider; do not mutate on read.
Other/duplicate legacy profiles remain directly accessible as saved-service rows;
the [writing follow-up](writing-workspace.md) removes the Manage dialog. Users explicitly assign a profile to a preset, preserving
its UUID, root, model entries, credential reference and bindings; reassigning a
preset unassigns its former profile rather than deleting it. Preserve legacy
authentication modes. No records are removed simply to simplify the new menu.

Service details show key availability/persistence, editable root, one Save
configuration action and the added-model list. A saved key is represented by
status, never returned as plaintext. Show/hide applies only to newly typed input.
Settings mutations share one revision-aware controller/queue; save root/profile
and credential steps truthfully report partial failure. Preserve entered drafts
on failure and during service switching. Clear unsaved secret input on settings
close, and never put keys in renderer storage. Loading/testing must not disable
the whole settings window or redirect late results to another selected service.

## Models, defaults and testing

Discovery opens a searchable selection view; persist only models the user adds.
Manual IDs remain available when listing fails. Preserve saved models on listing
failure. Model entries are independent of category bindings: add/remove/configure
without selecting a default. Block removal of a bound model until the user
explicitly changes or clears the affected binding; preserve other categories.

Default models initially shows one global text/manuscript selector, grouped by
service. A model-row Set as manuscript model action writes the same binding.
Existing legacy bindings remain visible and usable. Keep audio/video bindings
internally without showing unavailable placeholder controls. Outline, initial
draft and review use the shared text binding; no per-project overrides.

Model advanced settings hold capabilities, token-limit compatibility, temperature
and output budget. Unknown capabilities stay unknown. A service/model name or
successful listing does not prove vision/streaming/native JSON support. A model
test is explicit inference with a quota note; bind its receipt to the exact saved
root, credential revision, model and relevant options. Configuration changes
invalidate the visible result. Distinguish a fresh test from resolving an
ambiguous existing action; never silently redispatch or fall back. Settings only
affect future task starts; running/queued tasks retain their captured references.

Add optional AiModel.defaultParameters (AiParameters) for independently saved
model preferences. Seed absent preferences from an existing binding when present;
new models use conservative nonstreaming/prompt-JSON defaults and an 8192-token
output budget bounded by known model limits. The writing follow-up raises only new
entries: existing saved budgets and legacy 4096-token inheritance remain unchanged. Selecting a text default uses these
preferences; explicitly saving preferences for the bound text model updates that
binding in the same settings replacement. Preserve other categories. Existing
settings without the optional field retain their existing effective parameters.

## Durable Web credential adapter

Retain CredentialStore as the boundary. Native Windows/macOS keyring backends
remain in use. On nonnative hosts, a configured
`SCENESPARROW_AI_MASTER_KEY_FILE` selects an encrypted-file adapter; ordinary local
development without it remains explicitly session-only. Add `encrypted_file` to
AiSettingsView.credentialBackend, distinct from native and session-only.

The master key is 32 random bytes encoded as standard base64 in a bounded file,
outside app-data/project backups. Use a pinned maintained authenticated-encryption
implementation (AES-256-GCM, fresh random 96-bit nonce per write). Store one
versioned ciphertext per credential revision under global app-data, with a
SHA-256-derived filename and authenticated revision/context identity. Bound inputs
and envelopes; atomically replace private files and coordinate writes. No raw key
or API secret appears in settings JSON, project objects, errors, logs or IPC.
Deletion is idempotent; existing in-memory leases follow the shared spec.

Use an authenticated vault header to reject a wrong master key at open. Missing,
malformed or unreadable configured keys and incompatible vault headers fail with
a stable credential error; never silently downgrade an existing encrypted vault
to memory or plaintext. Per-entry corruption/unavailability is reported as missing
credentials without destroying other entries. Settings revisions/inventory remain
responsible for ownership and cleanup; credential bytes stay out of that JSON.

The Web supervisor passes only the master-key file locator to the core, not its
contents and not to document/render/provider workers. Deployment provisions a
master key once in the existing host secrets directory, mounts it read-only as a
Compose secret and reuses it on redeploy. Do not require a new chat-supplied key or
rotate it on each build. If an encrypted vault already exists but the key is
missing, deployment must stop and require restoration rather than generate a new
key. Key backup/restore is documented separately from the app-data archive.
Gateway authentication, origin checks, domain and port 8070 remain in force.

## Delivery slices and acceptance

1. MS-01–MS-05: shared settings shell/service presets, independent model catalog,
   default text binding, targeted operation state and legacy compatibility;
   schema/client/core validation and meaningful browser regressions.
2. MS-06–MS-08: encrypted credential adapter, accurate persistence status,
   supervisor/deployment secret provisioning, restart and backup guidance.
3. MS-09: root review, full checks/build/integration/browser regressions,
   desktop/narrow screenshots and an English PR validation report.

Acceptance includes unchanged project/history after opening settings, two preset
entries, explicit legacy assignment without identity loss, model addition without
binding changes, manual IDs after discovery failure, shared default action,
service-switch/late-response/unsaved-key isolation, invalidated test receipts,
no automatic inference, encrypted restart recovery, wrong/missing-key and tamper
behavior, deletion/reconciliation, idempotent deploy provisioning and no secret
leakage. Applied project migrations 001–010 are immutable. Native OS and real
provider execution need separate evidence; do not claim them from Linux mocks.
