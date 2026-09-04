# Lifecycle + prompt rendering

Type: feat
Status: resolved
Blocked by: 07

## Question

Implement activation tracking + prompt injection per spec (07): cumulative touched set, tier rendering, mid-run reconcile.

## Scope

- `src/lifecycle.ts` + `tests/lifecycle.test.ts` (TDD: red → green → refactor).
- Branch: `feat/rules-lifecycle`, base `map/rules-extension`.

## Acceptance

- [ ] Cumulative session touched set; `read`/`edit`/`write` tool calls activate (Read+Write trigger, no Read-only parity gap).
- [ ] `before_agent_start` renders `system` tier full + `general` tier index via per-prompt `systemPrompt` override only.
- [ ] `before_provider_request` reconciles the `<!-- pi-rules:begin/end -->` block (strip + rebuild, idempotent).
- [ ] Compaction leaves system prompt alone; `general` re-loads after compaction.
- [ ] User-facing warnings via official `notify(msg, "warning")` dimmed style.
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` green in the worktree.
