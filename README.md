# pi-better-rules

Pi extension that loads persistent rule memory from markdown files into every prompt — global conventions plus project conventions, with tiered injection and path-scoped activation.

## Rule memory (pi-better-rules)

**What it does.** On `session_start` the extension scans two rule trees, caches the result in memory, and re-applies a `systemPrompt` override on every `before_agent_start`. Mid-run file touches are reconciled on `before_provider_request` via a `<!-- pi-rules:begin --> … <!-- pi-rules:end -->` marker block (strip + rebuild, idempotent under retries). After loading it reports `pi-rules: N rule(s) — S system, G general, C scoped` at `info` level. Rules never render as user-role messages — `systemPrompt` only.

**Two rule locations.** Global rules live under `~/.pi/agent/rules`; project rules under `<project>/.pi/rules`. Both trees are scanned recursively for `**/*.md`, including subdirectories. Global loads first, project second, concatenated — on conflict project wins: an identical relative path in both trees is a shadow (the project copy replaces the global copy, no merge) and a load-time warning names the shadowed file. Files larger than 4 MiB are hard-skipped.

**Tier × `paths:` matrix.** The tier comes from `metadata.rule_tier` (`system` | `general`, default `general`; unknown values warn and fall back to `general`). `paths:` is optional scoping with `**` / `*` / `?` / `{a,b}` / `[...]` / `\[` glob syntax (an invalid pattern matches nothing while siblings keep working). Tier is HOW the rule renders, `paths:` is WHEN:

| Tier | `paths:` absent (unscoped) | `paths:` present (scoped) |
| --- | --- | --- |
| `system` | Full content injected every prompt | Full content injected while a match is active |
| `general` | One index line every prompt; full text via the read tool | One index line while a match is active |

Keep the always-on (unscoped) set minimal — invariants only. Domain rules belong in `paths:`-scoped rules. Every `paths:`-scoped rule is compaction-evictable: persistent invariants belong in unscoped rules. Activation is cumulative per session — once a file touched by a `read`, `edit`, or `write` call activates a rule, it stays active (no mid-task flicker). `bash` carries no `path`, so it never activates scoped rules — documented limitation.

**Freshness: snapshot, not live re-read.** The filesystem scan happens once per session and lives in module state; the per-prompt handler is cheap string concat. Edits to rule files mid-session do **not** take effect until a refresh:

- `/reload` wipes extension memory, so checksums persist on disk as `pi-better-rules-checksums.json` — global copy under `~/.pi/agent/cache/`, project copy under `.pi/.cache/`.
- On `session_start` with `reason === "reload"` the extension verifies checksums (list → stat pre-filter → checksum candidates): changed files reload, deleted files drop, and it reports `refreshed / added / removed` — unchanged rules keep byte-identical text. When nothing changed it reports `unchanged` and skips the rescan entirely. Other reasons (`startup | new | resume | fork`) always rescan.
- A corrupt checksum cache is treated as everything-changed (rebuild) with a warning. Rule-load warnings (unknown tier, over-budget globs, corrupt cache, shadowed files) surface via `notify(message, "warning")`.

> [!tip]
> Writing rules? See the [rule-authoring guide](docs/rules-authoring.md) — filename style, frontmatter examples, the shared-rules-via-symlink pattern, and version-control etiquette.
