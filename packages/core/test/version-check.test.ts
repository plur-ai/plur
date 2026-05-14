import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkForUpdate, getCachedUpdateCheck, clearVersionCache, minorVersionsBehind } from '../src/version-check.js'

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
})
