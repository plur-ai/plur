// The MCP server never asks npm for updates on its own (TEAM-5): not at
// start, not on a timer, not when a tool reads the cached answer. It asks only
// when the agent requests it: plur_status with check_updates. No offline
// variable is set here: a machine with no internet does not say so.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, clearVersionCache, settleVersionChecks, VERSION_CHECK_SUCCESS_TTL_MS } from '@plur-ai/core'
import { createServer } from '../src/server.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'] as const

describe('MCP server makes no update check it was not asked for', () => {
  const realFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  const attempts: string[] = []
  let answer: () => Promise<Response>
  let dir: string
  let client: Client

  beforeEach(async () => {
    attempts.length = 0
    for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k] }
    answer = async () => { throw new TypeError('blocked') }
    globalThis.fetch = (async (input: unknown) => { attempts.push(String(input)); return answer() }) as typeof fetch
    clearVersionCache()
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-noupdate-'))
    const server = await createServer(new Plur({ path: dir }), { profile: 'full' })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    client = new Client({ name: 't', version: '1' })
    await client.connect(c)
  })

  afterEach(async () => {
    await client.close()
    await settleVersionChecks()
    globalThis.fetch = realFetch
    for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    clearVersionCache()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  const registry = () => attempts.filter(a => a.includes('registry.npmjs.org'))

  it('starting the server and using it makes no registry request', async () => {
    await client.callTool({ name: 'plur_session_start', arguments: { task: 'test' } })
    await client.callTool({ name: 'plur_status', arguments: {} })
    await settleVersionChecks()
    await new Promise(r => setTimeout(r, 100))
    expect(registry()).toEqual([])
  })

  it('the periodic re-check is gone: no timer fires a request', async () => {
    // A fresh module instance, so a timer guarded at module level is created
    // under the fake clock.
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      const fresh = await import('../src/server.js')
      await fresh.createServer(new Plur({ path: dir }), { profile: 'full' })
      vi.advanceTimersByTime(VERSION_CHECK_SUCCESS_TTL_MS * 3)
    } finally { vi.useRealTimers() }
    await settleVersionChecks()
    expect(registry()).toEqual([])
  })

  it('an expired cached answer is shown, never refreshed by a read', async () => {
    answer = async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) }) as Response
    await client.callTool({ name: 'plur_status', arguments: { check_updates: true } })
    expect(registry()).toHaveLength(1)
    const base = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)
    const r = await client.callTool({ name: 'plur_status', arguments: {} })
    await client.callTool({ name: 'plur_session_start', arguments: { task: 'test' } })
    await settleVersionChecks()
    expect(registry()).toHaveLength(1)
    expect(JSON.parse((r.content as any)[0].text).update_available?.latest).toBe('99.0.0')
  })

  it('plur_status with check_updates asks the registry and reports the answer', async () => {
    answer = async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) }) as Response
    const r = await client.callTool({ name: 'plur_status', arguments: { check_updates: true } })
    const data = JSON.parse((r.content as any)[0].text)
    expect(registry()).toEqual(['https://registry.npmjs.org/@plur-ai/mcp/latest'])
    expect(data.update_available.latest).toBe('99.0.0')
  })
})
