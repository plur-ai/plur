// The MCP server checks npm for updates once at start. When that check cannot
// connect, the process is offline: the periodic re-check, a stale read and even
// an explicit plur_status check_updates make no further request. No offline
// variable is set here: a machine with no internet does not say so.
// The check runs the real npm against a local mirror set as the user's
// `@plur-ai:registry` (no request leaves 127.0.0.1). A mirror in `reset` mode
// accepts and drops each connection: the check cannot connect.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, clearVersionCache, settleVersionChecks, VERSION_CHECK_SUCCESS_TTL_MS } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { startMirror, npmSandbox, refusedPort, type Mirror, type NpmSandbox } from '../../core/test/npm-mirror.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'] as const

describe('MCP server update check: once at start, then offline if it cannot connect', () => {
  const realFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  const fetched: string[] = []
  let mirror: Mirror
  let box: NpmSandbox
  let restoreEnv: () => void
  let dir: string
  let client: Client | undefined

  const blocked = () => mirror.setMode('reset')
  const newer = () => mirror.setMode('ok')

  async function start(): Promise<Client> {
    const server = await createServer(new Plur({ path: dir }), { profile: 'full' })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const cl = new Client({ name: 't', version: '1' })
    await cl.connect(c)
    client = cl
    return cl
  }

  /** Connections the registry received (each lookup opens one). */
  const registry = () => mirror.connections()
  const status = async (cl: Client, args: Record<string, unknown> = {}) =>
    JSON.parse(((await cl.callTool({ name: 'plur_status', arguments: args })).content as any)[0].text)

  beforeEach(async () => {
    fetched.length = 0
    for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k] }
    mirror = await startMirror({ '@plur-ai/mcp': '99.0.0' })
    box = npmSandbox(`@plur-ai:registry=${mirror.url}\n`)
    restoreEnv = box.apply()
    blocked()
    // No direct registry read: every lookup goes through npm.
    globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); throw new TypeError('fetch blocked in test') }) as typeof fetch
    clearVersionCache()
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-update-'))
  })

  afterEach(async () => {
    await client?.close(); client = undefined
    await settleVersionChecks()
    expect(fetched).toEqual([])
    globalThis.fetch = realFetch
    restoreEnv()
    box.cleanup()
    await mirror.close()
    for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    clearVersionCache()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('starting the server checks the registry once; using it adds no request', async () => {
    newer()
    const cl = await start()
    await settleVersionChecks()
    expect(registry()).toBe(1)
    await cl.callTool({ name: 'plur_session_start', arguments: { task: 'test' } })
    await status(cl)
    await settleVersionChecks()
    expect(registry()).toBe(1)
  })

  it('a successful start check shows the update notice and the status answer', async () => {
    newer()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cl = await start()
    await settleVersionChecks()
    expect(err.mock.calls.some(c => String(c[0]).includes('Update available') && String(c[0]).includes('99.0.0'))).toBe(true)
    expect((await status(cl)).update_available?.latest).toBe('99.0.0')
  })

  it('after the start check cannot connect, an explicit check_updates makes no request and says offline', async () => {
    const cl = await start()
    await settleVersionChecks()
    expect(registry()).toBe(1)
    newer() // even if the network came back, the process stays offline
    const data = await status(cl, { check_updates: true })
    await settleVersionChecks()
    expect(registry()).toBe(1)
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
    expect(registry()).toBe(1)
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
      expect(registry()).toBe(1)
      vi.advanceTimersByTime(VERSION_CHECK_SUCCESS_TTL_MS * 3 + 1)
      await core.settleVersionChecks()
      expect(registry()).toBe(1)
      core.clearVersionCache()
    } finally { vi.useRealTimers() }
  })

  it('the periodic re-check still runs while online', async () => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setInterval'] })
    newer()
    try {
      const core = await import('@plur-ai/core')
      const fresh = await import('../src/server.js')
      await fresh.createServer(new core.Plur({ path: dir }), { profile: 'full' })
      await core.settleVersionChecks()
      expect(registry()).toBe(1)
      const base = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)
      vi.advanceTimersByTime(VERSION_CHECK_SUCCESS_TTL_MS + 1)
      await core.settleVersionChecks()
      expect(registry()).toBe(2)
      core.clearVersionCache()
    } finally { vi.useRealTimers() }
  })

  it('the offline switch stops the start check before any request', async () => {
    process.env.PLUR_OFFLINE = '1'
    newer()
    const cl = await start()
    await status(cl, { check_updates: true })
    await settleVersionChecks()
    expect(registry()).toBe(0)
  })

  it('the notice reports the mirror\'s latest, not npmjs\'s', async () => {
    newer()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cl = await start()
    await settleVersionChecks()
    expect(mirror.requests).toContain('/@plur-ai/mcp')
    expect(err.mock.calls.map(c => String(c[0])).filter(l => l.includes('Update available'))).toEqual([
      expect.stringContaining('→ 99.0.0'),
    ])
    expect((await status(cl)).update_available?.latest).toBe('99.0.0')
  })

  for (const [name, mode, reason] of [
    ['refused', 'refused', 'connection refused'],
    ['HTTP 500', '500', 'it answered HTTP 500'],
  ] as const) {
    it(`unreachable registry (${name}): says so plainly, advertises nothing, session_start stays silent`, async () => {
      let host = mirror.host
      if (mode === 'refused') {
        const port = await refusedPort()
        host = `127.0.0.1:${port}`
        restoreEnv(); box.cleanup()
        box = npmSandbox(`@plur-ai:registry=http://${host}/\n`)
        restoreEnv = box.apply()
      } else mirror.setMode('500')
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const cl = await start()
      await settleVersionChecks()
      const line = `[plur] Could not reach ${host} to check for updates (${reason}). No update is advertised.`
      expect(err.mock.calls.map(c => String(c[0]))).toContain(line)
      expect(err.mock.calls.some(c => String(c[0]).includes('Update available'))).toBe(false)
      const data = await status(cl)
      expect(data.update_available).toBeUndefined()
      expect(String(data.update_check)).toContain(`Could not reach ${host} to check for updates (${reason})`)
      const started = JSON.parse(((await cl.callTool({ name: 'plur_session_start', arguments: { task: 'test' } })).content as any)[0].text)
      expect(started.version_warning).toBeUndefined()
      expect(JSON.stringify(started)).not.toContain('Could not reach')
    })
  }

  it('the answer is kept in the store: a restart within the TTL asks npm nothing', async () => {
    newer()
    await start()
    await settleVersionChecks()
    const file = join(dir, 'cache', 'update-check.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))['@plur-ai/mcp']).toMatchObject({ latest: '99.0.0', ok: true })
    await client?.close(); client = undefined
    clearVersionCache() // a new process
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await start()
    await settleVersionChecks()
    expect(registry()).toBe(1)
    expect(err.mock.calls.some(c => String(c[0]).includes('→ 99.0.0'))).toBe(true)
  })

  it('a failure kept in the store is reported on restart without a lookup and without going offline', async () => {
    mirror.setMode('500')
    await start()
    await settleVersionChecks()
    await client?.close(); client = undefined
    clearVersionCache() // a new process
    newer()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cl = await start()
    await settleVersionChecks()
    expect(registry()).toBe(1)
    expect(err.mock.calls.map(c => String(c[0]))).toContain(`[plur] Could not reach ${mirror.host} to check for updates (it answered HTTP 500). No update is advertised.`)
    const data = await status(cl)
    expect(String(data.update_check)).not.toMatch(/^offline/)
  })

  it('started in an off folder: no cache file is written and a cached answer is not read', async () => {
    const off = realpathSync(mkdtempSync(join(tmpdir(), 'plur-mcp-off-folder-')))
    try {
      writeFileSync(join(dir, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${off}"\n    plur: off\n`)
      const startIn = async (folder: string) => {
        const server = await createServer(new Plur({ path: dir }), { profile: 'full', folder })
        const [c, s] = InMemoryTransport.createLinkedPair()
        await server.connect(s)
        const cl = new Client({ name: 't', version: '1' })
        await cl.connect(c)
        client = cl
      }
      newer()
      await startIn(off)
      await settleVersionChecks()
      expect(registry()).toBe(1) // the check itself still runs
      expect(existsSync(join(dir, 'cache', 'update-check.json'))).toBe(false)

      // A fresh answer already in the store is not read in an off folder either.
      await client?.close(); client = undefined
      clearVersionCache()
      mkdirSync(join(dir, 'cache'), { recursive: true })
      const file = join(dir, 'cache', 'update-check.json')
      const cached = JSON.stringify({ '@plur-ai/mcp': { latest: '42.0.0', ok: true, fetchedAt: Date.now() } })
      writeFileSync(file, cached)
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      await startIn(off)
      await settleVersionChecks()
      expect(registry()).toBe(2) // asked npm instead of using the file
      expect(err.mock.calls.some(c => String(c[0]).includes('→ 99.0.0'))).toBe(true)
      expect(err.mock.calls.some(c => String(c[0]).includes('42.0.0'))).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(cached)
    } finally { rmSync(off, { recursive: true, force: true }) }
  })
})
