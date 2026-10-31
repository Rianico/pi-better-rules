# Rule-authoring guide

How to write rule files for pi-better-rules. Two trees share one format: global (`~/.pi/agent/rules`, your conventions everywhere) and project (`<project>/.pi/rules`, this repo's conventions). See the README's rule-memory section for how scope, activation, and freshness work — this guide is about the files themselves.

## File layout

- **Filename style:** lowercase-hyphenated `*.md` — `typescript-rules.md`, `frontend/react-patterns.md`. The relative path is the rule's identity: it appears in load notices and scoped messages, and an identical relative path in the project tree shadows the global copy.
- **One topic per file:** each file covers one concern (lint config, commit style, API error shape). Small files keep unscoped appends cheap and let `paths:` scoping stay precise.
- **Subdirectory organization:** nest by area — `frontend/`, `backend/`, `docs/` — mirroring the paths the rules apply to. The walker follows subdirectories up to depth 5.
- **~200-line target:** aim for about 200 lines per rule file. Files larger than 4 MiB are hard-skipped and never load, with no partial credit — split before you approach that.

## Frontmatter

A file with no frontmatter is a valid unscoped rule. The summary derives from the first `#` heading, else the first non-blank line, else the relative path — so start every rule file with a `#` heading.

`paths:` scopes activation to files touched in the session. Unscoped rules need no frontmatter at all:

```markdown
# Non-negotiable invariants

Applies to every prompt. Keep this file short.
```

```markdown
---
paths:
  - "src/**/*.ts"
  - "tests/**/*.ts"
---

# TypeScript conventions

Appended to the triggering tool result (naming the matched file and the activating file) the first time a `src/` or `tests/` TypeScript file is read, edited, or written.
```

Inline list form also works: `paths: ["src/**/*.ts", "tests/**/*.ts"]`. Omit `paths:` for always-on rules; keep that set minimal — invariants only. Remember scoped rules are compaction-evictable, so anything that must survive compaction belongs in an unscoped rule. The whole `paths:` list per rule is budgeted at 1000 expanded patterns and 4 MiB — on breach the extension warns and falls back to literal matching for that rule.

### Harness scoping — `agents:`

`agents:` is an optional allowlist of harness ids. Absent, the rule loads in every harness — that is the default and every rule written before this key existed keeps working. Present, the rule loads only where the running harness id is listed; pi's id is `pi`.

```markdown
---
agents: [claude, codex, agy]
paths: ["src/**/*.ts"]
---

# Claude/codex/agy-only convention

Not loaded in pi: the bash sanitizer owns this concern there.
```

| Frontmatter | Loads in pi? |
| --- | --- |
| absent | yes (default) |
| `agents: [pi]` | yes |
| `agents: [claude, codex, agy]` | no |
| `agents: []` | no — an explicit empty allowlist admits nobody |
| malformed (`agents: pi`, bare `agents:`, unclosed `agents: [pi`) | yes, plus one load-time warning naming the file |

Ids are compared case-insensitively after trimming whitespace and quotes (`" PI "` equals `pi`), duplicates collapse, and the inline (`agents: [a, b]`) and block (`agents:` then `- a` lines) forms both work. `agents:` and `paths:` are independent: a listed harness keeps exactly the `paths:` activation it would have without `agents:`. When a harness and the rule disagree, prefer this key over a duplicate file — an excluded rule simply never enters the load, so it costs no prompt budget and no scan count.

## Shared rules via symlink

Both trees resolve file and directory symlinks and follow them, so shared conventions can live in one place:

```sh
ln -s ~/.pi/agent/rules/typescript-rules.md .pi/rules/shared-typescript.md
```

A realpath cycle guard stops at the first revisit, dangling symlinks are skipped silently, and the depth-5 cap applies through symlinked directories. Prefer linking whole directories (`shared/`) over individual files when a team shares a set.

## Version-control etiquette

- **Commit shared rules.** Project rules (`.pi/rules/`) are team knowledge — commit them like code. Review changes to unscoped rules as contract changes: they inject into every prompt, so a careless edit taxes every session.
- **Keep machine state out of git.** The refresh checksum cache at `.pi/.cache/pi-better-rules-checksums.json` is machine state — make sure `.pi/.cache/` is gitignored in your project (add the line if it isn't). Never hand-edit the checksum file; a corrupt cache rebuilds itself with a warning.
- **Moving from `.claude/rules/`.** There is no `.claude/` support by design — move files manually: copy the markdown into `.pi/rules/` (or `~/.pi/agent/rules/` for personal rules), add `paths:` frontmatter where the rule is scoped, and confirm the `/reload` refresh report picks them up. Delete the old copies so two systems don't diverge.
