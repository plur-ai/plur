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
