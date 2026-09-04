# Load visibility (what loaded and why)

Type: task
Status: resolved

## Question

When rule loading triggers, users should notice *what* rules loaded and
*why*: general loading, checksum refresh, compaction, scoped activation —
not just counts.

## Decision

- `formatRuleList` (`src/scanner.ts`): per-rule detail lines
  ``- `<rel>` `[<scope>]` — unscoped (always-on)`` /
  ``- `<rel>` `[<scope>]` — scoped (`<patterns>`)``, appended to every load
  notification after the one-line headline.
- Trigger reasons in the headline:
  - `startup | new | resume | fork` → `` `<report>` `(full scan on <reason>)` ``.
  - `reload` unchanged →
    `N rule(s) — unchanged (checksums verified, no rescan)`.
  - `reload` changed →
    `refreshed A, added B, removed C (checksum changes detected)` with
    `` `~`/`+`/`-` `` `` `<rel>` `[<scope>]` `` lines per file.
- `session_compact` handler (notification-only, no state work — the
  in-memory cache still survives compaction untouched):
  `` `N rule(s) retained across compaction (<reason>) — cache untouched, no
  rescan` `` + rule list.
- Scoped messages carry the cause: `findActivatingFile` records the first
  touched file matching the rule, rendered as
  an *Activated by `src/app.ts`.* line (with the matched file) under that rule's section.

## Answer

Implemented in `src/scanner.ts`, `src/lifecycle.ts`, `src/index.ts`
(describeAbs rel-rendering for checksum paths); covered by new tests
(startup list + reason, reload-changed filenames, compact retention,
activation line). `lint && typecheck && test` green (70 tests).
