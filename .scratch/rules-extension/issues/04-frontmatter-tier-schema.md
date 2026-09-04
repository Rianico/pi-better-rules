# Frontmatter tier schema

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Decide the frontmatter schema for the `system` / `general` tiers: field name (the proposal is `metadata.rules_catalog` — refine it if a better name emerges), enum values and default when absent or unknown, validation behavior (reject, warn, ignore?), and whether any Claude-like path-scoping rides along or is deferred. Also: does `system` mean full-content injection into the system prompt while `general` keeps the current list-plus-on-demand-read behavior?

Needs the Pi lifecycle facts and the Claude rules semantics to borrow or drop first. HITL: grill with the human; call the Skill tool for `grilling` and `domain-modeling`.

## Answer

Decided 2026-09-04 (round 1): `system` = full content injected into the system prompt every prompt; `general` = index line plus on-demand read. Field is `metadata.rule_tier: system | general` — namespaced under `metadata` because top-level frontmatter keys are reserved for common standards (codex, agents); default `general`, unknown value warns and falls back to `general`. `paths:` scoping is REQUIRED and follows claude-rules semantics (glob syntax, budgets); tier × paths interaction passes to Lifecycle and reload semantics.
