/**
 * PostgresAdapter — server Postgres as store AND index (ADR-0005, Phase 5).
 *
 * Requires a real Postgres with pgvector. Point `PLUR_TEST_POSTGRES_URL` at
 * one, e.g.
 *
 *   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=... pgvector/pgvector:pg16
 *   PLUR_TEST_POSTGRES_URL=postgres://user:pw@127.0.0.1:5432/db npx vitest run --project core-pglite
 *
 * ## On the gate
 *
 * The suite skips when the variable is unset — there is no server to talk to
 * and pretending otherwise helps nobody. It does NOT skip when the variable is
 * set and the server is broken: `beforeAll` connects and asserts pgvector is
 * available, so a misconfigured or extension-less database fails the run
 * loudly. A suite that quietly passes because its subject was unreachable is
 * worse than no suite.
 *
 * Everything runs inside a per-run schema which is dropped in teardown, so this
 * can share a database with anything else without colliding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { PostgresAdapter, HNSW_RECALL_TARGET } from '../src/storage-postgres.js'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { requiresIndexSync, asDerivedIndex, efSearchFor, PGVECTOR_DEFAULT_EF_SEARCH } from '../src/storage-adapter.js'
import type { Engram } from '../src/schemas/engram.js'

const DSN = process.env.PLUR_TEST_POSTGRES_URL
const VECTOR_DIM = 8
const TIMEOUT = 120_000

const SCHEMA = `plur_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`

function mkEngram(id: string, statement: string, opts: Partial<Engram> = {}): Engram {
  return {
    id,
    statement,
    type: (opts.type ?? 'behavioral') as Engram['type'],
    scope: opts.scope ?? 'project:plur',
    domain: opts.domain ?? 'plur.test',
    status: opts.status ?? 'active',
    tags: opts.tags ?? [],
    activation: {
      retrieval_strength: 1.0,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-07-26',
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    ...(opts as Record<string, unknown>),
  } as unknown as Engram
}

/** Deterministic unit-ish vector so ordering assertions do not depend on luck. */
function vec(seed: number, dim = VECTOR_DIM): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * 1.7 + i * 0.31)
  return v
}

/** Raw query against the adapter's pool — for asserting pgvector's own behaviour. */
async function raw(adapter: PostgresAdapter, sql: string, params: unknown[] = []): Promise<any> {
  await (adapter as unknown as { getPool: () => Promise<any> }).getPool()
  const pool = (adapter as unknown as { pool: any }).pool
  return pool.query(sql, params)
}

describe.skipIf(!DSN)('PostgresAdapter (requires PLUR_TEST_POSTGRES_URL)', () => {
  let adapter: PostgresAdapter

  beforeAll(async () => {
    adapter = new PostgresAdapter({
      connectionString: DSN!,
      schema: SCHEMA,
      vectorDim: VECTOR_DIM,
      vectorIndex: 'exact',
    })
    // Connect eagerly so a broken/extension-less database fails HERE, loudly,
    // instead of being mistaken for "nothing to test".
    const res = await raw(adapter, 'SELECT extversion FROM pg_extension WHERE extname = $1', ['vector'])
    expect(res.rows.length, 'pgvector must be installed in the test database').toBe(1)
  }, TIMEOUT)

  afterAll(async () => {
    if (adapter) {
      await adapter.dropSchema()
      await adapter.close()
    }
  }, TIMEOUT)

  describe('it is a primary store, not a derived index', () => {
    it('declares the primary role, and the role helpers agree', () => {
      expect(adapter.role).toBe('primary')
      // The whole point of ADR-0003's role flag: a write to the store does NOT
      // leave this backend stale, because it IS the store.
      expect(requiresIndexSync(adapter)).toBe(false)
      expect(asDerivedIndex(adapter)).toBeNull()
    })

    it('has no rebuild-from-YAML methods to call', () => {
      expect((adapter as unknown as { syncFromYaml?: unknown }).syncFromYaml).toBeUndefined()
      expect((adapter as unknown as { reindex?: unknown }).reindex).toBeUndefined()
    })

    it('identifies itself as a postgres-kind primary store with a credential-free location', () => {
      expect(adapter.kind).toBe('postgres')
      // `location` is what ends up in logs and status output, so the password
      // from the DSN must not survive into it.
      const password = new URL(DSN!).password
      if (password) expect(adapter.location).not.toContain(password)
      expect(adapter.location).toContain(new URL(DSN!).hostname)
    })
  })

  describe('AsyncPrimaryStore round trip', () => {
    it('saves and loads the corpus', async () => {
      const engrams = [
        mkEngram('ENG-2026-0726-001', 'the store of record is postgres'),
        mkEngram('ENG-2026-0726-002', 'the index and the store are the same engine'),
      ]
      await adapter.save(engrams)
      const loaded = await adapter.load()
      expect(loaded.map(e => e.id)).toEqual(['ENG-2026-0726-001', 'ENG-2026-0726-002'])
      expect(loaded[0].statement).toBe('the store of record is postgres')
      expect(await adapter.count()).toBe(2)
    }, TIMEOUT)

    it('save() is a full replace — an engram absent from the array is gone', async () => {
      await adapter.save([mkEngram('ENG-2026-0726-001', 'kept')])
      const loaded = await adapter.load()
      expect(loaded.map(e => e.id)).toEqual(['ENG-2026-0726-001'])
      expect(loaded[0].statement).toBe('kept')
    }, TIMEOUT)

    it('save() preserves embeddings of surviving engrams and cascades away the rest', async () => {
      await adapter.save([
        mkEngram('ENG-2026-0726-001', 'survivor'),
        mkEngram('ENG-2026-0726-002', 'doomed'),
      ])
      await adapter.upsertEmbedding('ENG-2026-0726-001', vec(1))
      await adapter.upsertEmbedding('ENG-2026-0726-002', vec(2))
      expect(await adapter.countEmbeddings()).toBe(2)

      // Re-saving must not be a truncate: that would destroy every embedding
      // and force a full re-embed of an unchanged corpus.
      await adapter.save([mkEngram('ENG-2026-0726-001', 'survivor')])
      expect(await adapter.hasEmbedding('ENG-2026-0726-001')).toBe(true)
      expect(await adapter.hasEmbedding('ENG-2026-0726-002')).toBe(false)
      expect(await adapter.countEmbeddings()).toBe(1)
    }, TIMEOUT)

    it('saving an empty array empties the store', async () => {
      await adapter.save([])
      expect(await adapter.count()).toBe(0)
      expect(await adapter.load()).toEqual([])
    }, TIMEOUT)

    it('loadCached() goes to the server — a shared store has no honest snapshot', async () => {
      await adapter.save([mkEngram('ENG-2026-0726-010', 'first')])
      const first = await adapter.loadCached()
      expect(first).toHaveLength(1)
      // Simulate another writer. A cache keyed on nothing would miss this.
      await raw(
        adapter,
        `INSERT INTO "${SCHEMA}".engrams (id, status, scope, domain, data) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        ['ENG-2026-0726-011', 'active', 'global', 'plur.test',
          JSON.stringify(mkEngram('ENG-2026-0726-011', 'written by someone else', { scope: 'global' }))],
      )
      expect(await adapter.loadCached()).toHaveLength(2)
    }, TIMEOUT)
  })

  describe('query surface', async () => {
    beforeAll(async () => {
      await adapter.save([
        mkEngram('ENG-2026-0726-101', 'postgres owns the bytes', { scope: 'project:plur', domain: 'plur.storage' }),
        mkEngram('ENG-2026-0726-102', 'yaml owns the bytes', { scope: 'project:plur/sub', domain: 'plur.storage' }),
        mkEngram('ENG-2026-0726-103', 'personal note', { scope: 'local', domain: 'personal.notes' }),
        mkEngram('ENG-2026-0726-104', 'sibling project engram', { scope: 'project:plurality', domain: 'plur.storage' }),
        mkEngram('ENG-2026-0726-105', 'retired engram', { scope: 'project:plur', status: 'retired' }),
      ])
    }, TIMEOUT)

    it('filters by status', async () => {
      const active = await adapter.loadFiltered({ status: 'active' })
      expect(active.map(e => e.id)).not.toContain('ENG-2026-0726-105')
      expect(await adapter.count({ status: 'retired' })).toBe(1)
    }, TIMEOUT)

    it('lets personal-family scopes through a project-scoped read (#402)', async () => {
      const ids = (await adapter.loadFiltered({ scope: 'project:plur' })).map(e => e.id)
      expect(ids).toContain('ENG-2026-0726-103')
    }, TIMEOUT)

    it('includes descendants on a real delimiter but not a sibling prefix (#383)', async () => {
      const ids = (await adapter.loadFiltered({ scope: 'project:plur' })).map(e => e.id)
      expect(ids).toContain('ENG-2026-0726-101')
      expect(ids).toContain('ENG-2026-0726-102')
      // 'project:plurality' merely starts with 'project:plur' as a STRING.
      expect(ids).not.toContain('ENG-2026-0726-104')
    }, TIMEOUT)

    it('filters by domain prefix', async () => {
      const ids = (await adapter.loadFiltered({ domain: 'plur.stor' })).map(e => e.id)
      expect(ids).toContain('ENG-2026-0726-101')
      expect(ids).not.toContain('ENG-2026-0726-103')
    }, TIMEOUT)

    it('runs BM25 through the same scorer as every other backend', async () => {
      const hits = await adapter.searchBM25('postgres bytes', { limit: 5 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].id).toBe('ENG-2026-0726-101')
    }, TIMEOUT)
  })

  describe('embedding write guard (#335)', async () => {
    it('refuses a wrong-dimension vector instead of persisting garbage', async () => {
      await adapter.save([mkEngram('ENG-2026-0726-201', 'guarded')])
      await expect(adapter.upsertEmbedding('ENG-2026-0726-201', new Float32Array(VECTOR_DIM + 1)))
        .rejects.toThrow(/Refusing to persist/)
    }, TIMEOUT)

    it('refuses an embedding for an engram that does not exist — no orphans', async () => {
      await expect(adapter.upsertEmbedding('ENG-2026-0726-999', vec(9)))
        .rejects.toThrow()
    }, TIMEOUT)
  })

  describe('exact vector search', async () => {
    it('declares exact search and returns the true nearest neighbour first', async () => {
      const engrams = Array.from({ length: 12 }, (_, i) =>
        mkEngram(`ENG-2026-0726-3${String(i).padStart(2, '0')}`, `vector subject ${i}`, { scope: 'global' }))
      await adapter.save(engrams)
      for (let i = 0; i < engrams.length; i++) {
        await adapter.upsertEmbedding(engrams[i].id, vec(i))
      }
      expect(adapter.vectorIndex.exact).toBe(true)
      expect(adapter.vectorIndex.kind).toBe('exact')
      expect(adapter.vectorIndex.recallTarget).toBeNull()

      const hits = await adapter.searchVector(vec(5), 3)
      expect(hits[0].engram.id).toBe(engrams[5].id)
      expect(hits[0].score).toBeGreaterThan(0.99)
      // Scores must be monotonically non-increasing.
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score)
      }
    }, TIMEOUT)

    it('excludes non-active engrams from vector results', async () => {
      await adapter.save([
        mkEngram('ENG-2026-0726-401', 'active subject', { scope: 'global' }),
        mkEngram('ENG-2026-0726-402', 'retired subject', { scope: 'global', status: 'retired' }),
      ])
      await adapter.upsertEmbedding('ENG-2026-0726-401', vec(3))
      await adapter.upsertEmbedding('ENG-2026-0726-402', vec(3))
      const hits = await adapter.searchVector(vec(3), 10)
      expect(hits.map(h => h.engram.id)).toEqual(['ENG-2026-0726-401'])
    }, TIMEOUT)
  })
})

/**
 * The approximate tier, and the constant that makes it usable.
 *
 * pgvector's `hnsw.ef_search` defaults to 40. An HNSW scan visits at most that
 * many candidates, so a query asking for more than 40 rows gets fewer — with no
 * error, no warning, and results that look plausible. These tests demonstrate
 * the failure against a real index and then demonstrate the fix.
 */
describe.skipIf(!DSN)('PostgresAdapter — HNSW tier (requires PLUR_TEST_POSTGRES_URL)', async () => {
  const hnswSchema = `${SCHEMA}_hnsw`
  let hnsw: PostgresAdapter
  const ROWS = 200
  const LIMIT = 60

  beforeAll(async () => {
    hnsw = new PostgresAdapter({
      connectionString: DSN!,
      schema: hnswSchema,
      vectorDim: VECTOR_DIM,
      vectorIndex: 'hnsw',
    })
    const engrams = Array.from({ length: ROWS }, (_, i) =>
      mkEngram(`ENG-2026-0726-H${String(i).padStart(3, '0')}`, `hnsw subject ${i}`, { scope: 'global' }))
    await hnsw.save(engrams)
    for (let i = 0; i < ROWS; i++) {
      await hnsw.upsertEmbedding(engrams[i].id, vec(i * 0.37))
    }
    // The index was created at init on an empty table; rebuilding is not
    // required for correctness (HNSW is maintained on insert), but re-checking
    // keeps `vectorIndex` honest about what exists.
    await hnsw.refreshVectorIndex()
  }, TIMEOUT)

  afterAll(async () => {
    if (hnsw) {
      await hnsw.dropSchema()
      await hnsw.close()
    }
  }, TIMEOUT)

  it('declares itself approximate, with a recall target and its parameters', () => {
    const strategy = hnsw.vectorIndex
    expect(strategy.kind).toBe('hnsw')
    expect(strategy.exact).toBe(false)
    expect(strategy.recallTarget).toBe(HNSW_RECALL_TARGET)
    expect(strategy.params.m).toBe(16)
    expect(strategy.params.efConstruction).toBe(64)
  })

  it('DEMONSTRATES the failure: pgvector\'s default ef_search truncates a larger limit', async () => {
    // enable_seqscan=off forces the index path; without it the planner may scan
    // a small table and the ef_search bound would not apply at all.
    const client = await (hnsw as unknown as { pool: any }).pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      await client.query(`SET LOCAL hnsw.ef_search = ${PGVECTOR_DEFAULT_EF_SEARCH}`)
      const res = await client.query(
        `SELECT em.engram_id FROM "${hnswSchema}".engram_embeddings em
         ORDER BY em.embedding <=> $1::vector LIMIT $2`,
        [`[${Array.from(vec(7)).join(',')}]`, LIMIT],
      )
      await client.query('COMMIT')
      expect(res.rows.length).toBeLessThan(LIMIT)
      expect(res.rows.length).toBeLessThanOrEqual(PGVECTOR_DEFAULT_EF_SEARCH)
    } finally {
      client.release()
    }
  }, TIMEOUT)

  it('FIXES it: the adapter\'s ef_search is at least the requested limit', async () => {
    expect(hnsw.efSearchForLimit(LIMIT)).toBeGreaterThanOrEqual(LIMIT)
    const client = await (hnsw as unknown as { pool: any }).pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      await client.query(`SET LOCAL hnsw.ef_search = ${efSearchFor(LIMIT)}`)
      const res = await client.query(
        `SELECT em.engram_id FROM "${hnswSchema}".engram_embeddings em
         ORDER BY em.embedding <=> $1::vector LIMIT $2`,
        [`[${Array.from(vec(7)).join(',')}]`, LIMIT],
      )
      await client.query('COMMIT')
      expect(res.rows.length).toBe(LIMIT)
    } finally {
      client.release()
    }
  }, TIMEOUT)

  it('searchVector() returns the full requested limit end to end', async () => {
    const hits = await hnsw.searchVector(vec(7), LIMIT)
    expect(hits.length).toBe(LIMIT)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score + 1e-6)
    }
  }, TIMEOUT)

  it('recall against the exact answer is at or above the declared target', async () => {
    // The measurement protocol ADR-0005 specifies, run small: same corpus, same
    // query, exact scan as ground truth, |approx ∩ exact| / k.
    const k = 20
    const query = vec(11)
    const approx = await hnsw.searchVector(query, k)
    const client = await (hnsw as unknown as { pool: any }).pool.connect()
    let exactIds: string[]
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = on')
      await client.query('SET LOCAL enable_indexscan = off')
      const res = await client.query(
        `SELECT em.engram_id FROM "${hnswSchema}".engram_embeddings em
         ORDER BY em.embedding <=> $1::vector LIMIT $2`,
        [`[${Array.from(query).join(',')}]`, k],
      )
      await client.query('COMMIT')
      exactIds = res.rows.map((r: any) => r.engram_id)
    } finally {
      client.release()
    }
    const approxIds = new Set(approx.map(h => h.engram.id))
    const overlap = exactIds.filter(id => approxIds.has(id)).length
    expect(overlap / k).toBeGreaterThanOrEqual(HNSW_RECALL_TARGET)
  }, TIMEOUT)
})

/**
 * Cross-adapter parity.
 *
 * `PostgresAdapter.buildFilterClause` is a copy of `PGLiteAdapter`'s. A copy is
 * a divergence waiting to happen, so the invariant is enforced behaviourally
 * rather than by hoping: same corpus, same filters, identical result sets.
 */
describe.skipIf(!DSN)('PGLite and Postgres answer the same filter identically', async () => {
  const paritySchema = `${SCHEMA}_parity`
  let pg: PostgresAdapter
  let pglite: PGLiteAdapter
  let dir: string

  const corpus: Engram[] = [
    mkEngram('ENG-2026-0726-501', 'shared project engram', { scope: 'project:plur', domain: 'plur.storage' }),
    mkEngram('ENG-2026-0726-502', 'nested project engram', { scope: 'project:plur/sub', domain: 'plur.storage.pg' }),
    mkEngram('ENG-2026-0726-503', 'sibling prefix engram', { scope: 'project:plurality', domain: 'plur.storage' }),
    mkEngram('ENG-2026-0726-504', 'personal local engram', { scope: 'local', domain: 'personal.notes' }),
    mkEngram('ENG-2026-0726-505', 'global engram', { scope: 'global', domain: 'plur.storage' }),
    mkEngram('ENG-2026-0726-506', 'agent engram', { scope: 'agent:claude', domain: 'plur.agents' }),
    mkEngram('ENG-2026-0726-507', 'group engram', { scope: 'group:plur/eng', domain: 'plur.storage' }),
    mkEngram('ENG-2026-0726-508', 'retired engram', { scope: 'project:plur', status: 'retired' }),
  ]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-parity-'))
    const yamlPath = join(dir, 'engrams.yaml')
    writeFileSync(yamlPath, yaml.dump({ engrams: corpus }), 'utf8')
    pglite = new PGLiteAdapter(yamlPath, join(dir, 'pglite'), { vectorDim: VECTOR_DIM })
    await pglite.syncFromYaml()

    pg = new PostgresAdapter({
      connectionString: DSN!,
      schema: paritySchema,
      vectorDim: VECTOR_DIM,
      vectorIndex: 'exact',
    })
    await pg.save(corpus)
  }, TIMEOUT)

  afterAll(async () => {
    if (pg) {
      await pg.dropSchema()
      await pg.close()
    }
    if (pglite) await pglite.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TIMEOUT)

  const filters = [
    {},
    { status: 'active' },
    { scope: 'project:plur' },
    { scope: 'project:plur', status: 'active' },
    { scope: 'group:plur/eng' },
    { scope: 'group:plur' },
    { scope: 'local' },
    { domain: 'plur.storage' },
    { domain: 'plur' },
    { scope: 'project:plur', domain: 'plur.storage' },
  ]

  for (const filter of filters) {
    it(`agrees on ${JSON.stringify(filter)}`, async () => {
      const a = (await pg.loadFiltered(filter)).map(e => e.id).sort()
      const b = (await pglite.loadFiltered(filter)).map(e => e.id).sort()
      expect(a).toEqual(b)
    }, TIMEOUT)
  }
})
