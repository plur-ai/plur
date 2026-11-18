// With the machine declared offline, `plur doctor` does not ask the npm
// registry whether the opencode plugin is published: it says it cannot tell.
// Online it asks npm (through the user's npm configuration), never fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkOpencodePluginPublished } from '../src/commands/doctor.js'
import { startMirror, npmSandbox, type Mirror, type NpmSandbox } from '../../core/test/npm-mirror.js'

describe('doctor registry lookup when offline', () => {
  const originalFetch = globalThis.fetch
  const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE'] as const
  const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]))
  let mirror: Mirror
  let box: NpmSandbox
  let restoreEnv: () => void
  beforeEach(async () => {
    for (const k of VARS) delete process.env[k]
    mirror = await startMirror({ '@plur-ai/example': '1.0.0' })
    box = npmSandbox(`@plur-ai:registry=${mirror.url}\n`)
    restoreEnv = box.apply()
  })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    restoreEnv(); box.cleanup()
    await mirror.close()
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('offline: no request, answer unknown', async () => {
    process.env.PLUR_OFFLINE = '1'
    const f = vi.fn()
    globalThis.fetch = f as unknown as typeof fetch
    expect(await checkOpencodePluginPublished('@plur-ai/example')).toEqual({ state: 'unknown' })
    expect(f).not.toHaveBeenCalled()
    expect(mirror.connections()).toBe(0)
  })

  it('online: asks the registry through npm, not fetch', async () => {
    const f = vi.fn()
    globalThis.fetch = f as unknown as typeof fetch
    expect(await checkOpencodePluginPublished('@plur-ai/example')).toEqual({ state: 'published' })
    expect(mirror.requests).toEqual(['/@plur-ai/example'])
    expect(f).not.toHaveBeenCalled()
  })
})
