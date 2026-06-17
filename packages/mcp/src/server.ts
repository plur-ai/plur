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
import { registerFlushOnExit } from './telemetry.js'
import { VERSION } from './version.js'
import { z } from 'zod'

const INSTRUCTIONS = `PLUR is your persistent memory. Corrections, preferences, and conventions persist across sessions as engrams.

PLUR is a GLOBAL tool — one MCP server, one engram store (~/.plur/), available in every project. Multi-project scoping uses domain/scope fields on engrams, not separate installations.

SESSION LIFECYCLE:
- With hooks installed (plur init): engrams are injected automatically on first message. You do NOT need to call plur_session_start — it happens via hooks. Just call plur_session_end before the conversation ends.
- Without hooks: call plur_session_start at the start, plur_session_end at the end.

DURING the session:
- When user corrects you ("no, use X not Y") → call plur_learn immediately
- When user states a preference ("always X", "never Y") → call plur_learn immediately
- When you discover a codebase convention or pattern → call plur_learn

OPTIONAL but improves quality:
- Call plur_feedback to rate which injected engrams helped (positive/negative)
- Call plur_recall_hybrid before answering factual questions — the answer may be in memory

Do not ask permission to use these tools — they are your memory system.

Setup: If this is a fresh install, suggest the user run: npx @plur-ai/mcp init
This installs hooks for automatic injection + session management. One-time global setup.`

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

// Recursive JSON-Schema → Zod converter for tool input validation.
// Handles nested array items + anyOf/oneOf so callers can't pass strings
// where objects are expected (issue #231). When the schema allows multiple
// item shapes via anyOf, the handler is expected to coerce — see tools.ts
// session_end handler for an example.
function jsonSchemaPropToZod(prop: any): z.ZodTypeAny {
  if (!prop || typeof prop !== 'object') return z.unknown()
  const variants = (prop.anyOf as any[] | undefined) ?? (prop.oneOf as any[] | undefined)
  if (Array.isArray(variants) && variants.length > 0) {
    const zodVariants = variants.map(jsonSchemaPropToZod)
    if (zodVariants.length === 1) return zodVariants[0]
    // z.union requires a 2+ tuple at the type level. We've guaranteed >= 2
    // via the length check above, so the cast carries a real invariant.
    return z.union(zodVariants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
  if (prop.type === 'string') return prop.enum ? z.enum(prop.enum) : z.string()
  if (prop.type === 'number' || prop.type === 'integer') return z.number()
  if (prop.type === 'boolean') return z.boolean()
  if (prop.type === 'array') {
    const itemSchema = prop.items ? jsonSchemaPropToZod(prop.items) : z.unknown()
    return z.array(itemSchema)
  }
  if (prop.type === 'object' && prop.properties) {
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [k, p] of Object.entries(prop.properties) as [string, any][]) {
      const field = jsonSchemaPropToZod(p)
      shape[k] = prop.required?.includes(k) ? field : field.optional()
    }
    return z.object(shape).passthrough()
  }
  return z.unknown()
}

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
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${request.params.name}`, success: false }) }],
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
          const field = jsonSchemaPropToZod(prop)
          shape[key] = schema.required?.includes(key) ? field : field.optional()
        }
        const parsed = z.object(shape).passthrough().safeParse(args)
        if (!parsed.success) {
          // Echo field NAMES only, never values (#281). Values may contain
          // engram content (statements, rationale) — echoing them would leak
          // memory content into client error logs. Keep this names-only.
          const receivedFields = Object.keys(args)
          const details = parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join(', ')
          const receivedInfo = receivedFields.length > 0
            ? `Received fields: [${receivedFields.join(', ')}].`
            : 'No fields received.'
          return {
            content: [{ type: 'text', text: JSON.stringify({
              error: `Invalid arguments: ${details}. ${receivedInfo}`,
              success: false,
              received_fields: receivedFields,
            }) }],
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
        content: [{ type: 'text', text: JSON.stringify({ error: message, success: false }) }],
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
  // Opt-in, content-free telemetry: ship any pending daily counter snapshot on
  // process exit (best-effort). Self-gates on telemetry opt-in — an opted-out
  // install registers the handler but flushes nothing. Registered in runStdio,
  // not createServer, so the per-test servers in the suite don't each attach a
  // beforeExit handler.
  registerFlushOnExit({})
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
