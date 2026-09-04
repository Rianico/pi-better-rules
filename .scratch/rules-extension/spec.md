# pi-better-rules — build-ready spec

Source of truth for the feat tickets ([Rule scanner](issues/08-rule-scanner.md), [Checksum cache + refresh](issues/09-checksum-cache.md), [Lifecycle + prompt rendering](issues/10-lifecycle-rendering.md)). Locks the 7 resolved decisions from [Pi lifecycle facts](issues/01-pi-lifecycle-facts.md) through [Prototype fidelity check](issues/06-prototype-fidelity-check.md) into one build contract. Builders implement from this file; the [map](../map.md) and ticket Answers are background only.

Trace key: each MUST ends with its source ticket in brackets, e.g. `[03]`. `GAP:` marks an explicit unknown the builder must not silently decide — either follow the stated fallback or escalate.

> [!note] Non-goals
> No `.claude/` paths, no auto-memory / `MEMORY.md`, no org-managed policy rules (all out of scope per map).

## 1. Behavior — discovery and precedence

- MUST recursively scan `**/*.md` under both `~/.pi/agent/rules` (global) and `<project>/.pi/rules` (project), including subdirectories (`frontend/`, `backend/` style nesting allowed) [02, 03].
- MUST load global first, project second, and concatenate; on conflict project wins [02, 03].
- MUST treat an identical relative path in both trees as a shadow: the project copy replaces the global copy, no merge, and a load-time warning names the shadowed file [03, 05-extra].
- MUST resolve symlinks (file and directory) and follow them, with a realpath cycle guard and a max walk depth of 5; dangling symlinks are skipped silently, cycles stop at first revisit [02, 05-round-3].
- MUST report load as `pi-rules: N rule(s) — U unscoped, S scoped` at `info` level after scan, followed by one `- <rel> [<scope>]` detail line per rule, with the trigger reason in the headline (`full scan on <reason>`, `checksums verified`, `checksum changes detected`, `retained across compaction`) [06, 15].
- MUST parse minimal frontmatter: `paths:` (see §2); a file with no frontmatter is a valid unscoped rule; a `metadata.rule_tier` key, if present, is ignored (tier retired [14]) [04].
- MUST derive the rule summary from the first `#` heading, else the first non-blank line, else the relative path [06].
- GAP: ordering within one tree (alphabetical vs directory order) was left open in [03] — the prototype emits walker order. Builders MUST sort `rel` ascending within each scope for determinism; flag if this breaks any human expectation.
- GAP: gitignored or untracked project rules were left open in [03] — this spec includes them (no git check in the walker). Exclusion, if ever wanted, goes through explicit exclude globs, not git status.

## 2. Scope — `paths:` only (tier retired [14])

- MUST treat `paths:`-absent files as **unscoped**: always-on invariants, full content appended to the `systemPrompt` every prompt (like pi's appended system prompt).
- MUST treat `paths:`-present files as **scoped**: full content injected as a visible session message (`customType: "pi-rules"`, `display: true`) when active, cumulative inject-once (never re-injected).
- MUST treat `paths:` as REQUIRED-capable scoping that follows claude-rules semantics: glob syntax `**` / `*` / `?` / `{a,b}` / `[...]` / backslash-escapes, invalid pattern matches nothing while siblings keep working [04, 05-round-3].
- MUST keep the always-on (unscoped) set minimal — invariants only; domain rules belong in `paths:`-scoped rules or skills, never all-always-on [02-conflict-1].
- MUST treat every `paths:`-scoped rule as compaction-evictable; MUST NOT promise scoped-rule persistence across compaction. Persistent invariants belong in unscoped rules [02-conflict-2].
- MUST match activation against cumulative session activity (see §3), not just the latest tool call [05].

## 3. Lifecycle — activation, injection, reload

### 3.1 Activation set

- MUST match scoped rules same-turn in `tool_result` (pi-rules dynamic style): extract touched paths from the result event (`read`/`edit` `input.path` plus `details.filePath`, `write` `filePath`/`path`), relativized against `ctx.cwd` [05-round-3].
- MUST try two path bases per touched file — the repo-relative path and its bare filename — so bare `paths:` entries (e.g. `pyproject.toml`) match nested files [16].
- MUST ground tool detection in the `tool_result` event; `bash` (no path) and error results never activate — documented limitation [05-round-3].
- MUST NOT evict rule text on compaction: eviction applies to the compaction summary only; rules re-render from cache each prompt [05].

### 3.2 Prompt injection

- MUST append unscoped full content to the per-prompt `systemPrompt` override — never a user-role message; scoped rules are appended to the triggering tool result instead [05, 14, 16].
- MUST re-apply the override on every `before_agent_start` (it runs once per user prompt and its result is ephemeral — cache the fs scan in module state at `session_start`, keep the handler to cheap string concat) [01].
- MUST format the per-prompt render as `## Rules (always-on)` followed by one `--- rel [scope] ---` separator plus the original body per rule; return nothing when no unscoped rules exist [06, 14].
- MUST append newly activated scoped rules to the triggering `tool_result` content as `\n\n## Rules (scoped — matched for <target>)` with one `--- rel [scope] ---` separator plus the original body per rule, each annotated with its activating file; notify `+N scoped rule(s) matched for <target>`; track injected rels in module state and never re-inject (cumulative inject-once) [14, 16].
- MUST notify retention on `session_compact` (notification-only, no state work): the in-memory cache survives compaction untouched [15].
- MUST rely on the proven fact that compaction never touches the system prompt (held separately as `agent.state.systemPrompt`) while re-injecting per prompt from cache [01].

### 3.3 `/reload` and refresh

- MUST persist the checksum map as `pi-better-rules-checksums.json` on disk — global copy under `~/.pi/agent/cache/`, project copy under `.pi/.cache/` (gitignored) — because `/reload` wipes extension memory [05-Q6].
- MUST skip the rescan on `session_start` with `reason === "reload"` (keep cached rules); rescan on `startup | new | resume | fork` [01].
- MUST verify on `/reload` and on explicit refresh via list → stat pre-filter → checksum candidates: reload changed, drop deleted, report `refreshed / added / removed` with one `~`/`+`/`-` line per file plus the full rule list; unchanged rules keep byte-identical text [05-Q6, 15].
- MUST treat a corrupt checksum cache as everything-changed (rebuild), with a warning [05-round-3, 06].
- MUST surface rule-load warnings (over-budget globs, corrupt checksum cache, shadowed files) user-facing via the official `notify(message, "warning")` channel [05-extra, 05-round-3].

## 4. Budgets

- MUST apply the per-file guidance: ~200-line target per rule file; hard-skip files larger than 4 MiB [02].
- MUST apply the whole-`paths:`-list budget: 1000 expanded patterns and 4 MiB; on breach warn and fall back to literal matching for that rule [02, 05-round-3].
- MUST cap walker depth at 5 (see §1) as the symlink/depth budget [05-round-3].

## 5. Packaging — extension entry + manifest

- MUST ship the extension as this repo's package `pi-better-rules` with a single entry module (default export function taking the Pi `ExtensionAPI`) plus one module per feat ticket: `src/scanner.ts` (08), `src/cache.ts` (09), `src/lifecycle.ts` (10), wired through `src/index.ts`. Existing repo standards apply (`package.json` scripts `typecheck` / `test` / `lint` / `build`, `tsconfig.json` strict, Biome).
- MUST declare Pi extension metadata per `docs/extensions.md` (manifest/entry fields the loader requires) in the repo packaging file; the entry MUST register exactly the four handlers in §6 and no others without a spec amendment.
- GAP: the exact manifest filename/fields were not settled in 01–06 (map "Not yet specified: packaging and repo shape"). Builder MUST follow the installed Pi `extensions.md` + `examples/extensions/claude-rules.ts` reference and record the chosen shape in the packaging file; anything beyond entry + manifest (CLI, extra commands) is out of scope.

## 6. Handler contract

| Handler | MUST |
| --- | --- |
| `session_start` | Build `checksumsPath` from `ctx.cwd`; bind `notifyWarn` to `ctx.ui.notify(msg, "warning")`; `reason === "reload"` → checksum-verify + rescan-only-if-changed + unchanged/changed report; else full scan [01, 05-Q6, 06] |
| `tool_result` | Extract touched paths for `read` / `edit` / `write` only; append newly activated scoped rules to the result content same-turn (cumulative inject-once); skip error results [05-round-3, 16] |
| `before_agent_start` | Append unscoped full content to the `systemPrompt` override; return nothing when no unscoped rules exist [01, 06, 14] |
| `session_compact` | Notify retention with the rule list; no state work — the cache survives compaction untouched [15] |

A `session_compact` handler notifies retention only; no rescan or state work runs on compaction [01, 15].

## 7. Tests

- MUST lay tests out as one module per feat ticket: `tests/scanner.test.ts` (08), `tests/cache.test.ts` (09), `tests/lifecycle.test.ts` (10), written TDD red → green → refactor in `feat/rules-*` worktrees per the tickets [08, 09, 10].
- MUST cover, at minimum: recursive scan + depth cap + cycle guard; shadow rule + warning; tier field ignored; glob matrix (`**` crossing separators, `{a,b}`, `[...]`, backslash-escapes, invalid-pattern isolation, 1000-pattern fallback); cumulative Read+Write activation (incl. Write-without-Read); unscoped full-content render; scoped inject-once with activating file; rule-list load reporting with trigger reasons; compact retention notice; checksum verify/refresh report with byte-identical passthrough; corrupt-cache rebuild; `/reload` no-rescan-when-unchanged.
- MUST keep `pnpm run lint && pnpm run typecheck && pnpm test` green in each worktree [08, 09, 10].

## 8. Docs

- MUST add a README section: what pi-better-rules does, the two rule locations, the scope model (unscoped always-on vs scoped on activation) in one table, and the `/reload` + explicit-refresh freshness story (snapshot, not live re-read) [02-conflict-3, ticket-07-scope].
- MUST add a rule-authoring guide: filename style (lowercase-hyphenated `*.md`), one-topic-per-file, subdirectory organization, ~200-line target, `paths:` frontmatter examples, shared-rules-via-symlink pattern [ticket-07-scope, 02].
- MUST document `.pi/rules` version-control etiquette (commit shared rules; keep machine state `.pi/.cache/` gitignored) and the move path for existing `.claude/rules/` users (manual move — no `.claude/` support by design) [map-not-yet-specified, map-out-of-scope].
- GAP: whether a local-private tier (e.g. gitignored `.pi/rules.local/`) exists is undecided — borrowed only partially in [02]. Builders MUST NOT invent it; authoring docs assume global + project only.

## 9. Decision trace

| Spec section | Source |
| --- | --- |
| §1 discovery / precedence / shadowing | Rule locations and precedence [03], borrow table [02] |
| §1 symlink + depth-5 guard | Claude rules semantics [02], Lifecycle round-3 [05] |
| §1 load report + rule list and trigger reasons | Prototype fidelity [06], Load visibility [15] |
| §2 retired tier (was: `metadata.rule_tier`) | Frontmatter tier schema [04], Scope-only model [14] |
| §2 scope-only model (was: tier×paths matrix) | Lifecycle decisions [05], Scope-only model [14] |
| §2 glob syntax + budgets | Claude rules semantics [02], Lifecycle round-3 [05] |
| §2 always-on minimal / evictable scoped | Conflicts 1–2 [02] |
| §3.1 cumulative Read+Write set | Lifecycle Q5 [05] |
| §3.1 ToolCallEvent grounding, bash excluded | Lifecycle round-3 [05] |
| §3.2 per-prompt ephemeral override | Pi lifecycle facts [01] |
| §3.2 render shape, scoped message injection (was: marker reconcile) | Prototype fidelity [06], Lifecycle Q7 [05], Scope-only model [14] |
| §3.3 checksum file, verify-not-rescan, report | Lifecycle Q6 [05] |
| §3.3 `reason === "reload"` skip | Pi lifecycle facts [01] |
| §3.3 `notify` warning channel | Lifecycle extra + round-3 [05] |
| §4 budgets | Claude rules semantics [02] |
| §6 `session_compact` handler, provider reconcile removed | Load visibility [15], Scope-only model [14] |
| §5–8 packaging / tests / docs | Build-ready spec ticket scope [07], feat tickets [08, 09, 10] |
