// The PLUR MCP server driven in-process for the folders evals (slice
// privacy-folders-team): a real MCP client over a linked in-memory transport,
// the folder map written as a user would, and a hash snapshot of a directory
// tree to prove nothing was written.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
// The MCP SDK is a dependency of packages/mcp only, so it is imported from there.
import { Client } from '../../packages/mcp/node_modules/@modelcontextprotocol/client/dist/index.mjs'
import { InMemoryTransport } from '../../packages/mcp/node_modules/@modelcontextprotocol/server/dist/index.mjs'
import { createServer } from '../../packages/mcp/src/server.js'
import type { Plur } from '../../packages/core/src/index.js'

export interface McpCall { raw: any; text: string; json: any }

/**
 * Keep the evals off the internet: the MCP server checks npm for updates when
 * it starts. Requests to 127.0.0.1 (the stub team server) pass; anything else
 * is recorded in the returned list and fails as if offline. Call the returned
 * `restore` in afterEach.
 */
export function offlineFetch(): { external: string[]; restore(): void } {
  const real = globalThis.fetch
  const external: string[] = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input)
    if (url.startsWith('http://127.0.0.1')) return real(input, init)
    external.push(url)
    throw new TypeError('fetch failed: evals are offline')
  }) as typeof globalThis.fetch
  return { external, restore: () => { globalThis.fetch = real } }
}

/** Connect a client to a fresh PLUR MCP server for `plur`. `roots` = the editor's workspace folders. */
export async function connectMcp(plur: Plur, opts: { profile?: 'full' | 'lean'; roots?: string[] } = {}): Promise<{ client: any; close(): Promise<void> }> {
  const server = await createServer(plur as any, { profile: opts.profile ?? 'full' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: 'plur-evals', version: '1.0.0' },
    opts.roots ? { capabilities: { roots: { listChanged: true } } } : undefined,
  )
  if (opts.roots) {
    const roots = opts.roots
    client.setRequestHandler('roots/list', async () => ({ roots: roots.map(r => ({ uri: pathToFileURL(r).href, name: 'ws' })) }))
  }
  await client.connect(clientTransport)
  return { client, close: async () => { await client.close().catch(() => {}) } }
}

export async function callTool(client: any, name: string, args: Record<string, unknown> = {}): Promise<McpCall> {
  const raw = await client.callTool({ name, arguments: args })
  const text = String((raw.content as any)?.[0]?.text ?? '')
  let json: any
  try { json = JSON.parse(text) } catch { json = undefined }
  return { raw, text, json }
}

/** Write `<home>/folders.yaml` the way `plur folders set` does. */
export function writeFolderMap(home: string, entries: Array<{ path: string; plur: 'on' | 'off' | 'ask' }>): void {
  writeFileSync(join(home, 'folders.yaml'),
    'version: 1\nfolders:\n' + entries.map(e => `  - path: "${e.path}"\n    plur: ${e.plur}\n`).join(''))
}

/** sha256 of every file under `root`, by relative path (symlinks by target). */
export function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (lstatSync(p).isSymbolicLink()) { out[relative(root, p)] = `link:${readlinkSync(p)}`; continue }
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(root)
  return out
}

/** Which files differ between two snapshots, in plain words. */
export function treeChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const changes: string[] = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(k in before)) changes.push(`created ${k}`)
    else if (!(k in after)) changes.push(`deleted ${k}`)
    else if (before[k] !== after[k]) changes.push(`changed ${k}`)
  }
  return changes.sort()
}
