## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Architecture

PLUR is installed **globally** — one MCP server, one engram store (`~/.plur/`), available in every project. You do NOT need per-project installation. The `plur` MCP server provides tools named `plur_session_start`, `plur_learn`, `plur_recall`, `plur_feedback`, `plur_session_end`, etc. If you cannot find these tools, run `plur doctor` to diagnose. Do **not** substitute tools from other MCP servers (e.g. `datacore_*`) — those belong to a different system.

A PreToolUse guard enforces that `plur_session_start` is called at the beginning of every session. All other tools are blocked until this is done. The flow is: ToolSearch to load `plur_session_start` → call it with a task description → proceed.

### Session Workflow

1. **Start**: Call `plur_session_start` with task description — enforced by guard hook
2. **Learn**: When corrected or discovering something new, call `plur_learn` immediately
3. **Recall**: Before answering factual questions, call `plur_recall` — check memory first
4. **Feedback**: Rate injected engrams with `plur_feedback` (positive/negative) — trains relevance
5. **End**: Call `plur_session_end` with summary + engram_suggestions — a SessionEnd hook auto-closes the lifecycle if you forget, but calling it yourself captures higher-quality learnings

Do not ask permission to use these tools — they are your memory system.

### Scope selection (set scope PER engram, by content)

PLUR uses `domain` and `scope` fields to separate knowledge. **Set `scope` on every `plur_learn` call, chosen by the engram's content** — a single session legitimately spans multiple scopes. Scoped recall automatically includes global engrams.

- **Team / shared knowledge** (engineering patterns, architecture decisions, project conventions) → the matching team scope (e.g. `group:<org>/<team>`). `plur_session_start` lists the remote scopes your token can write to.
- **This project's details** → `project:<name>` (a `.plur.yaml` with `scope:` makes this the default).
- **Personal preferences / your own workflow** → leave at the default / local scope.
- **Do NOT omit `scope` for team-relevant knowledge** — it falls back to `global`, which appears in every project's future sessions AND never reaches the team store. Prefer the project/local default over `global`; reserve `global` for genuinely cross-project facts (language gotchas, tool quirks).

### When to check memory

Before reaching for web search, file reads, or guessing — apply this priority:
1. Is the answer already in engrams? → `plur_recall`
2. Is the answer in the local filesystem? → Read/Grep/Glob
3. Is the answer derivable from context already loaded? → Just answer
4. Only if 1-3 fail → Use external tools

### When corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call `plur_learn` immediately — before continuing the task
2. Call `plur_feedback` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach
