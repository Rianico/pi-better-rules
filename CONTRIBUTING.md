# Contributing to pi-better-rules
## Conventional commits
- `feat[(scope)]: description` → MINOR, `fix[(scope)]:` → PATCH, `feat!:` / `BREAKING CHANGE:` → MAJOR
- Other types `docs|style|refactor|perf|test|build|ci|chore|revert` hidden unless `!`
- Scope is noun, description imperative present, lowercase, no period, ≤72 chars
- Enforced by `commitlint` + `husky` (`npx commitlint --from=origin/main --to=HEAD`)
## Changelog
`CHANGELOG.md` `## [Unreleased]` guarded by `pre-push` hook (`warn+block`, `uv run python scripts/changelog-unreleased.py update`) and `changelog-check.yml` (`pull_request` required, `diff -q` vs generated); `release.yml` runs `scripts/changelog-unreleased.py clear` then `semantic-release` owns versioned sections. Do not hand-edit versioned sections. Hidden types `style|chore|refactor|test|build|ci` only appear when `!`/`BREAKING CHANGE`.
## Reporting Issues
Pick the template that matches your intent — see `.github/ISSUE_TEMPLATE/` (blank issues disabled, `config.yml` links #38):
| Intent | Template | Structure |
|---|---|---|
| **Bug** | `01-bug_report.yml` | **Exemplar #38**: Summary → Environment (Version/Module/Trigger) → Steps to Reproduce (paste-complete file + operation map + exact payload) → Expected vs Actual (quote diff/logs) → Impact & Trigger Conditions → Root Cause / Suggested Fixes (optional, numbered tradeoffs) |
| **Feature** | `02-feature_request.yml` | Problem → Proposal → Alternatives → Additional context |
- Bugs: paste-complete, prefer text over screenshots, include `read` hashes / payload and `autoFixes`/balance delta. Link #38 as style reference.
- Features: state problem + proposal at minimum; alternatives optional.
Prompt rule: when the model helps file an issue, infer `bug` vs `feat` from intent, ask for any missing `body` field of that form, and render via `gh issue create --template <file>`. View exemplar with `gh issue view 38 --json title,body --repo Rianico/dsh-better-edit`.
## Before PR
`npm run lint && npm run typecheck && npm test` must pass. See `AGENTS.md` for agent rules.
