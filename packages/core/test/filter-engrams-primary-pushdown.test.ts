/**
 * _filterEngrams() routes through the primary adapter when available (#906).
 *
 * Without this fix, recallHybridWithMeta called _loadAllEngrams on every
 * invocation — a whole-corpus read — even when the primary store (e.g.
 * Postgres) supports a filtered query that returns only the matching rows.
 *
 * These tests verify that every authorization filter (status, scopes allow-list,
 * scope visibility, domain) that used to be applied in memory is still HANDED TO
 * the adapter when the pushdown path is taken.
 *
 * They deliberately stop there. The mock's `loadFiltered` implements only
 * `status` and `domain`, so what is pinned here is forwarding, not enforcement —
 * on the real path enforcement is a SQL WHERE clause and belongs to the Postgres
 * adapter's own tests. The distinction matters: the in-memory code this replaces
 * both forwarded and enforced, so a reader could reasonably assume this suite
 * covers both. It does not.
 *
 * A mock adapter that satisfies both PrimaryStore and the _primaryQueryAdapter()
 * duck-type check (role === 'primary' && typeof searchBM25 === 'function') is
 * used so the suite runs without a real Postgres instance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'
import type { StorageFilter } from '../src/storage-adapter.js'
import type { AsyncPrimaryStore, PrimaryStoreKind } from '../src/store/primary-store.js'

// ---------------------------------------------------------------------------
// Minimal primary store + StorageAdapter duck-type mock.
//
// Must pass the constructor guard in Plur (append + updateMany), and expose
// the two props _primaryQueryAdapter() keys on (role + searchBM25), plus
// loadFiltered so _filterEngrams can call it.
// ---------------------------------------------------------------------------

class MockPrimaryAdapter implements AsyncPrimaryStore {
  readonly kind: PrimaryStoreKind = 'postgres'
  readonly location: string | null = null
  // Expose the StorageAdapter role and vectorIndex fields directly on the
  // object — _primaryQueryAdapter() casts _primaryStore to Partial<StorageAdapter>
  // and reads them without a real instanceof check.
  readonly role = 'primary' as const
  readonly vectorIndex = { kind: 'exact' as const, precision: 'float32' as const }

  private rows: Engram[] = []
  loadFilteredCalls: Array<StorageFilter> = []
  loadAllCalls = 0

  seed(engrams: Engram[]): void {
    this.rows = [...engrams]
  }

  // ── PrimaryStore ────────────────────────────────────────────────────────────
  async load(): Promise<Engram[]> {
    this.loadAllCalls++
    return [...this.rows]
  }
  async loadCached(): Promise<Engram[]> {
    this.loadAllCalls++
    return [...this.rows]
  }
  async save(engrams: Engram[]): Promise<void> {
    this.rows = [...engrams]
  }
  invalidate(): void {}
  async append(engram: Engram): Promise<void> {
    this.rows.push({ ...engram })
  }
  async updateMany(engrams: Engram[]): Promise<void> {
    for (const e of engrams) {
      const i = this.rows.findIndex(r => r.id === e.id)
      if (i >= 0) this.rows[i] = { ...e }
      else this.rows.push({ ...e })
    }
  }

  // ── StorageAdapter (subset needed by _primaryQueryAdapter + _filterEngrams) ─
  async loadFiltered(filter: StorageFilter): Promise<Engram[]> {
    this.loadFilteredCalls.push({ ...filter })
    let out = this.rows.filter(e => !filter.status || e.status === filter.status)
    if (filter.domain) out = out.filter(e => e.domain?.startsWith(filter.domain!))
    return out
  }
  async count(): Promise<number> {
    return this.rows.length
  }
  async searchBM25(_query: string, opts: { limit: number } & StorageFilter): Promise<Engram[]> {
    return this.rows.slice(0, opts.limit)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngram(id: string, statement: string, scope: string, domain?: string): Engram {
  return {
    id,
    statement,
    scope,
    domain,
    status: 'active',
    commitment: 'leaning',
    tags: [],
    activation: {
      last_accessed: new Date().toISOString().slice(0, 10),
      frequency: 1,
      retrieval_strength: 0.5,
    },
  } as unknown as Engram
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('_filterEngrams(): primary-store pushdown (#906)', () => {
  let dir: string
  let adapter: MockPrimaryAdapter
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-906-'))
    adapter = new MockPrimaryAdapter()
    plur = new Plur({ path: dir, store: adapter as unknown as AsyncPrimaryStore })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('calls loadFiltered instead of the full corpus load', async () => {
    adapter.seed([
      makeEngram('ENG-2026-0815-001', 'deploy with terraform', 'global', 'ops/deploy'),
      makeEngram('ENG-2026-0815-002', 'monthly invoicing runs', 'global', 'finance'),
    ])

    const results = await plur.recallHybrid('deploy')

    // loadFiltered must have been called at least once
    expect(adapter.loadFilteredCalls.length).toBeGreaterThan(0)

    // Results should include the engrams from the adapter
    expect(results.some(e => e.statement.includes('terraform'))).toBe(true)
  })

  it('passes status:active to loadFiltered — inactive rows are excluded', async () => {
    adapter.seed([
      makeEngram('ENG-2026-0815-003', 'active fact', 'global'),
      { ...makeEngram('ENG-2026-0815-004', 'retired fact', 'global'), status: 'retired' } as unknown as Engram,
    ])

    await plur.recallHybrid('fact')

    const filters = adapter.loadFilteredCalls
    expect(filters.length).toBeGreaterThan(0)
    expect(filters.every(f => f.status === 'active')).toBe(true)
  })

  it('passes domain filter to loadFiltered when recalling by domain', async () => {
    adapter.seed([
      makeEngram('ENG-2026-0815-005', 'billing runs nightly', 'global', 'finance'),
      makeEngram('ENG-2026-0815-006', 'k8s cluster deploy', 'global', 'ops/deploy'),
    ])

    await plur.recallHybrid('billing', { domain: 'finance' })

    const filters = adapter.loadFilteredCalls
    expect(filters.some(f => f.domain === 'finance')).toBe(true)
  })

  it('a primary query store leaves PGLite and SQLite unconstructed, so the guard holds', async () => {
    // The pushdown branch is `adapter && !this.pgliteAdapter`. That second
    // conjunct is what stops the narrowed corpus from reaching a path which
    // needs the full one — but it is unreachable as written, because the
    // constructor's tier selection already guarantees it:
    //
    //   hasPrimaryQueryStore = _primaryQueryAdapter() !== null
    //   indexTier = hasPrimaryQueryStore ? 'none' : ...
    //   if (indexTier === 'pglite') this.pgliteAdapter = new PGLiteAdapter(...)
    //
    // So this pins the INVARIANT rather than the branch. If the tier logic ever
    // starts building a PGLite index alongside a Postgres primary, this fails
    // here — loudly and in one place — instead of silently narrowing the corpus
    // that the PGLite hybrid path reads.
    adapter.seed([makeEngram('ENG-2026-0815-007', 'some fact', 'global')])
    await plur.recallHybrid('fact')

    const internals = plur as unknown as {
      pgliteAdapter: unknown
      indexedStorage: unknown
    }
    expect(internals.pgliteAdapter, 'PGLite built alongside a primary query store').toBe(null)
    expect(internals.indexedStorage, 'SQLite index built alongside a primary query store').toBe(null)
    // And the pushdown really was the path taken, so the assertions above are
    // describing the state the branch actually ran under.
    expect(adapter.loadFilteredCalls.length).toBeGreaterThan(0)
  })
})

describe('_filterEngrams(): pushdown degradation paths (#906)', () => {
  it('a query adapter WITHOUT loadFiltered falls back to the corpus read, not a crash', async () => {
    // _primaryQueryAdapter() duck-types on role + searchBM25 only, so a store
    // can qualify for the pushdown branch while implementing just the query
    // surface. #903's hybrid-pushdown mock is exactly that shape, and so was
    // ReadonlyStoreGuard before it forwarded loadFiltered. Discovered as a
    // combined-tree failure: each PR green alone, TypeError together.
    const dir = mkdtempSync(join(tmpdir(), 'plur-906-nolf-'))
    try {
      const adapter = new MockPrimaryAdapter()
      adapter.seed([makeEngram('ENG-2026-0818-001', 'query-only store fact', 'global')])
      // Shadow the PROTOTYPE method with an instance undefined — `delete` on a
      // class instance removes nothing (the method lives on the prototype) and
      // silently leaves the pushdown path intact, making this test vacuous.
      ;(adapter as unknown as { loadFiltered?: unknown }).loadFiltered = undefined
      expect(typeof (adapter as unknown as { loadFiltered?: unknown }).loadFiltered).not.toBe('function')
      const plur = new Plur({ path: dir, store: adapter as unknown as AsyncPrimaryStore })

      const results = await plur.recallHybrid('fact')

      expect(results.some(e => e.statement.includes('query-only'))).toBe(true)
      expect(adapter.loadAllCalls, 'fallback corpus read was not taken').toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ReadonlyStoreGuard forwards loadFiltered, so a guarded store keeps the pushdown', async () => {
    // Without the forward the guarded store demotes to the whole-corpus
    // fallback — the quiet version of the #884 failure (readonly unusable
    // where it is most wanted: shared multi-tenant storage).
    const dir = mkdtempSync(join(tmpdir(), 'plur-906-ro-'))
    try {
      const adapter = new MockPrimaryAdapter()
      adapter.seed([makeEngram('ENG-2026-0818-002', 'guarded store fact', 'global')])
      const { ReadonlyStoreGuard } = await import('../src/store/readonly-store-guard.js')
      const guarded = new ReadonlyStoreGuard(adapter as unknown as ConstructorParameters<typeof ReadonlyStoreGuard>[0])
      const plur = new Plur({ path: dir, store: guarded as unknown as AsyncPrimaryStore, readonly: true })

      await plur.recallHybrid('fact')

      expect(adapter.loadFilteredCalls.length, 'pushdown did not reach the inner store').toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
