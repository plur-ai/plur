import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  checkForUpdate,
  getCachedUpdateCheck,
  clearVersionCache,
  minorVersionsBehind,
  settleVersionChecks,
  VERSION_CHECK_SUCCESS_TTL_MS,
  VERSION_CHECK_FAILURE_TTL_MS,
  updateCheckOffline,
  formatUpdateCheckFailure,
} from '../src/version-check.js'

// The registry lookup (npm-latest.ts, tested against a real npm in
// npm-latest-1833.test.ts) is replaced here so caching and offline rules are
// tested on their own.
const lookup = vi.hoisted(() => ({ fn: (() => Promise.resolve(undefined)) as (...a: unknown[]) => Promise<unknown> }))
vi.mock('../src/npm-latest.js', () => ({
  UNKNOWN_REGISTRY: 'the configured npm registry',
  npmLatest: (...a: unknown[]) => lookup.fn(...a),
}))
const ok = (version: string) => ({ state: 'ok', version })
const REFUSED = { state: 'unreachable', registry: '127.0.0.1:9', reason: 'connection refused', connectFailure: true }
const TIMEOUT = { state: 'unreachable', registry: '127.0.0.1:9', reason: 'timed out', connectFailure: true }
const HTTP_503 = { state: 'unreachable', registry: 'registry.example', reason: 'it answered HTTP 503', connectFailure: false }

describe('version-check', () => {
  afterEach(() => {
    lookup.fn = vi.fn().mockResolvedValue(REFUSED)
    clearVersionCache()
  })

  it('detects update available', async () => {
    lookup.fn = vi.fn().mockResolvedValue(ok('2.0.0'))
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(true)
    expect(result.latest).toBe('2.0.0')
    expect(result.current).toBe('1.0.0')
    expect(result.checkedAt).toBeTypeOf('number')
  })

  it('no update when current is latest', async () => {
    lookup.fn = vi.fn().mockResolvedValue(ok('1.0.0'))
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(false)
  })

  it('no update when current is newer', async () => {
    lookup.fn = vi.fn().mockResolvedValue(ok('0.9.0'))
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(false)
  })

  it('handles network error gracefully', async () => {
    lookup.fn = vi.fn().mockResolvedValue(REFUSED)
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(false)
    expect(result.latest).toBeNull()
  })

  it('handles non-ok response gracefully', async () => {
    lookup.fn = vi.fn().mockResolvedValue(HTTP_503)
    const result = await checkForUpdate('@plur-ai/core', '1.0.0')
    expect(result.updateAvailable).toBe(false)
    expect(result.latest).toBeNull()
  })

  it('calls onResult callback when update available', async () => {
    lookup.fn = vi.fn().mockResolvedValue(ok('3.0.0'))
    const cb = vi.fn()
    await checkForUpdate('@plur-ai/core', '1.0.0', cb)
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ updateAvailable: true, latest: '3.0.0' }))
  })

  it('compares minor and patch versions correctly', async () => {
    lookup.fn = vi.fn().mockResolvedValue(ok('1.2.3'))
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
    it('returns cached result on second call without a lookup', async () => {
      const mockLookup = vi.fn().mockResolvedValue(ok('2.0.0'))
      lookup.fn = mockLookup

      await checkForUpdate('pkg-a', '1.0.0')
      expect(mockLookup).toHaveBeenCalledTimes(1)

      const result2 = await checkForUpdate('pkg-a', '1.0.0')
      expect(mockLookup).toHaveBeenCalledTimes(1) // no second lookup
      expect(result2.updateAvailable).toBe(true)
    })

    it('getCachedUpdateCheck returns null before any check', () => {
      expect(getCachedUpdateCheck('never-checked')).toBeNull()
    })

    it('getCachedUpdateCheck returns result after check', async () => {
      lookup.fn = vi.fn().mockResolvedValue(ok('5.0.0'))
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
        const mockLookup = vi.fn()
          .mockResolvedValueOnce(ok('1.0.0'))
          .mockResolvedValueOnce(ok('2.0.0'))
        lookup.fn = mockLookup

        // Process starts current — check caches "no update"
        const first = await checkForUpdate('pkg-ttl', '1.0.0')
        expect(first.updateAvailable).toBe(false)

        // Within the TTL the cache is served — no second fetch
        await checkForUpdate('pkg-ttl', '1.0.0')
        expect(mockLookup).toHaveBeenCalledTimes(1)

        // Beyond the TTL the check re-fetches and finds the new release
        const base = Date.now()
        vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)
        const second = await checkForUpdate('pkg-ttl', '1.0.0')
        expect(mockLookup).toHaveBeenCalledTimes(2)
        expect(second.updateAvailable).toBe(true)
        expect(second.latest).toBe('2.0.0')
      })

      it('retries a non-OK registry answer after the failure TTL', async () => {
        // The registry answered (the network is up) but with an error: that is
        // not offline, so an explicit check after the failure TTL asks again.
        const mockLookup = vi.fn()
          .mockResolvedValueOnce(HTTP_503)
          .mockResolvedValueOnce(ok('2.0.0'))
        lookup.fn = mockLookup

        const first = await checkForUpdate('pkg-fail', '1.0.0')
        expect(first.latest).toBeNull()
        expect(updateCheckOffline()).toBe(false)

        // Still inside the failure TTL — negative result served from cache
        await checkForUpdate('pkg-fail', '1.0.0')
        expect(mockLookup).toHaveBeenCalledTimes(1)

        const base = Date.now()
        vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_FAILURE_TTL_MS + 1)
        const second = await checkForUpdate('pkg-fail', '1.0.0')
        expect(mockLookup).toHaveBeenCalledTimes(2)
        expect(second.updateAvailable).toBe(true)
        expect(second.latest).toBe('2.0.0')
      })

      it('getCachedUpdateCheck serves stale synchronously and refreshes in background', async () => {
        const mockLookup = vi.fn()
          .mockResolvedValueOnce(ok('1.0.0'))
          .mockResolvedValueOnce(ok('2.0.0'))
        lookup.fn = mockLookup
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
        expect(mockLookup).toHaveBeenCalledTimes(2)
      })

      it('concurrent checks for the same package share one lookup', async () => {
        let resolveLookup: ((v: unknown) => void) | undefined
        const mockLookup = vi.fn().mockImplementation(() => new Promise((r) => { resolveLookup = r }))
        lookup.fn = mockLookup

        const p1 = checkForUpdate('pkg-dedupe', '1.0.0')
        const p2 = checkForUpdate('pkg-dedupe', '1.0.0')
        resolveLookup!(ok('2.0.0'))
        const [r1, r2] = await Promise.all([p1, p2])
        expect(mockLookup).toHaveBeenCalledTimes(1)
        expect(r1.latest).toBe('2.0.0')
        expect(r2.latest).toBe('2.0.0')
      })
    })

    it('clearVersionCache resets everything', async () => {
      lookup.fn = vi.fn().mockResolvedValue(ok('2.0.0'))
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
      lookup.fn = vi.fn().mockResolvedValue(REFUSED)
      expect(updateCheckOffline()).toBe(false)
      await checkForUpdate('pkg-off', '1.0.0')
      expect(updateCheckOffline()).toBe(true)
    })

    it('while offline, an explicit check after the failure TTL makes no request', async () => {
      const mockLookup = vi.fn()
        .mockResolvedValueOnce(REFUSED)
        .mockResolvedValue(ok('2.0.0'))
      lookup.fn = mockLookup
      await checkForUpdate('pkg-off', '1.0.0')
      const base = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS * 10)
      const r = await checkForUpdate('pkg-off', '1.0.0')
      expect(mockLookup).toHaveBeenCalledTimes(1)
      expect(r.latest).toBeNull()
    })

    it('while offline, no package is checked: the network is down for the process', async () => {
      const mockLookup = vi.fn().mockResolvedValueOnce(REFUSED)
      lookup.fn = mockLookup
      await checkForUpdate('pkg-off', '1.0.0')
      await checkForUpdate('pkg-other', '1.0.0')
      expect(mockLookup).toHaveBeenCalledTimes(1)
    })

    it('while offline, a stale read starts no refresh', async () => {
      const mockLookup = vi.fn()
        .mockResolvedValueOnce(ok('1.0.0'))
        .mockResolvedValueOnce(REFUSED)
        .mockResolvedValue(ok('2.0.0'))
      lookup.fn = mockLookup
      await checkForUpdate('pkg-a', '1.0.0')
      await checkForUpdate('pkg-b', '1.0.0') // cannot connect: offline from here
      const base = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)
      const stale = getCachedUpdateCheck('pkg-a')
      await settleVersionChecks()
      expect(mockLookup).toHaveBeenCalledTimes(2)
      // The earlier answer is still shown.
      expect(stale!.latest).toBe('1.0.0')
      expect(getCachedUpdateCheck('pkg-a')!.latest).toBe('1.0.0')
    })

    it('a timeout counts as cannot connect', async () => {
      lookup.fn = vi.fn().mockResolvedValue(TIMEOUT)
      await checkForUpdate('pkg-off', '1.0.0')
      expect(updateCheckOffline()).toBe(true)
    })

    it('a non-OK registry answer is not offline', async () => {
      lookup.fn = vi.fn().mockResolvedValue(HTTP_503)
      await checkForUpdate('pkg-off', '1.0.0')
      expect(updateCheckOffline()).toBe(false)
    })

    it('clearVersionCache resets the offline mark (tests only)', async () => {
      lookup.fn = vi.fn().mockResolvedValue(REFUSED)
      await checkForUpdate('pkg-off', '1.0.0')
      clearVersionCache()
      expect(updateCheckOffline()).toBe(false)
    })
  })

  describe('a registry that gives no usable answer', () => {
    it('reports the registry and reason, never a version, and advertises nothing', async () => {
      lookup.fn = vi.fn().mockResolvedValue(HTTP_503)
      const r = await checkForUpdate('pkg-fail', '1.0.0')
      expect(r).toEqual({ current: '1.0.0', latest: null, updateAvailable: false, checkedAt: null, failure: { registry: 'registry.example', reason: 'it answered HTTP 503' } })
      expect(formatUpdateCheckFailure(r)).toBe('Could not reach registry.example to check for updates (it answered HTTP 503). No update is advertised.')
    })

    it('a failure after a success replaces the earlier version (never shown as current)', async () => {
      lookup.fn = vi.fn().mockResolvedValueOnce(ok('2.0.0')).mockResolvedValueOnce(HTTP_503)
      await checkForUpdate('pkg-x', '1.0.0')
      const base = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => base + VERSION_CHECK_SUCCESS_TTL_MS + 1)
      const r = await checkForUpdate('pkg-x', '1.0.0')
      vi.restoreAllMocks()
      expect(r.latest).toBeNull()
      expect(r.updateAvailable).toBe(false)
      expect(getCachedUpdateCheck('pkg-x')!.failure?.registry).toBe('registry.example')
    })

    it('a missing npm or a missing package is reported, not offline', async () => {
      lookup.fn = vi.fn().mockResolvedValue({ state: 'no-npm', registry: 'the configured npm registry', reason: 'npm was not found beside this Node' })
      const r = await checkForUpdate('pkg-n', '1.0.0')
      expect(formatUpdateCheckFailure(r)).toBe('Could not reach the configured npm registry to check for updates (npm was not found beside this Node). No update is advertised.')
      expect(updateCheckOffline()).toBe(false)
    })

    it('formatUpdateCheckFailure is null for a good answer', async () => {
      lookup.fn = vi.fn().mockResolvedValue(ok('2.0.0'))
      expect(formatUpdateCheckFailure(await checkForUpdate('pkg-g', '1.0.0'))).toBeNull()
    })
  })

  describe('disk cache (cacheFile)', () => {
    let dir: string
    let file: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-vc-')); file = join(dir, 'cache', 'update-check.json') })
    afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

    it('a fresh answer on disk is used by a new process without a lookup', async () => {
      lookup.fn = vi.fn().mockResolvedValue(ok('2.0.0'))
      await checkForUpdate('pkg-d', '1.0.0', undefined, { cacheFile: file })
      expect(JSON.parse(readFileSync(file, 'utf8'))['pkg-d']).toMatchObject({ latest: '2.0.0', ok: true })
      clearVersionCache() // a new process
      const mockLookup = vi.fn().mockResolvedValue(ok('3.0.0'))
      lookup.fn = mockLookup
      const r = await checkForUpdate('pkg-d', '1.5.0', undefined, { cacheFile: file })
      expect(mockLookup).not.toHaveBeenCalled()
      expect(r).toMatchObject({ current: '1.5.0', latest: '2.0.0', updateAvailable: true })
    })

    it('a failure on disk is reported, not retried within its TTL, and does not mark offline', async () => {
      lookup.fn = vi.fn().mockResolvedValue(REFUSED)
      await checkForUpdate('pkg-d', '1.0.0', undefined, { cacheFile: file })
      clearVersionCache() // a new process
      const mockLookup = vi.fn().mockResolvedValue(ok('3.0.0'))
      lookup.fn = mockLookup
      const r = await checkForUpdate('pkg-d', '1.0.0', undefined, { cacheFile: file })
      expect(mockLookup).not.toHaveBeenCalled()
      expect(r.latest).toBeNull()
      expect(formatUpdateCheckFailure(r)).toContain('Could not reach 127.0.0.1:9 to check for updates (connection refused)')
      expect(updateCheckOffline()).toBe(false)
    })

    it('an expired failure on disk is retried', async () => {
      writeFileSync(join(dir, 'x.json'), JSON.stringify({ 'pkg-d': { latest: null, ok: false, fetchedAt: Date.now() - VERSION_CHECK_FAILURE_TTL_MS - 1, failure: { registry: 'r', reason: 'x' } } }))
      const mockLookup = vi.fn().mockResolvedValue(ok('3.0.0'))
      lookup.fn = mockLookup
      const r = await checkForUpdate('pkg-d', '1.0.0', undefined, { cacheFile: join(dir, 'x.json') })
      expect(mockLookup).toHaveBeenCalledTimes(1)
      expect(r.latest).toBe('3.0.0')
    })

    it('a corrupt cache file is ignored and rewritten', async () => {
      writeFileSync(join(dir, 'x.json'), '{nope')
      lookup.fn = vi.fn().mockResolvedValue(ok('3.0.0'))
      expect((await checkForUpdate('pkg-d', '1.0.0', undefined, { cacheFile: join(dir, 'x.json') })).latest).toBe('3.0.0')
      expect(JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8'))['pkg-d'].latest).toBe('3.0.0')
    })

    it('without cacheFile nothing is written', async () => {
      lookup.fn = vi.fn().mockResolvedValue(ok('3.0.0'))
      await checkForUpdate('pkg-nofile', '1.0.0')
      expect(() => readFileSync(file)).toThrow()
    })
  })
})
