// With the machine declared offline, the update check makes no network call
// at all: not through fetch, not through a raw socket, not through a DNS
// lookup. Online, the check still asks the registry.
import dns from 'node:dns'
import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdate, clearVersionCache, getCachedUpdateCheck, settleVersionChecks } from '../src/version-check.js'
import { offlineByEnv, updateCheckDisabledByEnv } from '../src/offline.js'
import { downloadsOffByEnv } from '../src/embedders/transformers-base.js'

const VARS = ['PLUR_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'PLUR_MODEL_DOWNLOAD'] as const

describe('offline switch', () => {
  const attempts: string[] = []
  const saved = {
    fetch: globalThis.fetch,
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    env: {} as Record<string, string | undefined>,
  }

  beforeEach(() => {
    attempts.length = 0
    for (const k of VARS) { saved.env[k] = process.env[k]; delete process.env[k] }
    globalThis.fetch = (async (input: unknown) => {
      attempts.push(`fetch ${String(input)}`)
      return { ok: true, json: async () => ({ version: '99.0.0' }) } as Response
    }) as typeof globalThis.fetch
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      attempts.push(`socket ${JSON.stringify(args[0])}`)
      throw new Error('blocked')
    } as typeof net.Socket.prototype.connect
    ;(dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
      attempts.push(`dns ${host}`)
      const cb = rest.find(r => typeof r === 'function') as ((e: Error) => void) | undefined
      cb?.(new Error('blocked'))
    }
    clearVersionCache()
  })

  afterEach(async () => {
    await settleVersionChecks()
    globalThis.fetch = saved.fetch
    net.Socket.prototype.connect = saved.connect
    ;(dns as { lookup: unknown }).lookup = saved.lookup
    for (const k of VARS) {
      if (saved.env[k] === undefined) delete process.env[k]
      else process.env[k] = saved.env[k]
    }
    clearVersionCache()
    vi.restoreAllMocks()
  })

  it('online, the update check asks the registry', async () => {
    const r = await checkForUpdate('@plur-ai/example', '1.0.0')
    expect(attempts).toEqual(['fetch https://registry.npmjs.org/@plur-ai/example/latest'])
    expect(r.updateAvailable).toBe(true)
  })

  for (const [k, v] of [['PLUR_OFFLINE', '1'], ['HF_HUB_OFFLINE', '1'], ['TRANSFORMERS_OFFLINE', 'true'], ['PLUR_NO_UPDATE_CHECK', '1'], ['NO_UPDATE_NOTIFIER', '1']] as const) {
    it(`with ${k}=${v} the update check makes no network call of any kind`, async () => {
      process.env[k] = v
      const onResult = vi.fn()
      const r = await checkForUpdate('@plur-ai/example', '1.0.0', onResult)
      // A cached-entry read must not start a background refresh either.
      getCachedUpdateCheck('@plur-ai/example')
      await settleVersionChecks()
      await new Promise(res => setTimeout(res, 20))
      expect(attempts).toEqual([])
      expect(r).toMatchObject({ current: '1.0.0', latest: null, updateAvailable: false })
      expect(onResult).toHaveBeenCalledWith(r)
    })
  }

  it('a value that is not a yes does not count as offline', () => {
    process.env.PLUR_OFFLINE = '0'
    process.env.HF_HUB_OFFLINE = 'false'
    expect(offlineByEnv()).toBe(false)
    expect(updateCheckDisabledByEnv()).toBe(false)
  })

  it('PLUR_OFFLINE also turns model downloads off', () => {
    expect(downloadsOffByEnv()).toBe(false)
    process.env.PLUR_OFFLINE = 'yes'
    expect(downloadsOffByEnv()).toBe(true)
  })
})
