# Lifecycle and reload semantics

Type: grilling
Status: resolved
Blocked by: 03, 04

## Question

Lock the runtime lifecycle: how do `general` rules get re-loaded after compaction (which event, re-injected as what — system reminder, user message, context entry?), what exactly does "no reload on `/reload`" mean (skip rescan and keep cache? how do edited rules ever refresh — explicit command, restart?), and what does "system loads only once" mean in code given `before_agent_start` runs per turn (cache content at first load and re-append identical text, or inject once and rely on compaction preserving it?).

Needs Rule locations and precedence plus the Frontmatter tier schema decided first, built on the Pi lifecycle facts. HITL: grill with the human; call the Skill tool for `grilling` and `domain-modeling`. Edge cases to cover: fork/resume, repeated compactions, rules edited mid-session.

## Answer

Decided 2026-09-04 (round 2):

- Tier × paths matrix: tier controls *how* (system = full content, general = index line), `paths:` controls *when* (unscoped = every prompt, scoped = only while a match is active). Both tiers render into the per-prompt `systemPrompt` override only — no user-role message injection.
- Activation set is cumulative over the session (rules stay active once triggered; no mid-task flicker). Eviction applies to the compaction summary only, never to rule text (re-rendered from cache each prompt).
- Q5 decision (b): Read+Write trigger — activation set = files read OR written so far in session. Deliberately fixes anthropics/claude-code#23478 (Write-without-Read never fires scoped rules) instead of cloning it; glob syntax + budgets still follow claude-rules.
- Q6: checksum-gated refresh. Checksum map persisted on disk as `pi-better-rules-checksums.json` (global `~/.pi/agent/cache/`, project `.pi/.cache/` gitignored) because `/reload` wipes extension memory. On `/reload` and explicit refresh: list → stat pre-filter → checksum candidates → reload changed, drop deleted, report refreshed/added/removed. Unchanged rules keep byte-identical text.
- Extra (2026-09-04): rule-load warnings (unknown tier, over-budget globs, corrupt checksum cache, shadowed files) render user-facing in DIMMED style. Prototype placeholders this as `[pi-rules:dim]` — real channel TBD (`theme.fg("dim", …)` custom text/status component, since `notify` has no dim level).
- Round 3 (2026-09-04): `notify` CONFIRMED official (`notify(message, type?: "info" | "warning" | "error")`, types.d.ts:76) — warnings go out at `"warning"` level; sketch wired. Walker follows symlinks with realpath cycle guard + max depth 5. Activation grounded in `ToolCallEvent { toolName, input }` (types.d.ts:678-724) + session jsonl (`read`/`edit`/`write` carry `input.path`; `bash` excluded). Glob matcher ports Claude syntax (`**`/`*`/`?`/`{a,b}`/`[...]`/`\[`) + 1000-pattern budget fallback. Demo bug fixed: general+scoped cell was unobservable (no such rule in demo disk) — added `perf-notes.md` (general + `src/**/*.ts`) + nested `frontend/react.md`.
- Q7 Mid-run activation (2026-09-04, from your report that reads/writes alone never surface rules): per-prompt injection can't cover files touched mid-run. Decided: `before_agent_start` snapshots the rendered set (`runBase`); `before_provider_request` full-reconciles the pi-rules block by `<!-- pi-rules:begin/end -->` markers on every LLM call — newly-activated rules land on the next inner turn. Idempotent under retries (strip + rebuild). GAP: provider-specific payload location for system instructions. Demo models this with ⚡ TURN + hook ON/OFF toggle + "Mid-run lag" walkthrough.
- Q7 simplification (2026-09-04, lens caught `runBase` as dead code — correctly): marker full-reconcile needs no snapshot, so `runBase` was removed from the sketch. `before_provider_request` recomputes the active set and rebuilds the block deterministically each call.
