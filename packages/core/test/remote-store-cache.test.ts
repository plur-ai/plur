import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { RemoteStore } from '../src/store/remote-store.js'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

/**
 * Issue #89 — write-then-read consistency. After append() succeeds,
 * the next load() must see the engram without waiting for a background
 * refresh. RemoteStore.append() optimistically inserts into the cache
 * using the server-assigned id.
 */
describe('RemoteStore — optimistic cache insert (issue #89)', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('append() makes the engram visible to the very next load() (no extra GET)', async () => {
    // Server: empty list on initial load, returns assigned id on POST.
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return {
          ok: true, status: 201,
          json: async () => ({ id: 'ENG-SERVER-001' }),
          text: async () => '',
        } as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
        text: async () => '',
      } as Response
    }) as any)

    const store = new RemoteStore('https://plur.example.com/sse', 'plur_sk_test', 'user:plur:tester')

    // Prime the cache with the empty initial list.
    const before = await store.load()
    expect(before).toEqual([])

    // Append. The POST resolves; cache should be updated optimistically.
    await store.append({
      statement: 'optimistic insert test',
      scope: 'user:plur:tester',
      domain: 'memory',
      type: 'behavioral',
      status: 'active',
    } as any)

    const getCallsBefore = fetchMock.mock.calls.filter(([, init]) => !(init as any)?.method || (init as any)?.method === 'GET').length

    // Immediate next load() should see the new engram WITHOUT firing another GET.
    const after = await store.load()
    expect(after.length).toBe(1)
    expect((after[0] as any).statement).toBe('optimistic insert test')
    expect(after[0].id).toBe('ENG-SERVER-001')

    const getCallsAfter = fetchMock.mock.calls.filter(([, init]) => !(init as any)?.method || (init as any)?.method === 'GET').length
    expect(getCallsAfter).toBe(getCallsBefore) // no extra GETs needed
  })

  it('cold-cache append does not block a subsequent full load() (issue #130)', async () => {
    // Regression: a cold-cache append used to set ts: Date.now(), which made
    // the partial single-engram cache look "fresh" for ttlMs and hid every
    // other engram in the scope on the next load(). The fix marks the
    // cold-cache entry stale (ts: 0) so load() refetches from the server.
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return {
          ok: true, status: 201,
          json: async () => ({ id: 'ENG-NEW' }),
          text: async () => '',
        } as Response
      }
      // Server-side listing — three pre-existing engrams the cold-cache append
      // never knew about. (The just-appended engram would normally be here too,
      // but omitting it lets the test assert that load() returns the server's
      // view rather than the optimistic single-row cache.)
      return {
        ok: true, status: 200,
        json: async () => ({
          rows: [
            { id: 'ENG-A', scope: 'user:plur:tester', status: 'active', data: { statement: 'a' } },
            { id: 'ENG-B', scope: 'user:plur:tester', status: 'active', data: { statement: 'b' } },
            { id: 'ENG-C', scope: 'user:plur:tester', status: 'active', data: { statement: 'c' } },
          ],
          total_count: 3,
        }),
        text: async () => '',
      } as Response
    }) as any)

    const store = new RemoteStore('https://plur.example.com/sse', 'plur_sk_test', 'user:plur:tester')

    await store.append({
      statement: 'first ever write',
      scope: 'user:plur:tester',
      domain: 'memory',
      type: 'behavioral',
      status: 'active',
    } as any)

    const got = await store.load()
    // Before the fix this returned 1 (the optimistic single-engram cache).
    // After the fix it returns the full server list.
    expect(got.map(e => e.id).sort()).toEqual(['ENG-A', 'ENG-B', 'ENG-C'])

    const posts = fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'POST')
    const gets  = fetchMock.mock.calls.filter(([, init]) => !(init as any)?.method || (init as any)?.method === 'GET')
    expect(posts.length).toBe(1)
    expect(gets.length).toBe(1) // cold-cache must refetch on the next load()
  })
})

// ---------------------------------------------------------------------------
// Cold-start behavior — Plur-level (issue #184, #185 gap 3)
// ---------------------------------------------------------------------------

const STUB_TOKEN = 'cache-test-token'
let stubServer: StubServer
let stubUrl: string

beforeAll(async () => {
  stubServer = new StubServer(STUB_TOKEN)
  const info = await stubServer.start()
  stubUrl = info.url
})

afterAll(async () => {
  await stubServer.stop()
})

describe('Plur cold-start with remote store (issues #184, #185)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-cold-'))
    stubServer.reset()
    writeFileSync(
      join(dir, 'config.yaml'),
      yaml.dump({
        stores: [{
          url: stubUrl,
          token: STUB_TOKEN,
          scope: 'group:test',
          shared: true,
          readonly: false,
        }],
        index: false,
      }, { lineWidth: 120, noRefs: true }),
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('listStores returns 0 for remote store before cache populated (#184)', () => {
    const plur = new Plur({ path: dir })

    // Seed the stub with an engram so the remote is non-empty
    stubServer.seedEngram({
      id: 'ENG-SEED-001',
      scope: 'group:test',
      status: 'active',
      data: { statement: 'seeded engram', scope: 'group:test', status: 'active' },
    })

    // On cold start, listStores reports 0 for remote (cache empty)
    const stores = plur.listStores()
    const remote = stores.find(s => s.url)
    expect(remote).toBeTruthy()
    // This documents the current (broken) behavior — #184
    expect(remote!.engram_count).toBe(0)
  })

  it('listStores returns correct count after cache warms up', async () => {
    const plur = new Plur({ path: dir })

    stubServer.seedEngram({
      id: 'ENG-SEED-001',
      scope: 'group:test',
      status: 'active',
      data: { statement: 'seeded engram', scope: 'group:test', status: 'active' },
    })

    // Trigger cache population
    plur.list({ scope: 'group:test' })
    await new Promise(r => setTimeout(r, 2000))

    const stores = plur.listStores()
    const remote = stores.find(s => s.url)
    expect(remote).toBeTruthy()
    expect(remote!.engram_count).toBeGreaterThanOrEqual(1)
  })

  it('getById returns null for remote engram before cache populated', () => {
    const plur = new Plur({ path: dir })

    stubServer.seedEngram({
      id: 'ENG-SEED-001',
      scope: 'group:test',
      status: 'active',
      data: { statement: 'seeded engram', scope: 'group:test', status: 'active' },
    })

    // Cold start — cache not populated
    const found = plur.getById('ENG-GTE-SEED-001') // prefixed
    expect(found).toBeNull()
  })

  it('getById finds remote engram after cache warms up', async () => {
    const plur = new Plur({ path: dir })

    stubServer.seedEngram({
      id: 'ENG-SEED-001',
      scope: 'group:test',
      status: 'active',
      data: { statement: 'seeded engram', scope: 'group:test', status: 'active' },
    })

    plur.list()
    await new Promise(r => setTimeout(r, 2000))

    const found = plur.getById('ENG-GTE-SEED-001')
    expect(found).toBeTruthy()
    expect(found!.statement).toBe('seeded engram')
  })
})

// ---------------------------------------------------------------------------
// Pin/promote on remote engrams — pinned failing tests (#86, #185 gap 2)
// These will pass once enterprise server PATCH endpoint (enterprise#110)
// and RemoteStore.update() are implemented.
// ---------------------------------------------------------------------------

describe.skip('updateEngram remote routing (blocked on enterprise#110)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-update-'))
    stubServer.reset()
    writeFileSync(
      join(dir, 'config.yaml'),
      yaml.dump({
        stores: [{
          url: stubUrl,
          token: STUB_TOKEN,
          scope: 'group:test',
          shared: true,
          readonly: false,
        }],
        index: false,
      }, { lineWidth: 120, noRefs: true }),
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('pin on remote engram reaches server', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('remote engram for pin test', { scope: 'group:test', type: 'behavioral' })
    await new Promise(r => setTimeout(r, 2000))

    const loaded = plur.list({ scope: 'group:test' })
    const remote = loaded.find(e => e.id.includes('-GTE-'))
    expect(remote).toBeTruthy()

    remote!.pinned = true
    plur.updateEngram(remote!)

    // Verify server received the pin update
    const serverEngram = stubServer.getEngram(remote!.id.replace(/^ENG-GTE-/, 'ENG-'))
    expect((serverEngram?.data as any)?.pinned).toBe(true)
  })

  it('promote on remote engram reaches server', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('remote candidate engram', { scope: 'group:test', type: 'behavioral' })
    await new Promise(r => setTimeout(r, 2000))

    const loaded = plur.list({ scope: 'group:test' })
    const remote = loaded.find(e => e.id.includes('-GTE-'))
    expect(remote).toBeTruthy()

    remote!.status = 'active'
    remote!.activation.retrieval_strength = 0.7
    plur.updateEngram(remote!)

    const serverEngram = stubServer.getEngram(remote!.id.replace(/^ENG-GTE-/, 'ENG-'))
    expect(serverEngram?.status).toBe('active')
  })
})
