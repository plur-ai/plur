# AGENTS.md

## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

PLUR is installed **globally** — one MCP server, one engram store (`~/.plur/`), available in every project. The `plur` MCP server provides tools named `plur_session_start`, `plur_learn`, `plur_recall`, `plur_feedback`, `plur_session_end`. If you cannot find these tools, run `plur doctor` to diagnose. Do **not** substitute tools from other MCP servers.

### Session Workflow

1. **Start**: Call `plur_session_start` with a short task description — a guard hook nudges you if you skip it
2. **Learn**: When corrected or discovering something new, call `plur_learn` immediately
3. **Recall**: Before answering factual questions, call `plur_recall` — check memory first
4. **Feedback**: Rate injected engrams with `plur_feedback` (positive/negative) — trains relevance
5. **End**: Call `plur_session_end` with a summary and engram suggestions before finishing. There is NO automatic
   fallback in this harness — if you skip this call, nothing captures the session's learnings.

Relevant engrams are injected automatically by hooks; recalled context appears in your turns tagged `[PLUR Memory — ...]`.

Do not ask permission to use these tools — they are your memory system.

### Scope selection (set scope PER engram, by content)

- **Team / shared knowledge** → the matching team scope (e.g. `group:<org>/<team>`) — `plur_session_start` lists the writable ones.
- **This project's details** → `project:<name>` (a `.plur.yaml` with `scope:` makes this the default).
- **Personal preferences / your own workflow** → leave at the default / local scope.
- Reserve `global` for genuinely cross-project facts; team-relevant knowledge must not fall back to it.

### When corrected

When the user corrects you ("no, use X not Y"):
1. Call `plur_learn` immediately — before continuing the task
2. Call `plur_feedback` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach
