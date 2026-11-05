// The claw plugin checks npm for updates once when it registers. When that
// check cannot connect, the process is offline: building prompts, however much
// later, makes no further request. No offline variable is set here: a machine
// with no internet does not say so. The check runs the real npm against a local
// mirror set as the user's `@plur-ai:registry`; nothing leaves 127.0.0.1.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearVersionCache, settleVersionChecks, VERSION_CHECK_SUCCESS_TTL_MS } from '@plur-ai/core'
import plugin from '../src/index.js'
import { startMirror, npmSandbox, refusedPort, type Mirror, type NpmSandbox } from '../../core/test/npm-mirror.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'] as const

describe('claw update check: once at register, then offline if it cannot connect', () => {
  const realFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  const fetched: string[] = []
  let mirror: Mirror
  let box: NpmSandbox
  let restoreEnv: () => void
  let dir: string

  const useRegistry = (url: string) => {
    restoreEnv(); box?.cleanup()
    box = npmSandbox(`@plur-ai:registry=${url}\n`)
    restoreEnv = box.apply()
  }

  beforeEach(async () => {
    fetched.length = 0
    for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k] }
    mirror = await startMirror({ '@plur-ai/claw': '99.0.0' }, 'reset')
    restoreEnv = () => {}
    useRegistry(mirror.url)
    globalThis.fetch = (async (input: unknown) => { fetched.push(String(input)); throw new TypeError('fetch blocked in test') }) as typeof fetch
    clearVersionCache()
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-update-'))
  })

  afterEach(async () => {
    await settleVersionChecks()
    expect(fetched).toEqual([])
    globalThis.fetch = realFetch
    restoreEnv(); box.cleanup()
    await mirror.close()
    for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    clearVersionCache()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function register(warn: (m: string) => void = () => {}) {
    const handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {}
    const api = {
      pluginConfig: { path: dir },
      config: { agents: { defaults: { workspace: dir } } },
      logger: { info: () => {}, warn, debug: () => {}, error: () => {} },
      registerContextEngine: () => {},
      on: (event: string, h: (e: unknown, c: unknown) => unknown) => { (handlers[event] ??= []).push(h) },
      registerCommand: () => {},
      registerCli: () => {},
      registerService: () => {},
    }
    plugin.register(api as any)
    return handlers
  }
  /** Connections the registry received (each lookup opens one). */
  const registry = () => mirror.connections()

  it('register checks once and warns with the mirror\'s latest', async () => {
    mirror.setMode('ok')
    const warnings: string[] = []
    register(m => warnings.push(m))
    await settleVersionChecks()
    expect(mirror.requests).toEqual(['/@plur-ai/claw'])
    expect(warnings.filter(w => w.includes('update available'))).toEqual([expect.stringContaining('→ 99.0.0')])
    expect(existsSync(join(dir, 'cache', 'update-check.json'))).toBe(true)
  })

  for (const [name, reason] of [['refused', 'connection refused'], ['HTTP 500', 'it answered HTTP 500']] as const) {
    it(`unreachable registry (${name}): warns plainly and advertises nothing`, async () => {
      let host = mirror.host
      if (name === 'refused') { host = `127.0.0.1:${await refusedPort()}`; useRegistry(`http://${host}/`) } else mirror.setMode('500')
      const warnings: string[] = []
      register(m => warnings.push(m))
      await settleVersionChecks()
      expect(warnings).toContain(`PLUR: Could not reach ${host} to check for updates (${reason}). No update is advertised.`)
      expect(warnings.some(w => w.includes('update available'))).toBe(false)
    })
  }

  it('after the register check cannot connect, prompt builds long after make no request', async () => {
    const handlers = register()
    await settleVersionChecks()
    expect(registry()).toBe(1)
    const base = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS * 4)
    await Promise.all((handlers.before_prompt_build ?? []).map(h => h({ prompt: 'a task' }, {})))
    await settleVersionChecks()
    await new Promise(r => setTimeout(r, 100))
    expect(registry()).toBe(1)
  })
})
