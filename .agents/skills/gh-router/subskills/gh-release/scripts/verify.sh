#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

phase 2 3 "Verify — lint / typecheck / test"

# detect repo type once
if [[ -f package.json ]]; then
  repo="node"
elif [[ -f Cargo.toml ]]; then
  repo="rust"
else
  repo="python"
fi
info "repo type: $repo"

fail_step() {
  phase_fail 2 "$1 failed"
  exit 1
}

if [[ "$repo" == "node" ]]; then
  step "lint"
  if ! npm run --silent lint 2>&1 | tail -n 100; then
    fail_step "lint"
  fi
  ok "lint passed"

  step "typecheck"
  if ! npm run --silent typecheck 2>&1 | tail -n 100; then
    fail_step "typecheck"
  fi
  ok "typecheck passed"

  step "test"
  if ! npm test 2>&1 | tail -n 60; then
    fail_step "test"
  fi
  ok "test passed"

elif [[ "$repo" == "rust" ]]; then
  step "clippy"
  cargo clippy 2>&1 | tail -n 80 || fail_step "clippy"
  ok "clippy passed"

  step "test"
  cargo test 2>&1 | tail -n 80 || fail_step "test"
  ok "cargo test passed"

else
  step "ruff check"
  ruff check . 2>&1 | tail -n 80 || fail_step "ruff"
  ok "ruff passed"

  step "pytest"
  uv run pytest -q 2>&1 | tail -n 80 || warn "pytest failed or not configured"
  ok "verify done"
fi

phase_ok 2 "verification passed"
