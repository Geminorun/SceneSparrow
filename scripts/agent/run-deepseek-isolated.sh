#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || $1 != /* || -L $1 ]]; then
  echo 'Usage: run-deepseek-isolated.sh ABS_EMPTY_PRIVATE_SOCKET_DIR' >&2
  exit 2
fi
socket_dir=$(realpath "$1")
[[ $(id -u) != 0 && -d "$socket_dir" && $(stat -c %a "$socket_dir") == 700 && $(stat -c %u "$socket_dir") == "$(id -u)" ]] || {
  echo 'Runner socket directory must be private and owned by a nonroot launching user' >&2; exit 2;
}
shopt -s nullglob dotglob
entries=("$socket_dir"/*)
[[ ${#entries[@]} == 0 ]] || { echo 'Runner socket directory must be empty' >&2; exit 2; }
runner_dir=$(realpath "$(dirname "$0")/deepseek")
relay_pid=''
container_name="scenesparrow-dsh-$(id -u)-$$"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  if [[ -n $relay_pid ]]; then kill "$relay_pid" 2>/dev/null || true; wait "$relay_pid" 2>/dev/null || true; fi
  rm -f "$socket_dir/dsh.sock" "$socket_dir/provider.sock"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
node "$runner_dir/relay.mjs" "$socket_dir" &
relay_pid=$!
for ((n=0; n<100; n++)); do
  [[ -S "$socket_dir/provider.sock" ]] && break
  kill -0 "$relay_pid" 2>/dev/null || exit 1
  sleep 0.05
done
[[ -S "$socket_dir/provider.sock" ]] || exit 1
docker run --name "$container_name" --rm --init --read-only --network none \
  --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 128 --memory 768m --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
  --mount "type=bind,src=$socket_dir,dst=/run/writing-agent" \
  "${SCENESPARROW_DSH_RUNNER_IMAGE:-scenesparrow-dsh:0.2.2-rc.5}" &
wait $!
