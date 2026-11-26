# Native DeepSeek Harness for Web writing

Status — DSH-T01 implements the isolated native runner and controlled-provider
validation on Linux. Hosted-provider inference is pending. [Implementation evidence](../validation/deepseek-harness-agent.md)

## Scope and user experience

The file-backed Web deployment ships and starts the native DeepSeek Harness
runner with the application. DeepSeek Harness is the default Agent for new
configurations. In **Settings → Agent**, the user saves a DeepSeek API key,
selects a model and starts a conversation from the existing right pane. The
same Harness eventually handles Generate outline, Write draft and the existing
AI rewrite from a comment. An explicitly saved Codex preference remains usable
for conversations.

A question uses the attached document. A request with an explicit selection
can produce a replacement. The user reviews the difference and chooses Apply
or Discard. The Rust document service verifies the captured revision, byte
range, original quote and live locks before changing Markdown. The existing
Agent session and event interfaces carry the conversation and proposals.
[External writing Agent and guarded edits](external-writing-agent.md)

The Web editor, file import and saving remain usable while the runner starts,
credentials are missing, or DeepSeek is unavailable. The first delivery covers
the existing Linux Web deployment. Desktop packaging and persistent Agent
conversation history are follow-up scope.

## Runtime and protocol

Start with the official `@deepseek-ai/dsh` npm package and its ACP stdio
profile. The inspected `0.2.2-rc.5` package contains the ACP bundle and requires
Node 24.9 or later. The current Web image uses Node 24.22.1. Treat this release
candidate as an initial probe version. Pin the package and its dependency
lockfile after verifying clean startup and protocol behavior in the release
container. [Published package](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.2-rc.5)

Verify ACP initialization, session creation, model options, prompts, updates,
cancellation and close. Use a SceneSparrow-controlled text-only profile and
capture the actual capabilities of the pinned package. ACP updates carry
committed text. The composer displays those updates or progress as available.
For an edit, validate the complete response before emitting a replacement
proposal. Use Claudian's native integration as a reference for session routing
and orderly shutdown. [Official ACP profile](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/bundle/acp-app/README.zh.md)
· [Claudian native integration](https://github.com/YishenTu/claudian/blob/2fe7556de0b5f6f4f9c8eaa8206b7e1585b6f892/src/providers/deepseek/runtime/DeepSeekHostProcess.ts)

Extend the current `WritingAgent` boundary to select the adapter by engine.
Keep the authenticated project/session APIs and the existing Markdown write
path. Bind a conversation to its engine and model. Switching either starts
a fresh conversation. Keep native sessions in disposable runner storage.
Cancel or disconnect settles its turn once and fences late results. Retrying
starts only from an explicit action. A failed DeepSeek turn retains its status
and the user's input. A user can select a connected Codex runner separately.

## Packaging and isolation

Build a dedicated Linux runner image with the pinned package and profile
dependencies installed at build time. The release Compose bundle starts it
with Web and gives the core a private connection. Track both image identities
in release and rollback. Runner connectivity is an Agent status. Web readiness
checks project access and application startup independently.

The runner uses a nonroot account, a read-only root filesystem and bounded
private scratch space. It receives the authorized text context and the
selected routing information. The existing vault provides only the dedicated
DeepSeek credential for the official route. Keep project storage, the vault
and its master key, operator credentials and deployment controls outside the
runner. The runner owns the ACP transport and connection details.

The shipped profile exposes the writing operations and uses scoped provider
egress. Disable Shell, file and browser tools, MCP, subagents, dynamic plugin
loading and optional telemetry or transcript upload. Test the effective
runtime tool list and host isolation with real `dsh` before enabling it by
default. SceneSparrow owns document modifications. A package that cannot
satisfy this boundary leaves the default rollout pending.

## Configuration and upgrade

The DeepSeek Harness card distinguishes runner availability, missing or
rejected credentials and model availability. A connection check reads status
and the model catalog. An explicit model test verifies inference. A cached
catalog can describe offered models before the provider authenticates an
inference request. The browser displays masked credential status.

Use the documented official DeepSeek API-key route with `DEEPSEEK_API_KEY`.
Reuse the saved credential for the official DeepSeek origin through the
existing vault. Reuse the exact saved default model when the Harness offers it.
Prompt for a model selection when that ID is unavailable. Credential and
model changes apply to future runs. Preserve an existing direct API binding
to OpenAI or a proxy until the user selects the Harness. [DeepSeek API-key authentication](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/llm/llm-deepseek-api-key/README.zh.md)

Migrate outline, initial draft and comment rewrite as explicit actions over
the Harness. Reuse their current context preparation, output validation and
save behavior. Outline generation still lands in Outline automatically.
Comment rewrites and draft adoption retain their existing review and write
checks. Each action uses its own request identity and captured configuration.
When all three actions are migrated, consolidate Model services and Default
models into Settings → Agent. Keep upgraded installations' existing API-only
profiles accessible there for compatibility. Preserve current Markdown,
annotation and ZIP formats throughout. [Markdown outline and review](markdown-outline-review.md)

## Delivery and acceptance

| Task    | Deliverable                                                                                                                 | Acceptance  |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| DSH-T01 | Run the pinned official package in an isolated Linux container and verify ACP, credentials and the restricted profile.      | DSH-AC01–02 |
| DSH-T02 | Connect the native adapter to the existing conversation and guarded Apply flow. Keep Codex as a selectable adapter.         | DSH-AC03–04 |
| DSH-T03 | Ship the runner in the Web release and make DeepSeek Harness the default. Integrate credentials, status and model settings. | DSH-AC05–06 |
| DSH-T04 | Migrate the three writing actions and consolidate their settings.                                                           | DSH-AC07–08 |

1. **DSH-AC01** — Boot the pinned package without a browser in the Linux release
   container. Use the actual ACP process with a controlled provider to initialize,
   select a model, prompt, cancel and close. Record the package and container
   identities. Run a separate authorized hosted-provider prompt to validate the
   official credential route before the default rollout.
2. **DSH-AC02** — Verify the text-only profile and OS isolation. The runtime can
   use its scratch area. Attempts to reach host project data, app secrets or
   excluded capabilities fail. Verify credential redaction in logs and responses.
3. **DSH-AC03** — In the real Web UI, send a question and a selected edit through
   actual `dsh`. Review and apply the proposal. Verify the bytes outside the
   selection stay identical. Change the document or add a lock before Apply
   and verify the proposal stays available while the write is rejected.
4. **DSH-AC04** — Stop a turn, switch projects and reconnect after a runner exit.
   Verify late messages leave the current editor alone, repeated requests share
   a single outcome, and Codex remains selectable when connected.
5. **DSH-AC05** — Start the release bundle on a clean Linux host. The runtime
   starts with Web, reports a missing key and becomes usable after saving one
   key and choosing a model. Stop the runtime and verify Web editing and saving.
6. **DSH-AC06** — Upgrade with an existing official DeepSeek credential and
   matching model. Verify reuse. Exercise an unavailable saved model, an invalid
   key and an existing proxy profile, with actionable English and Chinese status.
7. **DSH-AC07** — Run outline generation, draft generation and comment rewrite
   through the configured Harness. Verify their original save and review behavior,
   including stale inputs, protected text and explicitly retried failures.
8. **DSH-AC08** — Verify the consolidated settings against a fresh installation
   and an upgraded installation. Saved provider settings remain discoverable
   and selecting another conversation Agent leaves writing action configuration
   intact. Verify deployment rollback restores the paired Web and runner images.

Use deterministic fixtures in ordinary CI. Record real-process and hosted-provider
results separately. The first delivery checkpoint is DSH-T01 and DSH-T02 together,
ending with a reviewed selection edit in Web. Review those results before enabling
the default deployment. [Implementation workflow](../implementation-execution.md)
