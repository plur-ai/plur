# PLUR — Shared Memory for AI Agents

Persistent, learnable, exchangeable memory for any AI agent.

## Packages

| Package | Description |
|---------|-------------|
| [@plur-ai/core](packages/core/) | Engram engine — learn, recall, inject, feedback |
| [@plur-ai/mcp](packages/mcp/) | MCP server — Model Context Protocol adapter |
| @plur-ai/claw | OpenClaw ContextEngine plugin (coming soon) |

## Quick Start

```bash
npm install @plur-ai/core
```

```typescript
import { Plur } from '@plur-ai/core'

const plur = new Plur()
plur.learn('API uses snake_case', { scope: 'project:myapp' })
const result = plur.inject('fix the API endpoint')
console.log(result.directives)
```

## As MCP Server

```bash
npm install -g @plur-ai/mcp
```

Add to your MCP config:
```json
{ "mcpServers": { "plur": { "command": "plur-mcp" } } }
```

## License

MIT
