/**
 * The vector leg must apply the permitted-scope allow-list IN the k-NN query
 * (Phase 3, #710).
 *
 * `PGLiteAdapter.searchVector` has always accepted a `ScopeRestriction`, but
 * every call site in `Plur` omitted it and instead intersected an UNRESTRICTED
 * neighbour list against the already-scope-filtered set. That is correct and
 * incomplete at the same time, which is the hard combination to notice: nothing
 * out of scope is ever returned, so no test asserting "only permitted engrams
 * came back" can fail — but `limit` was spent on rows the caller may not see,
 * so a principal whose permitted scopes are a small share of the corpus asks
 * for N results and silently gets far fewer.
 *
 * The `ScopeRestriction` docstring names this exact failure. These tests make
 * it observable: a corpus where the permitted scope is deliberately a small
 * minority, so an unrestricted top-k is swamped before the intersection runs.
 *
 * Not gated on Postgres — this is the PGLite index. The tier is forced on via
 * PLUR_BACKEND because the corpus needed to show the effect (405) is well under
 * the 5,000-engram threshold at which PGLite would engage on its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'

const TIMEOUT = 180_000

// Every engram is about the same thing, so vector similarity cannot separate
// them — only the scope filter can. That is deliberate: it makes the neighbour
// list's composition depend purely on whether the restriction reached the
// query.
// Large enough that an unrestricted top-50 is swamped: the k-NN floor in
// `_pgliteSemanticRecall` is `max(limit*3, 50)`, so with 400 noise engrams the
// 5 permitted ones are statistically absent from it. Verified — the
// unrestricted top-50 contains 0 of them.
const NOISE = 400
const WANTED = 5

let ready = false

/**
 * Fail visibly rather than pass silently when the embedder is unavailable.
 *
 * Every test here used `if (!ready) return`, which reports PASS — so with no
 * embedder the file announced "5 passed" while asserting nothing at all.
 * Verified: forcing `ready = false` yields exactly that. A suite that reports
 * success for having done nothing is worse than one that fails, because it is
 * counted as coverage.
 *
 * `ctx.skip()` marks the test SKIPPED in the output, which is the honest
 * signal: the environment could not run it, and nobody should read the run as
 * evidence that the vector scope filter works.
 */
function requireEmbedder(ctx: { skip: (note?: string) => void }): void {
  if (!ready) ctx.skip('embeddings unavailable — the vector leg cannot be exercised')
}

describe('vector recall applies the scope restriction in-query, not after', () => {
  let dir: string
  let plur: Plur

  const priorBackend = process.env.PLUR_BACKEND

  beforeAll(async () => {
    // FORCE the PGLite tier. Without this the corpus (405) sits below
    // PGLITE_MIN_ENGRAMS (5,000), `pgliteAdapter` is null, and recall takes the
    // in-memory `embeddingSearch(filtered, ...)` path — which is scope-correct
    // by construction and therefore cannot exhibit the bug. The first version
    // of this test omitted the override and passed with the fix REVERTED,
    // proving nothing.
    process.env.PLUR_BACKEND = 'pglite'
    dir = mkdtempSync(join(tmpdir(), 'plur-vec-dilution-'))
    plur = new Plur({ path: dir })
    await plur.ready()

    for (let i = 0; i < NOISE; i++) {
      await plur.learn(`the deployment pipeline runs database migrations, note ${i}`, { scope: 'group:noise' })
    }
    for (let i = 0; i < WANTED; i++) {
      await plur.learn(`the deployment pipeline runs database migrations, alpha ${i}`, { scope: 'project:alpha' })
    }
    // Embeddings are what this file is about; if they are unavailable the
    // vector leg degrades to BM25 and these assertions would measure something
    // else.
    const probe = await plur.recallSemantic('deployment pipeline migrations', { limit: 3 })
    ready = probe.length > 0
  }, TIMEOUT)

  afterAll(() => {
    if (priorBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = priorBackend
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('the fixture actually dilutes — an unrestricted top-50 contains no permitted engram', async (ctx) => {
    // Guards the FIXTURE. If a future edit shrinks the corpus or the k-NN floor
    // rises, the assertions below stop testing anything and would still pass.
    requireEmbedder(ctx)
    const unrestricted = await plur.recallSemantic('deployment pipeline migrations', { limit: 50 })
    expect(unrestricted.filter(e => e.scope === 'project:alpha').length).toBe(0)
  }, TIMEOUT)

  it('recallSemantic returns a FULL page of permitted results, not a diluted one', async (ctx) => {
    requireEmbedder(ctx)
    // With the restriction in the query, all 5 permitted engrams are reachable.
    // Without it, measured: 0 of 5. The unrestricted top-50 of 405 contains no
    // permitted engram at all (asserted above), so the post-hoc intersection
    // has nothing to keep.
    const hits = await plur.recallSemantic('deployment pipeline migrations', {
      limit: WANTED,
      scopes: ['project:alpha'],
    })
    expect(hits.length, 'permitted results were diluted away by out-of-scope neighbours').toBe(WANTED)
    expect(hits.every(e => e.scope === 'project:alpha')).toBe(true)
  }, TIMEOUT)

  it('recallHybrid does the same on its vector leg', async (ctx) => {
    requireEmbedder(ctx)
    const hits = await plur.recallHybrid('deployment pipeline migrations', {
      limit: WANTED,
      scopes: ['project:alpha'],
    })
    expect(hits.length).toBe(WANTED)
    expect(hits.every(e => e.scope === 'project:alpha')).toBe(true)
  }, TIMEOUT)

  it('an empty allow-list still returns nothing', async (ctx) => {
    requireEmbedder(ctx)
    expect(await plur.recallSemantic('deployment pipeline migrations', { limit: 5, scopes: [] })).toEqual([])
    expect(await plur.recallHybrid('deployment pipeline migrations', { limit: 5, scopes: [] })).toEqual([])
  }, TIMEOUT)

  it('an absent allow-list is unrestricted — existing behaviour unchanged', async (ctx) => {
    requireEmbedder(ctx)
    const hits = await plur.recallSemantic('deployment pipeline migrations', { limit: 10 })
    expect(hits.length).toBe(10)
    expect(hits.some(e => e.scope === 'group:noise'), 'unrestricted recall should see the noise').toBe(true)
  }, TIMEOUT)
})
