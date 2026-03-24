# @plur-ai/claw

OpenClaw plugin that gives every agent persistent memory — automatically.

```bash
npm install @plur-ai/claw
```

```json
{
  "plugins": ["@plur-ai/claw"]
}
```

That's it. Every agent session now remembers what happened before.

## What happens automatically

**On session start:** Relevant engrams from past sessions are injected into the agent's context, ranked by relevance and activation strength, within the token budget.

**During conversation:** User messages are scanned for corrections and preferences. High-confidence learnings are saved automatically.

**After each turn:** The agent's response is scanned for a `🧠 I learned:` section. The turn is summarized and appended to the episodic timeline.

**During compaction:** Before context is compacted, learnings are extracted so nothing is lost.

**On subagent spawn:** Child agents inherit the parent session's scope.

## With the MCP server

The plugin handles the automatic memory lifecycle. For explicit memory tools the agent can call on demand (`plur.learn`, `plur.recall`, `plur.sync`), add `@plur-ai/mcp` alongside:

```json
{
  "mcpServers": {
    "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
  },
  "plugins": ["@plur-ai/claw"]
}
```

## SYSTEM.md setup

On first run, the plugin appends memory instructions to the workspace `SYSTEM.md`. This teaches the agent the `🧠 I learned:` format and how to use PLUR tools. The section is appended once and never overwrites existing content.

## Configuration

```typescript
import { PlurContextEngine } from '@plur-ai/claw'

new PlurContextEngine({
  path: '/custom/storage/path',  // default: ~/.plur/
  auto_learn: true,              // extract learnings automatically (default: true)
  auto_capture: true,            // record episodic summaries (default: true)
  injection_budget: 2000,        // token budget for engram injection (default: 2000)
})
```

## Update notifications

On startup, the plugin checks npm for newer versions. If an update is available, it appears in the agent's context so the agent can inform the user. No overhead during conversation — the check runs once, the assembler reads a cached flag.

## License

Apache-2.0
