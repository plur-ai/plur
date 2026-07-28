import { describe, it, expect } from 'vitest'
import { requiresIndexSync, asDerivedIndex, EXACT_VECTOR_INDEX, type StorageAdapter } from '../src/storage-adapter.js'
import { PGLiteAdapter } from '../src/storage-pglite.js'

/**
 * Convergence Phase 1 — `StorageAdapter` used to be an INDEX interface wearing
 * a generic name: `syncFromYaml()` and `reindex()` were mandatory, which
 * hard-coded "YAML owns the data, this backend is a derived cache". A backend
 * that IS the source of truth (Phase 5's Postgres) cannot honour either method.
 *
 * The fix is a `role` discriminator plus optional rebuild methods. These tests
 * pin the two helpers callers must use instead of assuming the methods exist.
 */

function fakeAdapter(overrides: Partial<StorageAdapter> & Pick<StorageAdapter, 'role'>): StorageAdapter {
  return {
    // `vectorIndex` became required alongside `role` (ADR-0005): a caller must
    // be able to ask whether searchVector() is exact. Exact is the default a
    // stub should claim, since a stub that returns [] loses nothing.
    vectorIndex: EXACT_VECTOR_INDEX,
    loadFiltered: async () => [],
    count: async () => 0,
    searchBM25: async () => [],
    searchVector: async () => [],
    upsertEmbedding: async () => {},
    close: async () => {},
    ...overrides,
  }
}

describe('requiresIndexSync', () => {
  it('is false when there is no adapter at all', () => {
    expect(requiresIndexSync(null)).toBe(false)
    expect(requiresIndexSync(undefined)).toBe(false)
  })

  it('is true for a derived index — a write to the store leaves it stale', () => {
    expect(requiresIndexSync({ role: 'index' })).toBe(true)
  })

  it('is false for a primary-role adapter — the write already landed in it', () => {
    expect(requiresIndexSync({ role: 'primary' })).toBe(false)
  })
})

describe('asDerivedIndex', () => {
  it('narrows an index adapter that implements the rebuild contract', () => {
    const adapter = fakeAdapter({
      role: 'index',
      syncFromYaml: async () => {},
      reindex: async () => {},
    })
    const narrowed = asDerivedIndex(adapter)
    expect(narrowed).not.toBeNull()
    // Type-level proof: these are callable without optional chaining.
    expect(typeof narrowed!.syncFromYaml).toBe('function')
    expect(typeof narrowed!.reindex).toBe('function')
  })

  it('refuses a primary-role adapter even if it somehow carries the methods', () => {
    const adapter = fakeAdapter({
      role: 'primary',
      syncFromYaml: async () => {},
      reindex: async () => {},
    })
    expect(asDerivedIndex(adapter)).toBeNull()
  })

  it('refuses an index-role adapter that does not implement the rebuild methods', () => {
    // A programming error. Returning null means the caller skips the rebuild
    // rather than throwing TypeError deep inside a fire-and-forget chain.
    expect(asDerivedIndex(fakeAdapter({ role: 'index' }))).toBeNull()
  })

  it('is null-safe', () => {
    expect(asDerivedIndex(null)).toBeNull()
    expect(asDerivedIndex(undefined)).toBeNull()
  })
})

describe('PGLiteAdapter role', () => {
  it('declares itself a derived index (ADR-0001: YAML is the source of truth)', () => {
    // Construction is metadata-only — no DB is opened until first use.
    const adapter = new PGLiteAdapter('/nonexistent/engrams.yaml', '/nonexistent/store.pglite')
    expect(adapter.role).toBe('index')
    expect(requiresIndexSync(adapter)).toBe(true)
    expect(asDerivedIndex(adapter)).toBe(adapter)
  })
})
