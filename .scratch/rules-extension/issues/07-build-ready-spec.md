# Build-ready spec

Type: spec
Status: open
Blocked by: 06

## Question

Emit the locked build-ready spec from the 7 resolved decisions (01–06) so feat worktrees build against one contract, not the map.

## Scope

- New file: `.scratch/rules-extension/spec.md` (source of truth for 08/09/10).
- Settles remaining fog: packaging (extension entry + manifest), test layout (`tests/` per module), docs (README section + rule-authoring guide).
- Restates locked behavior verbatim: locations/precedence (03), tier schema (04), lifecycle + Q7 reconcile (05), budgets/glob (02 + prototype).

## Acceptance

- [ ] `spec.md` covers behavior, tiers, lifecycle, budgets, packaging, tests, docs.
- [ ] Every MUST traces to a ticket decision (03/04/05/06); every GAP marked inline.
- [ ] 08/09/10 owners can build without re-reading the map.
