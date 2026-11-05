/**
 * Formal model spec/formal/PlurSpec/McpTools.lean §4: server.ts runs tool
 * calls one at a time (`callTail`), and the slot is released on every return
 * path, so a call that fails never blocks the next one.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'

const dirs: string[] = []
const clients: Client[] = []

async function connect(): Promise<{ client: Client; plur: Plur }> {
  const dir = mkdtempSync(join(tmpdir(), 'plur-formal-mcp-serial-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  const plur = new Plur({ path: dir })
  const server = await createServer(plur, { discovery: false })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  clients.push(client)
  return { client, plur }
}

const tick = () => new Promise(r => setTimeout(r, 20))

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(c => c.close().catch(() => {})))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('tool calls are serialised (formal McpTools §4)', () => {
  it('a second call does not start while the first is still running', async () => {
    const { client, plur } = await connect()
    const real = plur.status.bind(plur)
    let active = 0
    let maxActive = 0
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    let n = 0
    vi.spyOn(plur, 'status').mockImplementation(async (...a: any[]) => {
      const mine = ++n
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (mine === 1) await gate
        return await (real as any)(...a)
      } finally { active-- }
    })
    const first = client.callTool({ name: 'plur_status', arguments: {} })
    await tick()
    const second = client.callTool({ name: 'plur_status', arguments: {} })
    await tick()
    expect(n).toBe(1) // the second has not reached its handler
    open()
    await Promise.all([first, second])
    expect(n).toBe(2)
    expect(maxActive).toBe(1)
  })

  it('a call that fails does not block the next one', async () => {
    const { client, plur } = await connect()
    const real = plur.status.bind(plur)
    let n = 0
    vi.spyOn(plur, 'status').mockImplementation(async (...a: any[]) => {
      if (++n === 1) throw new Error('first call fails')
      return await (real as any)(...a)
    })
    const first = await client.callTool({ name: 'plur_status', arguments: {} })
    expect(first.isError).toBe(true)
    const second = await Promise.race([
      client.callTool({ name: 'plur_status', arguments: {} }),
      new Promise(r => setTimeout(() => r('blocked'), 5000)),
    ])
    expect(second).not.toBe('blocked')
    expect((second as any).isError).toBeFalsy()
  })
})
