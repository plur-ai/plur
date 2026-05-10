import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteStore } from '../src/store/remote-store.js'

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

  it('append() initialises the cache when no prior load() has happened', async () => {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return {
          ok: true, status: 201,
          json: async () => ({ id: 'ENG-SERVER-002' }),
          text: async () => '',
        } as Response
      }
      // Should NOT be reached in this test — load() reads from the optimistic cache.
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
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
    expect(got.length).toBe(1)
    expect((got[0] as any).statement).toBe('first ever write')
    expect(got[0].id).toBe('ENG-SERVER-002')

    // Only the POST should have hit the network — load() served from optimistic cache.
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'POST')
    const gets  = fetchMock.mock.calls.filter(([, init]) => !(init as any)?.method || (init as any)?.method === 'GET')
    expect(posts.length).toBe(1)
    expect(gets.length).toBe(0)
  })
})
