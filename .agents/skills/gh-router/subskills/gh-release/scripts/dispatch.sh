#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_common.sh
source "$SCRIPT_DIR/_common.sh"

DRY="false"
if [[ "${1:-}" == "--dry-run" ]]; then DRY="true"; fi

# fetch token once
GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
if [[ -z "$GITHUB_TOKEN" ]]; then
  phase_fail 3 "gh auth token unavailable — run: gh auth login"
  exit 1
fi
export GITHUB_TOKEN

run_preview() {
  local out rc tmp
  tmp=$(mktemp)
  set +e
  GITHUB_TOKEN="$GITHUB_TOKEN" npx --silent semantic-release --dry-run >"$tmp" 2>&1
  rc=$?
  set -e
  out=$(cat "$tmp")
  rm -f "$tmp"
  # semantic-release exits non-zero on "no release"; still capture output
  echo "$out"
  return 0
}

extract_version() {
  # extract "The next release version is X" or "no new version"
  local out="$1"
  local ver
  ver=$(echo "$out" | grep -oE "The next release version is [0-9][^ ]*" | tail -n1 | awk '{print $NF}' || true)
  if [[ -n "$ver" ]]; then
    echo "$ver"
    return 0
  fi
  if echo "$out" | grep -q "no new version\|no release"; then
    echo ""
    return 0
  fi
  echo ""
}

if [[ "$DRY" == "true" ]]; then
  phase 3 3 "Preview — dry-run (no publish)"
  info "running semantic-release --dry-run…"
  preview_out=$(run_preview)
  ver=$(extract_version "$preview_out")
  if [[ -n "$ver" ]]; then
    ok "next version: v$ver"
    dim "run with --dry-run off to dispatch, or inspect full log with: GITHUB_TOKEN=\$(gh auth token) npx semantic-release --dry-run"
  else
    warn "no new version — nothing to release"
    dim "commits since last tag do not trigger a release (need feat/fix/! or BREAKING CHANGE)"
  fi
  # concise preview: show only version/notes lines, not full plugin trace
  echo ""
  echo "$preview_out" | grep -E "next release version|Release note|no new version|no release" | tail -n 20 || true
  phase_ok 3 "dry-run complete"
  exit 0
fi

# non-dry-run: single preview + prompt + dispatch
phase 3 3 "Preview & Dispatch"

info "running semantic-release --dry-run (preview)…"
preview_out=$(run_preview)
ver=$(extract_version "$preview_out")

if [[ -z "$ver" ]]; then
  warn "no new version detected — dispatch will be a no-op (GitHub will receive event but semantic-release will skip)"
  echo ""
  echo "$preview_out" | grep -E "no new version|no release|Analysis of.*commits" | tail -n 10 || true
else
  ok "next version: v$ver"
  # show condensed release notes preview if present
  echo "$preview_out" | grep -A 30 "Release note for version" | head -n 40 || true
fi

echo ""
if [[ -n "$ver" ]]; then
  printf "%s Publish v%s ? %s\n" "${_C_BOLD}" "$ver" "$_C_RESET"
fi
read -r -p "a: dispatch (publish)   b: hold > " ans
if [[ "$ans" != "a" ]]; then
  warn "hold — not dispatched"
  phase_ok 3 "aborted by user"
  exit 0
fi

OWNER_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || git remote get-url origin | sed -E 's/.*github.com[:\/](.*)\.git/\1/')
info "dispatching semantic-release to $OWNER_REPO…"
if gh api "repos/$OWNER_REPO/dispatches" -f event_type=semantic-release >/dev/null 2>&1; then
  ok "dispatched $OWNER_REPO"
  dim "Actions: https://github.com/$OWNER_REPO/actions"
else
  phase_fail 3 "gh api dispatch failed for $OWNER_REPO"
  exit 1
fi

phase_ok 3 "dispatch sent — watch Actions for Verify and Release"
