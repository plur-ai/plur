// An MCP client wired to an in-process PLUR MCP server built from SOURCE
// (packages/mcp/src), so a planted bug there takes effect without a rebuild.
// The agent's view of the tools is exactly what crosses this wire.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @modelcontextprotocol/* are dependencies of packages/mcp only; the eval
// folder cannot resolve them by bare name, so they are imported by path.
import { Client } from '../../packages/mcp/node_modules/@modelcontextprotocol/client/dist/index.mjs'
import { InMemoryTransport } from '../../packages/mcp/node_modules/@modelcontextprotocol/server/dist/index.mjs'
import { Plur } from '../../packages/core/src/index.js'
import { createServer } from '../../packages/mcp/src/server.js'

export interface McpSession {
  client: InstanceType<typeof Client>
  plur: Plur
  dir: string
  /** Call a tool over the wire; returns the text payload, parsed when it is JSON. */
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }>
  close(): Promise<void>
}

export async function mcpSession(opts: { profile?: 'lean' | 'full' | 'cursor'; config?: string } = {}): Promise<McpSession> {
  const dir = mkdtempSync(join(tmpdir(), 'plur-eval-mcp-'))
  writeFileSync(join(dir, 'config.yaml'), opts.config ?? 'backend: yaml\n')
  // The server's workspace is its cwd (no client roots here): turn memory on
  // for it in the folder map, as a user who answered "yes" has.
  writeFileSync(join(dir, 'folders.yaml'),
    `version: 1\nfolders:\n  - path: ${JSON.stringify(process.cwd())}\n    plur: on\n`)
  const plur = new Plur({ path: dir, autoDiscover: false })
  await plur.ready()
  const server = await createServer(plur as any, { profile: opts.profile ?? 'lean' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'promise-eval', version: '1.0.0' })
  await client.connect(clientTransport)
  return {
    client, plur, dir,
    async call(name, args = {}) {
      const res: any = await client.callTool({ name, arguments: args })
      const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n')
      let json: any = null
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      return { isError: res.isError === true, text, json }
    },
    async close() {
      await client.close().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
