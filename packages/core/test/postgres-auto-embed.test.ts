/**
 * Postgres primary-store auto-embed (#762).
 *
 * The 0.16.0 audit (#752, item 4) measured the gap this file closes: five
 * engrams learned through `Plur` against a `PostgresAdapter` left
 * `engram_embeddings` at ZERO rows, so `vectorIndex: 'hnsw'` indexed an empty
 * table and `recallSemantic` silently fell back to loading the corpus and
 * scoring it in memory — the O(N) path the tier exists to escape. Correct
 * results, wrong performance, no error.
 *
 * These tests pin the closure end to end, through the engine, against a real
 * Postgres:
 *
 *   1. a write through `Plur.learn()` populates `engram_embeddings`;
 *   2. a store migrated in WITH rows but WITHOUT embeddings is backfilled,
 *      kicked by the first semantic recall — which must degrade to the
 *      in-memory path while the table fills, never block, never miss rows;
 *   3. `PLUR_DISABLE_EMBEDDINGS`-style opt-out: writes still land, nothing
 *      crashes, recall falls back — and re-enabling converges the gap;
 *   4. `recallSemantic` actually READS the table once it is complete — proven
 *      behaviourally, not just by call-counting: a stored embedding is
 *      poisoned with the query's own vector, and the poisoned engram tops the
 *      ranking even though its TEXT is unrelated to the query. Only a path
 *      that trusts the stored vectors can produce that ordering.
 *
 * Embeddings use the deterministic stub adapter (`_setCachedEmbedder`, the
 * #335 test seam) so nothing here depends on a model download — the point is
 * the plumbing between engine and store, not embedding quality.
 *
 * Gate follows the house rule: skip when PLUR_TEST_POSTGRES_URL is unset,
 * fail loudly when it is set and the database is broken.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { PostgresAdapter } from '../src/storage-postgres.js'
import { _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled, embed } from '../src/embeddings.js'
import { logger } from '../src/logger.js'

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const SCHEMA = 'plur_auto_embed_762'
const TIMEOUT = 120_000
/** Must match the default vectorDim the adapter sizes its column to (and the
 *  bge-small dim the engine's #335 guard resolves for the active embedder). */
const DIM = 384

/**
 * Deterministic bag-of-tokens embedding: each token hashes to one of DIM
 * buckets, vector is L2-normalized. Similar texts share tokens, share
 * buckets, and score high cosine — enough signal for ranking assertions
 * without a model load.
 */
function stubVec(text: string): Float32Array {
  const v = new Float32Array(DIM)
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)
  for (const t of tokens) {
    let h = 2166136261
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619)
    v[Math.abs(h) % DIM] += 1
  }
  let norm = 0
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm)
  if (norm === 0) { v[0] = 1; return v }
  for (let i = 0; i < DIM; i++) v[i] /= norm
  return v
}

/** (Re)install the deterministic stub as the active embedder. Needed again
 *  after `setEmbeddingsEnabled(false)`, which drops the cached pipeline —
 *  without this, re-enabling would make the next embed() load the real model. */
function installStubEmbedder(): void {
  _setCachedEmbedder({
    name: 'bge-small-en-v1.5',
    dim: DIM,
    modelId: 'stub-762',
    embed: async t => stubVec(t),
    embedBatch: async ts => ts.map(stubVec),
  })
}

describe.skipIf(!PG_URL)('Postgres primary-store auto-embed (#762)', () => {
  let adapter: PostgresAdapter
  let plur: Plur
  let dir: string

  beforeAll(async () => {
    // Intent routing keys off query phrasing; pin it off so ranking
    // assertions cannot be reordered by the classifier.
    process.env.PLUR_INTENT_ROUTING = 'off'
    installStubEmbedder()
    dir = mkdtempSync(join(tmpdir(), 'plur-auto-embed-'))
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    await adapter.save([]) // known-empty store; fails loudly on a broken database
    plur = new Plur({ path: dir, store: adapter })
    await plur.ready()
  }, TIMEOUT)

  afterAll(async () => {
    setEmbeddingsEnabled(true)
    resetEmbedder()
    delete process.env.PLUR_INTENT_ROUTING
    if (adapter) {
      await adapter.dropSchema().catch(() => { /* best effort */ })
      await adapter.close().catch(() => { /* best effort */ })
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TIMEOUT)

  it('learn() populates engram_embeddings — the audit-measured gap (#752 item 4)', async () => {
    const e = await plur.learn('solar panel efficiency improves with active cooling', {
      scope: 'global', type: 'behavioral',
    })
    // The embed pass is fire-and-track — the write itself must not wait on it.
    await plur.waitForIndex()
    expect(await adapter.hasEmbedding(e.id), 'learned engram has no embedding row').toBe(true)
    expect(await adapter.countEmbeddings()).toBeGreaterThan(0)
    expect(plur.lastIndexError()).toBeNull()
  }, TIMEOUT)

  it('a second write converges the whole gap, not just its own row', async () => {
    const a = await plur.learn('kubernetes deploys use rolling updates', { scope: 'global' })
    const b = await plur.learn('espresso extraction takes thirty seconds', { scope: 'global' })
    await plur.waitForIndex()
    expect(await adapter.hasEmbedding(a.id)).toBe(true)
    expect(await adapter.hasEmbedding(b.id)).toBe(true)
    // Set-based invariant: nothing active is left behind.
    expect(await adapter.listEngramsMissingEmbeddings(1)).toEqual([])
  }, TIMEOUT)

  it('recallSemantic READS the table when it is complete — poisoned-vector proof', async () => {
    await plur.waitForIndex()
    const query = 'solar panel cooling'
    // Find the engram whose TEXT is unrelated to the query...
    const all = await adapter.load()
    const espresso = all.find(e => e.statement.includes('espresso'))!
    // ...and poison its STORED vector with the query's own embedding.
    const queryVec = await embed(query, 'query')
    await adapter.upsertEmbedding(espresso.id, queryVec!)

    // Count real k-NN queries too, so a silent fallback cannot pass.
    let vectorCalls = 0
    const real = adapter.searchVector.bind(adapter)
    ;(adapter as unknown as { searchVector: typeof adapter.searchVector }).searchVector = async (q, l, o) => {
      vectorCalls++
      return await real(q, l, o)
    }
    try {
      const hits = await plur.recallSemantic(query, { limit: 3 })
      expect(vectorCalls, 'recallSemantic did not query the vector index').toBe(1)
      // Only a path trusting STORED vectors ranks the espresso engram first —
      // the in-memory path re-embeds its text and would bury it.
      expect(hits[0]?.id, 'ranking ignored the stored vectors').toBe(espresso.id)
    } finally {
      ;(adapter as unknown as { searchVector: typeof adapter.searchVector }).searchVector = real
      // Heal the poisoned row for the tests that follow.
      const { engramSearchText } = await import('../src/fts.js')
      await adapter.upsertEmbedding(espresso.id, (await embed(engramSearchText(espresso)))!)
    }
  }, TIMEOUT)

  it('backfills a store that has rows but no embeddings, kicked by the first semantic recall', async () => {
    // Simulate a corpus migrated in from outside the engine: rows exist,
    // embeddings do not. `save()` through the adapter writes no vectors.
    const corpus = await adapter.load()
    await adapter.dropSchema()
    await adapter.close().catch(() => { /* superseded below */ })
    const adapter2 = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    await adapter2.save(corpus)
    expect(await adapter2.countEmbeddings()).toBe(0)

    const dir2 = mkdtempSync(join(tmpdir(), 'plur-auto-embed-bf-'))
    try {
      const plur2 = new Plur({ path: dir2, store: adapter2 })
      await plur2.ready()

      let vectorCalls = 0
      const real = adapter2.searchVector.bind(adapter2)
      ;(adapter2 as unknown as { searchVector: typeof adapter2.searchVector }).searchVector = async (q, l, o) => {
        vectorCalls++
        return await real(q, l, o)
      }
      try {
        // While the table is incomplete the vector index would return results
        // drawn from whatever subset happens to be embedded — correct-looking,
        // silently incomplete. The read must degrade to the in-memory path...
        const during = await plur2.recallSemantic('solar panel cooling', { limit: 3 })
        expect(vectorCalls, 'used a half-filled vector index').toBe(0)
        expect(during.length).toBeGreaterThan(0)
        expect(during[0].statement).toContain('solar panel')

        // ...while kicking the backfill in the background.
        await plur2.waitForIndex()
        expect(await adapter2.listEngramsMissingEmbeddings(1)).toEqual([])
        expect(await adapter2.countEmbeddings()).toBe(corpus.filter(e => e.status === 'active').length)

        // Once complete, the same call routes through the vector index.
        const after = await plur2.recallSemantic('solar panel cooling', { limit: 3 })
        expect(vectorCalls, 'complete table was not used').toBe(1)
        expect(after[0].statement).toContain('solar panel')
      } finally {
        ;(adapter2 as unknown as { searchVector: typeof adapter2.searchVector }).searchVector = real
      }
      // Hand the (now embedded) store back to the outer fixtures.
      adapter = adapter2
      plur = new Plur({ path: dir, store: adapter2 })
      await plur.ready()
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  }, TIMEOUT)

  it('embedder disabled: writes still land, nothing crashes, recall falls back', async () => {
    setEmbeddingsEnabled(false, 'test: simulating PLUR_DISABLE_EMBEDDINGS')
    let disabledEngramId = ''
    try {
      const before = await adapter.countEmbeddings()
      const e = await plur.learn('written while embeddings are disabled', { scope: 'global' })
      disabledEngramId = e.id
      await plur.waitForIndex()
      // The write landed; the embedding deliberately did not.
      expect((await adapter.load()).map(x => x.id)).toContain(e.id)
      expect(await adapter.countEmbeddings()).toBe(before)
      expect(plur.lastIndexError()).toBeNull()

      // Semantic recall must not throw and must not touch the vector index.
      let vectorCalls = 0
      const real = adapter.searchVector.bind(adapter)
      ;(adapter as unknown as { searchVector: typeof adapter.searchVector }).searchVector = async (q, l, o) => {
        vectorCalls++
        return await real(q, l, o)
      }
      try {
        const hits = await plur.recallSemantic('solar panel cooling', { limit: 3 })
        expect(Array.isArray(hits)).toBe(true)
        expect(vectorCalls).toBe(0)
      } finally {
        ;(adapter as unknown as { searchVector: typeof adapter.searchVector }).searchVector = real
      }
    } finally {
      setEmbeddingsEnabled(true)
      installStubEmbedder() // disabling dropped the cached stub pipeline
    }

    // Re-enabled: the next write sweeps up the engram written while disabled.
    await plur.learn('written after embeddings were re-enabled', { scope: 'global' })
    await plur.waitForIndex()
    expect(await adapter.hasEmbedding(disabledEngramId), 'disabled-era engram was never backfilled').toBe(true)
    expect(await adapter.listEngramsMissingEmbeddings(1)).toEqual([])
  }, TIMEOUT)

  it('scope restrictions ride the semantic pushdown — an empty allow-list returns nothing', async () => {
    await plur.waitForIndex()
    expect(await plur.recallSemantic('solar panel cooling', { limit: 5, scopes: [] })).toEqual([])
    const scoped = await plur.recallSemantic('solar panel cooling', { limit: 5, scopes: ['global'] })
    expect(scoped.every(e => e.scope === 'global')).toBe(true)
  }, TIMEOUT)

  it('a store torn down mid-pass is a cancellation, not a failure — smoke-packaged regression', async () => {
    // The release smoke caught this: its pg step drops the schema and closes
    // the adapter when its work is done, and the still-in-flight auto-embed
    // pass then failed LOUDLY — a stray "auto-embed failed: relation ...
    // does not exist" warning after the process's real output, which broke
    // the smoke's last-line gate. Teardown-under-a-background-pass must be
    // classified as benign: no warning, no lastIndexError.
    const SCHEMA2 = `${SCHEMA}_teardown`
    const a3 = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA2, vectorIndex: 'exact' })
    await a3.save([])
    const dir3 = mkdtempSync(join(tmpdir(), 'plur-auto-embed-td-'))
    const plur3 = new Plur({ path: dir3, store: a3 })
    await plur3.ready()

    // Gate the embedder so the pass is PROVABLY mid-flight when the store is
    // dropped: embed() signals arrival, then blocks until released. Without
    // the gate the pass usually wins the race and the test proves nothing.
    let arrived!: () => void
    const arrival = new Promise<void>(r => { arrived = r })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    _setCachedEmbedder({
      name: 'bge-small-en-v1.5',
      dim: DIM,
      modelId: 'stub-762-gate',
      embed: async t => { arrived(); await gate; return stubVec(t) },
      embedBatch: async ts => ts.map(stubVec),
    })
    const warnSpy = vi.spyOn(logger, 'warning')
    try {
      await plur3.learn('teardown race probe', { scope: 'global' }) // kicks the pass
      await arrival                                                 // pass is inside embed()
      await a3.dropSchema()                                         // teardown wins the race
      release()                                                     // pass resumes into a dropped schema (42P01)
      await plur3.waitForIndex()                                    // resolves — the pass never rejects

      expect(plur3.lastIndexError(), 'teardown was recorded as a background failure').toBeNull()
      const loud = warnSpy.mock.calls.filter(c => String(c[0]).includes('auto-embed failed'))
      expect(loud, 'teardown produced a loud auto-embed warning').toEqual([])
    } finally {
      warnSpy.mockRestore()
      installStubEmbedder() // drop the gated stub before any other test embeds
      await a3.close().catch(() => { /* best effort */ })
      rmSync(dir3, { recursive: true, force: true })
    }
  }, TIMEOUT)
})

/**
 * Embedding staleness on the Postgres tier (#812).
 *
 * The anti-join used to ask only `em.engram_id IS NULL`, so an engram whose
 * text changed kept the vector of its previous text forever — the store had no
 * column that could even express the question. These pin the `content_hash`
 * comparison end to end against a real Postgres: the PGLite tier answers it in
 * JS, this one answers it in SQL (`content_hash IS DISTINCT FROM
 * md5(search_text)`), and the two derivations have to agree or the backfill
 * loop's exit condition is unsatisfiable.
 */
describe.skipIf(!PG_URL)('Postgres embedding staleness (#812)', () => {
  let adapter: PostgresAdapter
  let plur: Plur
  let dir: string

  beforeAll(async () => {
    process.env.PLUR_INTENT_ROUTING = 'off'
    installStubEmbedder()
    dir = mkdtempSync(join(tmpdir(), 'plur-staleness-812-'))
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: `${SCHEMA}_812`, vectorIndex: 'exact' })
    await adapter.save([])
    plur = new Plur({ path: dir, store: adapter })
    await plur.ready()
  }, TIMEOUT)

  afterAll(async () => {
    resetEmbedder()
    delete process.env.PLUR_INTENT_ROUTING
    if (adapter) {
      await adapter.dropSchema().catch(() => { /* best effort */ })
      await adapter.close().catch(() => { /* best effort */ })
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TIMEOUT)

  it('re-embeds an engram whose text changed, and stops once it has', async () => {
    const e = await plur.learn('cats are excellent pets', { scope: 'global', type: 'behavioral' })
    await plur.waitForIndex()
    expect(await adapter.listEngramsMissingEmbeddings(1)).toEqual([])
    const before = await adapter.searchVector(await embed('cats are excellent pets', 'query') as Float32Array, 5)
    const beforeScore = before.find(h => h.engram.id === e.id)!.score

    // Rewrite the statement in place — same id, different meaning. This is the
    // dedup UPDATE/MERGE shape from learn-async.ts.
    const stored = (await adapter.load()).find(x => x.id === e.id)!
    await adapter.updateMany([{ ...stored, statement: 'databases are excellent stores' }])

    // The store must now volunteer it as needing work (the backfill's question:
    // the read path's completeness gate deliberately does NOT ask about staleness).
    const stale = await adapter.listEngramsMissingEmbeddings(10, { includeStale: true })
    expect(stale.map(s => s.id)).toContain(e.id)

    // ...and one pass must clear it, not report it forever.
    await (plur as any)._autoEmbedPrimaryStore(adapter)
    expect(await adapter.listEngramsMissingEmbeddings(1, { includeStale: true })).toEqual([])

    // The vector actually moved: it no longer answers to the OLD text as well.
    const after = await adapter.searchVector(await embed('cats are excellent pets', 'query') as Float32Array, 5)
    const afterScore = after.find(h => h.engram.id === e.id)?.score ?? 0
    expect(afterScore).toBeLessThan(beforeScore)
  }, TIMEOUT)

  it('re-embeds a legacy row stored without a content hash exactly once', async () => {
    const e = await plur.learn('written before content hashing existed', { scope: 'global' })
    await plur.waitForIndex()

    // Simulate a row written by a version predating the column.
    const pool = await (adapter as any).getPool()
    await pool.query(`UPDATE "${SCHEMA}_812".engram_embeddings SET content_hash = NULL WHERE engram_id = $1`, [e.id])
    expect((await adapter.listEngramsMissingEmbeddings(50, { includeStale: true })).map(s => s.id)).toContain(e.id)

    await (plur as any)._autoEmbedPrimaryStore(adapter)

    // Converged — a NULL hash must not mean "stale on every pass forever".
    expect(await adapter.listEngramsMissingEmbeddings(1, { includeStale: true })).toEqual([])
  }, TIMEOUT)
})
