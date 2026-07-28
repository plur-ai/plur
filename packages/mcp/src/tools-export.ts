/**
 * Side-effect-free subpath export: @plur-ai/mcp/tools
 *
 * Importable without starting the MCP server or parsing process.argv.
 * Use this to access PLUR's tool surface — names, descriptions, input schemas
 * — from a consumer that re-exposes or validates the definitions without
 * running the server.
 */
export type { ToolAnnotations, ToolDefinition, ToolProfile } from './tools.js'
export { getToolDefinitions, CURSOR_CORE_TOOL_NAMES, validateToolArgs } from './tools.js'

import type { ToolAnnotations, ToolProfile } from './tools.js'
import { getToolDefinitions } from './tools.js'

/** Tool definition without the runtime handler — plain data, safe to serialize. */
export interface ToolSchema {
  name: string
  description: string
  inputSchema: { type: 'object'; [key: string]: unknown }
  annotations?: ToolAnnotations
}

/**
 * Return tool definitions as plain, handler-free schema objects.
 *
 * Useful when you need the MCP tool surface — name, description, and input
 * schema — without the runtime handlers that require a live Plur instance.
 * A downstream consumer that re-exposes a filtered subset can import this
 * list and keep its copy in sync without duplicating schemas.
 */
export function getToolSchemas(profile?: ToolProfile): ToolSchema[] {
  return getToolDefinitions(profile).map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    ...(annotations !== undefined ? { annotations } : {}),
  }))
}
