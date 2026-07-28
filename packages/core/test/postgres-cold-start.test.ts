/**
 * N processes cold-starting against ONE fresh database.
 *
 * This is what a server deployment does every time it scales its replicas, and
 * it was broken. Postgres `CREATE ... IF NOT EXISTS` is check-then-act, not
 * atomic: concurrent sessions all pass the existence check, then all but one
 * die on the catalog's unique index (`pg_namespace_nspname_index`,
 * `pg_type_typname_nsp_index`, `pg_class_relname_nsp_index`,
 * `pg_extension_name_index`).
 *
 * Measured on PostgreSQL 16 with 8 workers against an empty schema, before the
 * fix: 7 of 8 failed, across 5 consecutive runs (7, 7, 7, 6, 4).
 *
 * The pgvector arm was worse than a crash. Its catch turned ANY failure into
 * "Install the extension (CREATE EXTENSION vector) as a superuser, or grant the
 * PLUR role rights to create it" — so a race presented as a permissions
 * problem, and the operator would go and fix something that was never wrong.
 *
 * Gated on PLUR_TEST_POSTGRES_URL, like the other Postgres suites.
 *
 * Two mechanisms defend this, and mutation testing says each is independently
 * sufficient: removing the advisory lock alone still passes, and removing the
 * duplicate-object tolerance alone still passes; removing BOTH fails 4 of the
 * 5 tests here. So this suite pins the DEFECT, not either mechanism — do not
 * read a green run as evidence that the lock is still in place. Both are kept
 * deliberately: the lock stops the collision happening at all, and the
 * tolerance covers a rolling upgrade in which an older adapter is doing
 * unlocked DDL against the same database at the same time.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { PostgresAdapter } from '../src/storage-postgres.js'
import type { Engram } from '../src/schemas/engram.js'

function makeEngram(id: string, statement: string): Engram {
  return {
    id, statement,
    type: 'behavioral', scope: 'global', status: 'active', visibility: 'private',
    version: 1, engram_version: 1, consolidated: false,
    reference_count: 0, recurrence_count: 0, episode_ids: [], sources: [], tags: [],
    relations: { broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [] },
    activation: { retrieval_strength: 1, storage_strength: 1, last_accessed: null, decay_rate: 0 },
    temporal: { learned_at: '2026-07-28' },
    created_at: '2026-07-28T00:00:00Z',
    updated_at: '2026-07-28T00:00:00Z',
  } as unknown as Engram
}

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const TIMEOUT = 180_000

/** A distinct schema per test, so every case is a genuine COLD start. */
let counter = 0
const freshSchema = () => `plur_cold_${process.pid}_${counter++}`

describe.skipIf(!PG_URL)('concurrent cold start on a fresh schema', () => {
  let adapters: PostgresAdapter[] = []

  afterEach(async () => {
    await adapters[0]?.dropSchema().catch(() => { /* best effort */ })
    await Promise.all(adapters.map(a => a.close().catch(() => { /* best effort */ })))
    adapters = []
  }, TIMEOUT)

  it('8 workers all initialise the schema without a catalog collision', async () => {
    const schema = freshSchema()
    adapters = Array.from({ length: 8 }, () => new PostgresAdapter({
      connectionString: PG_URL!, schema, vectorIndex: 'exact',
    }))

    const results = await Promise.allSettled(adapters.map(a => a.load()))
    const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]

    expect(
      failed.map(f => String(f.reason?.message ?? f.reason)),
      'a cold start lost the race and reported it as a failure',
    ).toEqual([])
  }, TIMEOUT)

  it('16 workers — the same, under heavier contention', async () => {
    const schema = freshSchema()
    adapters = Array.from({ length: 16 }, () => new PostgresAdapter({
      connectionString: PG_URL!, schema, vectorIndex: 'exact',
    }))
    const results = await Promise.allSettled(adapters.map(a => a.load()))
    expect(results.filter(r => r.status === 'rejected')).toEqual([])
  }, TIMEOUT)

  it('the store is usable afterwards — not merely free of errors', async () => {
    // Swallowing the duplicate-object codes could just as easily hide a schema
    // that was never finished. Prove the table, the columns the BM25 pushdown
    // needs, and the embeddings table all exist by using them.
    const schema = freshSchema()
    adapters = Array.from({ length: 8 }, () => new PostgresAdapter({
      connectionString: PG_URL!, schema, vectorIndex: 'exact',
    }))
    await Promise.all(adapters.map(a => a.load()))

    await adapters[0].save([makeEngram('ENG-COLD-0001', 'a coldstart engram written after concurrent init')])

    for (const a of adapters) {
      const loaded = await a.load()
      expect(loaded.map(e => e.id)).toContain('ENG-COLD-0001')
    }
    expect(await adapters[0].searchBM25('cold-start', { limit: 5 })).not.toHaveLength(0)
  }, TIMEOUT)

  it('works when the pool allows exactly one connection', async () => {
    // The lock is held on a pooled client. Holding one connection for the lock
    // while the DDL asks the pool for a SECOND one deadlocks at maxConnections:1
    // — which is how the first version of this fix failed. It hung rather than
    // erroring, so only a timeout catches it.
    const schema = freshSchema()
    adapters = Array.from({ length: 16 }, () => new PostgresAdapter({
      connectionString: PG_URL!, schema, vectorIndex: 'exact', maxConnections: 1,
    }))
    const results = await Promise.allSettled(adapters.map(a => a.load()))
    expect(results.filter(r => r.status === 'rejected')).toEqual([])
  }, TIMEOUT)

  it('a second cold start against an ALREADY-initialised schema is still clean', async () => {
    // The warm path has to keep working — the lock must be released, not leaked.
    const schema = freshSchema()
    const first = new PostgresAdapter({ connectionString: PG_URL!, schema, vectorIndex: 'exact' })
    await first.load()
    adapters = [first, ...Array.from({ length: 8 }, () => new PostgresAdapter({
      connectionString: PG_URL!, schema, vectorIndex: 'exact',
    }))]
    const results = await Promise.allSettled(adapters.slice(1).map(a => a.load()))
    expect(results.filter(r => r.status === 'rejected')).toEqual([])
  }, TIMEOUT)
})
