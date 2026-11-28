/**
 * 0.24 review, round 2 (MCP side): plur_scopes_discover with register:true
 * adds new stores, so under `pinning.agents: request` or `deny` it is refused
 * for the agent the MCP server runs as, with the same pin_denied reply
 * plur_stores_add gives, and config.yaml is untouched. Under `allow` it
 * registers as before.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const tool = (name: string) => getToolDefinitions('full').find(t => t.name === name)!
const URL = 'https://plur.example.test'
const BASE = 'group:example/eng'
const OTHER = 'group:example/comms'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).endsWith('/api/v1/me')
    ? new Response(JSON.stringify({ username: 'tester', org_id: 'example', scopes: [BASE, OTHER] }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('{}', { status: 404 })))
})

function setup(agents: 'allow' | 'request' | 'deny') {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-r2-disc-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`
    + `stores:\n  - url: ${URL}\n    token: tok\n    scope: ${BASE}\n    shared: true\n    readonly: false\n`)
  // The MCP server runs as an agent (server.ts sets the default actor).
  return { dir, plur: new Plur({ path: dir, autoDiscover: false, actor: 'agent' }) }
}

describe('round 2: plur_scopes_discover register:true under pinning.agents', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: registering is refused with pin_denied and config.yaml is untouched`, async () => {
      const { dir, plur } = setup(agents)
      const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
      const res = await tool('plur_scopes_discover').handler({ register: true }, plur) as any
      expect(res.success).toBe(false)
      expect(res.error).toBe('pin_denied')
      expect(String(res.note)).toContain('plur stores add')
      expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
    })

    it(`${agents}: discovery without register still answers`, async () => {
      const { plur } = setup(agents)
      const res = await tool('plur_scopes_discover').handler({}, plur) as any
      expect(res.discovered[0].unregistered).toEqual([OTHER])
    })
  }

  it('allow (default): register:true registers the discovered scope', async () => {
    const { dir, plur } = setup('allow')
    const res = await tool('plur_scopes_discover').handler({ register: true }, plur) as any
    expect(res.registered[0].added).toEqual([OTHER])
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toContain(OTHER)
  })
})
