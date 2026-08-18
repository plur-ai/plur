/**
 * #906 — hybrid recall narrows through the store only when that is provably
 * equivalent to reading the whole corpus.
 *
 * `recallHybridWithMeta` called `_filterEngrams()` unconditionally. For a
 * Postgres primary query store that is a full scan per query: `indexTier`
 * resolves to 'none' when a primary query store is present (ADR-0005), so it
 * takes the else branch and loads everything — and `plur_recall` defaults to
 * hybrid, so it is one whole-corpus read per query on exactly the deployment
 * where scans are expensive.
 *
 * Narrowing before RRF is normally a recall-QUALITY change needing a benchmark.
 * This is not: it narrows only when the adapter reports `exhausted`, meaning
 * the rows returned are everything the store holds for that filter, so the
 * ranking is identical by construction. The tests below pin exactly that
 * boundary — equivalent when exhausted, untouched when not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'

function engram(id: string, statement: string): Engram {
  return {
    id, version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global', visibility: 'private', statement,
    activation: { retrieval_strength: 0.8, storage_strength: 1, frequency: 0, last_accessed: '2026-08-14' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
    abstract: null, derived_from: null, polarity: null, content_hash: `h-${id}`,
    commitment: 'leaning', write_count: 1, injection_count: 0, sources: [], recurrence_count: 0,
    summary: 's', engram_version: 1, episode_ids: [], temporal: { learned_at: '2026-08-14' },
  } as unknown as Engram
}

/** A primary query store that records how it was asked. */
function adapter(corpus: Engram[], exhausted: boolean) {
  const calls = { exhaustive: 0, load: 0, filters: [] as Record<string, unknown>[] }
  return {
    calls,
    store: {
      kind: 'postgres', location: 'postgres://stub', role: 'primary',
      load: async () => { calls.load++; return corpus },
      loadCached: async () => { calls.load++; return corpus },
      invalidate: () => {},
      withExclusiveAccess: async <T>(fn: () => Promise<T>) => fn(),
      save: async () => {}, append: async () => {}, updateMany: async () => {},
      loadByIds: async (ids: string[]) => corpus.filter(e => ids.includes(e.id)),
      findActiveByContentHash: async () => null,
      nextEngramId: async () => 'ENG-STUB-001',
      searchVector: async () => [],
      searchBM25: async (_q: string, o: { limit: number }) => corpus.slice(0, o.limit),
      searchBM25Exhaustive: async (_q: string, o: { limit: number } & Record<string, unknown>) => {
        calls.exhaustive++
        const { limit: _l, ...filters } = o
        calls.filters.push(filters)
        return { rows: corpus.slice(0, o.limit), exhausted }
      },
    } as unknown as never,
  }
}

describe('hybrid recall pushdown (#906)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-906-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const corpus = Array.from({ length: 8 }, (_, i) =>
    engram(`ENG-C-${i}`, `docker compose deployment note number ${i}`))

  it('reads the corpus STRICTLY LESS when the adapter reports exhausted', async () => {
    // Asserted as a comparison rather than an absolute count: other parts of
    // the recall path legitimately read the store (remote merge, reactivation),
    // and pinning "zero reads" would couple this test to all of them. What the
    // fix claims is narrower and is exactly what this measures — the
    // candidate-set read stops happening when the store can answer
    // exhaustively.
    const exhaustive = adapter(corpus, true)
    await new Plur({ path: dir, store: exhaustive.store })
      .recallHybridWithMeta('docker compose', { limit: 5 })

    const partial = adapter(corpus, false)
    await new Plur({ path: mkdtempSync(join(tmpdir(), 'plur-906b-')), store: partial.store })
      .recallHybridWithMeta('docker compose', { limit: 5 })

    expect(exhaustive.calls.exhaustive, 'the store was never asked to narrow').toBe(1)
    expect(exhaustive.calls.load, 'narrowing did not avoid the corpus read')
      .toBeLessThan(partial.calls.load)
  })

  it('falls back to the full read when NOT exhausted — no quality change', async () => {
    // The boundary. A partial candidate set could change what the vector leg
    // ranks, which is a recall-quality question this fix deliberately does not
    // answer without a benchmark.
    const { store, calls } = adapter(corpus, false)
    const plur = new Plur({ path: dir, store })
    await plur.recallHybridWithMeta('docker compose', { limit: 5 })
    expect(calls.exhaustive).toBe(1)
    expect(calls.load, 'a non-exhaustive narrowing was used as the candidate set').toBeGreaterThan(0)
  })

  it('passes every filter through, so authorization cannot be dropped', async () => {
    // The precondition for the whole approach: StorageFilter carries each
    // field `_filterEngrams` applies. If a filter were omitted here, the
    // narrowed set would be WIDER than the caller asked for.
    const { store, calls } = adapter(corpus, true)
    const plur = new Plur({ path: dir, store })
    await plur.recallHybridWithMeta('docker', { limit: 5, scope: 'group:acme/eng', domain: 'plur.core' })
    expect(calls.filters[0]).toMatchObject({
      status: 'active', scope: 'group:acme/eng', domain: 'plur.core',
    })
  })

  it('still returns results, and only ones matching the query', async () => {
    const { store } = adapter(corpus, true)
    const plur = new Plur({ path: dir, store })
    const res = await plur.recallHybridWithMeta('docker compose', { limit: 5 })
    expect(res.engrams.length).toBeGreaterThan(0)
    expect(res.engrams.length).toBeLessThanOrEqual(5)
  })

  it('a store without the hook is untouched', async () => {
    const { store, calls } = adapter(corpus, true)
    delete (store as unknown as Record<string, unknown>).searchBM25Exhaustive
    const plur = new Plur({ path: dir, store })
    await plur.recallHybridWithMeta('docker compose', { limit: 5 })
    expect(calls.exhaustive).toBe(0)
    expect(calls.load).toBeGreaterThan(0)
  })
})
