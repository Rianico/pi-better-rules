---
name: gh-router
description: >-
  GitHub workflow router — release via dispatch and PR enhancement. Use when releasing, dispatching semantic-release, submitting or refining PRs. TRIGGER: release, dispatch, pr enhance, submit PR, refine PR
argument-hint: |-
  gh-release [--dry-run] -- changelog and publish via dispatch
  pr-enhance [base|pr_url] -- PR description generation
metadata:
  manage: [gh-release, pr-enhance]
---

# GH Router

GitHub workflow router. Model-invocable — dispatches to `gh-release` or `pr-enhance` via subskill load.

## Subskills

| Subskill | Trigger |
|----------|---------|
| `gh-release` | `release`, dispatch semantic-release |
| `pr-enhance` | `submit PR`, `refine PR` |

Load via `Read $SKILL_DIR/subskills/<name>/SKILL.md`.
