// The claw plugin checks npm for updates once when it registers (TEAM-5, owner
// decision 2026-10-19). When that check cannot connect, the process is offline:
// building prompts, however much later, makes no further request. No offline
// variable is set here: a machine with no internet does not say so.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearVersionCache, settleVersionChecks, VERSION_CHECK_SUCCESS_TTL_MS } from '@plur-ai/core'
import plugin from '../src/index.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'] as const

describe('claw update check: once at register, then offline if it cannot connect', () => {
  const realFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  const attempts: string[] = []
  let answer: () => Promise<Response>
  let dir: string

  beforeEach(() => {
    attempts.length = 0
    for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k] }
    answer = async () => { throw new TypeError('fetch failed') }
    globalThis.fetch = (async (input: unknown) => { attempts.push(String(input)); return answer() }) as typeof fetch
    clearVersionCache()
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-update-'))
  })

  afterEach(async () => {
    await settleVersionChecks()
    globalThis.fetch = realFetch
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
  const registry = () => attempts.filter(a => a.includes('registry.npmjs.org'))

  it('register checks once and warns when an update is published', async () => {
    answer = async () => ({ ok: true, json: async () => ({ version: '99.0.0' }) }) as Response
    const warnings: string[] = []
    register(m => warnings.push(m))
    await settleVersionChecks()
    expect(registry()).toEqual(['https://registry.npmjs.org/@plur-ai/claw/latest'])
    expect(warnings.some(w => w.includes('update available') || w.includes('Update available'))).toBe(true)
  })

  it('after the register check cannot connect, prompt builds long after make no request', async () => {
    const handlers = register()
    await settleVersionChecks()
    expect(registry()).toHaveLength(1)
    const base = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS * 4)
    await Promise.all((handlers.before_prompt_build ?? []).map(h => h({ prompt: 'a task' }, {})))
    await settleVersionChecks()
    await new Promise(r => setTimeout(r, 100))
    expect(registry()).toHaveLength(1)
  })
})
