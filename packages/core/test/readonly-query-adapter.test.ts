/**
 * #830 — a read-only Plur over a PRIMARY QUERY STORE must keep pushdown.
 *
 * `ReadonlyStoreGuard` forwarded a whitelist and omitted `role`, `searchBM25`,
 * `searchVector` and `vectorIndex`. `_primaryQueryAdapter()` keys on
 * `role === 'primary' && typeof searchBM25 === 'function'`, so a guarded store
 * failed that check, `recall()` fell back to `_filterEngrams()` — and for a
 * store that answers queries itself (which therefore has no `indexedStorage`,
 * because `indexTier` resolves to 'none' when a primary query store is present)
 * that path had nothing to read and threw
 * `Cannot read properties of undefined (reading 'length')`.
 *
 * Which made `readonly: true` unusable exactly where it is most wanted: shared
 * multi-tenant storage, where core's per-read activation write — `recall()`
 * updates `retrieval_strength`, `last_accessed` and `frequency` on every hit —
 * is a real cost rather than a harmless single-user convenience.
 */
import { describe, it, expect } from 'vitest'
import { ReadonlyStoreGuard, ReadonlyStoreError } from '../src/store/readonly-store-guard.js'
import type { Engram } from '../src/schemas/engram.js'

/** Minimal stand-in for a Postgres-backed primary query store. */
function makePrimaryQueryStore() {
  const calls: string[] = []
  return {
    calls,
    store: {
      kind: 'postgres' as never,
      location: 'postgres://stub',
      role: 'primary',
      vectorIndex: { kind: 'hnsw' },
      load: async () => [] as Engram[],
      loadCached: async () => [] as Engram[],
      invalidate: () => {},
      withExclusiveAccess: async <T>(fn: () => Promise<T>) => fn(),
      save: async () => {},
      loadByIds: async () => [] as Engram[],
      append: async () => {},
      updateMany: async () => {},
      nextEngramId: async () => 'ENG-STUB-001',
      searchBM25: async (q: string) => { calls.push(`bm25:${q}`); return [] as Engram[] },
      searchVector: async () => { calls.push('vector'); return [] },
    },
  }
}

describe('ReadonlyStoreGuard forwards the query-adapter surface (#830)', () => {
  it('forwards role — the field _primaryQueryAdapter actually keys on', () => {
    const { store } = makePrimaryQueryStore()
    const guard = new ReadonlyStoreGuard(store as never)
    // Without this the adapter resolver returns null and recall silently loses
    // pushdown before it crashes.
    expect((guard as unknown as { role?: string }).role).toBe('primary')
  })

  it('satisfies the exact predicate _primaryQueryAdapter uses', () => {
    const { store } = makePrimaryQueryStore()
    const g = new ReadonlyStoreGuard(store as never) as unknown as
      { role?: string; searchBM25?: unknown }
    expect(g.role === 'primary' && typeof g.searchBM25 === 'function').toBe(true)
  })

  it('delegates searchBM25 to the inner store', async () => {
    const { store, calls } = makePrimaryQueryStore()
    const guard = new ReadonlyStoreGuard(store as never) as unknown as
      { searchBM25: (q: string, o: { limit: number }) => Promise<Engram[]> }
    await guard.searchBM25('rebase policy', { limit: 5 })
    expect(calls).toContain('bm25:rebase policy')
  })

  it('delegates searchVector and forwards vectorIndex', async () => {
    const { store, calls } = makePrimaryQueryStore()
    const guard = new ReadonlyStoreGuard(store as never) as unknown as
      { searchVector: (...a: unknown[]) => Promise<unknown>; vectorIndex?: { kind: string } }
    await guard.searchVector()
    expect(calls).toContain('vector')
    expect(guard.vectorIndex).toEqual({ kind: 'hnsw' })
  })

  it('still refuses every write — forwarding reads must not open a write path', async () => {
    const { store } = makePrimaryQueryStore()
    const guard = new ReadonlyStoreGuard(store as never)
    await expect(guard.save([])).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(guard.append!({} as Engram)).rejects.toBeInstanceOf(ReadonlyStoreError)
    await expect(guard.updateMany!([])).rejects.toBeInstanceOf(ReadonlyStoreError)
    // nextEngramId is NOT a read: an implementation that makes allocation
    // collision-safe does so by CONSUMING the id, which mutates the store.
    await expect(guard.nextEngramId!('2026-08-13')).rejects.toBeInstanceOf(ReadonlyStoreError)
  })

  it('does not invent a query surface for a store that has none', () => {
    // A plain YAML store declares none of these. The guard must mirror that
    // absence rather than fabricate it, or capability probes see a store that
    // can answer queries when it cannot.
    const plain = {
      kind: 'yaml' as never, location: '/tmp/e.yaml',
      load: async () => [] as Engram[], loadCached: async () => [] as Engram[],
      invalidate: () => {}, withExclusiveAccess: async <T>(fn: () => Promise<T>) => fn(),
      save: async () => {},
    }
    const g = new ReadonlyStoreGuard(plain as never) as unknown as
      { role?: string; searchBM25?: unknown; vectorIndex?: unknown }
    expect(g.role).toBeUndefined()
    expect(g.searchBM25).toBeUndefined()
    expect(g.vectorIndex).toBeUndefined()
  })
})
