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
- MUST report load as `pi-rules: N rule(s) — S system, G general, C scoped` at `info` level after scan [06].
- MUST parse minimal frontmatter: `metadata.rule_tier` and `paths:` (see §2); a file with no frontmatter is a valid unscoped `general` rule [04].
- MUST derive the general-tier index summary from the first `#` heading, else the first non-blank line, else the relative path [06].
- GAP: ordering within one tree (alphabetical vs directory order) was left open in [03] — the prototype emits walker order. Builders MUST sort `rel` ascending within each scope for determinism; flag if this breaks any human expectation.
- GAP: gitignored or untracked project rules were left open in [03] — this spec includes them (no git check in the walker). Exclusion, if ever wanted, goes through explicit exclude globs, not git status.

## 2. Tiers — `metadata.rule_tier` + `paths:`

- MUST read the tier from `metadata.rule_tier` (namespaced under `metadata` because top-level frontmatter keys are reserved for common standards); values `system | general` [04].
- MUST default a missing tier to `general` [04].
- MUST warn on an unknown tier value and fall back to `general` [04].
- MUST render tier as HOW and `paths:` as WHEN (4-cell matrix) [05]:
  - `system` + unscoped → full content injected every prompt.
  - `system` + scoped → full content injected while a match is active.
  - `general` + unscoped → one index line every prompt; full text via the read tool.
  - `general` + scoped → one index line while a match is active.
- MUST treat `paths:` as REQUIRED-capable scoping that follows claude-rules semantics: glob syntax `**` / `*` / `?` / `{a,b}` / `[...]` / `\[`, invalid pattern matches nothing while siblings keep working [04, 05-round-3].
- MUST keep the always-on (unscoped) set minimal — invariants only; domain rules belong in `paths:`-scoped or skill tier, never all-always-on [02-conflict-1].
- MUST treat every `paths:`-scoped rule as compaction-evictable; MUST NOT promise scoped-rule persistence across compaction. Persistent invariants belong in unscoped rules [02-conflict-2].
- MUST match activation against cumulative session activity (see §3), not just the latest tool call [05].

## 3. Lifecycle — activation, injection, reload

### 3.1 Activation set

- MUST maintain a cumulative session set of touched files: once a file activates a rule it stays active for the session (no mid-task flicker) [05].
- MUST add to the touched set on `read`, `edit`, and `write` tool calls carrying `input.path` (Read+Write trigger — deliberately fixes anthropics/claude-code#23478 where Write-without-Read never fires scoped rules) [05-Q5b, 05-round-3].
- MUST ground tool detection in `ToolCallEvent { toolName, input }`; `bash` (no `path`) is excluded — documented limitation [05-round-3].
- MUST NOT evict rule text on compaction: eviction applies to the compaction summary only; rules re-render from cache each prompt [05].

### 3.2 Prompt injection

- MUST render both tiers into the per-prompt `systemPrompt` override only — never a user-role message injection [05].
- MUST re-apply the override on every `before_agent_start` (it runs once per user prompt and its result is ephemeral — cache the fs scan in module state at `session_start`, keep the handler to cheap string concat) [01].
- MUST format the per-prompt render as `## Rules: system tier (full)` with `### <rel> [<scope>]` + full body, plus `## Rules: general tier (index — use the read tool for full text)` with `- <rel> [<scope>] — <summary>` lines when any general rules are active; skip empty sections [06].
- MUST also reconcile mid-run: on `before_provider_request`, strip any existing `<!-- pi-rules:begin --> … <!-- pi-rules:end -->` block from the outgoing system text and rebuild it deterministically from the current active set, so files touched mid-run land on the next inner turn. Idempotent under retries by construction (strip + rebuild, no snapshot state) [05-Q7, 05-Q7-simplification].
- GAP: the exact payload location for system instructions is provider-specific; the prototype reads `payload.system` as a string and returns unchanged when it is absent. Builders MUST keep that guard and extend per provider without changing the marker contract [05-Q7].
- MUST rely on the proven fact that compaction never touches the system prompt (held separately as `agent.state.systemPrompt`) while re-injecting per prompt from cache [01].

### 3.3 `/reload` and refresh

- MUST persist the checksum map as `pi-better-rules-checksums.json` on disk — global copy under `~/.pi/agent/cache/`, project copy under `.pi/.cache/` (gitignored) — because `/reload` wipes extension memory [05-Q6].
- MUST skip the rescan on `session_start` with `reason === "reload"` (keep cached rules); rescan on `startup | new | resume | fork` [01].
- MUST verify on `/reload` and on explicit refresh via list → stat pre-filter → checksum candidates: reload changed, drop deleted, report `refreshed / added / removed`; unchanged rules keep byte-identical text [05-Q6].
- MUST treat a corrupt checksum cache as everything-changed (rebuild), with a warning [05-round-3, 06].
- MUST surface rule-load warnings (unknown tier, over-budget globs, corrupt checksum cache, shadowed files) user-facing via the official `notify(message, "warning")` channel [05-extra, 05-round-3].

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
| `tool_call` | Add `input.path` to the touched set for `read` / `edit` / `write` only [05-round-3] |
| `before_agent_start` | Return the per-prompt `systemPrompt` override per §3.2; return nothing when no rules are active [01, 06] |
| `before_provider_request` | Marker full-reconcile per §3.2; pass through untouched when no string system field exists (GAP per provider) [05-Q7] |

No handler for `session_before_compact` / `session_compact`: in-memory cache survives compaction untouched and no event work is needed [01].

## 7. Tests

- MUST lay tests out as one module per feat ticket: `tests/scanner.test.ts` (08), `tests/cache.test.ts` (09), `tests/lifecycle.test.ts` (10), written TDD red → green → refactor in `feat/rules-*` worktrees per the tickets [08, 09, 10].
- MUST cover, at minimum: recursive scan + depth cap + cycle guard; shadow rule + warning; tier default + unknown-tier fallback; glob matrix (`**` crossing separators, `{a,b}`, `[...]`, `\[`, invalid-pattern isolation, 1000-pattern fallback); cumulative Read+Write activation (incl. Write-without-Read); per-prompt render shape; marker reconcile idempotence; checksum verify/refresh report with byte-identical passthrough; corrupt-cache rebuild; `/reload` no-rescan-when-unchanged.
- MUST keep `pnpm run lint && pnpm run typecheck && pnpm test` green in each worktree [08, 09, 10].

## 8. Docs

- MUST add a README section: what pi-better-rules does, the two rule locations, the tier × `paths:` matrix in one table, and the `/reload` + explicit-refresh freshness story (snapshot, not live re-read) [02-conflict-3, ticket-07-scope].
- MUST add a rule-authoring guide: filename style (lowercase-hyphenated `*.md`), one-topic-per-file, subdirectory organization, ~200-line target, `metadata.rule_tier` + `paths:` frontmatter examples, shared-rules-via-symlink pattern [ticket-07-scope, 02].
- MUST document `.pi/rules` version-control etiquette (commit shared rules; keep machine state `.pi/.cache/` gitignored) and the move path for existing `.claude/rules/` users (manual move — no `.claude/` support by design) [map-not-yet-specified, map-out-of-scope].
- GAP: whether a local-private tier (e.g. gitignored `.pi/rules.local/`) exists is undecided — borrowed only partially in [02]. Builders MUST NOT invent it; authoring docs assume global + project only.

## 9. Decision trace

| Spec section | Source |
| --- | --- |
| §1 discovery / precedence / shadowing | Rule locations and precedence [03], borrow table [02] |
| §1 symlink + depth-5 guard | Claude rules semantics [02], Lifecycle round-3 [05] |
| §1 load report | Prototype fidelity [06] |
| §2 `metadata.rule_tier`, default, fallback | Frontmatter tier schema [04] |
| §2 tier×paths matrix, systemPrompt-only | Lifecycle decisions [05] |
| §2 glob syntax + budgets | Claude rules semantics [02], Lifecycle round-3 [05] |
| §2 always-on minimal / evictable scoped | Conflicts 1–2 [02] |
| §3.1 cumulative Read+Write set | Lifecycle Q5 [05] |
| §3.1 ToolCallEvent grounding, bash excluded | Lifecycle round-3 [05] |
| §3.2 per-prompt ephemeral override | Pi lifecycle facts [01] |
| §3.2 render shape, marker reconcile, no `runBase` | Prototype fidelity [06], Lifecycle Q7 [05] |
| §3.3 checksum file, verify-not-rescan, report | Lifecycle Q6 [05] |
| §3.3 `reason === "reload"` skip | Pi lifecycle facts [01] |
| §3.3 `notify` warning channel | Lifecycle extra + round-3 [05] |
| §4 budgets | Claude rules semantics [02] |
| §5–8 packaging / tests / docs | Build-ready spec ticket scope [07], feat tickets [08, 09, 10] |
