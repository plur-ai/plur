// The claw plugin never asks npm for updates on its own: not when it
// registers, and not when it builds a prompt (TEAM-5). No offline variable
// is set here: a machine with no internet does not say so.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearVersionCache, settleVersionChecks } from '@plur-ai/core'
import plugin from '../src/index.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'] as const

describe('claw makes no update check it was not asked for', () => {
  const realFetch = globalThis.fetch
  const saved: Record<string, string | undefined> = {}
  const attempts: string[] = []
  let dir: string

  beforeEach(() => {
    attempts.length = 0
    for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k] }
    globalThis.fetch = (async (input: unknown) => {
      attempts.push(String(input))
      throw new TypeError('blocked')
    }) as typeof fetch
    clearVersionCache()
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-noupdate-'))
  })

  afterEach(async () => {
    await settleVersionChecks()
    globalThis.fetch = realFetch
    for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    clearVersionCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it('register and a prompt build make no registry request', async () => {
    const handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {}
    const api = {
      pluginConfig: { path: dir },
      config: { agents: { defaults: { workspace: dir } } },
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      registerContextEngine: () => {},
      on: (event: string, h: (e: unknown, c: unknown) => unknown) => { (handlers[event] ??= []).push(h) },
      registerCommand: () => {},
      registerCli: () => {},
      registerService: () => {},
    }
    plugin.register(api as any)
    await Promise.all((handlers.before_prompt_build ?? []).map(h => h({ prompt: 'a task' }, {})))
    await settleVersionChecks()
    await new Promise(r => setTimeout(r, 100))
    expect(attempts.filter(a => a.includes('registry.npmjs.org'))).toEqual([])
  })
})
