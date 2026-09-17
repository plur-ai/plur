/**
 * #1126 — sequence the namespaced-id forget throw against the scope-unaware path.
 *
 * #1114 added a hard throw in the forget() remote walk gated on `id !== serverId`
 * (the prefix was stripped, so "this store is the intended target"). The throw fires
 * immediately on the first unreachable store whose prefix matches the id.
 *
 * storePrefix() is a lossy 3-char derivation — two distinct scopes can produce the
 * same prefix. For example storePrefix('group:test') === storePrefix('group:tempo')
 * === 'GTE'. Both stores accept id 'ENG-GTE-...' as their own, so a walk that hits
 * the unreachable one first throws before reaching the reachable one that holds the
 * engram. This is the ordering defect: the wrong error (thrown immediately) wins over
 * a successful retirement.
 *
 * Fix: defer the throw until the walk completes. Fire it only if nothing was retired.
 * If a subsequent store retires the engram, the deferred error is discarded silently.
 * Once the walk ends without retirement, "Cannot reach" surfaces above "Engram not
 * found" — more informative, and still actionable.
 *
 * The test is written AFTER A9 landed (#1127 — direct-scope path probeById fix),
 * because A9 changed what the direct-scope path says for unreachable stores and the
 * ordering contract here depends on A9 being settled first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

// storePrefix('group:test') === storePrefix('group:tempo') === 'GTE'.
// Both stores accept 'ENG-GTE-...' as their own namespace — the deliberate
// collision that provokes the ordering defect.
const UNREACHABLE_URL = 'https://unreachable.example.com/sse'
const REACHABLE_URL = 'https://reachable.example.com/sse'
// RemoteStore strips '/sse' and appends '/api/v1', so all requests go to
// these hostnames under /api/v1/ — use hostname-only checks in assertions.
const UNREACHABLE_HOST = 'unreachable.example.com'
const REACHABLE_HOST = 'reachable.example.com'
const SCOPE_UNREACHABLE = 'group:test'
const SCOPE_REACHABLE = 'group:tempo'
// Bare server-side id (prefix stripped). Both stores strip 'GTE-' from the
// caller-facing id, so both see this as the lookup target.
const BARE_ID = 'ENG-2026-09-01-099'
// Namespaced caller-facing id (the form recall surfaces and forget receives).
const NAMESPACED_ID = 'ENG-GTE-2026-09-01-099'

function twoStoreConfig(unreachableFirst: boolean): object {
  const unreachable = { url: UNREACHABLE_URL, token: 'tok', scope: SCOPE_UNREACHABLE, shared: true, readonly: false }
  const reachable = { url: REACHABLE_URL, token: 'tok', scope: SCOPE_REACHABLE, shared: true, readonly: false }
  return {
    stores: unreachableFirst ? [unreachable, reachable] : [reachable, unreachable],
    index: false,
  }
}

describe('forget() — namespaced-id walk order with shared prefix (#1126)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-1126-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as never
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  function mockReachableOwns() {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = (init as any)?.method ?? 'GET'

      if (String(url).includes('unreachable.example.com')) {
        throw new Error('connect ECONNREFUSED 127.0.0.1:443')
      }

      // Reachable store: owns the engram.
      if (method === 'GET' && String(url).includes(`/engrams/${BARE_ID}`)) {
        return {
          ok: true, status: 200,
          json: async () => ({ id: BARE_ID, scope: SCOPE_REACHABLE, status: 'active', data: { statement: 'owned by tempo' } }),
          text: async () => '',
        } as Response
      }
      if (method === 'DELETE' && String(url).includes(`/engrams/${BARE_ID}`)) {
        return {
          ok: true, status: 200,
          json: async () => ({ id: BARE_ID, status: 'retired' }),
          text: async () => '',
        } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    })
  }

  function mockBothUnreachable() {
    fetchMock.mockImplementation(async () => { throw new Error('connect ECONNREFUSED') })
  }

  // Core scenario: unreachable store comes FIRST in the config so the bug fires.
  // Before the fix: throws 'Cannot reach group:test' on the first loop iteration.
  // After the fix: continues past group:test, retires from group:tempo.
  it('retires from the reachable store when the first (unreachable) store shares the prefix', async () => {
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify(twoStoreConfig(/* unreachableFirst */ true)))
    mockReachableOwns()
    const plur = new Plur({ path: dir })

    await expect(plur.forget(NAMESPACED_ID, 'no longer needed', { force: true })).resolves.toBeUndefined()

    // RemoteStore sends DELETE to /api/v1/..., not /sse — filter by hostname.
    const deleteCalls = fetchMock.mock.calls.filter(
      ([url, init]: [string, any]) => (init?.method ?? 'GET') === 'DELETE' && String(url).includes(REACHABLE_HOST),
    )
    expect(deleteCalls.length, 'exactly one DELETE against the reachable store').toBe(1)
    expect(String(deleteCalls[0][0]), 'DELETE targets the bare server-side id').toContain(BARE_ID)

    const wrongDeletes = fetchMock.mock.calls.filter(
      ([url, init]: [string, any]) => (init?.method ?? 'GET') === 'DELETE' && String(url).includes(UNREACHABLE_HOST),
    )
    expect(wrongDeletes.length, 'no DELETE to the unreachable store').toBe(0)
  })

  // Order reversal: reachable store is first. The engram should be retired on the
  // first iteration and the deferred throw should never fire.
  it('retires successfully when the reachable owner comes before the unreachable store', async () => {
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify(twoStoreConfig(/* unreachableFirst */ false)))
    mockReachableOwns()
    const plur = new Plur({ path: dir })

    await expect(plur.forget(NAMESPACED_ID, undefined, { force: true })).resolves.toBeUndefined()
  })

  // Deferred throw fires when the walk completes without a retirement (#1126).
  // "Cannot reach" must surface — not the generic "Engram not found" that would
  // falsely imply the walk verified absence everywhere.
  it('throws "Cannot reach" (not "Engram not found") when all prefix-matching stores are unreachable', async () => {
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify(twoStoreConfig(/* unreachableFirst */ true)))
    mockBothUnreachable()
    const plur = new Plur({ path: dir })

    const message = await plur
      .forget(NAMESPACED_ID, undefined, { force: true })
      .then(() => 'retired', (e: Error) => e.message)

    expect(message, '"Cannot reach" surfaces, not a false claim of absence').toMatch(/Cannot reach/i)
    expect(message, 'must not claim absence it never verified').not.toMatch(/^Engram not found/)
  })
})
