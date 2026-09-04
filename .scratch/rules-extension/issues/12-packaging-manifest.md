# Extension packaging + manifest

Type: feat
Status: open
Blocked by: 11

## Question

Declare the pi extension manifest/entry per the installed Pi reference so the loader picks up the wired entry.

## Scope

- Packaging file(s) in repo (manifest filename/fields per spec §5 GAP — follow `docs/extensions.md` + `examples/extensions/claude-rules.ts`, record chosen shape in the file).
- Branch: `feat/rules-packaging`, base `map/rules-extension`.
- Out of scope: CLI, extra commands — entry + manifest only.

## Acceptance

- [ ] Manifest declares entry module + metadata the Pi loader requires; anything beyond entry + manifest is absent by design.
- [ ] Chosen manifest shape recorded in the packaging file (closes §5 GAP).
- [ ] `pnpm run lint && pnpm run typecheck && pnpm test` green in the worktree.
