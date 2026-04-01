import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { Plur, checkForUpdate } from '@plur-ai/core'
import { getToolDefinitions } from './tools.js'
import { z } from 'zod'

const VERSION = '0.5.3'

const INSTRUCTIONS = `PLUR is your persistent memory. Corrections, preferences, and conventions persist across sessions as engrams.

REQUIRED at session boundaries:
- FIRST ACTION of every session: call plur_session_start with a task description
- LAST ACTION before conversation ends: call plur_session_end with summary + engram_suggestions

REQUIRED during the session:
- When user corrects you ("no, use X not Y") → call plur_learn immediately
- When user states a preference ("always X", "never Y") → call plur_learn immediately
- When you discover a codebase convention or pattern → call plur_learn

OPTIONAL but improves quality:
- Call plur_feedback to rate which injected engrams helped (positive/negative)
- Call plur_recall_hybrid before answering factual questions — the answer may be in memory

Do not ask permission to use these tools — they are your memory system.

Setup: If this is a fresh install, suggest the user run: npx @plur-ai/cli init
This installs Claude Code hooks for automatic engram injection. Without hooks, injection only happens when you call plur_session_start.`

const GUIDE_RESOURCE = `# PLUR — Agent Guide

## What is PLUR?

Persistent memory for AI agents. Corrections, preferences, and conventions are stored as **engrams** — small assertions that strengthen with use and decay when irrelevant (ACT-R model). Storage is plain YAML on disk. Search is fully local (BM25 + embeddings). Zero API calls.

## Quick Start

1. \`plur_session_start\` — start a session, inject relevant context
2. \`plur_learn\` — store a new learning
3. \`plur_feedback\` — rate injected engrams
4. \`plur_session_end\` — capture summary and new learnings

## When to Call Each Tool

| Trigger | Tool |
|---------|------|
| Session starts | \`plur_session_start\` with task description |
| User corrects you | \`plur_learn\` with the correction |
| User states preference ("always X", "never Y") | \`plur_learn\` with scope and type |
| You used a recalled engram successfully | \`plur_feedback\` with "positive" |
| A recalled engram was wrong or irrelevant | \`plur_feedback\` with "negative" |
| User says "forget X" or a memory is outdated | \`plur_forget\` |
| You need to check what's stored | \`plur_status\` or \`plur_packs_list\` |
| End of session | \`plur_session_end\` with summary and suggestions |

## Tool Categories

### Session Management
- **plur_session_start** — start a session, inject relevant context
- **plur_session_end** — end a session, capture summary and new learnings

### Core Memory
- **plur_learn** — store a correction, preference, or convention
- **plur_recall** — BM25 keyword search
- **plur_recall_hybrid** — BM25 + embeddings (recommended default)
- **plur_feedback** — rate an engram (trains relevance)
- **plur_forget** — retire an outdated engram
- **plur_promote** — activate a candidate engram

### Context Injection
- **plur_inject** — select engrams for a task (BM25)
- **plur_inject_hybrid** — select engrams for a task (BM25 + embeddings, recommended)

### Episodic Timeline
- **plur_capture** — record what happened in a session
- **plur_timeline** — query past episodes

### Knowledge Management
- **plur_ingest** — extract engrams from text content
- **plur_packs_install** — install curated engram packs
- **plur_packs_list** — list installed packs
- **plur_packs_export** — export engrams as a shareable pack

### Multi-Store
- **plur_stores_add** — register an additional engram store
- **plur_stores_list** — list all configured stores

**Note:** Multi-store is currently config-only. Recall and inject search the primary store. Cross-store search coming in a future release.

### Sync & Status
- **plur_sync** — sync engrams across devices via git
- **plur_sync_status** — check sync state
- **plur_status** — system health

## Scoping

Use \`scope\` to namespace engrams per project:
- \`scope: "global"\` — applies everywhere (default)
- \`scope: "project:my-app"\` — applies only to my-app
- Scoped recall automatically includes global engrams

## Storage

\`\`\`
~/.plur/
├── engrams.yaml     # learned knowledge
├── episodes.yaml    # session timeline
└── config.yaml      # settings
\`\`\`

Override with \`PLUR_PATH\` environment variable.
`

export async function createServer(plur?: Plur): Promise<Server> {
  const instance = plur ?? new Plur()
  const tools = getToolDefinitions()

  // Non-blocking version check — fire and forget
  checkForUpdate('@plur-ai/mcp', VERSION, (r) => {
    if (r.updateAvailable) {
      console.error(`[plur] Update available: ${r.current} → ${r.latest}. Run: npx @plur-ai/mcp@latest`)
    }
  })

  const server = new Server(
    { name: 'plur-mcp', version: VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
      },
      instructions: INSTRUCTIONS,
    },
  )

  // --- Tools ---

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations && { annotations: t.annotations }),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find(t => t.name === request.params.name)
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      }
    }
    try {
      // Validate arguments against input schema
      const args = request.params.arguments ?? {}
      const schema = tool.inputSchema as any
      if (schema?.properties) {
        const shape: Record<string, z.ZodTypeAny> = {}
        for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
          let field: z.ZodTypeAny
          if (prop.type === 'string') field = prop.enum ? z.enum(prop.enum) : z.string()
          else if (prop.type === 'number') field = z.number()
          else if (prop.type === 'boolean') field = z.boolean()
          else if (prop.type === 'array') field = z.array(z.unknown())
          else field = z.unknown()
          shape[key] = schema.required?.includes(key) ? field : field.optional()
        }
        const parsed = z.object(shape).passthrough().safeParse(args)
        if (!parsed.success) {
          return {
            content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}` }],
            isError: true,
          }
        }
      }
      const result = await tool.handler(args, instance)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err: any) {
      const message = err?.message ?? String(err)
      server.sendLoggingMessage({ level: 'error', data: `Tool ${request.params.name} failed: ${message}` })
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      }
    }
  })

  // --- Resources ---

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'plur://guide',
        name: 'PLUR Agent Guide',
        description: 'Complete reference for all PLUR tools, when to use them, scoping, and storage',
        mimeType: 'text/markdown',
      },
      {
        uri: 'plur://status',
        name: 'PLUR Status',
        description: 'Live system health — engram count, episode count, pack count, storage path',
        mimeType: 'application/json',
      },
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri

    if (uri === 'plur://guide') {
      return {
        contents: [{
          uri: 'plur://guide',
          mimeType: 'text/markdown',
          text: GUIDE_RESOURCE,
        }],
      }
    }

    if (uri === 'plur://status') {
      const status = instance.status()
      return {
        contents: [{
          uri: 'plur://status',
          mimeType: 'application/json',
          text: JSON.stringify({
            engram_count: status.engram_count,
            episode_count: status.episode_count,
            pack_count: status.pack_count,
            storage_root: status.storage_root,
            version: VERSION,
          }, null, 2),
        }],
      }
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`)
  })

  // --- Prompts ---

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'plur-getting-started',
        description: 'Step-by-step guide to set up and start using PLUR memory',
      },
      {
        name: 'plur-session-start',
        description: 'Load relevant context for a task — call at the start of each session',
        arguments: [
          { name: 'task', description: 'Brief description of the task or goal', required: true },
          { name: 'scope', description: 'Project scope (e.g. project:my-app)', required: false },
        ],
      },
    ],
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name

    if (name === 'plur-getting-started') {
      const status = instance.status()
      return {
        description: 'Get started with PLUR memory',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I just set up PLUR. Here's my current status:

- Engrams stored: ${status.engram_count}
- Episodes recorded: ${status.episode_count}
- Packs installed: ${status.pack_count}
- Storage: ${status.storage_root}

${status.engram_count === 0
  ? `I have no memories yet. Help me get started by:
1. Teaching me a coding preference or convention (I'll use plur_learn)
2. Then recalling it to verify it works (I'll use plur_recall_hybrid)
3. Rating the recall quality (I'll use plur_feedback)`
  : `I have ${status.engram_count} engrams stored. Try asking me something related to your project — I'll check my memory first.`}`,
          },
        }],
      }
    }

    if (name === 'plur-session-start') {
      const task = request.params.arguments?.task ?? 'general work'
      const scope = request.params.arguments?.scope
      return {
        description: 'Load relevant context for this session',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Starting a new session. Task: ${task}${scope ? ` (scope: ${scope})` : ''}

Please:
1. Call plur_recall_hybrid with query "${task}"${scope ? ` and scope "${scope}"` : ''} to load relevant memories
2. Review the recalled engrams and apply any relevant conventions or preferences
3. If any recalled engrams are helpful, call plur_feedback with "positive"
4. If any are irrelevant, call plur_feedback with "negative"`,
          },
        }],
      }
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`)
  })

  return server
}

export async function runStdio(): Promise<void> {
  const server = await createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
