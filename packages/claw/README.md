# @plur-ai/claw

OpenClaw plugin that adds persistent memory to every agent session.

```bash
npm install @plur-ai/claw
```

Register in your OpenClaw plugin config:

```json
{
  "plugins": ["@plur-ai/claw"]
}
```

That's it. Every agent session now has memory that survives across restarts.

## What Happens Automatically

**On session start (bootstrap):** Engrams from previous sessions are loaded and scoped to the current session key.

**On every turn (assemble):** The most recent user message is used as a query. Relevant engrams are injected into the agent's context, ranked by relevance and activation strength, within the token budget.

**During the conversation (ingest):** User messages are scanned in real time for corrections and explicit preferences. High-confidence learnings (>=0.7) are saved immediately.

**After each turn (afterTurn):** The agent's response is scanned for a `🧠 I learned:` section — self-reported learnings are saved. A regex fallback also extracts learnings from user messages. The turn is summarized and appended to the episodic timeline.

**During compaction (compact):** Before context is compacted, learnings are extracted from accumulated messages so nothing is lost.

**On subagent spawn:** Child agents inherit the parent session's scope, so sub-tasks share the same memory namespace.

## SYSTEM.md Setup

On first run, the plugin appends a `## PLUR Memory System` section to the workspace `SYSTEM.md`. This teaches the agent how to use PLUR tools (`plur.recall`, `plur.learn`, `plur.forget`, `plur.status`) and the `🧠 I learned:` reporting format. The section is only appended once and never overwrites existing content.

For this to work, `@plur-ai/mcp` must also be configured as an MCP server in OpenClaw so the agent has access to the PLUR tools.

## Configuration

```typescript
import { PlurContextEngine } from '@plur-ai/claw'

new PlurContextEngine({
  path: '/custom/storage/path',  // default: ~/Plur/
  auto_learn: true,              // extract and save learnings automatically (default: true)
  auto_capture: true,            // record episodic summaries after each turn (default: true)
  injection_budget: 2000,        // token budget for engram injection (default: 2000)
})
```

## With the MCP Server

`@plur-ai/claw` handles automatic memory operations (inject, capture, learn on corrections). `@plur-ai/mcp` gives the agent explicit memory tools to call when it decides to. Use both together:

- The plugin handles the automatic memory lifecycle
- The MCP tools let the agent actively store and query memory when needed

Configure `@plur-ai/mcp` alongside the plugin:

```json
{
  "mcpServers": {
    "plur": { "command": "plur-mcp" }
  },
  "plugins": ["@plur-ai/claw"]
}
```

## License

Apache-2.0
