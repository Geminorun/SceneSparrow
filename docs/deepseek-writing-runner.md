# Isolated DeepSeek writing runner

This optional Linux runner implements DSH-T01. It does not enable DeepSeek in
Web settings or change deployment defaults. The actual official `dsh` CLI runs
ACP stdio inside a dedicated container; SceneSparrow owns all document writes.
Hosted inference and release rollout remain separate acceptance gates.

## Build and start

Use Node 24.9 or later and an unprivileged Docker user. The image pins Node
24.22.1 by digest and `@deepseek-ai/dsh@0.2.2-rc.5` plus the official profile
modules in a separate npm lockfile. Install scripts are disabled. No packages
are installed at runtime. The candidate remains a release candidate.

```sh
docker build -t scenesparrow-dsh:0.2.2-rc.5 scripts/agent/deepseek
install -d -m 700 /private/deepseek-socket
bash scripts/agent/run-deepseek-isolated.sh /private/deepseek-socket
```

For a managed HTTPS build proxy, use the existing build CA secret convention:
`docker build --secret id=build_ca,src=/etc/ssl/certs/ca-certificates.crt
-t scenesparrow-dsh:0.2.2-rc.5 scripts/agent/deepseek`. The certificate is a
build-only secret. TLS verification remains enabled.

The socket directory must be empty, mode 0700 and owned by the nonroot launching
user. The core and runner use the same numeric UID. `SCENESPARROW_DSH_RUNNER_IMAGE`
can select a trusted locally built image. This is an operator-controlled image
identity, never a model-selected setting. Stopping the launcher removes the
container, stops its relay and removes both sockets. After an abrupt host failure,
verify the processes have stopped before removing stale sockets and restarting.

The native container has a read-only root, no capabilities, no new privileges,
no network interfaces except loopback, a 128 MiB scratch tmpfs, a 768 MiB memory
limit, 128 PIDs and two CPUs. Its only host mount is this private socket directory.
It receives no application/user directories, Docker socket, vault, master key,
operator credential or inherited application environment. Runtime storage and
credentials disappear when the connection or container ends.

## Private connection protocol

The private directory and mode-0600 sockets authorize the matching local UID.
Do not expose or mount them for another user or an unrelated service. Mount the
directory into the future core with the same ownership; never expose TCP ACP.
One connection owns one native process and one disposable Harness home.

Connect to `dsh.sock` and send one newline-terminated JSON handshake:

```json
{ "protocolVersion": 1, "apiKey": null }
```

`apiKey` is either the dedicated DeepSeek credential from an official-origin
vault lease or `null`. Pass it server-side through this private connection;
never through the browser, command line, container environment or project file.
The bridge injects only `DEEPSEEK_API_KEY` into that connection's child, together
with fixed home/path/locale/telemetry settings. It echoes only metadata:

```json
{
  "protocolVersion": 1,
  "ready": true,
  "engine": "deepseek",
  "packageVersion": "0.2.2-rc.5",
  "credentialPresent": false
}
```

`ready` means the bridge accepted the connection. Require successful native ACP
`initialize` and `session/new` before reporting a usable native session. Credential
presence and the advisory model catalog do not establish provider authentication.
A missing key fails inference locally; only an explicitly authorized model turn
can validate the hosted key/model route.

After the greeting, use ordinary ACP JSON-RPC NDJSON. Initialize with
`protocolVersion: 1`. Create a session with `cwd: "/tmp/writing"` and
`mcpServers: []`. The reply contains `sessionId` and `configOptions`; select the
exact offered model value via `session/set_config_option` with `configId: "model"`.
The pinned package's advisory IDs are `deepseek-flash` (default) and
`deepseek-v4-pro`. The ACP option value includes the provider identity; use the
returned value instead of constructing it. A connection without a key can still
initialize and expose its current model selection.

Send `session/prompt` with text blocks. Committed text arrives as
`session/update` with `update.sessionUpdate: "agent_message_chunk"` and
`update.content.text`; the prompt response carries `stopReason`. Stop with a
`session/cancel` notification, then close the session with `session/close` and
close the socket. The bridge also closes on EOF, timeout or child exit and
terminates the native process group. It permits four concurrent connections,
2 MiB total client input, 8 MiB total native output, a five-second handshake and
125 seconds per connection. There is no automatic inference retry.

Only initialize, new, model selection, text prompt, cancel and close are admitted.
The bridge rejects MCP servers, foreign working directories, nontext context,
resume/list, permission responses and other native methods. The generic native
ACP advertisement is narrowed to the deployment's actual text/close capabilities.
Native stderr is discarded; credential substrings in outgoing JSON string fields
are replaced with `[REDACTED]` before serialization. The bridge does not log
prompts, responses or credentials.

## Profile and provider boundary

The trusted profile starts from an empty bundle list, instead of the upstream
ACP base bundle. It mounts the official LLM/session/agent loop/system prompt/empty
tool registry/native executor/persistence/ACP modules and a small local guard.
There are no tool registrations. The guard checks the effective native registry
before ACP activates and when agents/tools change. The controlled provider probe
also checks the tool list actually sent by the native Messages adapter.
Shell, filesystem, browser, MCP, subagents, dynamic plugin management, retries,
telemetry and transcript upload plugins are absent. `DSH_TELEMETRY_DISABLED=1`
is also set. `NARB_DISABLE_NATIVE_CACHE=1` loads the installed native addon directly
from the immutable image, preserving the scratch mount's `noexec` restriction.
The npm package still contains its official modules, but the trusted
profile does not activate the excluded modules and accepts no client patches.
The launcher never runs unrestricted `dsh` on the host.

The native adapter uses the official DeepSeek API-key implementation and
Anthropic-compatible Messages protocol. A fixed container loopback HTTP adapter
passes only `POST /anthropic/v1/messages` through `provider.sock` to the trusted
host relay. The relay forwards only to `https://api.deepseek.com` with TLS
verification and no redirect following. It admits only the required protocol/key
headers, bounds both request and response bytes and time, and propagates aborts.
The native container has no direct external network access. Catalog options come
from the pinned adapter's advisory catalog; no `/models` proxy route is needed.

`startProviderRelay(directory)` is a small module for the future trusted Web
supervisor to own. The standalone launcher starts it for this stage. Its optional
loopback fixture port is used only by the explicit synthetic acceptance probe;
ACP never accepts a provider address. Production callers omit that argument.

## Verification

```sh
node --test tests/unit/deepseek-runner.test.mjs
node scripts/agent/check-deepseek-isolation.mjs
```

The second command requires the built image and Docker. It starts the actual CLI
inside the isolated image and uses a loopback synthetic Messages provider, never
a hosted prompt. It checks native initialization, creation/model selection,
committed output, cancellation/provider abort, close, missing/rejected credentials,
redaction, excluded input capabilities, OS mount/network boundaries and connection
cleanup. [DSH-T01 evidence](validation/deepseek-harness-agent.md)

Source reference: upstream ACP documentation at
[`4b399c39a6d1479cd84ca591b4d7c88e24d38a96`](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/bundle/acp-app/README.zh.md).
The installed package's effective behavior, rather than its generic default
profile, determines the restrictions verified here.
