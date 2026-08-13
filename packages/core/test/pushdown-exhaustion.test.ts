/**
 * #753 — the widening loop must stop when the adapter has nothing more.
 *
 * `recall()`'s adaptive over-fetch widens 3L → 9L → 27L when residual filters
 * (expiry, `min_strength`) reject more than 2/3 of a page. Its early exit,
 * `narrowed.length < fetch`, assumes an adapter that bounds its search by the
 * requested limit.
 *
 * `PostgresAdapter.searchBM25` deliberately does the opposite: its trigram
 * prefilter cannot rank, so it computes and scores the FULL candidate set and
 * slices to `limit` in core. So a full page means "your slice was full", not
 * "there is more" — and rounds 2 and 3 re-execute the identical query and
 * re-rank identical rows purely to take a longer slice of an answer already
 * computed. A 2–3x cost amplification, concentrated in exactly the
 * high-rejection scenario the widening exists to serve, at the 50k+-engram
 * scale that selects this tier.
 *
 * Correctness was never affected — this is a cost bug. So these tests count
 * QUERIES, not results.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

/**
 * A primary query store that reports exhaustion, standing in for
 * `PostgresAdapter` without booting one.
 */
function makeAdapter(opts: { corpus: Engram[]; exhaustive: boolean }) {
  const calls = { bm25: 0, exhaustive: 0 }
  const rank = (limit: number) => opts.corpus.slice(0, limit)

  const base: Record<string, unknown> = {
    kind: 'postgres',
    location: 'postgres://stub',
    role: 'primary',
    load: async () => opts.corpus,
    loadCached: async () => opts.corpus,
    invalidate: () => {},
    withExclusiveAccess: async <T>(fn: () => Promise<T>) => fn(),
    save: async () => {},
    loadByIds: async (ids: string[]) => opts.corpus.filter(e => ids.includes(e.id)),
    updateMany: async () => {},
    append: async () => {},
    findActiveByContentHash: async () => null,
    nextEngramId: async () => 'ENG-STUB-001',
    searchVector: async () => [],
    searchBM25: async (_q: string, o: { limit: number }) => { calls.bm25++; return rank(o.limit) },
  }
  if (opts.exhaustive) {
    base.searchBM25Exhaustive = async (_q: string, o: { limit: number }) => {
      calls.exhaustive++
      // The PostgresAdapter property: the full candidate set is always known,
      // so exhaustion is free.
      return { rows: rank(o.limit), exhausted: opts.corpus.length <= o.limit }
    }
  }
  return { store: base, calls }
}

/** An engram the residual filters will reject, so widening is triggered. */
function expiredEngram(id: string): Engram {
  return {
    id, version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global', visibility: 'private',
    statement: `docker deployment note ${id}`,
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-10' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
    abstract: null, derived_from: null, polarity: null, content_hash: `h-${id}`,
    commitment: 'leaning', write_count: 1, injection_count: 0, sources: [], recurrence_count: 0,
    summary: 's', engram_version: 1, episode_ids: [],
    // Expired: `_applyResidualFilters` rejects it, which is what drives widening.
    temporal: { learned_at: '2020-01-01', valid_until: '2020-01-02' },
  } as unknown as Engram
}

describe('recall stops widening when the adapter says it is exhausted (#753)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-753-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('queries ONCE when a FULL page is nonetheless the whole candidate set', async () => {
    // The discriminating case, and the only one that isolates this fix.
    //
    // limit 10 -> first fetch is 3L = 30. A corpus of exactly 30 fills that
    // page, so `narrowed.length < fetch` is FALSE and the inferred signal
    // cannot fire — yet the adapter knows those 30 rows are everything. This is
    // precisely PostgresAdapter's situation: it computes and scores the full
    // candidate set, so a full page means "your slice was full", not "there is
    // more".
    //
    // (An earlier version of this test used a 5-row corpus and passed with the
    // fix reverted, because the short page tripped the inferred signal. It
    // proved nothing.)
    const corpus = Array.from({ length: 30 }, (_, i) => expiredEngram(`ENG-EXP-${i}`))
    const { store, calls } = makeAdapter({ corpus, exhaustive: true })
    const plur = new Plur({ path: dir, store: store as never })

    await plur.recall('docker', { limit: 10 })

    expect(calls.exhaustive, 'rounds 2-3 re-rank rows the adapter already returned').toBe(1)
    expect(calls.bm25, 'the exhaustion-aware path should be preferred').toBe(0)
  })

  it('still widens for an adapter WITHOUT the hook — purely additive', async () => {
    const corpus = Array.from({ length: 5 }, (_, i) => expiredEngram(`ENG-EXP-${i}`))
    const { store, calls } = makeAdapter({ corpus, exhaustive: false })
    const plur = new Plur({ path: dir, store: store as never })

    await plur.recall('docker', { limit: 10 })

    // The inferred signal (`narrowed.length < fetch`) still applies, so this
    // one short page also stops the loop — the point is that behaviour for
    // adapters lacking the hook is unchanged.
    expect(calls.bm25).toBeGreaterThanOrEqual(1)
    expect(calls.exhaustive).toBe(0)
  })

  it('does not stop early when the adapter reports MORE is available', async () => {
    // Corpus larger than the first fetch window, all rejected: exhausted is
    // false, so the loop must still widen. Stopping here would be the opposite
    // bug — a silent recall shortfall.
    const corpus = Array.from({ length: 500 }, (_, i) => expiredEngram(`ENG-EXP-${i}`))
    const { store, calls } = makeAdapter({ corpus, exhaustive: true })
    const plur = new Plur({ path: dir, store: store as never })

    await plur.recall('docker', { limit: 5 })

    expect(calls.exhaustive, 'a non-exhausted adapter must still be widened against').toBeGreaterThan(1)
  })
})
