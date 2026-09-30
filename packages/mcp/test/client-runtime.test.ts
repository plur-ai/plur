import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, type Server } from '@modelcontextprotocol/server'
import { Plur, settleVersionChecks, clearVersionCache } from '@plur-ai/core'
import { createServer } from '../src/server.js'

describe('MCP client runtime attribution', () => {
  let dir: string
  let plur: Plur
  const clients: Client[] = []
  const servers: Server[] = []

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    dir = mkdtempSync(join(tmpdir(), 'plur-client-runtime-'))
    plur = new Plur({ path: dir, autoDiscover: false })
  })

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()))
    await Promise.all(servers.splice(0).map(server => server.close()))
    await settleVersionChecks()
    clearVersionCache()
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  async function connect(name = 'codex', version = '1.2.3') {
    const server = await createServer(plur)
    servers.push(server)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name, version })
    clients.push(client)
    await client.connect(clientTransport)
    return client
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    return JSON.parse((result.content as Array<{ text: string }>)[0].text)
  }

  it('persists initialize.clientInfo on direct learns and preserves other attribution', async () => {
    const client = await connect()
    const result = await call(client, 'plur_learn', {
      statement: 'Database migrations run before deployment',
      attribution: {
        asserted_by: 'local:maintainer',
        runtime: { name: 'caller-supplied-placeholder' },
        model: { name: 'test-model' },
        on_behalf_of: 'local:team',
      },
    })
    const stored = await new Plur({ path: dir, autoDiscover: false }).getById(result.id)
    expect(stored?.attribution).toEqual({
      asserted_by: 'local:maintainer',
      runtime: { name: 'codex', version: '1.2.3' },
      tool: { name: 'plur-core' },
      model: { name: 'test-model' },
      on_behalf_of: 'local:team',
    })
  })

  it('attributes batch writes through admin and session-end suggestions', async () => {
    const client = await connect()
    const batch = await call(client, 'plur_admin', {
      action: 'plur_learn_batch',
      args: { engrams: [
        { statement: 'Use connection pooling for database access' },
        { statement: 'Keep application icons in the assets directory' },
      ], max_llm_calls: 0 },
    })
    expect(batch.stats.added).toBe(2)
    const end = await call(client, 'plur_session_end', {
      summary: 'Recorded project conventions',
      engram_suggestions: ['Translate interface labels using locale files'],
    })
    expect(end.engrams_created).toBe(1)
    const stored = await plur.list()
    expect(stored).toHaveLength(3)
    for (const engram of stored) {
      expect(engram.attribution?.runtime).toEqual({ name: 'codex', version: '1.2.3' })
      expect(engram.attribution?.tool).toEqual({ name: 'plur-core' })
    }
  })

  it('keeps concurrent connections isolated even when they share core', async () => {
    const codex = await connect()
    const cursor = await connect('cursor', '2.0')
    const results = await Promise.all([
      call(codex, 'plur_learn', { statement: 'API responses use JSON envelopes' }),
      call(cursor, 'plur_learn', { statement: 'Schedule database backups every evening' }),
    ])
    expect((await plur.getById(results[0].id))?.attribution?.runtime).toEqual({ name: 'codex', version: '1.2.3' })
    expect((await plur.getById(results[1].id))?.attribution?.runtime).toEqual({ name: 'cursor', version: '2.0' })

    // The request context must not become a default for later non-MCP writes.
    const direct = await plur.learn('Use semantic HTML elements for navigation')
    expect(direct.attribution?.runtime).toBeUndefined()
    expect(direct.attribution?.tool).toEqual({ name: 'plur-core' })
  })

  it('allows a write with no initialize clientInfo and leaves runtime absent', async () => {
    const server = await createServer(plur)
    servers.push(server)
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    // Exercise the wire handler without an initialize handshake. No client
    // identity is available; the server must not guess one from the host.
    const response = new Promise<any>(resolve => {
      transport.onmessage = message => {
        if ('id' in message && message.id === 1) resolve(message)
      }
    })
    await transport.start()
    await transport.send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'plur_learn', arguments: { statement: 'Missing client identity is allowed' } },
    })
    const message = await response
    expect(message.error).toBeUndefined()
    expect(message.result.isError).toBeFalsy()
    const result = JSON.parse(message.result.content[0].text)
    const stored = await plur.getById(result.id)
    expect(stored?.attribution?.tool).toEqual({ name: 'plur-core' })
    expect(stored?.attribution).not.toHaveProperty('runtime')
    await transport.close()
  })
})
