# Scope-only model (drop tier)

Type: task
Status: resolved

## Question

Should `general`-tier rules stay index-only, or should both tiers inject full
content? Refined in discussion to: drop `tier` entirely — scope (`paths:`
absent vs present) is the only distinction.

## Decision

- No `tier`. `paths:` absent = **unscoped**: always-on invariant, full content
  appended to the `systemPrompt` every prompt (like pi's appended system
  prompt). `paths:` present = **scoped**: full content injected as a visible
  session message (`customType: "pi-rules"`, `display: true`) on activation,
  cumulative inject-once (never re-injected, no mid-task flicker).
- A `metadata.rule_tier` key, if present in old files, is ignored (nobody
  used the field — diminish, don't migrate).
- The `before_provider_request` marker reconcile
  (`<!-- pi-rules:begin/end -->`) is removed: it only handled
  `payload.system: string`, which Responses-API providers (e.g. opencode-go
  with `payload.input[]`) never send — dead code on the live path. Proven by
  instrumented run: `input[0] role=developer hasRules=true` via
  `before_agent_start` alone.
- Cost guard stays: keep the unscoped set minimal (invariants only). The 5
  stock unscoped files cost ~14 KB per prompt vs ~500 chars of index.

## Answer

Implemented in `src/scanner.ts` (no `tier`; `formatLoadReport` counts
unscoped/scoped), `src/lifecycle.ts` (`getUnscopedRules`,
`getActiveScopedRules`, `getNewScopedRules`, `findActivatingFile`,
`buildSystemPromptOverride`, `buildScopedMessage`), `src/index.ts`
(`touched` + `injected` sets, prune-on-rescan, three handlers). Contradicts
the 04/05 tier decisions and spec §2/§3.2/§6 — spec amended accordingly
(see also issue 15 for load-visibility reporting).
Surfaced here rather than silently overriding, per domain rules.
