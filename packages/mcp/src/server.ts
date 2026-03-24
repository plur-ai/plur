import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Plur, checkForUpdate } from '@plur-ai/core'
import { getToolDefinitions } from './tools.js'

const VERSION = '0.2.6'

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
    { capabilities: { tools: {} } },
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
