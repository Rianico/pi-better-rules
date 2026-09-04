#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

phase 1 3 "Check — tree, branch, commits"

# 1a — clean tree (ignore ephemeral artifacts)
info "checking working tree…"
dirty=$(git status --porcelain | grep -v -E '^\?\? \.lsz/tmp|^\?\? coverage|^\?\? node_modules' || true)
if [[ -n "$dirty" ]]; then
  phase_fail 1 "working tree not clean"
  echo "$dirty" | head -n 20 >&2
  if [[ $(echo "$dirty" | wc -l) -gt 20 ]]; then
    dim "… $(echo "$dirty" | wc -l) files total, truncated above"
  fi
  exit 1
fi
ok "working tree clean"

# 1b — correct branch
branch=$(git branch --show-current)
if [[ "$branch" != "main" ]]; then
  phase_fail 1 "not on main (current: $branch)"
  exit 1
fi
ok "on branch main"

# 1c — conventional commits (quiet on success)
commit_count=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
if [[ "$commit_count" -eq 0 ]]; then
  warn "no commits ahead of origin/main — nothing to check"
else
  info "checking $commit_count commit(s) vs origin/main…"
  set +e
  out=$(npx --silent commitlint --from=origin/main --to=HEAD 2>&1)
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    phase_fail 1 "commitlint failed"
    # re-run verbose for actionable output
    npx commitlint --from=origin/main --to=HEAD --verbose || true
    exit $rc
  fi
  ok "$commit_count commit(s) — conventional commits ok"
fi

phase_ok 1 "all checks passed"
