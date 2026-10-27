// PROOF-4: Unless I turn Swarm storage on, ending a session uploads nothing: no proof
// leaves my machine by default.
import { afterEach, describe, expect, it } from 'vitest'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'
import { startGatewayStub, type GatewayStub } from '../helpers/provenance-gateway-stub.js'

describe('PROOF-4 with Swarm storage not turned on, session end uploads nothing', () => {
  let s: McpSession | undefined
  let gw: GatewayStub | undefined
  afterEach(async () => { await s?.close(); await gw?.stop() })

  async function endASession(config: string) {
    s = await mcpSession({ config })
    const start = await s.call('plur_session_start', { task: 'prepare the release notes' })
    const session_id = start.json?.session_id
    expect(session_id, 'precondition: a session started').toBeTruthy()
    await s.call('plur_learn', { statement: 'Release notes are written in plain language', scope: 'global', session_id })
    return s.call('plur_session_end', { summary: 'Wrote release notes.', engram_suggestions: [], session_id })
  }

  it('no receipts setting at all: nothing is sent, and the answer carries no anchor', async () => {
    gw = await startGatewayStub()
    const realFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: any, init?: any) => { calls.push(String(input)); return realFetch(input, init) }) as typeof fetch
    try {
      const end = await endASession(`backend: yaml\nreceipts:\n  gateway_url: ${gw.url}\n`)
      expect(end.isError, `session end failed: ${end.text}`).toBe(false)
      expect(gw.hits, 'session end contacted the gateway although storing proofs was never turned on').toEqual([])
      expect(calls.filter(u => u.includes('/api/v1/')), 'session end made a gateway call although storing proofs is off').toEqual([])
      expect(end.json?.anchor, 'session end reported an anchor although storing proofs is off').toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('receipts.store: off is the same', async () => {
    gw = await startGatewayStub()
    const end = await endASession(`backend: yaml\nreceipts:\n  store: off\n  gateway_url: ${gw.url}\n`)
    expect(end.isError, `session end failed: ${end.text}`).toBe(false)
    expect(gw.hits, 'session end contacted the gateway with receipts.store: off').toEqual([])
  })
})
