/**
 * `Plur.recall()` routed through an injected Postgres adapter (#739).
 *
 * `searchBM25` and `corpusStats` were implemented in Phase 3/4, parity-tested
 * against real Postgres — and had ZERO call sites. `Plur` never queried through
 * an injected adapter, so every recall loaded the whole corpus into process
 * memory and ranked it there, which is precisely the cost the Postgres tier
 * exists to avoid.
 *
 * These tests pin the two properties that make the wiring safe rather than just
 * present:
 *
 *   1. the pushed-down path returns the SAME answer as the in-memory path, and
 *   2. every filter that used to be applied in memory — scope, domain, and the
 *      permitted-scope allow-list — is still enforced.
 *
 * (2) is the one worth stating plainly: routing a query into the store while
 * dropping a filter would not fail, it would return MORE than the caller is
 * allowed to see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { PostgresAdapter } from '../src/storage-postgres.js'
import { searchEngrams } from '../src/fts.js'
import type { Engram } from '../src/schemas/engram.js'

const PG_URL = process.env.PLUR_TEST_POSTGRES_URL
const SCHEMA = 'plur_recall_pushdown'
const TIMEOUT = 180_000

describe.skipIf(!PG_URL)('Plur.recall() through an injected Postgres adapter (#739)', () => {
  let adapter: PostgresAdapter
  let plur: Plur
  let dir: string
  let corpus: Engram[]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-recall-pd-'))
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: SCHEMA, vectorIndex: 'exact' })
    await adapter.save([])
    plur = new Plur({ path: dir, store: adapter })
    await plur.ready()

    await plur.learn('deploy the billing service with terraform', { scope: 'global', domain: 'ops/deploy' })
    await plur.learn('deploy the tenant cluster onto kubernetes', { scope: 'project:alpha', domain: 'ops/deploy' })
    await plur.learn('deploy the other cluster onto kubernetes', { scope: 'project:beta', domain: 'ops/deploy' })
    await plur.learn('invoicing reconciliation runs nightly', { scope: 'global', domain: 'finance/billing' })
    corpus = await adapter.load()
  }, TIMEOUT)

  afterAll(async () => {
    await adapter?.dropSchema().catch(() => { /* best effort */ })
    await adapter?.close().catch(() => { /* best effort */ })
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TIMEOUT)

  it('actually routes through the adapter, not the in-memory path', async () => {
    // Without this the rest of the file would pass on the old code path and
    // prove nothing about the wiring. Counts a real query against the store.
    //
    // Spies on BOTH entry points (#753): core prefers `searchBM25Exhaustive`
    // when the adapter offers it, so watching only `searchBM25` counted zero
    // and reported "did not go through the adapter" for a recall that did.
    // What this test means is "exactly one real query hit the store", which is
    // independent of which method core picked.
    let calls = 0
    type A = typeof adapter
    const realBM25 = adapter.searchBM25.bind(adapter)
    const realExhaustive = adapter.searchBM25Exhaustive?.bind(adapter)
    const patch = adapter as unknown as {
      searchBM25: A['searchBM25']
      searchBM25Exhaustive?: NonNullable<A['searchBM25Exhaustive']>
    }
    patch.searchBM25 = async (q, o) => { calls++; return await realBM25(q, o) }
    if (realExhaustive) {
      patch.searchBM25Exhaustive = async (q, o) => { calls++; return await realExhaustive(q, o) }
    }
    try {
      await plur.recall('deploy kubernetes')
      expect(calls, 'recall() did not go through the adapter').toBe(1)
    } finally {
      patch.searchBM25 = realBM25
      if (realExhaustive) patch.searchBM25Exhaustive = realExhaustive
    }
  }, TIMEOUT)

  it('returns the same ranking as scoring the corpus in memory', async () => {
    for (const q of ['deploy kubernetes', 'kubernetes', 'invoicing', 'deploy']) {
      const pushed = await plur.recall(q, { limit: 10 })
      const local = searchEngrams(corpus.filter(e => e.status === 'active'), q, 10)
      expect(pushed.map(e => e.id), `ranking diverged for "${q}"`).toEqual(local.map(e => e.id))
    }
  }, TIMEOUT)

  it('enforces the permitted-scope allow-list', async () => {
    const alpha = await plur.recall('deploy kubernetes cluster', { limit: 10, scopes: ['project:alpha'] })
    expect(alpha.map(e => e.statement)).toEqual(['deploy the tenant cluster onto kubernetes'])
  }, TIMEOUT)

  it('an empty allow-list returns nothing, never everything', async () => {
    expect(await plur.recall('deploy', { limit: 10, scopes: [] })).toEqual([])
  }, TIMEOUT)

  it('still enforces the domain filter — it must not be dropped in the handover', async () => {
    // The hazard of pushing a query down: a filter the in-memory path applied
    // silently stops being applied, and the result is MORE than was asked for.
    const hits = await plur.recall('deploy', { limit: 10, domain: 'finance' })
    expect(hits.every(e => e.domain?.startsWith('finance')), 'domain filter was dropped').toBe(true)
  }, TIMEOUT)

  it('still enforces the visibility scope filter', async () => {
    const hits = await plur.recall('deploy kubernetes', { limit: 10, scope: 'project:alpha' })
    // Personal-family pass-through means `global` is admitted; `project:beta`
    // is a sibling and must not be.
    expect(hits.some(e => e.scope === 'project:beta'), 'a sibling scope leaked').toBe(false)
  }, TIMEOUT)

  it('composes scope with the allow-list — both narrow, neither widens', async () => {
    const hits = await plur.recall('deploy', { limit: 10, scope: 'project:alpha', scopes: ['project:beta'] })
    expect(hits, 'AND-ing two disjoint filters returned rows').toEqual([])
  }, TIMEOUT)
})

/**
 * Mounted-scope visibility grants through the Postgres pushdown (#775).
 *
 * The grant flows from `config.yaml` `stores:` into `pushdownFilter.
 * visibilityGrants` and lands in `buildFilterClause` as extra segment-aware
 * containment triples on the visibility clause. This is the fourth SQL arm's
 * end-to-end proof — the mounted `group:` engram survives a project-scope
 * recall on the Postgres tier, and the authorization allow-list is untouched.
 */
describe.skipIf(!PG_URL)('mounted-scope visibility grants through the Postgres pushdown (#775)', () => {
  const GRANT_SCHEMA = 'plur_recall_grants_775'
  let adapter: PostgresAdapter
  let plur: Plur
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-recall-grants-'))
    const teamPath = join(dir, 'team.yaml')
    // The mount IS the grant — the granted engrams themselves live in the
    // Postgres primary store, so the SQL clause is what admits them.
    writeFileSync(teamPath, 'engrams: []\n')
    writeFileSync(join(dir, 'config.yaml'), `stores:\n  - path: ${teamPath}\n    scope: "group:acme/eng"\n`)
    adapter = new PostgresAdapter({ connectionString: PG_URL!, schema: GRANT_SCHEMA, vectorIndex: 'exact' })
    await adapter.save([])
    plur = new Plur({ path: dir, store: adapter })
    await plur.ready()

    await plur.learn('deploy the billing service with terraform', { scope: 'project:alpha' })
    await plur.learn('deploy the billing service via the team pipeline', { scope: 'group:acme/eng' })
    await plur.learn('deploy the billing service via the sub pipeline', { scope: 'group:acme/eng/sub' })
    await plur.learn('deploy the billing service via the private pipeline', { scope: 'group:acme/eng-private' })
    await plur.learn('deploy the billing service via the other pipeline', { scope: 'group:other/team' })
  }, TIMEOUT)

  afterAll(async () => {
    await adapter?.dropSchema().catch(() => { /* best effort */ })
    await adapter?.close().catch(() => { /* best effort */ })
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, TIMEOUT)

  it('the granted scope and its true descendant survive a project-scope recall', async () => {
    const stmts = (await plur.recall('deploy billing', { limit: 10, scope: 'project:alpha' }))
      .map(e => e.statement)
    expect(stmts).toContain('deploy the billing service with terraform')
    expect(stmts, 'the mounted group scope was zeroed').toContain('deploy the billing service via the team pipeline')
    expect(stmts).toContain('deploy the billing service via the sub pipeline')
  }, TIMEOUT)

  it('the sibling string-prefix and ungranted scopes stay excluded', async () => {
    const stmts = (await plur.recall('deploy billing', { limit: 10, scope: 'project:alpha' }))
      .map(e => e.statement)
    expect(stmts, 'sibling-prefix leak (#383)').not.toContain('deploy the billing service via the private pipeline')
    expect(stmts, 'ungranted scope leak').not.toContain('deploy the billing service via the other pipeline')
  }, TIMEOUT)

  it('ADVERSARIAL: the grant does not widen the scopes allow-list', async () => {
    const hits = await plur.recall('deploy billing', {
      limit: 10,
      scope: 'project:alpha',
      scopes: ['project:alpha'],
    })
    expect(hits.map(e => e.statement)).toEqual(['deploy the billing service with terraform'])
    expect(await plur.recall('deploy billing', { limit: 10, scopes: [] })).toEqual([])
  }, TIMEOUT)
})
