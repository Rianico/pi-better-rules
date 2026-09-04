# Pi lifecycle facts

Type: research
Status: resolved
Blocked by: none

## Question

What are Pi's actual extension-lifecycle facts for rules injection — `session_start` (including `reason: reload`), `before_agent_start` (`systemPrompt` chaining), `session_before_compact` / compaction entry behavior, and `/reload` semantics — and do they confirm or refute the assumption that compaction leaves the system prompt alone and system rules load only once?

Resolve with evidence from Pi docs (`extensions.md`, `compaction.md`) and, where docs are thin, the pi-mono source (`compaction.ts`, `session-manager.ts`, extension types). Record: which events fire on startup / `/reload` / fork / resume / compaction; whether `before_agent_start` re-runs per turn (so what "load only once" must mean in code — cache vs re-inject); how an extension distinguishes `reason: reload` to skip rescanning; what survives compaction and what must be re-injected.

## Answer

Full brief: [01-pi-lifecycle-brief.md](../assets/01-pi-lifecycle-brief.md).

Distilled findings (evidence: pi `extensions.md`, `compaction.md`, `dist/core/*.js`, extension types):

- `before_agent_start` runs once per user prompt (agent-run preflight), not per inner turn; its `systemPrompt` override is ephemeral — every prompt must return it again. Cache the fs scan in module state at `session_start`; keep the handler to cheap string concat.
- Compaction never touches the system prompt (assumption 6 CONFIRMED): it summarizes the entry/message list into a `CompactionEntry`; the system prompt is held separately (`agent.state.systemPrompt`). But per-prompt injections are not stored — they must be re-applied each prompt, which is exactly the general-tier re-load requirement.
- `/reload` tears down the runtime (`session_shutdown{reload}`) and re-runs the factory + `session_start{reload}` + `resources_discover{reload}`. Skip rescan with `if (event.reason === "reload") return;` keeping cached rules; rescan on `startup|new|resume|fork`. `/compact` fires no start/shutdown events and does not reload extensions — in-memory cache survives it.
- Survives compaction: session entries, summary chain, extension module state. Must re-inject per prompt: `systemPrompt` override and `message` injection.
