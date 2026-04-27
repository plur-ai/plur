/**
 * HTTP/SSE Transport for PLUR MCP Server
 *
 * Enables centralized PLUR deployment for teams/enterprise.
 * Phase 1: Pre-provisioned bearer tokens, multiple concurrent connections.
 *
 * Usage:
 *   PLUR_HTTP_PORT=3000 PLUR_AUTH_TOKENS=token1,token2 plur-mcp --http
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http'
import { parse as parseUrl } from 'url'
import { createServer as createPlurServer } from './server.js'
import { Plur } from '@plur-ai/core'

const DEFAULT_PORT = 3000
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

interface HttpTransportConfig {
  port?: number
  tokens?: string[]  // Pre-provisioned bearer tokens for Phase 1 auth
  plur?: Plur
}

/**
 * Validate bearer token from Authorization header
 */
function validateAuth(req: IncomingMessage, validTokens: string[]): boolean {
  if (validTokens.length === 0) return true  // No auth configured = allow all (dev mode)

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return false

  const token = authHeader.slice(7)
  return validTokens.includes(token)
}

/**
 * Send JSON response
 */
function jsonResponse(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS })
  res.end(JSON.stringify(body))
}

/**
 * Start HTTP/SSE server for PLUR MCP
 *
 * Endpoints:
 *   GET  /health          - Health check (no auth)
 *   GET  /sse             - SSE connection (auth required)
 *   POST /message         - Send message to server (auth required)
 */
export async function runHttpTransport(config: HttpTransportConfig = {}): Promise<void> {
  const port = config.port ?? parseInt(process.env.PLUR_HTTP_PORT ?? String(DEFAULT_PORT))
  const tokens = config.tokens ?? (process.env.PLUR_AUTH_TOKENS?.split(',').filter(Boolean) ?? [])

  const plur = config.plur ?? new Plur()
  const mcpServer = await createPlurServer(plur)

  // Track active SSE connections
  const connections = new Map<string, SSEServerTransport>()
  let connectionCounter = 0

  const httpServer = createHttpServer(async (req, res) => {
    const { pathname } = parseUrl(req.url ?? '/')

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    // Health check (no auth)
    if (pathname === '/health' && req.method === 'GET') {
      const status = plur.status()
      jsonResponse(res, 200, {
        ok: true,
        version: '0.9.3',
        engram_count: status.engram_count,
        connections: connections.size,
      })
      return
    }

    // Auth required for SSE and message endpoints
    if (!validateAuth(req, tokens)) {
      jsonResponse(res, 401, { error: 'Unauthorized', hint: 'Include Authorization: Bearer <token>' })
      return
    }

    // SSE connection
    if (pathname === '/sse' && req.method === 'GET') {
      const connectionId = `conn-${++connectionCounter}`

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...CORS_HEADERS,
      })

      const transport = new SSEServerTransport('/message', res)
      connections.set(connectionId, transport)

      console.error(`[plur-http] Client connected: ${connectionId} (${connections.size} active)`)

      // Handle disconnect
      req.on('close', () => {
        connections.delete(connectionId)
        console.error(`[plur-http] Client disconnected: ${connectionId} (${connections.size} active)`)
      })

      // Connect MCP server to this transport
      await mcpServer.connect(transport)
      return
    }

    // Message endpoint (for SSE clients to send requests)
    if (pathname === '/message' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          // The SSE transport handles routing messages to the right connection
          // This endpoint just acknowledges receipt
          jsonResponse(res, 200, { received: true })
        } catch (err: any) {
          jsonResponse(res, 500, { error: err.message })
        }
      })
      return
    }

    // 404 for unknown routes
    jsonResponse(res, 404, { error: 'Not found', endpoints: ['/health', '/sse', '/message'] })
  })

  httpServer.listen(port, () => {
    console.error(`[plur-http] PLUR MCP server listening on http://localhost:${port}`)
    console.error(`[plur-http] Auth: ${tokens.length > 0 ? `${tokens.length} tokens configured` : 'DISABLED (dev mode)'}`)
    console.error(`[plur-http] Endpoints: GET /health, GET /sse, POST /message`)
  })

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.error('\n[plur-http] Shutting down...')
    httpServer.close()
    process.exit(0)
  })
}
