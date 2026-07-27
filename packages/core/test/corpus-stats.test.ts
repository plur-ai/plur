/**
 * Corpus statistics for BM25 under a narrowed candidate set (Phase 4, #711).
 *
 * These tests exist to make one claim concrete: pushing BM25 narrowing into the
 * store, without also moving the corpus statistics, silently corrupts ranking.
 *
 * It is worth pinning precisely because it does not announce itself. There is
 * no error, no empty result, no exception — every score is a plausible number
 * and the right-ish rows come back in the wrong order. A test asserting "the
 * matching engram was returned" passes either way. The only observable symptom
 * in production is that recall quietly gets worse.
 *
 * So the first test does not check an implementation detail; it demonstrates
 * the failure, so that the fix has something to be a fix OF.
 */
import { describe, it, expect } from 'vitest'
import { computeIdf, ftsTokenize, ftsScore, searchEngrams, termMatches, engramSearchText, type CorpusStats } from '../src/fts.js'
import type { Engram } from '../src/schemas/engram.js'

function makeEngram(id: string, statement: string): Engram {
  return {
    id,
    statement,
    type: 'behavioral',
    scope: 'global',
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
 * A corpus where one query term is genuinely rare and another is genuinely
 * common — and where narrowing INVERTS that relationship among the survivors.
 *
 * Corpus-wide: `kubernetes` appears in 1 of 40 documents (rare, high IDF),
 * `deploy` appears in 30 of 40 (common, low IDF). A store narrowing on the
 * query "deploy kubernetes" plausibly returns the handful of documents that
 * mention both or either — and within THAT set, `kubernetes` is no longer rare.
 */
function buildCorpus(): { corpus: Engram[]; candidates: Engram[] } {
  const corpus: Engram[] = []
  // 30 documents about deploying, only one of which mentions kubernetes.
  for (let i = 0; i < 29; i++) {
    corpus.push(makeEngram(`ENG-2026-0727-1${String(i).padStart(2, '0')}`, `deploy the billing service revision ${i}`))
  }
  corpus.push(makeEngram('ENG-2026-0727-200', 'deploy the cluster onto kubernetes nodes'))
  // 10 documents about neither.
  for (let i = 0; i < 10; i++) {
    corpus.push(makeEngram(`ENG-2026-0727-3${String(i).padStart(2, '0')}`, `unrelated note about invoicing ${i}`))
  }

  // What a store's narrowing step would hand back for "deploy kubernetes":
  // the kubernetes doc plus a few deploy docs. Within this set `kubernetes`
  // looks common (1 of 4) rather than rare (1 of 40).
  const candidates = [
    corpus.find(e => e.id === 'ENG-2026-0727-200')!,
    corpus.find(e => e.id === 'ENG-2026-0727-100')!,
    corpus.find(e => e.id === 'ENG-2026-0727-101')!,
    corpus.find(e => e.id === 'ENG-2026-0727-102')!,
  ]
  return { corpus, candidates }
}

/** Count df the way a conforming store must — via the shared matching rule. */
function statsFrom(corpus: Engram[], queryTokens: string[]): CorpusStats {
  const df = new Map<string, number>()
  for (const qt of queryTokens) {
    let n = 0
    for (const e of corpus) {
      const terms = new Set(ftsTokenize(`${e.statement}`))
      if ([...terms].some(t => termMatches(t, qt))) n++
    }
    df.set(qt, n)
  }
  const avgDocLength = corpus.length > 0
    ? corpus.reduce((sum, e) => sum + ftsTokenize(engramSearchText(e)).length, 0) / corpus.length
    : 0
  return { N: corpus.length, df, avgDocLength }
}

describe('CorpusStats — BM25 under a narrowed candidate set (#711)', () => {
  const QUERY = 'deploy kubernetes'

  it('local IDF over candidates disagrees with IDF over the whole corpus', () => {
    const { corpus, candidates } = buildCorpus()
    const tokens = ftsTokenize(QUERY)

    const overCorpus = computeIdf(corpus, tokens)
    const overCandidates = computeIdf(candidates, tokens)

    // Corpus-wide, `kubernetes` is the discriminating term: 1/40 vs 30/40.
    expect(overCorpus.get('kubernetes')!).toBeGreaterThan(overCorpus.get('deploy')!)

    // Among the candidates that relationship does not survive. This is the
    // whole bug: the same query, the same scorer, a different answer — decided
    // by how the store happened to narrow.
    expect(overCandidates.get('kubernetes')!).toBeLessThan(overCorpus.get('kubernetes')!)
  })

  it('supplying corpus stats restores the corpus-wide IDF exactly', () => {
    const { corpus, candidates } = buildCorpus()
    const tokens = ftsTokenize(QUERY)

    const overCorpus = computeIdf(corpus, tokens)
    const withStats = computeIdf(candidates, tokens, statsFrom(corpus, tokens))

    for (const t of tokens) {
      expect(withStats.get(t)).toBeCloseTo(overCorpus.get(t)!, 12)
    }
  })

  it('scores a candidate identically to scoring it against the full corpus', () => {
    const { corpus, candidates } = buildCorpus()
    const tokens = ftsTokenize(QUERY)
    const target = candidates[0]

    // avgDocLength is held equal so the comparison isolates IDF; a real store
    // must report it alongside df for full parity, which is why the narrowed
    // path is not wired into recall until the store can supply both.
    const avg = 7
    const full = ftsScore(target, tokens, computeIdf(corpus, tokens), avg)
    const narrowed = ftsScore(target, tokens, computeIdf(candidates, tokens, statsFrom(corpus, tokens)), avg)

    expect(narrowed).toBeCloseTo(full, 12)
  })

  it('searchEngrams accepts stats and ranks the narrowed set by corpus-wide IDF', () => {
    const { corpus, candidates } = buildCorpus()
    const tokens = ftsTokenize(QUERY)

    const ranked = searchEngrams(candidates, QUERY, 10, statsFrom(corpus, tokens))

    // The kubernetes document wins on a term that is rare corpus-wide. Without
    // stats it is competing on a term the candidate set makes look ordinary.
    expect(ranked[0].id).toBe('ENG-2026-0727-200')
  })

  it('supplying corpus-derived stats agrees with deriving them locally', () => {
    // This is the invariant with teeth, and it replaces one that had none: the
    // original compared `searchEngrams(c, q, 5)` with
    // `searchEngrams(c, q, 5, undefined)`, which are the same call — omitting an
    // optional parameter IS passing undefined — so it could not fail for any
    // implementation.
    //
    // Handing over stats computed FROM THE WHOLE CORPUS must reproduce what the
    // local derivation produces, because they describe the same rows. If N, df,
    // or avgDocLength is derived differently on the two paths, this diverges —
    // which is exactly how the avgDocLength hole would have been caught.
    const { corpus } = buildCorpus()
    const tokens = ftsTokenize(QUERY)
    expect(searchEngrams(corpus, QUERY, 5, statsFrom(corpus, tokens)).map(e => e.id))
      .toEqual(searchEngrams(corpus, QUERY, 5).map(e => e.id))
  })

  it('narrowing does not change the ranking, INCLUDING length normalisation', () => {
    // The parity claim, stated where it can fail. `avgDocLength` used to be
    // derived from whatever array was passed, so on the pushdown path it came
    // from the candidates — systematically longer, since every candidate
    // contains a query term — while N and df came from the corpus. The two
    // paths agreed only on fixtures uniform enough to hide it.
    const { corpus } = buildCorpus()
    const tokens = ftsTokenize(QUERY)
    const stats = statsFrom(corpus, tokens)

    // A store's narrowing step: every engram that could score above zero.
    const candidates = corpus.filter(e => {
      const terms = new Set(ftsTokenize(engramSearchText(e)))
      return tokens.some(qt => [...terms].some(t => termMatches(t, qt)))
    })

    expect(searchEngrams(candidates, QUERY, 10, stats).map(e => e.id))
      .toEqual(searchEngrams(corpus, QUERY, 10).map(e => e.id))
  })

  it('uses the corpus avgDocLength, not the candidates\' — pinned directly', () => {
    // Guards the specific field rather than only its effect, so a future change
    // that reintroduces candidate-derived avgdl fails here with a clear cause
    // even if the ranking above happens to survive it.
    const { corpus, candidates } = buildCorpus()
    const tokens = ftsTokenize(QUERY)
    const stats = statsFrom(corpus, tokens)

    const candidateAvg = candidates.reduce(
      (sum, e) => sum + ftsTokenize(engramSearchText(e)).length, 0) / candidates.length
    expect(stats.avgDocLength).not.toBeCloseTo(candidateAvg, 6)

    const target = candidates[0]
    expect(ftsScore(target, tokens, computeIdf(corpus, tokens), stats.avgDocLength))
      .toBeCloseTo(ftsScore(target, tokens, computeIdf(corpus, tokens),
        corpus.reduce((s2, e) => s2 + ftsTokenize(engramSearchText(e)).length, 0) / corpus.length), 12)
  })

  it('an empty corpus yields no weights rather than dividing by zero', () => {
    const tokens = ftsTokenize(QUERY)
    expect(computeIdf([], tokens, { N: 0, df: new Map(), avgDocLength: 0 }).size).toBe(0)
  })

  it('a token the store never reports is treated as maximally rare, not as an error', () => {
    // df absent means "seen in no document". log(N/1) is the correct weight for
    // that, and it must not throw or silently become NaN — a store may legally
    // omit a token it found no rows for.
    const tokens = ftsTokenize('kubernetes')
    const idf = computeIdf([], tokens, { N: 40, df: new Map(), avgDocLength: 7 })
    expect(idf.get('kubernetes')).toBeCloseTo(Math.log(40), 12)
  })
})

describe('termMatches — the rule df and tf must share', () => {
  it('matches forward substrings (the compound-identifier case)', () => {
    expect(termMatches('transferwithauthorization', 'auth')).toBe(true)
  })

  it('matches morphological prefixes', () => {
    expect(termMatches('deploy', 'deploying')).toBe(true)
  })

  it('rejects reverse non-prefix substrings (#721)', () => {
    expect(termMatches('yin', 'deploying')).toBe(false)
    expect(termMatches('res', 'postgres')).toBe(false)
    expect(termMatches('sql', 'postgresql')).toBe(false)
  })
})

/**
 * A corpus built specifically so candidate-average and corpus-average document
 * length land on OPPOSITE SIDES of a BM25 ranking crossover.
 *
 * The first attempt at a parity test used a fixture whose documents were all
 * roughly the same length, so candidate-avgdl and corpus-avgdl were nearly
 * equal and the assertion passed whether or not the implementation used the
 * right one — verified by mutation. This fixture is the fix for that.
 *
 * Two matching documents:
 *   SHORT — few tokens, term appears once
 *   LONG  — many tokens, term appears three times
 * plus non-matching filler that is very long, which drags the CORPUS average
 * well above the CANDIDATE average.
 *
 * BM25's length penalty is `k1 * (1 - b + b * docLen/avgdl)`. At the candidate
 * average, LONG looks enormous relative to its peers and is penalised hard, so
 * SHORT wins. At the true corpus average, LONG is unremarkable and its higher
 * term frequency carries it, so LONG wins. Same documents, same query, opposite
 * order — decided solely by which average is used.
 */
function lengthSkewedCorpus(): { corpus: Engram[]; candidates: Engram[] } {
  const filler = (n: number, seed: string) =>
    Array.from({ length: n }, (_, i) => `${seed}${i}zzz`).join(' ')

  const short = makeEngram('ENG-2026-0727-900', `kubernetes ${filler(5, 'aaa')}`)
  const long = makeEngram('ENG-2026-0727-901', `kubernetes ${filler(58, 'bbb')} kubernetes kubernetes`)
  const candidates = [short, long]

  // Non-matching, very long — pulls the corpus average above the crossover.
  const corpus = [short, long]
  for (let i = 0; i < 12; i++) {
    corpus.push(makeEngram(`ENG-2026-0727-9${String(i + 10).padStart(2, '0')}`, filler(210, `f${i}x`)))
  }
  return { corpus, candidates }
}

describe('CorpusStats — length normalisation (#711)', () => {
  const QUERY = 'kubernetes'

  it('candidate-average and corpus-average avgdl actually differ here', () => {
    // Guards the FIXTURE. If a future edit flattens the length spread, the
    // ranking test below silently stops testing anything — which is exactly
    // what happened to its predecessor.
    const { corpus, candidates } = lengthSkewedCorpus()
    const avg = (es: Engram[]) =>
      es.reduce((sum, e) => sum + ftsTokenize(engramSearchText(e)).length, 0) / es.length
    expect(avg(corpus) / avg(candidates)).toBeGreaterThan(2)
  })

  it('ranks by corpus avgdl, not candidate avgdl — the two disagree', () => {
    const { corpus, candidates } = lengthSkewedCorpus()
    const tokens = ftsTokenize(QUERY)

    const viaCorpus = searchEngrams(corpus, QUERY, 10).map(e => e.id)
    const viaPushdown = searchEngrams(candidates, QUERY, 10, statsFrom(corpus, tokens)).map(e => e.id)
    expect(viaPushdown).toEqual(viaCorpus.filter(id => candidates.some(c => c.id === id)))

    // And the orders genuinely differ, so the assertion above has teeth:
    // deriving avgdl from the candidates reverses them.
    const naive = searchEngrams(candidates, QUERY, 10).map(e => e.id)
    expect(naive).not.toEqual(viaPushdown)
  })
})
