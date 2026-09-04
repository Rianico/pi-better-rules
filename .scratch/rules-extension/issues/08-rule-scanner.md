# Rule scanner

Type: feat
Status: resolved
Blocked by: 07

## Question

Implement rule discovery + parsing + matching per spec (07): recursive walker, frontmatter tiers, Claude-syntax glob.

## Scope

- `src/scanner.ts` + `tests/scanner.test.ts` (TDD: red → green → refactor).
- Branch: `feat/rules-scanner`, base `map/rules-extension`.

## Acceptance

- [ ] Recursive `**/*.md` scan of global `~/.pi/agent/rules` + project `.pi/rules`; max depth 5; symlinks followed with realpath cycle guard.
- [ ] Global-first / project-wins concat; identical rel path shadows (no merge), reported.
- [ ] Frontmatter `metadata.rule_tier` (`system` | `general`, default `general`, unknown warns + falls back); `paths:` required for scoped rules.
- [ ] Glob supports `**`/`*`/`?`/`{a,b}`/`[...]`/`\[` with 1000-pattern budget fallback.
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` green in the worktree.
