# Rule locations and precedence

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Decide discovery and precedence for `~/.pi/agent/rules` (global) and `.pi/rules` (project): recursive scan? subdirectories? symlinks? filename conventions? What wins on name collision — project over global? How do gitignored or untracked project rules behave? What is the exact precedence order (global < project, then what — alphabetical, directory order)?

Needs the Pi lifecycle facts and the Claude rules semantics to borrow or drop first, so the answers fit what Pi can actually do and what Claude proved worth copying. HITL: grill with the human; call the Skill tool for `grilling` and `domain-modeling`.

## Answer

Accepted 2026-09-04 (round 1): recursive `**/*.md` scan of both locations; load global first, project second, concatenate, project wins; identical relative paths shadow (project replaces global, no merge); symlinks resolved with cycle guard. Open ordering detail (alphabetical vs directory order) and gitignored-rule behavior pass to the spec author as edge cases.
