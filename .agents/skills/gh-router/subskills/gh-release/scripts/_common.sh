#!/usr/bin/env bash
# _common.sh — shared log helpers for gh-release phases
# Usage: source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
# Respects NO_COLOR; falls back to plain when not a TTY.

set -uo pipefail

# --- color setup ---
if [[ -n "${NO_COLOR:-}" ]] || [[ "${TERM:-}" == "dumb" ]] || ! [[ -t 1 ]] 2>/dev/null; then
  _C_RESET=""; _C_BOLD=""; _C_DIM=""; _C_RED=""; _C_GREEN=""; _C_YELLOW=""; _C_BLUE=""; _C_CYAN=""; _C_MAGENTA=""
else
  _C_RESET=$'\033[0m'; _C_BOLD=$'\033[1m'; _C_DIM=$'\033[2m'
  _C_RED=$'\033[31m'; _C_GREEN=$'\033[32m'; _C_YELLOW=$'\033[33m'
  _C_BLUE=$'\033[34m'; _C_CYAN=$'\033[36m'; _C_MAGENTA=$'\033[35m'
fi

# _log <color> <prefix> <msg>
_log() {
  local color="$1" prefix="$2"; shift 2
  printf "%s%s%s %s%s\n" "$color" "$prefix" "$_C_RESET" "$*" "$_C_RESET"
}

# Public helpers
phase() {
  # phase N M Name — e.g. phase 1 3 "Check"
  local n="$1" m="$2"; shift 2
  local name="$*"
  local bar="━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf "\n%s%s━━━ Phase %s/%s: %s ━━━%s\n" "$_C_BOLD" "$_C_CYAN" "$n" "$m" "$name" "$_C_RESET"
  printf "%s%s%s%s\n" "$_C_DIM" "$bar" "$_C_RESET" ""
}

phase_ok() {
  # phase_ok N "detail"
  local n="$1"; shift
  _log "$_C_GREEN" "✔" "Phase $n ok${*:+ — $*}"
}

phase_fail() {
  local n="$1"; shift
  _log "$_C_RED" "✘" "Phase $n failed${*:+ — $*}"
}

info()  { _log "$_C_BLUE"   "→" "$*"; }
ok()    { _log "$_C_GREEN"  "✔" "$*"; }
warn()  { _log "$_C_YELLOW" "⚠" "$*"; }
fail()  { _log "$_C_RED"    "✘" "$*"; }
dim()   { _log "$_C_DIM"    "·" "$*"; }
step()  { _log "$_C_CYAN"   "▸" "$*"; }

# Ensure errors show a clear marker before set -e exits
trap 'fail "command failed: $BASH_COMMAND (line $LINENO)"' ERR
