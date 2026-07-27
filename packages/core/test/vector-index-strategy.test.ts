/**
 * Convergence Phase 5 — the vector-index decision, made explicit (ADR-0005).
 *
 * Core has always answered `searchVector()` with a brute-force cosine scan, so
 * recall was 1.0 by construction and nobody had to ask. Postgres at scale means
 * an approximate index, whose recall is a tuning outcome. The decision taken
 * here is that exactness becomes a DECLARED property of the adapter rather than
 * an assumption a caller inherits — plus one concrete guard against pgvector's
 * most expensive default.
 *
 * `hnsw.ef_search` defaults to 40. An HNSW scan visits at most `ef_search`
 * candidates, so a `LIMIT 50` query on the default returns at most 40 rows —
 * silently, with no error and no warning. That is the failure these tests pin
 * shut.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  EXACT_VECTOR_INDEX,
  PGVECTOR_DEFAULT_EF_SEARCH,
  EF_SEARCH_FILTER_HEADROOM,
  efSearchFor,
  type StorageAdapter,
} from '../src/storage-adapter.js'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import {
  PostgresAdapter,
  HNSW_DEFAULT_M,
  HNSW_DEFAULT_EF_CONSTRUCTION,
  HNSW_RECALL_TARGET,
  redactDsn,
} from '../src/storage-postgres.js'

const DSN = 'postgres://someone:hunter2@db.example:5432/plur'

describe('efSearchFor — ef_search is never below the requested limit', () => {
  it('never returns less than the limit, for any limit', () => {
    for (const limit of [1, 5, 20, 40, 41, 50, 100, 500, 1000]) {
      expect(efSearchFor(limit)).toBeGreaterThanOrEqual(limit)
    }
  })

  it('defeats pgvector\'s own default where it would truncate the result set', () => {
    // The exact case: pgvector ships ef_search = 40, a caller asks for 50.
    // Left alone, the scan yields 40 candidates and the query returns 40 rows.
    expect(PGVECTOR_DEFAULT_EF_SEARCH).toBe(40)
    expect(efSearchFor(50)).toBeGreaterThan(PGVECTOR_DEFAULT_EF_SEARCH)
    expect(efSearchFor(50)).toBeGreaterThanOrEqual(50)
  })

  it('carries headroom for a post-filter the index cannot evaluate', () => {
    // searchVector() filters on status='active' AFTER the vector scan, so
    // ef_search == limit can still come back short. The headroom absorbs a
    // filter that rejects up to half the neighbourhood.
    expect(efSearchFor(100)).toBe(100 * EF_SEARCH_FILTER_HEADROOM)
  })

  it('lets an operator raise the floor but never lower it', () => {
    expect(efSearchFor(10, 400)).toBe(400)
    // A configured value below the limit must not win — that is the bug.
    expect(efSearchFor(200, 40)).toBeGreaterThanOrEqual(200)
  })

  it('is total on degenerate limits', () => {
    expect(efSearchFor(0)).toBeGreaterThanOrEqual(1)
    expect(efSearchFor(-5)).toBeGreaterThanOrEqual(1)
  })
})

describe('StorageAdapter.vectorIndex — a caller can ask what it is getting', () => {
  it('exposes the exact-search constant with recall unset rather than faked', () => {
    expect(EXACT_VECTOR_INDEX.kind).toBe('exact')
    expect(EXACT_VECTOR_INDEX.exact).toBe(true)
    // Not 1.0: exact search has no recall TARGET, it has a guarantee. A number
    // here would invite someone to compare it against a tuned one.
    expect(EXACT_VECTOR_INDEX.recallTarget).toBeNull()
  })

  it('PGLite declares exact search — it builds no vector index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-vindex-'))
    try {
      const adapter = new PGLiteAdapter(join(dir, 'engrams.yaml'), join(dir, 'pglite'))
      const strategy = (adapter as StorageAdapter).vectorIndex
      expect(strategy.kind).toBe('exact')
      expect(strategy.exact).toBe(true)
      expect(strategy.format).toBe('float32')
      expect(strategy.params).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Postgres declares exact search when the index mode is exact', () => {
    const adapter = new PostgresAdapter({ connectionString: DSN, vectorIndex: 'exact' })
    expect(adapter.vectorIndex.exact).toBe(true)
    expect(adapter.vectorIndex.recallTarget).toBeNull()
  })

  it('Postgres reports its role as primary — store and index are one engine', () => {
    const adapter = new PostgresAdapter({ connectionString: DSN })
    expect(adapter.role).toBe('primary')
    expect(adapter.kind).toBe('postgres')
    // A primary-role adapter must NOT carry the derived-index rebuild methods:
    // there is no file to rebuild from.
    expect((adapter as unknown as { syncFromYaml?: unknown }).syncFromYaml).toBeUndefined()
    expect((adapter as unknown as { reindex?: unknown }).reindex).toBeUndefined()
  })

  it('surfaces the HNSW parameters in force rather than leaving them implicit', () => {
    const adapter = new PostgresAdapter({ connectionString: DSN, vectorIndex: 'hnsw' })
    // Before init the adapter has not confirmed the index exists, so it must
    // report exact — claiming HNSW it has not built would be the same silent
    // divergence in the other direction.
    expect(adapter.vectorIndex.exact).toBe(true)
    // The parameters themselves are still knowable and are pgvector's defaults,
    // restated so they are visible instead of inherited.
    expect(HNSW_DEFAULT_M).toBe(16)
    expect(HNSW_DEFAULT_EF_CONSTRUCTION).toBe(64)
    expect(HNSW_RECALL_TARGET).toBeGreaterThan(0.9)
    expect(HNSW_RECALL_TARGET).toBeLessThanOrEqual(1)
  })

  it('computes an ef_search at least as large as the limit for any query', () => {
    const adapter = new PostgresAdapter({ connectionString: DSN })
    for (const limit of [10, 40, 64, 250]) {
      expect(adapter.efSearchForLimit(limit)).toBeGreaterThanOrEqual(limit)
    }
  })
})

describe('PostgresAdapter — construction guards', () => {
  it('refuses a schema name it would have to interpolate unsafely', () => {
    expect(() => new PostgresAdapter({ connectionString: DSN, schema: 'evil"; DROP SCHEMA plur; --' }))
      .toThrow(/not a plain SQL identifier/)
  })

  it('refuses nonsense tuning values instead of passing them into DDL', () => {
    expect(() => new PostgresAdapter({ connectionString: DSN, hnswM: 0 })).toThrow(/positive integer/)
    expect(() => new PostgresAdapter({ connectionString: DSN, efSearch: -1 })).toThrow(/positive integer/)
    expect(() => new PostgresAdapter({ connectionString: DSN, vectorDim: 1.5 })).toThrow(/positive integer/)
  })

  it('requires a connection string', () => {
    expect(() => new PostgresAdapter({ connectionString: '' })).toThrow(/connectionString is required/)
  })

  it('never exposes the password through `location`', () => {
    const adapter = new PostgresAdapter({ connectionString: DSN })
    expect(adapter.location).not.toContain('hunter2')
    expect(adapter.location).toContain('db.example')
    // libpq key=value form too — `location` feeds logs and status output.
    expect(redactDsn('host=db.example password=hunter2 dbname=plur')).not.toContain('hunter2')
  })
})
