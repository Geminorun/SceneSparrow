#!/usr/bin/env bash
# Source this file only in the managed Linux cloud workspace.
export CARGO_HOME=/workspace/.toolchains/cargo
export RUSTUP_HOME=/workspace/.toolchains/rustup
export PNPM_HOME=/workspace/.toolchains/pnpm/node_modules/.bin
export XDG_CACHE_HOME=/workspace/.cache
export XDG_DATA_HOME=/workspace/.local/share
export XDG_STATE_HOME=/workspace/.local/state
export npm_config_cache=/workspace/.cache/npm
export ELECTRON_CACHE=/workspace/.cache/electron
export PATH="$PNPM_HOME:$CARGO_HOME/bin:$PATH"
export CARGO_BUILD_JOBS=4
export NODE_USE_ENV_PROXY=1
export NODE_USE_SYSTEM_CA=1
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost"
export SCENESPARROW_TEST_BROWSER=/usr/bin/chromium
