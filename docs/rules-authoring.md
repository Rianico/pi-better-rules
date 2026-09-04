# Rule-authoring guide

How to write rule files for pi-better-rules. Two trees share one format: global (`~/.pi/agent/rules`, your conventions everywhere) and project (`<project>/.pi/rules`, this repo's conventions). See the README's rule-memory section for how tiers, scoping, and freshness work — this guide is about the files themselves.

## File layout

- **Filename style:** lowercase-hyphenated `*.md` — `typescript-rules.md`, `frontend/react-patterns.md`. The relative path is the rule's identity: it appears in the per-prompt index, and an identical relative path in the project tree shadows the global copy.
- **One topic per file:** each file covers one concern (lint config, commit style, API error shape). Small files keep the general-tier index readable and let `paths:` scoping stay precise.
- **Subdirectory organization:** nest by area — `frontend/`, `backend/`, `docs/` — mirroring the paths the rules apply to. The walker follows subdirectories up to depth 5.
- **~200-line target:** aim for about 200 lines per rule file. Files larger than 4 MiB are hard-skipped and never load, with no partial credit — split before you approach that.

## Frontmatter

A file with no frontmatter is a valid unscoped `general` rule. The index summary derives from the first `#` heading, else the first non-blank line, else the relative path — so start every rule file with a `#` heading.

Tier lives under `metadata` (top-level frontmatter keys are reserved); `paths:` scopes activation to files touched in the session:

```markdown
---
metadata:
  rule_tier: system
---

# Non-negotiable invariants

Applies to every prompt. Keep this file short.
```

```markdown
---
metadata:
  rule_tier: general
paths:
  - "src/**/*.ts"
  - "tests/**/*.ts"
---

# TypeScript conventions

Loaded as one index line until a `src/` or `tests/` TypeScript file is
touched; the agent reads the full text with the read tool when relevant.
```

Inline list form also works: `paths: ["src/**/*.ts", "tests/**/*.ts"]`. Omit `paths:` for always-on rules; keep that set minimal — invariants only. Remember scoped rules are compaction-evictable, so anything that must survive compaction belongs in an unscoped rule. The whole `paths:` list per rule is budgeted at 1000 expanded patterns and 4 MiB — on breach the extension warns and falls back to literal matching for that rule.

## Shared rules via symlink

Both trees resolve file and directory symlinks and follow them, so shared conventions can live in one place:

```sh
ln -s ~/.pi/agent/rules/typescript-rules.md .pi/rules/shared-typescript.md
```

A realpath cycle guard stops at the first revisit, dangling symlinks are skipped silently, and the depth-5 cap applies through symlinked directories. Prefer linking whole directories (`shared/`) over individual files when a team shares a set.

## Version-control etiquette

- **Commit shared rules.** Project rules (`.pi/rules/`) are team knowledge — commit them like code. Review changes to unscoped `system` rules as contract changes: they inject into every prompt, so a careless edit taxes every session.
- **Keep machine state out of git.** The refresh checksum cache at `.pi/.cache/pi-better-rules-checksums.json` is machine state — make sure `.pi/.cache/` is gitignored in your project (add the line if it isn't). Never hand-edit the checksum file; a corrupt cache rebuilds itself with a warning.
- **Moving from `.claude/rules/`.** There is no `.claude/` support by design — move files manually: copy the markdown into `.pi/rules/` (or `~/.pi/agent/rules/` for personal rules), add `metadata.rule_tier` + `paths:` frontmatter per this guide, and confirm the `/reload` refresh report picks them up. Delete the old copies so two systems don't diverge.
