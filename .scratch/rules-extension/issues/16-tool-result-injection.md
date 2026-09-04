# Same-turn scoped injection (pi-rules tool_result port)

Type: task
Status: resolved

## Question

Scoped rules never visibly triggered: the `tool_call` → next-turn
`before_agent_start` message path meant single-shot runs could never fire,
toasts vanished from transcripts/exports, and bare `paths:` entries
(`pyproject.toml`) missed nested files. How does the reference
(code-yeongyu/pi-rules) deliver scoped rules and warnings?

## Decision

Port the reference mechanics, keep our scope-only model + rel separators:

- `tool_result` is the sole scoped injector (same-turn): append
  `\n\n## Rules (scoped — matched for <target>)` block to the triggering
  result's content, original content preserved first. `before_agent_start`
  carries unscoped system-prompt appends only. `tool_call` tracking removed.
- Multi-base matching (`candidateBases`/`matchFile` in `src/lifecycle.ts`):
  every touched file matches as repo-relative path + bare filename, so bare
  patterns fire for nested files.
- Path extraction (`extractResultPaths`): `read`/`edit` `input.path` plus
  `details.filePath`, `write` `filePath`/`path`, relativized vs `ctx.cwd`;
  `bash` and error results never activate.
- Every injection notifies `+N scoped rule(s) matched for <target>`.
- `session_start` persists a `pi-rules.scan` timeline entry via
  `pi.appendEntry` (visible in session exports); `/rules` reprints load
  state on demand, `/rules show <rel>` prints a body.
- Inject-once per rel preserved from the scope-only model.

## Verification

- 83 tests green, tsc + biome clean.
- Live probe against the repo's own rules: `read src/app.ts` appends both
  TypeScript scoped rules same-turn, original result kept, second matching
  read injects nothing.
