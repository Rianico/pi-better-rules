# Claude rules semantics to borrow or drop

Type: research
Status: resolved
Blocked by: none

## Question

What exactly does Claude's `.claude/rules/` system do, and what should this Pi extension borrow vs drop given the no-`.claude/`-paths constraint and the `~/.pi/agent/rules` + `.pi/rules` locations?

Resolve from <https://code.claude.com/docs/en/memory> (rules setup, `paths` frontmatter scoping, user `~/.claude/rules/` vs project rules, symlinks, load order, size/budget guidance, what survives compaction). Produce a borrow/drop table: load order and precedence, per-file scoping, discovery (recursive, subdirectories), user-vs-project priority — mapped onto Pi's two locations. Flag anything Claude does that conflicts with the system/general tier idea or the compaction + `/reload` requirements.

## Answer

Full brief: [02-claude-rules-brief.md](../assets/02-claude-rules-brief.md).

Distilled findings (source: <https://code.claude.com/docs/en/memory> + context-window):

- Recursive `*.md` discovery; no-`paths` = launch-time at `CLAUDE.md` priority; `paths:` = on-demand on Read match (Write-trigger undocumented — open bug). Borrow all three, mapped onto `~/.pi/agent/rules` + `.pi/rules`; must decide Read vs Read+Write trigger for Pi.
- User loads before project, project wins, everything concatenates. Borrow: global first, project second, concat, project wins.
- Borrow: symlinks + cycle guard, exclude globs, 200-line target / 4 MiB skip budgets, always-on vs evictable-scoped distinction.
- Three flagged conflicts for later tickets: (1) system+general both always-on risks priority-nowhere — keep always-on minimal; (2) scoped rules are evicted by compaction, never promise persistence; (3) no-reload-on-`/reload` contradicts Claude's re-read-from-disk freshness — pick snapshot vs live explicitly.
