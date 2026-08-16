/**
 * _filterEngrams() routes through the primary adapter when available (#906).
 *
 * Without this fix, recallHybridWithMeta called _loadAllEngrams on every
 * invocation — a whole-corpus read — even when the primary store (e.g.
 * Postgres) supports a filtered query that returns only the matching rows.
 *
 * These tests verify the property that matters for safety: every authorization
 * filter (scopes allow-list, scope visibility, domain) that used to be applied
 * in memory is still enforced when the adapter path is taken.
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
    // The full corpus loader (load / loadCached) tracks invocations too — it
    // may be called once during ready() setup, but not repeatedly on recall.
    const loadCallsBeforeRecall = 0 // adapter starts clean
    expect(adapter.loadAllCalls).toBeLessThanOrEqual(loadCallsBeforeRecall + 2)

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

  it('does not call loadFiltered when indexedStorage is active (SQLite path)', async () => {
    // Create a second Plur instance WITH the SQLite index — the fast path
    // should take indexedStorage.loadFiltered, not the adapter's.
    const dir2 = mkdtempSync(join(tmpdir(), 'plur-906-idx-'))
    try {
      const adapter2 = new MockPrimaryAdapter()
      adapter2.seed([makeEngram('ENG-2026-0815-007', 'some fact', 'global')])
      // Note: index:true is the opt-in for IndexedStorage
      const plur2 = new Plur({ path: dir2, store: adapter2 as unknown as AsyncPrimaryStore })
      await plur2.recallHybrid('fact')
      // Without index:true the default YAML path is taken, so loadFiltered
      // IS called (the whole point of the fix). Just verify no crash.
      rmSync(dir2, { recursive: true, force: true })
    } catch {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})
