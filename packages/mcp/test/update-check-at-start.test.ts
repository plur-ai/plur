// The MCP server checks npm for updates once at start (TEAM-5, owner decision
// 2026-10-19). When that check cannot connect, the process is offline: the
// periodic re-check, a stale read and even an explicit plur_status
// check_updates make no further request. No offline variable is set here: a
// machine with no internet does not say so.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, clearVersionCache, settleVersionChecks, VERSION_CHECK_SUCCESS_TTL_MS } from '@plur-ai/core'
import { createServer } from '../src/server.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'] as const
const REGISTRY = 'https://registry.npmjs.org/@plur-ai/mcp/latest'

describe('MCP server update check: once at start, then offline if it cannot connect', () => {
  const realFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  const attempts: string[] = []
  let answer: () => Promise<Response>
  let dir: string
  let client: Client | undefined

  const blocked = async (): Promise<Response> => { throw new TypeError('fetch failed') }
  const newer = async (): Promise<Response> => ({ ok: true, json: async () => ({ version: '99.0.0' }) }) as Response

  async function start(): Promise<Client> {
    const server = await createServer(new Plur({ path: dir }), { profile: 'full' })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const cl = new Client({ name: 't', version: '1' })
    await cl.connect(c)
    client = cl
    return cl
  }

  const registry = () => attempts.filter(a => a.includes('registry.npmjs.org'))
  const status = async (cl: Client, args: Record<string, unknown> = {}) =>
    JSON.parse(((await cl.callTool({ name: 'plur_status', arguments: args })).content as any)[0].text)

  beforeEach(() => {
    attempts.length = 0
    for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k] }
    answer = blocked
    globalThis.fetch = (async (input: unknown) => { attempts.push(String(input)); return answer() }) as typeof fetch
    clearVersionCache()
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-update-'))
  })

  afterEach(async () => {
    await client?.close(); client = undefined
    await settleVersionChecks()
    globalThis.fetch = realFetch
    for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    clearVersionCache()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starting the server checks the registry once; using it adds no request', async () => {
    answer = newer
    const cl = await start()
    await settleVersionChecks()
    expect(registry()).toEqual([REGISTRY])
    await cl.callTool({ name: 'plur_session_start', arguments: { task: 'test' } })
    await status(cl)
    await settleVersionChecks()
    expect(registry()).toEqual([REGISTRY])
  })

  it('a successful start check shows the update notice and the status answer', async () => {
    answer = newer
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cl = await start()
    await settleVersionChecks()
    expect(err.mock.calls.some(c => String(c[0]).includes('Update available') && String(c[0]).includes('99.0.0'))).toBe(true)
    expect((await status(cl)).update_available?.latest).toBe('99.0.0')
  })

  it('after the start check cannot connect, an explicit check_updates makes no request and says offline', async () => {
    const cl = await start()
    await settleVersionChecks()
    expect(registry()).toHaveLength(1)
    answer = newer // even if the network came back, the process stays offline
    const data = await status(cl, { check_updates: true })
    await settleVersionChecks()
    expect(registry()).toHaveLength(1)
    expect(data.update_available).toBeUndefined()
    expect(String(data.update_check)).toMatch(/offline/i)
  })

  it('after the start check cannot connect, a stale read long after makes no request', async () => {
    const cl = await start()
    await settleVersionChecks()
    const base = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS * 4)
    await status(cl)
    await cl.callTool({ name: 'plur_session_start', arguments: { task: 'test' } })
    await settleVersionChecks()
    expect(registry()).toHaveLength(1)
  })

  it('after the start check cannot connect, the periodic re-check makes no request', async () => {
    // A fresh module instance, so the module-level timer is created under the
    // fake clock (and the version-check state starts empty, like a new process).
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setInterval'] })
    try {
      const core = await import('@plur-ai/core')
      const fresh = await import('../src/server.js')
      await fresh.createServer(new core.Plur({ path: dir }), { profile: 'full' })
      await core.settleVersionChecks()
      expect(registry()).toHaveLength(1)
      vi.advanceTimersByTime(VERSION_CHECK_SUCCESS_TTL_MS * 3 + 1)
      await core.settleVersionChecks()
      expect(registry()).toHaveLength(1)
      core.clearVersionCache()
    } finally { vi.useRealTimers() }
  })

  it('the periodic re-check still runs while online', async () => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setInterval'] })
    answer = newer
    try {
      const core = await import('@plur-ai/core')
      const fresh = await import('../src/server.js')
      await fresh.createServer(new core.Plur({ path: dir }), { profile: 'full' })
      await core.settleVersionChecks()
      expect(registry()).toHaveLength(1)
      const base = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)
      vi.advanceTimersByTime(VERSION_CHECK_SUCCESS_TTL_MS + 1)
      await core.settleVersionChecks()
      expect(registry()).toHaveLength(2)
      core.clearVersionCache()
    } finally { vi.useRealTimers() }
  })

  it('the offline switch stops the start check before any request', async () => {
    process.env.PLUR_OFFLINE = '1'
    answer = newer
    const cl = await start()
    await status(cl, { check_updates: true })
    await settleVersionChecks()
    expect(registry()).toEqual([])
  })
})
