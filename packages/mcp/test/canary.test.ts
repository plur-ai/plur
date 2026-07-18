// Issue #192 — CapabilityCanary must reset on plur_session_start so health
// detection is per-session, not per-process. Before this fix the module-level
// canary accumulated state forever: once learn_activity fired once, it stayed
// healthy for the rest of the MCP server's lifetime, and ticks only advanced
// on session_start, so within a session no staleness could ever be detected.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'
import { createServer } from '../src/server.js'

const CANARY_THRESHOLD = 10

describe('CapabilityCanary session reset (#192)', () => {
  let plur: Plur
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-canary-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  const callDirect = async (name: string, args: Record<string, unknown> = {}) => {
    const tools = getToolDefinitions('full')
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  const capability = (status: any, id: string) => {
    const cap = (status.capabilities as any[]).find(c => c.capability === id)
    if (!cap) throw new Error(`Capability ${id} not in status`)
    return cap
  }

  it('session_start clears learn_activity carried over from a previous session', async () => {
    // Session A: user learns something — canary records it
    await callDirect('plur_learn', { statement: 'Canary reset test engram' })

    // Session B starts: prior session's activity must not count as current health
    await callDirect('plur_session_start', { task: 'canary reset test' })

    const status = await callDirect('plur_status') as any
    expect(capability(status, 'learn_activity').firedCount).toBe(0)
    // The session_start itself fired the injection capability for this session
    expect(capability(status, 'session_start_hook').firedCount).toBeGreaterThan(0)
  })

  describe('wire protocol (per-turn ticks)', () => {
    let client: Client

    beforeEach(async () => {
      const server = await createServer(plur)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      client = new Client({ name: 'canary-test-client', version: '1.0.0' })
      await client.connect(clientTransport)
    })

    const callWire = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args })
      return JSON.parse((result.content as any)[0].text)
    }

    it('flags learn_activity unhealthy after threshold turns without learning, then recovers on new session', async () => {
      await callWire('plur_session_start', { task: 'long session, no learning' })

      // Burn through a session's worth of turns with zero plur_learn calls
      let status: any
      for (let i = 0; i < CANARY_THRESHOLD; i++) {
        status = await callWire('plur_status')
      }
      expect(capability(status, 'learn_activity').healthy).toBe(false)
      expect(capability(status, 'learn_activity').warning).toContain('learn_activity')
      // session_start fired this session, so injection stays healthy
      expect(capability(status, 'session_start_hook').healthy).toBe(true)

      // A new session opens a fresh detection window
      await callWire('plur_session_start', { task: 'fresh session' })
      status = await callWire('plur_status')
      expect(capability(status, 'learn_activity').healthy).toBe(true)
      expect(capability(status, 'learn_activity').firedCount).toBe(0)
    })

    it('stays healthy through many turns when learning happens in the session', async () => {
      await callWire('plur_session_start', { task: 'productive session' })
      await callWire('plur_learn', { statement: 'Engram learned mid-session' })

      let status: any
      for (let i = 0; i < CANARY_THRESHOLD + 2; i++) {
        status = await callWire('plur_status')
      }
      expect(capability(status, 'learn_activity').healthy).toBe(true)
      expect(capability(status, 'learn_activity').firedCount).toBeGreaterThan(0)
    })
  })
})
