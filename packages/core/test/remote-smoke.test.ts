/**
 * Production smoke tests against plur.datafund.io (or any live server).
 *
 * Skipped unless PLUR_REMOTE_TEST_TOKEN is set — regular `pnpm test` runs
 * don't depend on network or a live server. Run manually after publishing
 * or when verifying the production deployment.
 *
 * ## Setup
 *
 *   export PLUR_REMOTE_TEST_URL=https://plur.datafund.io
 *   export PLUR_REMOTE_TEST_TOKEN=<JWT or plur_sk_... bearer token>
 *   export PLUR_REMOTE_TEST_SCOPE=group:plur/test/smoke
 *   pnpm test:smoke
 *
 * ## What this covers
 *
 * Full roundtrip against production: learn → getById → load → remove.
 * All test engrams are tagged with a unique marker and cleaned up in afterAll.
 *
 * ## Credential provisioning
 *
 * Needs a dedicated test scope + token on the enterprise server. See:
 * https://github.com/plur-ai/plur/issues/TBD (smoke test credentials)
 *
 * ## What this does NOT cover
 *
 * - Testing the published npm artifact (installs from npm) — low priority follow-up
 * - Running automatically in CI after publish — blocked by #59 (publish workflow)
 *
 * See: https://github.com/plur-ai/plur/issues/83
 * Test plan: 3-plur/1-tracks/engineering/remote-store-test-plan.md (Level 4)
 */

import { describe, it, expect, afterAll } from 'vitest'
import { RemoteStore } from '../src/store/remote-store.js'

const URL_   = process.env.PLUR_REMOTE_TEST_URL
const TOKEN  = process.env.PLUR_REMOTE_TEST_TOKEN
const SCOPE  = process.env.PLUR_REMOTE_TEST_SCOPE ?? 'group:plur/test/smoke'

// Unique marker for this run — enables cleanup
const RUN_ID = `smoke-${Date.now()}`
const marker = (label: string) => `[${RUN_ID}] ${label}`

// Track IDs created during this run for cleanup
const createdIds: string[] = []

describe.skipIf(!URL_ || !TOKEN)('Production smoke — live server', () => {

  afterAll(async () => {
    // Best-effort cleanup: delete all engrams created during this run
    if (!URL_ || !TOKEN) return
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    for (const id of createdIds) {
      try {
        await store.remove(id)
      } catch {
        console.warn(`[smoke] cleanup failed for ${id} — manual deletion may be needed`)
      }
    }
  })

  it('append creates an engram on the server', async () => {
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const before = await store.count()

    await store.append({
      statement: marker('append test'),
      scope: SCOPE,
      status: 'active',
    } as any)

    // Fresh driver to bypass TTL cache
    const fresh = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const after = await fresh.count()
    expect(after).toBeGreaterThanOrEqual(before + 1)

    // Find the engram we just created for cleanup
    const all = await fresh.load()
    const ours = all.find(e => (e as any).statement?.includes(RUN_ID))
    if (ours) createdIds.push(ours.id)
  }, 30_000)

  it('getById returns the created engram', async () => {
    // Create a fresh engram with known content
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    await store.append({
      statement: marker('getById test'),
      scope: SCOPE,
      status: 'active',
    } as any)

    // Find it via load (to get server-assigned ID)
    const fresh = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const all = await fresh.load()
    const ours = all.find(e => (e as any).statement?.includes('getById test') && (e as any).statement?.includes(RUN_ID))
    expect(ours).toBeDefined()
    createdIds.push(ours!.id)

    // getById should find it
    const found = await fresh.getById(ours!.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(ours!.id)
  }, 30_000)

  it('remove retires an engram on the server', async () => {
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    await store.append({
      statement: marker('remove test'),
      scope: SCOPE,
      status: 'active',
    } as any)

    // Find it
    const fresh = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const all = await fresh.load()
    const ours = all.find(e => (e as any).statement?.includes('remove test') && (e as any).statement?.includes(RUN_ID))
    expect(ours).toBeDefined()

    // Remove it
    const removed = await fresh.remove(ours!.id)
    expect(removed).toBe(true)

    // Verify it's retired (getById may still return it with status=retired)
    const afterRemove = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const check = await afterRemove.getById(ours!.id)
    if (check) {
      expect(check.status).toBe('retired')
    }
    // Already cleaned up via remove — don't add to createdIds
  }, 30_000)

  it('scope filtering returns only matching engrams', async () => {
    const store = new RemoteStore(URL_!, TOKEN!, SCOPE)
    await store.append({
      statement: marker('scope filter test'),
      scope: SCOPE,
      status: 'active',
    } as any)

    const fresh = new RemoteStore(URL_!, TOKEN!, SCOPE)
    const all = await fresh.load()

    // All returned engrams should match the requested scope
    for (const e of all) {
      expect(e.scope).toBe(SCOPE)
    }

    // Our test engram should be in the list
    const ours = all.find(e => (e as any).statement?.includes('scope filter test') && (e as any).statement?.includes(RUN_ID))
    expect(ours).toBeDefined()
    createdIds.push(ours!.id)
  }, 30_000)

  it('bad token returns empty list (not crash)', async () => {
    const badStore = new RemoteStore(URL_!, 'invalid-token-xxx', SCOPE)
    const all = await badStore.load()
    expect(all).toEqual([])
  }, 15_000)
})
