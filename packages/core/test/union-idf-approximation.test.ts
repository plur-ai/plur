/**
 * #757 — quantify the IDF approximation in recall union ranking.
 *
 * `recall()` ranks primary-store hits together with secondary-store and pack
 * engrams. The primary side's statistics come from the store
 * (`adapter.corpusStats`); the outsiders are not in that corpus, so the union
 * is scored against statistics that do not describe it. #752 accepted that as
 * defensible and asked for it to be MEASURED rather than assumed negligible —
 * specifically when a query term's document frequency differs sharply inside
 * and outside the primary corpus.
 *
 * The measurement compares two IDF vectors over the same union:
 *
 *   exact  — `computeIdf(union, tokens)`, which counts df across every
 *            document under `termMatches`, the rule `ftsScore` applies.
 *   folded — `extendCorpusStats(primaryStats, tokens, outsiders)`, which is
 *            what recall actually uses.
 *
 * Both are asserted, not just compared, because the interesting outcome is not
 * "the divergence is small" — it is whether there is any divergence at all.
 */
import { describe, it, expect } from 'vitest'
import {
  ftsTokenize, engramSearchText, computeIdf, extendCorpusStats, termMatches,
  type CorpusStats,
} from '../src/fts.js'
import type { Engram } from '../src/schemas/engram.js'

function engram(id: string, statement: string): Engram {
  return {
    id, version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global', visibility: 'private',
    statement,
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-13' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
    abstract: null, derived_from: null, polarity: null, content_hash: `h-${id}`,
    commitment: 'leaning', write_count: 1, injection_count: 0, sources: [], recurrence_count: 0,
    summary: 's', engram_version: 1, episode_ids: [],
    temporal: { learned_at: '2026-08-13' },
  } as unknown as Engram
}

/**
 * Exact `CorpusStats` over one set, computed with the SAME matching rule a
 * conforming store must reproduce (`CorpusStats.df`'s contract: a store that
 * cannot reproduce it exactly must not supply stats at all).
 */
function exactStats(engrams: Engram[], queryTokens: string[]): CorpusStats {
  const termSets = engrams.map(e => new Set(ftsTokenize(engramSearchText(e))))
  const df = new Map<string, number>()
  for (const qt of queryTokens) {
    let n = 0
    for (const set of termSets) {
      if (set.has(qt) || [...set].some(t => termMatches(t, qt))) n++
    }
    df.set(qt, n)
  }
  const totalLen = engrams.reduce((sum, e) => sum + ftsTokenize(engramSearchText(e)).length, 0)
  return { N: engrams.length, df, avgDocLength: engrams.length > 0 ? totalLen / engrams.length : 0 }
}

/** Largest absolute IDF difference across the query's tokens. */
function maxDivergence(a: Map<string, number>, b: Map<string, number>): number {
  let worst = 0
  for (const [t, v] of a) worst = Math.max(worst, Math.abs(v - (b.get(t) ?? 0)))
  return worst
}

describe('union IDF: folded statistics vs an exact whole-set baseline (#757)', () => {
  /**
   * The skew the issue asks about, in both directions: a term that is common
   * in the primary corpus and rare among outsiders, and one that is the
   * reverse. If the fold under-counts either side, these are where it shows.
   */
  const primary = [
    ...Array.from({ length: 20 }, (_, i) => engram(`P-common-${i}`, `deployment runbook step ${i} for the deployment pipeline`)),
    ...Array.from({ length: 5 }, (_, i) => engram(`P-other-${i}`, `unrelated note about invoicing ${i}`)),
  ]
  const outsiders = [
    ...Array.from({ length: 12 }, (_, i) => engram(`O-jargon-${i}`, `kubernetes ingress annotation ${i} in the cluster`)),
    engram('O-deploy-1', 'a single outsider mentioning deployment'),
  ]

  it.each([
    ['a term common in primary, rare outside', 'deployment pipeline'],
    ['a term rare in primary, common outside', 'kubernetes ingress'],
    ['a mixed query spanning both', 'deployment kubernetes'],
    ['a term in neither corpus', 'sasquatch telemetry'],
  ])('%s', (_label, query) => {
    const tokens = ftsTokenize(query)
    expect(tokens.length, 'fixture query tokenized to nothing').toBeGreaterThan(0)

    const union = [...primary, ...outsiders]
    const exact = computeIdf(union, tokens)
    const folded = computeIdf([], tokens, extendCorpusStats(exactStats(primary, tokens), tokens, outsiders))

    // The finding: with `extendCorpusStats` in place the fold is not an
    // approximation at all — outsider df is counted under the same rule and
    // N/avgDocLength are exact, so the union is scored against the union's
    // own statistics. #752 was written before that fold landed (#750
    // iteration 2); this test is what turns "defensible approximation" into
    // "measured as exact", and what will catch it becoming an approximation
    // again if either side's counting rule drifts.
    expect(maxDivergence(exact, folded)).toBe(0)
  })

  it('diverges measurably WITHOUT the fold — so the assertions above are not vacuous', () => {
    // The control. Scoring the union against the primary corpus's raw stats
    // is what the code did before #750 iteration 2, and it is what the issue
    // describes. If this did not diverge, the tests above would prove nothing.
    const tokens = ftsTokenize('kubernetes ingress')
    const union = [...primary, ...outsiders]
    const exact = computeIdf(union, tokens)
    const unfolded = computeIdf([], tokens, exactStats(primary, tokens))

    const divergence = maxDivergence(exact, unfolded)
    expect(divergence, 'primary-only stats should misprice outsider vocabulary').toBeGreaterThan(0.5)
  })

  it('the fold stays exact as the outsider share grows', () => {
    // The approximation, if there were one, would grow with the outsider
    // fraction. Sweeping it is cheaper than arguing about where the boundary
    // would be.
    const tokens = ftsTokenize('kubernetes deployment')
    for (const outsiderCount of [1, 5, 25, 100]) {
      const many = Array.from({ length: outsiderCount }, (_, i) =>
        engram(`O-sweep-${i}`, `kubernetes ingress annotation ${i} in the cluster`))
      const exact = computeIdf([...primary, ...many], tokens)
      const folded = computeIdf([], tokens, extendCorpusStats(exactStats(primary, tokens), tokens, many))
      expect(maxDivergence(exact, folded), `diverged at ${outsiderCount} outsiders`).toBe(0)
    }
  })
})
