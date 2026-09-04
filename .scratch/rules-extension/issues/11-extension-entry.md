# Extension entry wiring

Type: feat
Status: resolved
Blocked by: 08, 09, 10

## Question

Wire the three pure modules into a working pi extension entry implementing the §6 handler contract.

## Scope

- `src/index.ts` (default export function taking the Pi `ExtensionAPI`) + `tests/entry.test.ts` (TDD).
- Consumes `src/scanner.ts` (08), `src/cache.ts` (09), `src/lifecycle.ts` (10).
- Branch: `feat/rules-entry`, base `map/rules-extension`.
- Reference: installed Pi `docs/extensions.md` + `examples/extensions/claude-rules.ts` for loader/handler shapes.

## Acceptance

- [ ] Entry registers exactly the four §6 handlers: `session_start` (build `checksumsPath` from `ctx.cwd`, bind `notifyWarn`, reload-verify vs full scan), `tool_call` (`read`/`edit`/`write` → touched set), `before_agent_start` (per-prompt override, nothing when idle), `before_provider_request` (marker reconcile, pass-through guard).
- [ ] No handler for `session_before_compact` / `session_compact` (cache survives; §6).
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` green in the worktree.
