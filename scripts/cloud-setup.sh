#!/usr/bin/env bash
set -euo pipefail
cd /workspace/SceneSparrow
source scripts/cloud-env.sh

test "$(uname -sm)" = "Linux x86_64" || { echo "This setup script targets the managed Linux x64 workspace." >&2; exit 1; }
test "$(node --version)" = "v$(cat .node-version)" || { echo "Use the Node.js version pinned in .node-version." >&2; exit 1; }
mkdir -p "$CARGO_HOME" "$RUSTUP_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

if ! command -v rustup >/dev/null 2>&1; then
  bootstrap_dir=$(mktemp -d)
  trap 'rm -rf "$bootstrap_dir"' EXIT
  curl --fail --silent --show-error --location https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o "$bootstrap_dir/rustup-init"
  curl --fail --silent --show-error --location https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256 -o "$bootstrap_dir/rustup-init.sha256"
  expected=$(awk '{print $1}' "$bootstrap_dir/rustup-init.sha256")
  printf '%s  %s\n' "$expected" "$bootstrap_dir/rustup-init" | sha256sum --check --status
  chmod +x "$bootstrap_dir/rustup-init"
  "$bootstrap_dir/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.100.0 --component rustfmt --component clippy
else
  rustup toolchain install 1.100.0 --profile minimal --component rustfmt --component clippy
fi

if ! test -x "$PNPM_HOME/pnpm" || ! test "$("$PNPM_HOME/pnpm" --version)" = "11.25.0"; then
  npm install --prefix /workspace/.toolchains/pnpm pnpm@11.25.0 --no-audit --no-fund
fi

for command in cc pkg-config ffmpeg chromium; do
  command -v "$command" >/dev/null || { echo "Missing managed-image dependency: $command" >&2; exit 1; }
done
pnpm install --frozen-lockfile
node apps/desktop/node_modules/electron/install.js
cargo fetch --locked
pnpm build
pnpm render:smoke
pnpm run env:check
