# Prototype fidelity check

Type: prototype
Status: resolved
Blocked by: 03, 04, 05

## Question

Raise the fidelity of the whole discussion with a cheap, rough prototype: a skeleton extension showing `system`-tier full injection vs `general`-tier list-plus-on-demand, wired to the locked lifecycle (compaction re-load, `/reload` skip). React to the artifact — how should it behave — rather than debating abstractly. Links the prototype as an asset; does not ship.

Needs all three decisions above first. HITL: build with the human via the Skill tool with `prototype`, then grill reactions.

## Asset

First sketch: [prototype/pi-rules.ts](../prototype/pi-rules.ts) (~200 lines, all 5 decisions + dimmed-warning extra wired, GAPs marked inline). Shown 2026-09-04 — awaiting human reaction before resolution.

## Resolution (2026-09-04)

Human reaction arrived as two defect reports, both fixed in prototype: scoped-rule activation lag → Q7 `before_provider_request` marker reconcile (+TURN demo + mid-run walkthrough, zero `innerHTML`); `runBase` dead code → removed by lens. Demo + sketch now model all 7 locked decisions. Unblocks 07.
