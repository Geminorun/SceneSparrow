# Native DeepSeek Harness validation

[Specification](../specs/deepseek-harness-agent.md) · [PR #31](https://github.com/Geminorun/SceneSparrow/pull/31)

## DSH-T01 — Isolated native runtime

The pinned runner uses official `@deepseek-ai/dsh@0.2.2-rc.5` and Node
24.22.1. Verified image ID
`sha256:e008d54d39a5cb673b3f56e58d2ee875044cb60ef0b7173d341350a1016ecb68`.
The profile starts with an empty bundle list and loads only the required Agent,
model, persistence and ACP modules. The runner enforces a private socket and
uses a fixed Messages relay for DeepSeek egress. [Runner guide](../deepseek-writing-runner.md)

| Acceptance | Evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DSH-AC01   | Actual ACP initialization, session creation, model selection, prompt, committed text, cancellation and close passed with four synthetic Messages requests. The suite exercises missing and rejected keys and confirms the provider request aborts on cancellation or disconnect. Hosted-provider inference remains pending.                                                                                 |
| DSH-AC02   | The actual model request had an empty tool list. The Docker probe verified a nonroot process, read-only root, isolated network and mount, writable scratch and removal of temporary homes. The launcher shutdown test verified that SIGTERM cleans up the container and both sockets. Tests confirmed private app paths and secrets are absent and a synthetic key with escaped punctuation stays redacted. |

The build used the existing BuildKit CA secret and kept TLS verification enabled.
`node scripts/agent/check-deepseek-isolation.mjs`, the focused Node unit tests,
shell syntax and formatting passed. Root repeated the native protocol and OS
probe against the exact image. Ponytail Review covered the runner, relay,
profile and launcher. Review corrections covered output redaction, stream
backpressure and immutable addon loading with a noexec scratch mount.

The Linux test host accepted Docker resource flags with a cgroup driver of
`none`. Hard CPU and memory enforcement remains to be verified on a host
with cgroups.
