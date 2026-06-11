#!/usr/bin/env bash

# shellcheck shell=bash

BENCH_COMPONENTS=(
  operator
  public-api
  api-server
  cli
  sdk
  runner
)

bench_env_operator() {
  local cache_root=$1
  bench_setup_go_env "$cache_root"
}

bench_env_public_api() {
  local cache_root=$1
  bench_setup_go_env "$cache_root"
}

bench_env_api_server() {
  local cache_root=$1
  bench_setup_go_env "$cache_root"
}

bench_env_cli() {
  local cache_root=$1
  bench_setup_go_env "$cache_root"
}

bench_env_sdk() {
  local cache_root=$1
  bench_setup_go_env "$cache_root"
}

bench_env_runner() {
  local cache_root=$1
  bench_setup_runner_env "$cache_root"
}

bench_preflight_operator() {
  bench_require_command go
  bench_require_go_version 1 21
}

bench_preflight_public_api() {
  bench_preflight_operator
}

bench_preflight_api_server() {
  bench_preflight_operator
  bench_require_command make
}

bench_preflight_cli() {
  bench_preflight_operator
  bench_require_command make
}

bench_preflight_sdk() {
  bench_preflight_operator
  bench_require_command make
}

bench_preflight_runner() {
  bench_require_python3
  bench_require_python_version 3 11
  if ! command -v uv >/dev/null 2>&1 && ! python3 -m venv --help >/dev/null 2>&1; then
    printf '%s\n' "uv or python3 -m venv support is required"
    return 1
  fi
}

bench_setup_go_env() {
  local cache_root=$1
  export GOMODCACHE="$cache_root/go-mod"
  export GOPATH="$cache_root/go-path"
  export GOCACHE="$cache_root/go-build"
  mkdir -p "$GOMODCACHE" "$GOPATH" "$GOCACHE"
}

bench_setup_runner_env() {
  local cache_root=$1
  export UV_CACHE_DIR="$cache_root/uv-cache"
  export PIP_CACHE_DIR="$cache_root/pip-cache"
  mkdir -p "$UV_CACHE_DIR" "$PIP_CACHE_DIR"
}

bench_create_runner_venv() {
  if command -v uv >/dev/null 2>&1; then
    uv venv .venv >/dev/null
  else
    python3 -m venv .venv
  fi
  ./.venv/bin/python -m pip install --upgrade pip >/dev/null
  ./.venv/bin/python -m pip install -e '.[all]'
}

bench_cold_operator() {
  local worktree_dir=$1

  cd "$worktree_dir/components/operator" || return 1
  go mod download
  go build ./...
}

bench_warm_operator() {
  local worktree_dir=$1

  cd "$worktree_dir/components/operator" || return 1
  touch main.go
  go build ./...
}

bench_cleanup_operator() {
  :
}

bench_cold_public_api() {
  local worktree_dir=$1

  cd "$worktree_dir/components/public-api" || return 1
  go mod download
  go build ./...
}

bench_warm_public_api() {
  local worktree_dir=$1

  cd "$worktree_dir/components/public-api" || return 1
  touch main.go
  go build ./...
}

bench_cleanup_public_api() {
  :
}

bench_cold_api_server() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-api-server" || return 1
  go mod download
  make binary
}

bench_warm_api_server() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-api-server" || return 1
  touch cmd/ambient-api-server/main.go
  make binary
}

bench_cleanup_api_server() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-api-server" || return 0
  rm -f ambient-api-server
}

bench_cold_cli() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-cli" || return 1
  go mod download
  make build
}

bench_warm_cli() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-cli" || return 1
  touch cmd/acpctl/main.go
  make build
}

bench_cleanup_cli() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-cli" || return 0
  rm -f acpctl
}

bench_cold_sdk() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-sdk" || return 1
  make build-generator
}

bench_warm_sdk() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-sdk" || return 1
  touch generator/main.go
  make build-generator
}

bench_cleanup_sdk() {
  local worktree_dir=$1

  cd "$worktree_dir/components/ambient-sdk" || return 0
  rm -f bin/ambient-sdk-generator
}

bench_cold_runner() {
  local worktree_dir=$1

  cd "$worktree_dir/components/runners/ambient-runner" || return 1
  rm -rf .venv
  bench_create_runner_venv
}

bench_warm_runner() {
  local worktree_dir=$1

  cd "$worktree_dir/components/runners/ambient-runner" || return 1
  touch ambient_runner/__init__.py
  ./.venv/bin/python -c "from ambient_runner import *"
}

bench_cleanup_runner() {
  local worktree_dir=$1

  cd "$worktree_dir/components/runners/ambient-runner" || return 0
  rm -rf .venv
}

# --- Session benchmark interface (v1: contract only, v2: implementation) ---
#
# bench_session_create NAME PROMPT RUNNER_TYPE
#   Create an agentic session via acpctl or SDK.
#   Returns: session ID (stdout), exit code 0 on success.
#
# bench_session_wait_phase SESSION_ID TARGET_PHASE TIMEOUT_S
#   Poll session status until TARGET_PHASE is reached or TIMEOUT_S expires.
#   Returns: elapsed seconds (stdout), exit code 0 on success, 1 on timeout.
#
# bench_session_collect SESSION_ID
#   Collect session metrics after completion.
#   Emits JSON to stdout with fields:
#     startup_s         -- Pending to Running
#     total_s           -- startTime to completionTime
#     image_pull_s      -- pod creation to container running
#     token_provision_s -- secret creation to mount
#     final_phase       -- Completed | Failed | Stopped
#     exit_code         -- runner container exit code
#
# bench_session_cleanup SESSION_ID
#   Delete the session CR and any associated resources.

bench_session_create() { echo "NOT_IMPLEMENTED"; return 2; }
bench_session_wait_phase() { echo "NOT_IMPLEMENTED"; return 2; }
bench_session_collect() { echo "NOT_IMPLEMENTED"; return 2; }
bench_session_cleanup() { echo "NOT_IMPLEMENTED"; return 2; }
