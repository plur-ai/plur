import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Plur, checkForUpdate } from '@plur-ai/core'
import { getToolDefinitions } from './tools.js'

const VERSION = '0.2.9'

const INSTRUCTIONS = `PLUR is your persistent memory. It stores corrections, preferences, and conventions as engrams that persist across sessions.

Use PLUR proactively:
- Call plur_recall_hybrid at session start to load relevant context for the current task
- Call plur_learn when the user corrects you, states a preference ("always use X", "never do Y"), or when you discover a project convention
- Call plur_feedback after using recalled engrams to train relevance
- Call plur_status to check system health and engram counts

You do not need permission to use these tools — they are your memory system.`

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
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
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
      const result = await tool.handler(request.params.arguments ?? {}, instance)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      }
    }
  })

  return server
}

export async function runStdio(): Promise<void> {
  const server = await createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
