import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteStore } from '../src/store/remote-store.js'

const scope = 'group:audit/review'
const input = { id: 'ENG-LOCAL-001', statement: 'Requires human review', scope, status: 'active', type: 'behavioral', commitment: 'decided' } as any
const row = { ...input, id: 'ENG-SERVER-001', commitment: 'draft', review_state: 'policy', review_required: true }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())

describe('remote acknowledgements are authoritative', () => {
  it.each(['entities', 'episodic', 'exchange', 'insight', 'polarity', 'structured_data'])('refuses unsupported %s content before sending', async key => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const store = new RemoteStore('https://audit.invalid', 'fixture', scope)
    await expect(store.appendAndGetServerId({ ...input, [key]: key === 'structured_data' ? { custom_note: 'Preserve this qualification' } : { note: 'Preserve this qualification' } })).rejects.toThrow(/does not support/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('caches and returns the held state, and replaces repeated IDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? json(row) : json({ rows: [], total_count: 0 })))
    const store = new RemoteStore('https://audit.invalid', 'fixture', scope)
    await store.load()
    const result = await store.appendAndGetServerId(input)
    await store.appendAndGetServerId(input)
    const cached = await store.load()
    expect(cached).toHaveLength(1)
    expect(cached[0].commitment).toBe('draft')
    expect((cached[0] as any).review_state).toBe('policy')
    expect((result as any).engram.commitment).toBe('draft')
  })
  it.each([
    ['ID-only', { id: row.id }],
    ['foreign scope', { ...row, scope: 'group:other/private' }],
    ['malformed state', { ...row, commitment: { invalid: true } }],
  ])('invalidates the cache after a %s acknowledgement', async (_name, response) => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? json(response) : json({ rows: [], total_count: 0 }))
    vi.stubGlobal('fetch', fetcher)
    const store = new RemoteStore('https://audit.invalid', 'fixture', scope)
    await store.load()
    if (_name !== 'ID-only') {
      await expect(store.appendAndGetServerId(input)).rejects.toThrow('acknowledgement')
      expect(await store.load()).toEqual([])
      return
    }
    const result = await store.appendAndGetServerId(input)
    expect(result.id).toBe(row.id) // preserve the confirmed receipt; never retry just because the echo is incomplete
    expect((result as any).engram).toBeUndefined()
    expect(await store.load()).toEqual([])
    expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'POST')).toHaveLength(2)
  })
})
