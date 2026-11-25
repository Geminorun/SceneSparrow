# Optional Codex writing runner

The file-backed Web workspace discovers Codex through a private Unix socket.
Settings → Agent reports the connection and model catalog. A deployment without
the socket shows a setup status and the built-in writing actions remain available.

## Linux setup

Use an unprivileged Linux account with Docker and a Codex App Server binary.
Create two private directories owned by that account.
The auth directory accepts a single regular `auth.json` from a dedicated,
authorized Codex login. An empty auth directory reports missing authentication.
Use the same numeric user ID for the launcher and the Web core that will access
the socket. Retain the dedicated auth file on the host to provision each ephemeral
Codex home. Credential refreshes in the runner last for that connection.

```sh
install -d -m 700 /private/writing-socket /private/writing-auth
bash scripts/agent/run-codex-isolated.sh \
  /private/writing-socket /private/writing-auth /opt/codex/bin/codex
```

Set `SCENESPARROW_CODEX_SOCKET=/private/writing-socket/codex.sock` in the Web
supervisor's environment. For a containerized Web deployment, mount the private
socket directory read-only in its container and use the socket's in-container path. Keep the dedicated auth
mount scoped to the runner. Start with an empty socket directory, including
after a runner crash that left a stale socket.

The launcher uses `node:24-bookworm-slim` by default. Set
`SCENESPARROW_CODEX_RUNNER_IMAGE` to use a trusted local image. The container
requires a read-only root, a nonroot UID, zero capabilities, no new privileges
and bounded scratch and process resources. The launcher mounts the private
socket directory, dedicated auth directory, Codex binary and runner script.
The runner checks its OS restrictions before accepting connections.

## Runtime behavior

The global catalog checks the dedicated account and available models. Each
writing turn uses a fresh Codex home and an ephemeral thread, with fixed
configuration, a read-only sandbox and approval disabled. The adapter sends the
exact selected text for an edit or the attached document for a question.
It carries up to eight completed turns from the same conversation. Questions
stream text. Edits show progress and validate the structured reply before
offering a replacement. The protected Markdown writer applies the accepted
replacement and checks the original document revision, quote and current locks.

Cancellation interrupts the bound native turn and closes its connection. The
runner terminates the child process group and cleans up its temporary files.
Requests, replies and connection lifetimes have byte and time bounds. Retry
starts on an explicit user action.

## Verification

Run `node scripts/agent/check-isolation.mjs /absolute/path/to/codex` on a Linux
Docker host for the launcher and unauthenticated account check. Local tests used
Codex App Server `0.167.0-alpha.4`, including a Chromium edit through a real
runtime with a simulated model response. A hosted-provider edit with authorized
credentials remains pending. [Validation evidence](validation/external-writing-agent.md)
