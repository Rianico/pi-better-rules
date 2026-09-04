---
name: gh-release
description: >-
  Release via semantic-release dispatch. Validates conventional commits, runs verification, dispatches publish. TRIGGER: release, dispatch, publish, dry-run
argument-hint: |-
  "[--dry-run] -- dispatch semantic-release (dry-run previews version)"
metadata:
  managed-by: gh-router
---

# GH Release

Dispatch semantic-release from `main` — version from `feat`/`fix`/`!` since last tag.

## Phases

| # | Script | Banner | Output contract |
|---|--------|--------|-----------------|
| 1 | `check.sh` | `━━━ Phase 1/3: Check ━━━` | tree clean (ignores `.lsz/tmp`, `coverage`, `node_modules`) · on `main` · `commitlint --from=origin/main --to=HEAD` quiet-on-success; on failure re-runs `--verbose`. Ends `✔ Phase 1 ok` or `✘ Phase 1 failed`. |
| 2 | `verify.sh` | `━━━ Phase 2/3: Verify ━━━` | auto-detects `node`/`rust`/`python`; prints `▸ lint/typecheck/test` substeps via `--silent` + tail; ends `✔ Phase 2 ok`. |
| 3 | `dispatch.sh [--dry-run]` | `━━━ Phase 3/3: Preview… ━━━` | single `semantic-release --dry-run` (token fetched once), parses `The next release version is X`, shows condensed notes + `✔ next version: vX` or `⚠ no new version`; prompt `a: dispatch (publish vX)  b: hold`; on dispatch `✔ dispatched <owner/repo>` + Actions link. |

All scripts source `scripts/_common.sh` for `phase`/`ok`/`warn`/`fail`/`step` helpers with ANSI (respects `NO_COLOR`). No duplicate dry-run; no `npm` prefix noise; no `--verbose` unless failed.

## Run

```bash
$SKILL_DIR/scripts/check.sh
$SKILL_DIR/scripts/verify.sh
$SKILL_DIR/scripts/dispatch.sh --dry-run   # preview only
$SKILL_DIR/scripts/dispatch.sh             # preview → prompt → dispatch
```

## Confirm

`git log --oneline -5; git tag | tail -5; head -n 40 CHANGELOG.md`
