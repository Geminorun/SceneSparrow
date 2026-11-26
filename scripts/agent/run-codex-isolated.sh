#!/usr/bin/env bash
# Optional Linux sidecar; the app gets only the resulting private Unix socket.
set -euo pipefail
if [[ $# != 3 ]]; then
  echo 'Usage: run-codex-isolated.sh ABS_PRIVATE_SOCKET_DIR ABS_DEDICATED_AUTH_DIR ABS_CODEX_BINARY' >&2
  exit 2
fi
socket_dir=$(realpath "$1")
auth_dir=$(realpath "$2")
codex_binary=$(realpath "$3")
runner_file=$(realpath "$(dirname "$0")/codex-runner.mjs")
for directory in "$socket_dir" "$auth_dir"; do
  [[ -d "$directory" && $(stat -c %a "$directory") == 700 && $(stat -c %u "$directory") == "$(id -u)" ]] || {
    echo 'Runner directories must be private and owned by the launching user' >&2; exit 2;
  }
done
shopt -s nullglob dotglob
socket_entries=("$socket_dir"/*)
[[ ${#socket_entries[@]} == 0 ]] || { echo 'The socket directory must be empty' >&2; exit 2; }
for entry in "$auth_dir"/*; do
  [[ "$entry" == "$auth_dir/auth.json" && -f "$entry" && ! -L "$entry" ]] || {
    echo 'The dedicated auth directory may contain only a regular auth.json' >&2; exit 2;
  }
done
[[ -f "$codex_binary" && -x "$codex_binary" && ! -e "$socket_dir/codex.sock" ]] || exit 2
# Auth is a dedicated directory containing auth.json only. No user config/MCP/Skills are loaded.
exec docker run --rm --init --read-only --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 768m --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
  --mount "type=bind,src=$socket_dir,dst=/run/writing-agent" \
  --mount "type=bind,src=$auth_dir,dst=/run/codex-auth,readonly" \
  --mount "type=bind,src=$codex_binary,dst=/opt/codex/bin/codex,readonly" \
  --mount "type=bind,src=$runner_file,dst=/opt/writing-runner.mjs,readonly" \
  --workdir /tmp --entrypoint node \
  "${SCENESPARROW_CODEX_RUNNER_IMAGE:-node:24-bookworm-slim}" /opt/writing-runner.mjs
