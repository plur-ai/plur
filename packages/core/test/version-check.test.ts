import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  checkForUpdate,
  getCachedUpdateCheck,
  clearVersionCache,
  minorVersionsBehind,
  settleVersionChecks,
  VERSION_CHECK_SUCCESS_TTL_MS,
  VERSION_CHECK_FAILURE_TTL_MS,
  updateCheckOffline,
} from '../src/version-check.js'

describe('version-check', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearVersionCache()
  })

  it('detects update available', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '2.0.0' }),
    }) as any
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(true)
    expect(result.latest).toBe('2.0.0')
    expect(result.current).toBe('1.0.0')
    expect(result.checkedAt).toBeTypeOf('number')
  })

  it('no update when current is latest', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '1.0.0' }),
    }) as any
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(false)
  })

  it('no update when current is newer', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.9.0' }),
    }) as any
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(false)
  })

  it('handles network error gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as any
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(false)
    expect(result.latest).toBeNull()
  })

  it('handles non-ok response gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as any
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(false)
    expect(result.latest).toBeNull()
  })

  it('calls onResult callback when update available', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '3.0.0' }),
    }) as any
    const cb = vi.fn()
    await checkForUpdate('@plur-ai/core', '1.0.0', cb)
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ updateAvailable: true, latest: '3.0.0' }))
  })

  it('compares minor and patch versions correctly', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '1.2.3' }),
    }) as any
    expect((await checkForUpdate('a', '1.2.2')).updateAvailable).toBe(true)
    clearVersionCache()
    expect((await checkForUpdate('b', '1.2.3')).updateAvailable).toBe(false)
    clearVersionCache()
    expect((await checkForUpdate('c', '1.1.9')).updateAvailable).toBe(true)
    clearVersionCache()
    expect((await checkForUpdate('d', '1.3.0')).updateAvailable).toBe(false)
  })

  describe('minorVersionsBehind', () => {
    it('counts minor version gap', () => {
      expect(minorVersionsBehind('0.7.7', '0.9.9')).toBe(2)
    })

    it('returns 0 when same minor', () => {
      expect(minorVersionsBehind('0.9.8', '0.9.9')).toBe(0)
    })

    it('returns 0 when same version', () => {
      expect(minorVersionsBehind('0.9.9', '0.9.9')).toBe(0)
    })

    it('returns 0 when current is newer', () => {
      expect(minorVersionsBehind('0.9.9', '0.9.8')).toBe(0)
    })

    it('handles major version gap', () => {
      expect(minorVersionsBehind('1.0.0', '2.3.0')).toBe(13)
    })

    it('handles single minor behind', () => {
      expect(minorVersionsBehind('0.8.0', '0.9.0')).toBe(1)
    })
  })

  describe('caching', () => {
    it('returns cached result on second call without fetching', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0' }),
      })
      globalThis.fetch = mockFetch as any

      await checkForUpdate('pkg-a', '1.0.0')
      expect(mockFetch).toHaveBeenCalledTimes(1)

      const result2 = await checkForUpdate('pkg-a', '1.0.0')
      expect(mockFetch).toHaveBeenCalledTimes(1) // no second fetch
      expect(result2.updateAvailable).toBe(true)
    })

    it('getCachedUpdateCheck returns null before any check', () => {
      expect(getCachedUpdateCheck('never-checked')).toBeNull()
    })

    it('getCachedUpdateCheck returns result after check', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '5.0.0' }),
      }) as any
      await checkForUpdate('pkg-b', '1.0.0')
      const cached = getCachedUpdateCheck('pkg-b')
      expect(cached).not.toBeNull()
      expect(cached!.updateAvailable).toBe(true)
      expect(cached!.latest).toBe('5.0.0')
    })

    // #760: before the TTL existed, the cache was "one fetch per process
    // lifetime" — a long-lived server that started while current (or offline)
    // never re-checked and stayed silent about every later release.
    describe('TTL refresh (#760)', () => {
      afterEach(() => {
        vi.restoreAllMocks()
      })

      it('re-checks after the success TTL expires and sees a later release', async () => {
        const mockFetch = vi.fn()
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: '1.0.0' }) })
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: '2.0.0' }) })
        globalThis.fetch = mockFetch as any

        // Process starts current — check caches "no update"
        const first = await checkForUpdate('pkg-ttl', '1.0.0')
        expect(first.updateAvailable).toBe(false)

        // Within the TTL the cache is served — no second fetch
        await checkForUpdate('pkg-ttl', '1.0.0')
        expect(mockFetch).toHaveBeenCalledTimes(1)

        // Beyond the TTL the check re-fetches and finds the new release
        const base = Date.now()
        vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)
        const second = await checkForUpdate('pkg-ttl', '1.0.0')
        expect(mockFetch).toHaveBeenCalledTimes(2)
        expect(second.updateAvailable).toBe(true)
        expect(second.latest).toBe('2.0.0')
      })

      it('retries a non-OK registry answer after the failure TTL', async () => {
        // The registry answered (the network is up) but with an error: that is
        // not offline, so an explicit check after the failure TTL asks again.
        const mockFetch = vi.fn()
          .mockResolvedValueOnce({ ok: false })
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: '2.0.0' }) })
        globalThis.fetch = mockFetch as any

        const first = await checkForUpdate('pkg-fail', '1.0.0')
        expect(first.latest).toBeNull()
        expect(updateCheckOffline()).toBe(false)

        // Still inside the failure TTL — negative result served from cache
        await checkForUpdate('pkg-fail', '1.0.0')
        expect(mockFetch).toHaveBeenCalledTimes(1)

        const base = Date.now()
        vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_FAILURE_TTL_MS + 1)
        const second = await checkForUpdate('pkg-fail', '1.0.0')
        expect(mockFetch).toHaveBeenCalledTimes(2)
        expect(second.updateAvailable).toBe(true)
        expect(second.latest).toBe('2.0.0')
      })

      it('getCachedUpdateCheck serves stale synchronously and refreshes in background', async () => {
        const mockFetch = vi.fn()
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: '1.0.0' }) })
          .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: '2.0.0' }) })
        globalThis.fetch = mockFetch as any
        await checkForUpdate('pkg-read', '1.0.0')

        const base = Date.now()
        vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)

        // Stale read returns the old answer immediately and starts a refresh
        const stale = getCachedUpdateCheck('pkg-read')
        expect(stale).not.toBeNull()
        expect(stale!.updateAvailable).toBe(false)

        await settleVersionChecks()
        const fresh = getCachedUpdateCheck('pkg-read')
        expect(fresh!.updateAvailable).toBe(true)
        expect(fresh!.latest).toBe('2.0.0')
        expect(mockFetch).toHaveBeenCalledTimes(2)
      })

      it('concurrent checks for the same package share one fetch', async () => {
        let resolveFetch: ((v: unknown) => void) | undefined
        const mockFetch = vi.fn().mockImplementation(() => new Promise((r) => { resolveFetch = r }))
        globalThis.fetch = mockFetch as any

        const p1 = checkForUpdate('pkg-dedupe', '1.0.0')
        const p2 = checkForUpdate('pkg-dedupe', '1.0.0')
        resolveFetch!({ ok: true, json: () => Promise.resolve({ version: '2.0.0' }) })
        const [r1, r2] = await Promise.all([p1, p2])
        expect(mockFetch).toHaveBeenCalledTimes(1)
        expect(r1.latest).toBe('2.0.0')
        expect(r2.latest).toBe('2.0.0')
      })
    })

    it('clearVersionCache resets everything', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '2.0.0' }),
      }) as any
      await checkForUpdate('pkg-c', '1.0.0')
      expect(getCachedUpdateCheck('pkg-c')).not.toBeNull()
      clearVersionCache()
      expect(getCachedUpdateCheck('pkg-c')).toBeNull()
    })
  })

  // TEAM-5 (owner decision 2026-10-19): PLUR tries the network at most once,
  // with the update check. When that cannot connect, the process is offline and
  // the update checker makes no further attempt of any kind: not on an explicit
  // check, not on a refresh-on-read, however much time has passed.
  describe('offline after a connection failure (TEAM-5)', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('a check that cannot connect marks the process offline', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as any
      expect(updateCheckOffline()).toBe(false)
      await checkForUpdate('pkg-off', '1.0.0')
      expect(updateCheckOffline()).toBe(true)
    })

    it('while offline, an explicit check after the failure TTL makes no request', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '2.0.0' }) })
      globalThis.fetch = mockFetch as any
      await checkForUpdate('pkg-off', '1.0.0')
      const base = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS * 10)
      const r = await checkForUpdate('pkg-off', '1.0.0')
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(r.latest).toBeNull()
    })

    it('while offline, no package is checked: the network is down for the process', async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))
      globalThis.fetch = mockFetch as any
      await checkForUpdate('pkg-off', '1.0.0')
      await checkForUpdate('pkg-other', '1.0.0')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('while offline, a stale read starts no refresh', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: '1.0.0' }) })
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '2.0.0' }) })
      globalThis.fetch = mockFetch as any
      await checkForUpdate('pkg-a', '1.0.0')
      await checkForUpdate('pkg-b', '1.0.0') // cannot connect: offline from here
      const base = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)
      const stale = getCachedUpdateCheck('pkg-a')
      await settleVersionChecks()
      expect(mockFetch).toHaveBeenCalledTimes(2)
      // The earlier answer is still shown.
      expect(stale!.latest).toBe('1.0.0')
      expect(getCachedUpdateCheck('pkg-a')!.latest).toBe('1.0.0')
    })

    it('a timeout counts as cannot connect', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })) as any
      await checkForUpdate('pkg-off', '1.0.0')
      expect(updateCheckOffline()).toBe(true)
    })

    it('a non-OK registry answer is not offline', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as any
      await checkForUpdate('pkg-off', '1.0.0')
      expect(updateCheckOffline()).toBe(false)
    })

    it('clearVersionCache resets the offline mark (tests only)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as any
      await checkForUpdate('pkg-off', '1.0.0')
      clearVersionCache()
      expect(updateCheckOffline()).toBe(false)
    })
  })
})
