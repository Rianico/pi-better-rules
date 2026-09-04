# README + rule-authoring guide

Type: docs
Status: resolved
Blocked by: 11

## Question

Document the extension per spec §8: README section + authoring guide + version-control etiquette.

## Scope

- README section (what it does, two rule locations, tier × `paths:` table, `/reload` + refresh freshness story).
- Rule-authoring guide (filename style, one-topic-per-file, subdirectories, ~200-line target, frontmatter examples, symlink pattern).
- `.pi/rules` etiquette (commit shared rules, `.pi/.cache/` gitignored) + `.claude/rules/` manual-move path.
- Branch: `doc/rules-guide`, base `map/rules-extension`.
- MUST NOT invent a local-private tier (spec §8 GAP — global + project only).

## Acceptance

- [ ] All three §8 MUSTs covered; tier matrix renders as one table.
- [ ] No local-private tier invented anywhere.
