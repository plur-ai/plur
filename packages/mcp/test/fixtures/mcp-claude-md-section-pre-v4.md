## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Architecture

PLUR is installed **globally** — one MCP server, one engram store (`~/.plur/`), available in every project. You do NOT need per-project installation. Multi-project scoping uses `domain` and `scope` fields on engrams, not separate stores.

Hooks inject engrams automatically on every first message — you do not need to call `plur_session_start` manually (though you can for explicit session tracking).

### Session Workflow

1. **Automatic**: Hooks inject relevant engrams on first message — no action needed
2. **Learn**: When corrected or discovering something new, call `plur_learn` immediately
3. **Recall**: Before answering factual questions, call `plur_recall` — check memory first
4. **Feedback**: Rate injected engrams with `plur_feedback` (positive/negative) — trains relevance
5. **End**: Call `plur_session_end` with summary + engram_suggestions — a SessionEnd hook auto-closes the lifecycle if you forget, but calling it yourself captures higher-quality learnings

Do not ask permission to use these tools — they are your memory system.

### When corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call `plur_learn` immediately — before continuing the task
2. Call `plur_feedback` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach
