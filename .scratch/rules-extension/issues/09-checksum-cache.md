# Checksum cache + refresh

Type: feat
Status: resolved
Blocked by: 07

## Question

Implement checksum-gated refresh per spec (07): disk-persisted checksums, stat pre-filter, `/reload` verifies without rescanning.

## Scope

- `src/cache.ts` + `tests/cache.test.ts` (TDD: red → green → refactor).
- Branch: `feat/rules-cache`, base `map/rules-extension`.

## Acceptance

- [ ] `pi-better-rules-checksums.json` persisted (global `~/.pi/agent/cache/`, project `.pi/.cache/` gitignored).
- [ ] Refresh flow: list → stat pre-filter → checksum candidates; reports refreshed/added/removed; byte-identical files untouched.
- [ ] `/reload` path verifies checksums only — no full rescan when nothing changed.
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` green in the worktree.
