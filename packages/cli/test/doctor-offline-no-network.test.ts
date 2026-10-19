// With the machine declared offline, `plur doctor` does not ask the npm
// registry whether the opencode plugin is published: it says it cannot tell.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkOpencodePluginPublished } from '../src/commands/doctor.js'

describe('doctor registry lookup when offline', () => {
  const originalFetch = globalThis.fetch
  const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'] as const
  const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]))
  beforeEach(() => { for (const k of VARS) delete process.env[k] })
  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('offline: no request, answer unknown', async () => {
    process.env.PLUR_OFFLINE = '1'
    const f = vi.fn()
    globalThis.fetch = f as unknown as typeof fetch
    expect(await checkOpencodePluginPublished('@plur-ai/example')).toBe('unknown')
    expect(f).not.toHaveBeenCalled()
  })

  it('online: asks the registry', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = f as unknown as typeof fetch
    expect(await checkOpencodePluginPublished('@plur-ai/example')).toBe('published')
    expect(f).toHaveBeenCalledTimes(1)
  })
})
