/**
 * Live verification of RemoteStore against the real plur.datafund.io
 * server. Skipped unless PLUR_REMOTE_TEST_TOKEN is set in the env so
 * regular `pnpm test` runs don't depend on network or a live server.
 *
 * Setup before running:
 *   export PLUR_REMOTE_TEST_URL=https://plur.datafund.io
 *   export PLUR_REMOTE_TEST_TOKEN=<JWT or plur_sk_... bearer for plur9>
 *   export PLUR_REMOTE_TEST_SCOPE=user:plur:plur9
 *   pnpm --filter @plur-ai/core test -- remote-store-live
 */
import { describe, it, expect } from 'vitest'
import { RemoteStore } from '../src/store/remote-store.js'

const URL_   = process.env.PLUR_REMOTE_TEST_URL
const TOKEN  = process.env.PLUR_REMOTE_TEST_TOKEN
const SCOPE  = process.env.PLUR_REMOTE_TEST_SCOPE ?? 'user:plur:plur9'

describe.skipIf(!URL_ || !TOKEN)('RemoteStore — live verification', () => {
  it('lists engrams from the remote scope', async () => {
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const all = await store.load()
    expect(Array.isArray(all)).toBe(true)
    // We don't assert a specific count — depends on what's there now.
    // Just verify the shape of any returned engram.
    if (all.length > 0) {
      const e: any = all[0]
      expect(typeof e.id).toBe('string')
      expect(typeof e.scope).toBe('string')
      expect(typeof e.status).toBe('string')
    }
  }, 15_000)

  it('count() returns a number', async () => {
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const n = await store.count()
    expect(n).toBeGreaterThanOrEqual(0)
  }, 15_000)

  it('append() creates a new engram, then load() sees it', async () => {
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const before = await store.count()
    const statement = `RemoteStore live test — ${new Date().toISOString()}`
    await store.append({ statement, scope: SCOPE, status: 'active' } as any)
    // Bust the in-driver cache by waiting past the ttl OR
    // creating a fresh driver
    const fresh = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const after = await fresh.count()
    expect(after).toBeGreaterThanOrEqual(before + 1)
  }, 30_000)

  it('save() throws — bulk-replace is not supported', async () => {
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    await expect(store.save([])).rejects.toThrow(/bulk save/i)
  })
})
