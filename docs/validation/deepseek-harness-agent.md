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

## DSH-T02 — Web conversation and guarded edits

The private `SCENESPARROW_DEEPSEEK_SOCKET` connection adds DeepSeek Harness to
the existing Agent catalog alongside Codex. The core sends an official DeepSeek
credential from the existing vault only to the isolated runner. It selects the
exact model advertised by ACP and checks the runtime's acknowledgment. A
question streams committed text. Only a validated final reply can create a
selection proposal. ACP thoughts and control metadata stay out of the transcript.

- **DSH-AC03** — In Chromium 156, the authenticated Web app sent a question
  and a selected edit through the pinned native runner and a controlled Messages
  provider. Before Apply, the Markdown stayed identical. After Apply, the
  surrounding bytes stayed identical. Adding a live lock after a second proposal
  caused the core to reject Apply and retain the suggestion. The service fixture
  also verified stale revision rejection.
- **DSH-AC04** — The ACP and service fixtures cover duplicate requests,
  cancellation, disconnect and protocol failures. The shared Agent/browser
  tests exercise project switching and late-event fencing. The existing Codex
  adapter remains available through the same engine selector.

Root reviewed the credential filter, bounded ACP transport, scoped proposals
and guarded edits. The real Web smoke ran with both advertised model IDs,
`deepseek-flash` and `deepseek-v4-pro`. A separate native ACP probe verified
two turns on the same session. The provider fixture verified that a selection
edit receives only the selected passage. Workspace checks, the production
build, 14 integration tests and 17 focused browser tests passed.

## DSH-T03 — Paired release and Agent configuration

The release pipeline builds both images and runs a paired Compose smoke with
disposable volumes. A release records both immutable digests. Deployment tests
check that both images are pulled before downtime, and that old single-image
and paired backup configurations remain available for manual rollback.
Exact release image and paired startup validation is tracked separately.

- **DSH-AC05** — Compose resolves the private socket volume, fixed UID,
  read-only root and disabled runner network. The paired smoke checks fresh
  readiness, saving with DeepSeek stopped and restart. The supervisor and
  deploy fixtures passed locally.
- **DSH-AC06** — Chromium 156 reached the authenticated Web gateway, loaded the
  official credential from the encrypted vault and exercised explicit native
  inference against the controlled provider. A duplicate request had one
  provider call. A 401 mapped to the credential rejection code with no raw
  provider details or key in the response. The final native runtime probe
  also verified the 503 code and recovery on the same bridge. The exact overlay
  runner image was
  `sha256:6a9b2644844727e85e0d0f472236b6072bb4fa5bc810310f5b55418857296f1c`.

The Chrome lock smoke now waits for save acknowledgment and places the input
selection on the intended locked paragraph. In the previous GitHub trace,
the test typed into an unlocked sibling. Both matching lock tests passed
three local repetitions after the test-only correction.
