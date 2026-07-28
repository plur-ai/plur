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

describe.skipIf(!PG_URL)('PostgresAdapter — scope restriction as an AUTHORIZATION control', () => {
  let adapter: PostgresAdapter
  let corpus: Engram[]

  beforeAll(async () => {
    corpus = buildCorpus()
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: 'plur_authz_check', vectorIndex: 'exact' })
    await adapter.save(corpus)
  }, TIMEOUT)

  afterAll(async () => {
    if (adapter) {
      await adapter.dropSchema().catch(() => { /* best effort */ })
      await adapter.close().catch(() => { /* best effort */ })
    }
  }, TIMEOUT)

  // These four cover the hole the audit found: `buildFilterClause` had no
  // branch for `filter.scopes` at all, so loadFiltered returned every scope —
  // including for `scopes: []`, which must return nothing. PGLite implemented
  // it correctly, Postgres did not, and no test compared them.
  it('loadFiltered honours a non-empty allow-list', async () => {
    const rows = await adapter.loadFiltered({ status: 'active', scopes: ['project:alpha'] })
    expect(rows.map(e => e.id)).toEqual(['ENG-2026-0727-700'])
  }, TIMEOUT)

  it('loadFiltered with an EMPTY allow-list returns nothing, never everything', async () => {
    // The privilege-escalation case. A principal with zero permitted scopes
    // must see zero engrams; a truthiness guard would let `[]` fall through to
    // no clause and return the whole corpus.
    expect(await adapter.loadFiltered({ status: 'active', scopes: [] })).toEqual([])
  }, TIMEOUT)

  it('loadFiltered with an ABSENT allow-list is unrestricted', async () => {
    const rows = await adapter.loadFiltered({ status: 'active' })
    expect(rows.length).toBe(corpus.length)
  }, TIMEOUT)

  it('does no hierarchy expansion — an allow-list is exact membership', async () => {
    // `scopes` is authorization, not visibility: it must NOT admit descendants
    // or pass personal-family scopes through, both of which `filter.scope` does.
    const rows = await adapter.loadFiltered({ status: 'active', scopes: ['project'] })
    expect(rows).toEqual([])
  }, TIMEOUT)

  it('searchVector applies the restriction inside the k-NN query', async () => {
    // searchVector previously omitted the `opts` parameter entirely; TypeScript
    // accepted the narrower arity, so callers passing `scopes` got an
    // unrestricted search with no error.
    //
    // This test used to run against a fixture with NO embeddings stored, and
    // asserted `searchVector(v, 10, { scopes: [] })` returned []. Of course it
    // did — with no vectors in the table it returns [] whether or not the
    // filter is applied. The assertion could not fail. Real embeddings are
    // stored here so the restriction has something to exclude.
    const dim = 384
    const vec = (seed: number) => {
      const v = new Float32Array(dim)
      for (let i = 0; i < dim; i++) v[i] = Math.sin(seed + i) / 10
      v[0] = 1
      return v
    }
    const alpha = corpus.find(e => e.scope === 'project:alpha')!
    const beta = corpus.find(e => e.scope === 'project:beta')!
    const globals = corpus.filter(e => e.scope === 'global').slice(0, 3)
    for (const [i, e] of [alpha, beta, ...globals].entries()) {
      await adapter.upsertEmbedding(e.id, vec(i))
    }

    // Unrestricted: the neighbour list contains engrams from several scopes —
    // without this the restricted assertions below would be vacuous again.
    const all = await adapter.searchVector(vec(0), 10)
    expect(new Set(all.map(h => h.engram.scope)).size).toBeGreaterThan(1)

    // Restricted to one scope: only that scope comes back, and the in-scope
    // engram is still reachable (i.e. it filtered rather than returned nothing).
    const scoped = await adapter.searchVector(vec(0), 10, { scopes: ['project:alpha'] })
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.every(h => h.engram.scope === 'project:alpha')).toBe(true)
    expect(scoped.map(h => h.engram.id)).toContain(alpha.id)

    // Empty allow-list means nothing, never everything.
    expect(await adapter.searchVector(vec(0), 10, { scopes: [] })).toEqual([])
  }, TIMEOUT)

  it('corpusStats honours the allow-list even with no query tokens', async () => {
    // The empty-token early return used to count the whole corpus regardless of
    // scope, reporting an N the caller was not permitted to see.
    const none = await adapter.corpusStats([], { scopes: [] })
    expect(none.N).toBe(0)
    const alpha = await adapter.corpusStats([], { scopes: ['project:alpha'] })
    expect(alpha.N).toBe(1)
  }, TIMEOUT)
})

describe.skipIf(!PG_URL)('PostgresAdapter — LIKE metacharacters in query tokens (#711)', () => {
  let adapter: PostgresAdapter

  beforeAll(async () => {
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: 'plur_like_escape', vectorIndex: 'exact' })
    await adapter.save([
      makeEngram('ENG-2026-0727-950', 'the snakeXcase identifier appears here'),
      makeEngram('ENG-2026-0727-951', 'the snake_case identifier appears here'),
    ])
  }, TIMEOUT)

  afterAll(async () => {
    if (adapter) {
      await adapter.dropSchema().catch(() => { /* best effort */ })
      await adapter.close().catch(() => { /* best effort */ })
    }
  }, TIMEOUT)

  it('treats `_` as a literal, not as a single-character wildcard', async () => {
    // `ftsTokenize` keeps `_` (it is a \w character), so unescaped it reaches
    // LIKE as a wildcard: in Postgres `'snakeXcase' LIKE '%snake_case%'` is
    // true. That makes the SQL predicate disagree with `termMatches`, so df is
    // counted under a different rule than tf — which is not BM25.
    const hits = await adapter.searchBM25('snake_case', { limit: 10 })
    expect(hits.map(e => e.id)).toEqual(['ENG-2026-0727-951'])

    const stats = await adapter.corpusStats(ftsTokenize('snake_case'))
    expect(stats.df.get('snake_case')).toBe(1)
  }, TIMEOUT)
})
