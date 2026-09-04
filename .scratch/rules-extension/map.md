## Destination

A locked, build-ready spec for a Pi rules extension — global `~/.pi/agent/rules` plus project `.pi/rules`, with `system` / `general` tiers, compaction and `/reload` lifecycle — that a builder can implement without reopening design questions. Planning only: decisions, not the built extension.

## Notes

- Domain: Pi extensions (`docs`: `extensions.md`, `compaction.md`; example `examples/extensions/claude-rules.ts`). Reference: <https://code.claude.com/docs/en/memory#organize-rules-with-claude/rules>
- Standing preferences: no `.claude/` paths; global + project locations as stated; refine the `metadata.rules_catalog` field name if a better one emerges; verify the assumption that compaction leaves the system prompt alone (do not assume — prove from Pi source/docs).
- Skills per session: `grilling` + `domain-modeling` by default; `research` for AFK fact-finding; `prototype` only where the ticket names it. Consult `CONTEXT.md`/ADRs when they exist (none yet — create lazily per `domain-modeling`).
- Tracker: local-markdown (confirmed via setup; see `docs/agents/issue-tracker.md`). This file is the map, `.scratch/rules-extension/issues/NN-<slug>.md` are the tickets.
- Naming: refer to tickets by name in prose, never by bare number.

## Decisions so far

<!-- one line per closed ticket: gist + link; the ticket holds the detail -->

- [Pi lifecycle facts](issues/01-pi-lifecycle-facts.md): `before_agent_start` is per-prompt with an ephemeral override; compaction never touches the system prompt; `/reload` can be skipped via `reason === "reload"`; general-tier re-injection happens per prompt from surviving in-memory cache.
- [Claude rules semantics to borrow or drop](issues/02-claude-rules-semantics.md): borrow recursive discovery, launch-time vs `paths:`-scoped split, global-first/project-wins concat, symlinks, budgets; conflicts flagged — keep always-on minimal, scoped rules are compaction-evictable, snapshot-vs-live freshness must be picked explicitly.
- [Rule locations and precedence](issues/03-rule-locations-and-precedence.md): recursive scan of both locations, global-first/project-wins concat, identical relative paths shadow (no merge), symlinks with cycle guard.
- [Frontmatter tier schema](issues/04-frontmatter-tier-schema.md): `system` = full prompt injection, `general` = index + on-demand; field `metadata.rule_tier: system | general` (namespaced — top-level keys reserved for common standards), default `general`, unknown warns + falls back; `paths:` scoping REQUIRED per claude-rules.
- [Lifecycle and reload semantics](issues/05-lifecycle-and-reload-semantics.md): tier controls how / `paths:` controls when (4-cell matrix); both tiers render into the per-prompt `systemPrompt` override; activation set is cumulative session files with Read+Write trigger (fixes the Claude Write-hole); checksum-gated refresh persisted as `pi-better-rules-checksums.json` (global `~/.pi/agent/cache/`, project `.pi/.cache/` gitignored), verified on `/reload` and explicit refresh with refreshed/added/removed report.
- [Scope-only model](issues/14-scope-only-model.md): tier retired (supersedes 04/05 tier decisions) — unscoped rules append full content to the system prompt every prompt, scoped rules inject once as visible `pi-rules` messages on activation; `metadata.rule_tier` ignored; `before_provider_request` marker reconcile removed (dead on Responses-API providers).
- [Load visibility](issues/15-load-visibility.md): every load trigger notifies what+why — full rule list with trigger reason on startup/reload, per-file change lines on checksum refresh, retention notice on `session_compact`, activating file in scoped messages.
- [Same-turn scoped injection](issues/16-tool-result-injection.md): pi-rules `tool_result` port (supersedes the 14 next-turn message path) — scoped rules append to the triggering result same-turn, multi-base matching (rel path + basename), `pi-rules.scan` timeline entries, `/rules` status/show command; inject-once per rel preserved.

## Not yet specified

- Packaging and repo shape: where the extension lives in this repo, how it ships, what tests guard it, what docs accompany it.
- Rule authoring conventions: filename style, one-topic-per-file, size limits, subdirectory organization.
- Gitignored rules and `.pi/rules` version-control etiquette.
- Performance and prompt-budget guards when many/large rules exist.
- Migration story for existing `.claude/rules/` users (explicitly no `.claude/` support — but do we document the move?).

## Out of scope

- Supporting `.claude/` paths — explicitly ruled out for this effort.
- Auto-memory / `MEMORY.md` behavior — separate mechanism, not this map.
- Org-managed policy rules — not in the stated idea.
