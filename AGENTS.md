# AGENTS.md

git config core.hooksPath .githooks to arm the pre-push changelog guard.

## Agent skills

### Issue tracker

Issues live as markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.

### Contribution
Conventional commits & changelog: see CONTRIBUTING.md
Git hooks: `git config core.hooksPath .githooks` (or `npm install` with husky → `.husky` delegates to `.githooks`) so pre-push CHANGELOG guard is live on fresh clone/worktree.
