---
name: pi-extension-gotcha
description: >-
  Non-obvious pi extension traps: injection surfaces, system-prompt sections, export visibility, and delivery timing. Audits output against decoded session exports and pi source. Use when rules are missing from exported HTML, prompts vanish after a run, or entries render invisible.
---

# pi Extension Gotchas

Picking the wrong injection surface in a pi extension produces a feature that works in the terminal and is absent from the exported session, with no error at any point. This is the surface table, the traps behind it, and the decode recipe that settles the question with evidence instead of a grep.

Every claim cites the installed pi dist as `file:line`. Verified against pi 0.99.1 — re-check the line numbers after a pi upgrade before trusting a trap.

`$PI_DIST` is the `@earendil-works/pi-coding-agent/dist` directory of the installed pi:

```bash
PI_DIST=$(find -L "${PNPM_HOME:-$HOME/Library/pnpm}/global" "$(npm root -g 2>/dev/null)" \
  -type d -path '*/node_modules/@earendil-works/pi-coding-agent/dist' 2>/dev/null | head -1)
test -f "$PI_DIST/core/agent-session.js" || echo "unresolved — locate the @earendil-works/pi-coding-agent dist yourself"
```

A pnpm or npm shim in `bin/` is not a symlink into the package, so resolving `$(command -v pi)` does not find it.

## Pick the surface

Five surfaces exist. Pick by *where the content must land*, not by which is easiest to call.

| Intent | Surface | Lands in transcript | Export HTML | Terminal |
| --- | --- | --- | --- | --- |
| Always-on guidance in the system prompt | `event.systemPromptOptions.sections[<name>] = body` | yes, as a system message | System Prompt block | not shown |
| Per-request prompt text | return `{systemPrompt}` from `before_agent_start` | **no** | **absent** | not shown |
| Mid-conversation event, loud | `pi.sendMessage(msg, {deliverAs:"steer", triggerTurn:false})` | yes | ordinary message | shown |
| Mid-conversation record, quiet | same with `display: false` | yes | behind "Show hidden messages" | not shown |
| Batch entries at the settle boundary | `agent_before_settle` → `{entries: [...]}` | yes | per-entry `display` | per-entry `display` |
| Extension-private data | `pi.appendEntry(customType, data)` | yes | **renders as `''`** | not shown |

The rows that bite are the forced prompt and `appendEntry`.

## Traps

### T1 — a forced system prompt never reaches the export

`{systemPrompt}` from `before_agent_start` becomes `forceSystemPrompt`, applied as a per-request `agent.transformContext` projection (`$PI_DIST/core/agent-session.js:1288`). `_runAgentPrompt` clears the run options in its `finally` (`:1341`). `/export` reads `state.systemPrompt`, the `agent.state.systemPrompt` getter over the *transcript* (`@earendil-works/pi-agent-core/dist/agent.js:37`), which never held your text — the transcript keeps structured sections instead.

Symptom: the model obeys the rule, the terminal shows nothing, the HTML shows nothing. Cure: use a section.

_Check:_ `python3 $SKILL_DIR/scripts/export_payload.py <file.html>` prints a `systemPrompt` containing your block.

### T2 — `rules` is pi's own section name

`buildSystemPromptSections` wraps every non-preamble section as `<name>…</name>` (`$PI_DIST/core/system-prompt.js:113`). The harness's own tool guidelines are the built-in `rules` section, so a hand-rolled `<rules>` block collides with it inside one prompt.

Ship a distinct name — this repo uses `user-rules`; any name except `rules` and `preamble` works. Set the *body* only; pi writes the wrapper.

_Check:_ the prompt holds exactly one `<rules>` (pi's) and one `<user-rules>` (yours).

### T3 — an invalid section name aborts the send

Names must match `/^[a-z][a-z0-9_-]*$/` and must not be `preamble`, and `buildSystemPromptSections` **throws** `Invalid system prompt section name` (`$PI_DIST/core/system-prompt.js:71-73`). Callers in `agent-session.js` do not catch it, so a typo in a section key kills the whole request rather than dropping the section. The first user message of a session is where you find out.

### T4 — `display: false` hides the message in the export too

The class is applied at render time (`$PI_DIST/core/export-html/template.js:1332`: `entry.display === false` → `hook-message-hidden`), and `showHiddenMessages` starts `false` (`:1822`). A quiet message sits in the payload and stays invisible until the reader clicks "Show hidden messages".

Symptom: "it is not in the HTML" while the data is provably present.

### T5 — the export renders five entry types, and `appendEntry` is not one of them

`renderEntry` (`$PI_DIST/core/export-html/template.js:1195`) handles `message`, `model_change`, `compaction`, `branch_summary`, `custom_message`, then ends `return ''` (`:1338`). A `custom` entry from `pi.appendEntry` — and a `label` entry — render nothing, whatever their `display`.

Do not confuse `renderEntry` with `getSearchableText` (`:335`), which switches over a different type list and falls back to a `[type]` placeholder. Grepping the file for `entry.type ===` lands you in whichever function matched first.

### T6 — grep cannot see into an export

The HTML embeds session data as one base64 blob and renders it client-side, and long sections start collapsed (`.system-prompt-full { display: none }`, `$PI_DIST/core/export-html/template.css:672`). Both `grep` and browser find miss rule text in a fresh export. Decode instead.

### T7 — two export paths, different payloads

TUI `/export` passes the live `AgentState`, so `systemPrompt` is populated (`$PI_DIST/core/export-html/index.js:186`). CLI `pi --export <file>` uses `exportFromFile` and sets `systemPrompt: undefined` (`:214`). The System Prompt block exists only in a TUI export.

### T8 — `--no-session` cannot be exported at all

It builds `SessionManager.inMemory`, and `/export` throws `Cannot export in-memory session to HTML` (`$PI_DIST/core/export-html/index.js:167`).

### T9 — `sendMessage` delivery depends on streaming, not on `triggerTurn` alone

Reading `sendCustomMessage` (`$PI_DIST/core/agent-session.js:1726-1751`) in order:

| State | Options | Effect |
| --- | --- | --- |
| any | `deliverAs: "nextTurn"` | queued for the next user turn |
| streaming | `triggerTurn` not `false` | `agent.steer` / `followUp` — injected into the live run |
| idle | `triggerTurn: true` | runs a **whole extra agent prompt** |
| streaming | `triggerTurn: false` | queued, flushed at `turn_end` (`:771`) — after the tool result, before the next provider request |
| idle | `triggerTurn` omitted | plain append, no extra turn |

So the surprise extra turn needs an explicit `triggerTurn: true` while idle. `{deliverAs:"steer", triggerTurn:false}` is the safe pairing when the agent may or may not be mid-run.

### T10 — raw XML is escaped and visible, not swallowed

Message content renders through `marked.parse` with the `html` and `tag` tokenizers disabled (`$PI_DIST/core/export-html/template.js:1591-1607`, comment: "Treat HTML-like input as plain text so tags are shown verbatim, matching the TUI markdown renderer"). Raw `<user-rules>` in a message comes out as `&lt;user-rules&gt;` inside a paragraph — readable.

Fence XML in messages for legibility, not for survival: `breaks: true` turns each newline into `<br>`, so a fenced block is the only shape that keeps the XML copyable. Raw XML is fine in the system prompt, which is not markdown-rendered.

### T11 — activation never fires when the model picks another tool

Rules keyed on `read`/`edit`/`write` miss a model that reads with `bash cat`. Confirm the real `toolName` in the session JSONL before concluding a feature is broken, and prompt the probe with "use the read tool".

### T12 — scoped frontmatter must start at byte 0

The frontmatter pattern is anchored at `^` with no `m` flag (`$REPO/src/scanner.ts:144`), so a heading above the `---` block silently degrades a scoped rule to unscoped. `head -c 3 <rule>` prints `---` when it is right.

### T13 — driving pi from a script

`RpcClient` needs `cliPath` pointing at `$PI_DIST/bundle/cli.js`; the default `dist/cli.js` resolves relative to the spawn cwd and fails with `MODULE_NOT_FOUND` (`$PI_DIST/modes/rpc/rpc-client.js:31,42`). Its call is `promptAndWait(message, images, timeout)` — pass `undefined` for `images`.

### T14 — sections are diffed, so a section costs nothing when unchanged

`diffSystemPromptSections` returns `undefined` when no section changed (`$PI_DIST/core/system-prompt.js:135-146`), so an unchanged section is not re-sent. `forceSystemPrompt` has no such economy — it replaces the whole prompt on every request. Prefer a section for cache cost as well as for export visibility.

### T15 — `agent_before_settle` appends without forcing another request

`_runBeforeSettleBoundary` commits `result.entries` and continues only when `result.continue` is set or the agent has queued messages (`$PI_DIST/core/agent-session.js:1384-1396`). Returning `{entries: [...]}` is the channel for batching entries at the end of a run; without `continue: true` it adds no provider request.

## Decode an export before claiming anything

```bash
python3 "$SKILL_DIR/scripts/export_payload.py" <export.html>              # system prompt + entry summary
python3 "$SKILL_DIR/scripts/export_payload.py" <export.html> --entries    # every message and custom entry
python3 "$SKILL_DIR/scripts/export_payload.py" <export.html> --grep user-rules
```

Completion criterion: the decoded `systemPrompt` or the listed entries contain the exact text you claim is there. A substring hit on the raw HTML is not evidence — T2 and T6 each manufacture false positives, and reading a switch statement in the wrong function manufactures them too (T5).

## Source of truth

| Claim | Where |
| --- | --- |
| section wrapping, name validation, `diffSystemPromptSections` | `$PI_DIST/core/system-prompt.js` |
| `sections?: Record<string,string>`; sections become `SystemMessage.sections` | `$PI_DIST/core/system-prompt.d.ts` |
| mutable `systemPromptOptions` on `before_agent_start` | `$PI_DIST/core/extensions/types.d.ts:697` |
| forced prompt projection and its clearance | `$PI_DIST/core/agent-session.js:1288,1341` |
| `sendCustomMessage` delivery branches | `$PI_DIST/core/agent-session.js:1726-1751` |
| `_pendingCustomMessages` flushed at turn end | `$PI_DIST/core/agent-session.js:771` |
| settle boundary, entries without continuation | `$PI_DIST/core/agent-session.js:1384` |
| export payload shape, `exportFromFile`, in-memory refusal | `$PI_DIST/core/export-html/index.js:167,186,214` |
| rendered entry types, hidden-message class and default | `$PI_DIST/core/export-html/template.js:1195,1332,1822` |
| markdown config that keeps tags verbatim | `$PI_DIST/core/export-html/template.js:1591` |
| `state.systemPrompt` is a transcript getter | `@earendil-works/pi-agent-core/dist/agent.js:37` |

## Keep this honest

Line numbers drift on every pi upgrade. `pnpm check:pi-dist` (`scripts/check-pi-dist-contract.mjs`) asserts the behaviour this repo depends on by importing pi's own modules and calling them — section wrapping for the shipped name, invalid-name rejection, unchanged-section diffing, the forced prompt carrying no sections, live-versus-file export payloads, and the hidden-message markers. It fails loudly on drift instead of silently losing the record.

Run it after a pi upgrade, then correct the line numbers above. The marker checks at the end of that script read the export template as text, so they are drift alarms rather than proofs.
