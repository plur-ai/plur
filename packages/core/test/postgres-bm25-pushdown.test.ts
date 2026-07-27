/**
 * BM25 pushdown parity (convergence Phase 4, #711).
 *
 * The pushdown is only worth having if it changes nothing observable. Narrowing
 * in Postgres and scoring in core must produce the SAME ranking as loading the
 * corpus and scoring it locally — otherwise the deployment a user runs answers
 * differently from the one the benchmarks measure, and neither is wrong enough
 * to notice.
 *
 * So the assertions here are equality against the local path, not "the expected
 * engram came back". The latter passes under a broken IDF; the former does not.
 *
 * Gated on PLUR_TEST_POSTGRES_URL. Fails rather than skips when the variable is
 * set but the database is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresAdapter } from '../src/storage-postgres.js'
import { searchEngrams, ftsTokenize, computeIdf, termMatches } from '../src/fts.js'
import type { Engram } from '../src/schemas/engram.js'

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const SCHEMA = 'plur_phase4_pushdown'
const TIMEOUT = 120_000

function makeEngram(id: string, statement: string, scope = 'global'): Engram {
  return {
    id,
    statement,
    type: 'behavioral',
    scope,
    status: 'active',
    visibility: 'private',
    version: 1,
    engram_version: 1,
    consolidated: false,
    reference_count: 0,
    recurrence_count: 0,
    episode_ids: [],
    sources: [],
    tags: [],
    relations: { broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [] },
    activation: { retrieval_strength: 1, storage_strength: 1, last_accessed: null, decay_rate: 0 },
    temporal: { learned_at: '2026-07-27' },
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
  } as unknown as Engram
}

/**
 * A corpus with a deliberately skewed term distribution, so a wrong IDF shows
 * up as a wrong ORDER rather than a missing row. `kubernetes` is rare
 * corpus-wide; `deploy` is everywhere. Narrowing on "deploy kubernetes" returns
 * a set in which that relationship no longer holds locally.
 */
function buildCorpus(): Engram[] {
  const out: Engram[] = []
  for (let i = 0; i < 40; i++) {
    out.push(makeEngram(`ENG-2026-0727-4${String(i).padStart(2, '0')}`, `deploy the billing service revision ${i}`))
  }
  out.push(makeEngram('ENG-2026-0727-500', 'deploy the cluster onto kubernetes nodes'))
  out.push(makeEngram('ENG-2026-0727-501', 'kubernetes autoscaling policy for the ingress tier'))
  for (let i = 0; i < 20; i++) {
    out.push(makeEngram(`ENG-2026-0727-6${String(i).padStart(2, '0')}`, `invoicing reconciliation note ${i}`))
  }
  // Scoped rows, to prove the restriction composes with the pushdown.
  out.push(makeEngram('ENG-2026-0727-700', 'deploy kubernetes to the tenant cluster', 'project:alpha'))
  out.push(makeEngram('ENG-2026-0727-701', 'deploy kubernetes to the other cluster', 'project:beta'))
  return out
}

describe.skipIf(!PG_URL)('BM25 pushdown parity (#711)', () => {
  let adapter: PostgresAdapter
  let corpus: Engram[]

  beforeAll(async () => {
    corpus = buildCorpus()
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    await adapter.save(corpus)
  }, TIMEOUT)

  afterAll(async () => {
    if (adapter) {
      await adapter.dropSchema().catch(() => { /* best effort */ })
      await adapter.close().catch(() => { /* best effort */ })
    }
  }, TIMEOUT)

  it('reports the same corpus size the local path would', async () => {
    const stats = await adapter.corpusStats(ftsTokenize('deploy kubernetes'))
    expect(stats.N).toBe(corpus.length)
  }, TIMEOUT)

  it('counts df exactly as termMatches does over the same corpus', async () => {
    const tokens = ftsTokenize('deploy kubernetes postgres auth')
    const stats = await adapter.corpusStats(tokens)

    for (const qt of tokens) {
      // The local ground truth, computed with the shared rule.
      let expected = 0
      for (const e of corpus) {
        const terms = new Set(ftsTokenize(e.statement))
        if ([...terms].some(t => termMatches(t, qt))) expected++
      }
      expect(stats.df.get(qt), `df mismatch for "${qt}"`).toBe(expected)
    }
  }, TIMEOUT)

  it('produces IDF weights identical to the local path', async () => {
    const tokens = ftsTokenize('deploy kubernetes')
    const stats = await adapter.corpusStats(tokens)

    const local = computeIdf(corpus, tokens)
    const pushed = computeIdf([], tokens, stats)
    for (const t of tokens) {
      expect(pushed.get(t), `idf mismatch for "${t}"`).toBeCloseTo(local.get(t)!, 12)
    }
  }, TIMEOUT)

  it('ranks identically to loading the corpus and scoring locally', async () => {
    // The acceptance criterion. Same corpus, same query, two paths.
    for (const query of ['deploy kubernetes', 'kubernetes', 'deploy', 'invoicing reconciliation']) {
      const viaPushdown = await adapter.searchBM25(query, { limit: 10 })
      const viaLocal = searchEngrams(corpus, query, 10)
      expect(viaPushdown.map(e => e.id), `ranking diverged for "${query}"`).toEqual(viaLocal.map(e => e.id))
    }
  }, TIMEOUT)

  it('applies the scope restriction inside the query, not after it', async () => {
    const scoped = await adapter.searchBM25('deploy kubernetes cluster', { limit: 10, scopes: ['project:alpha'] })
    expect(scoped.map(e => e.id)).toEqual(['ENG-2026-0727-700'])

    // And an empty allow-list means nothing, never "unrestricted".
    const none = await adapter.searchBM25('deploy kubernetes cluster', { limit: 10, scopes: [] })
    expect(none).toEqual([])
  }, TIMEOUT)

  it('scopes the corpus statistics to the same restriction as the search', async () => {
    // df counted over the whole corpus while the candidates come from one scope
    // would be a subtler version of the bug this phase exists to prevent.
    const tokens = ftsTokenize('deploy')
    const all = await adapter.corpusStats(tokens)
    const alpha = await adapter.corpusStats(tokens, { scopes: ['project:alpha'] })

    expect(alpha.N).toBe(1)
    expect(alpha.N).toBeLessThan(all.N)
    expect(alpha.df.get('deploy')).toBe(1)
  }, TIMEOUT)

  it('refuses to report statistics when rows predate the tokens column', async () => {
    // A row written before Phase 4 has NULL tokens and would match nothing,
    // deflating every df silently. The adapter must say so instead.
    const pool = await (adapter as unknown as { getPool(): Promise<{ query: (q: string) => Promise<unknown> }> }).getPool()
    await pool.query(`UPDATE "${SCHEMA}".engrams SET tokens = NULL WHERE id = 'ENG-2026-0727-500'`)
    try {
      await expect(adapter.corpusStats(ftsTokenize('deploy'))).rejects.toThrow(/tokens column/)
    } finally {
      await adapter.save(corpus) // restore
    }
  }, TIMEOUT)

  it('finds a compound identifier by an infix — the case tsvector cannot express', async () => {
    // `auth` is an infix of `transferwithauthorization`, not a prefix. This is
    // the match that forces pg_trgm over a tsvector prefix query, so it is
    // worth pinning rather than assuming.
    const extra = [...corpus, makeEngram('ENG-2026-0727-800', 'the transferWithAuthorization signature is EIP-3009')]
    await adapter.save(extra)
    try {
      const hits = await adapter.searchBM25('auth', { limit: 5 })
      expect(hits.map(e => e.id)).toContain('ENG-2026-0727-800')
      expect(hits.map(e => e.id)).toEqual(searchEngrams(extra, 'auth', 5).map(e => e.id))
    } finally {
      await adapter.save(corpus)
    }
  }, TIMEOUT)
})
