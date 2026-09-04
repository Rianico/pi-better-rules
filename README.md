# pi-better-rules

Pi extension that loads persistent rule memory from markdown files into every prompt — global conventions plus project conventions, with always-on rules and path-scoped activation.

## Rule memory (pi-better-rules)

**What it does.** On `session_start` the extension scans two rule trees, caches the result in memory, appends unscoped full content to the `systemPrompt` on every `before_agent_start`, and injects newly activated scoped rules as visible `pi-rules` session messages (cumulative inject-once). After loading it reports `pi-rules: N rule(s) — U unscoped, S scoped` at `info` level, followed by one detail line per rule and the trigger reason (full scan, checksum refresh, compaction retention). Unscoped rules live in the system prompt; scoped rules render as session messages — never as user-role text.

**Two rule locations.** Global rules live under `~/.pi/agent/rules`; project rules under `<project>/.pi/rules`. Both trees are scanned recursively for `**/*.md`, including subdirectories. Global loads first, project second, concatenated — on conflict project wins: an identical relative path in both trees is a shadow (the project copy replaces the global copy, no merge) and a load-time warning names the shadowed file. Files larger than 4 MiB are hard-skipped.

**Scope model.** `paths:` is optional scoping with `**` / `*` / `?` / `{a,b}` / `[...]` / backslash-escape glob syntax (an invalid pattern matches nothing while siblings keep working). Absent `paths:` means always-on; present `paths:` means conditional:

| Scope | Where it renders | When |
| --- | --- | --- |
| Unscoped (`paths:` absent) | Full content appended to the system prompt | Every prompt |
| Scoped (`paths:` present) | Full content injected as a visible session message | Once, when a touched file first matches |

Keep the always-on (unscoped) set minimal — invariants only. Domain rules belong in `paths:`-scoped rules. Every `paths:`-scoped rule is compaction-evictable: persistent invariants belong in unscoped rules. Activation is cumulative per session — once a file touched by a `read`, `edit`, or `write` call activates a rule, it stays active (no mid-task flicker). `bash` carries no `path`, so it never activates scoped rules — documented limitation.

**Freshness: snapshot, not live re-read.** The filesystem scan happens once per session and lives in module state; the per-prompt handler is cheap string concat. Edits to rule files mid-session do **not** take effect until a refresh:

- `/reload` wipes extension memory, so checksums persist on disk as `pi-better-rules-checksums.json` — global copy under `~/.pi/agent/cache/`, project copy under `.pi/.cache/`.
- On `session_start` with `reason === "reload"` the extension verifies checksums (list → stat pre-filter → checksum candidates): changed files reload, deleted files drop, and it reports `refreshed / added / removed` with one `~`/`+`/`-` line per changed file plus the full rule list — unchanged rules keep byte-identical text. When nothing changed it reports `unchanged (checksums verified, no rescan)` plus the rule list and skips the rescan entirely. Other reasons (`startup | new | resume | fork`) always rescan with a full rule list. A `session_compact` handler notifies retention (cache untouched, no rescan).
- A corrupt checksum cache is treated as everything-changed (rebuild) with a warning. Rule-load warnings (over-budget globs, corrupt cache, shadowed files) surface via `notify(message, "warning")`. Scoped messages name the activating file.

> [!tip]
> Writing rules? See the [rule-authoring guide](docs/rules-authoring.md) — filename style, frontmatter examples, the shared-rules-via-symlink pattern, and version-control etiquette.
