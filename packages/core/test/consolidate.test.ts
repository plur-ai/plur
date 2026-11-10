/**
 * Store consolidation, candidate generation and clustering (overhaul W6, R1, D7, R9).
 *
 * Pure functions over vectors, so every cosine in these tests is chosen, not
 * measured from a model:
 *  - complete linkage: every member is at or above the threshold to EVERY
 *    other member, so a chain A–B, B–C with a weak A–C is not one cluster;
 *  - clusters never cross a block (scope, and author inside a group scope);
 *  - a cluster that mixes a prohibition with a directive is not proposed;
 *  - the neighbour pass finds planted duplicates in a large synthetic store
 *    without comparing every pair (the 100k run is behind PLUR_SCALE_TESTS=1);
 *  - the nightly sample is seeded from the date and deterministic.
 */
import { describe, it, expect } from 'vitest'
import {
  candidatePairs,
  completeLinkageClusters,
  blockKeyFor,
  polarityOf,
  mixedPolarity,
  nightlySeed,
  seededSample,
  buildConsolidationPrompt,
  parseConsolidationResponse,
  type ConsolidationItem,
} from '../src/consolidate.js'
import { fromGram, axis, near, dot, randomUnitVectors } from './fixtures/consolidate-vectors.js'

function items(vs: Float32Array[], block = 'global', prefix = 'E'): ConsolidationItem[] {
  return vs.map((v, i) => ({ id: `${prefix}${i}`, block, v }))
}

function clustersOf(list: ConsolidationItem[], threshold = 0.85) {
  const pairs = candidatePairs(list, { threshold })
  const vectors = new Map(list.map(i => [i.id, i.v]))
  return completeLinkageClusters(vectors, pairs, { threshold }).map(c => [...c.members].sort())
}

describe('complete-linkage clustering (R1)', () => {
  it('A–B 0.86, B–C 0.86, A–C 0.6 is not one cluster', () => {
    const [a, b, c] = fromGram([
      [1, 0.86, 0.6],
      [0.86, 1, 0.86],
      [0.6, 0.86, 1],
    ])
    expect(dot(a, c)).toBeCloseTo(0.6, 5)
    const cl = clustersOf(items([a, b, c]))
    expect(cl.length).toBe(1)
    expect(cl[0].length).toBe(2)
    // C never sits with A.
    for (const members of cl) expect(members.includes('E0') && members.includes('E2')).toBe(false)
  })

  it('seeds each cluster from its strongest pair', () => {
    // A–B 0.90, B–C 0.95, A–C 0.75: the strongest pair is B–C, so A is left out.
    const [a, b, c] = fromGram([
      [1, 0.9, 0.75],
      [0.9, 1, 0.95],
      [0.75, 0.95, 1],
    ])
    expect(clustersOf(items([a, b, c]))).toEqual([['E1', 'E2']])
  })

  it('finds a fixture of known duplicate groups exactly', () => {
    const dim = 64
    // Three groups around orthogonal axes, members at 0.93–0.97 to the centre
    // (pairwise above 0.85), plus five unrelated singletons.
    const g1 = [axis(0, dim), near(axis(0, dim), 10, 0.96), near(axis(0, dim), 11, 0.95)]
    const g2 = [axis(1, dim), near(axis(1, dim), 12, 0.97)]
    const g3 = [axis(2, dim), near(axis(2, dim), 13, 0.95), near(axis(2, dim), 14, 0.94), near(axis(2, dim), 15, 0.96)]
    const singles = [3, 4, 5, 6, 7].map(i => axis(i, dim))
    const list: ConsolidationItem[] = [
      ...g1.map((v, i) => ({ id: `G1-${i}`, block: 'global', v })),
      ...g2.map((v, i) => ({ id: `G2-${i}`, block: 'global', v })),
      ...g3.map((v, i) => ({ id: `G3-${i}`, block: 'global', v })),
      ...singles.map((v, i) => ({ id: `S-${i}`, block: 'global', v })),
    ]
    const got = clustersOf(list).sort((x, y) => x[0].localeCompare(y[0]))
    expect(got).toEqual([
      ['G1-0', 'G1-1', 'G1-2'],
      ['G2-0', 'G2-1'],
      ['G3-0', 'G3-1', 'G3-2', 'G3-3'],
    ])
  })

  it('caps cluster size', () => {
    const dim = 64
    const vs = Array.from({ length: 12 }, (_, i) => near(axis(0, dim), 10 + i, 0.97))
    const list = items(vs)
    const pairs = candidatePairs(list, { threshold: 0.85, k: 20 })
    const cl = completeLinkageClusters(new Map(list.map(i => [i.id, i.v])), pairs, { threshold: 0.85, maxSize: 5 })
    expect(Math.max(...cl.map(c => c.members.length))).toBe(5)
    // Nobody is in two clusters.
    const all = cl.flatMap(c => c.members)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('blocking (D7): same scope, and in group scopes the same author', () => {
  it('never pairs engrams across scopes, however similar', () => {
    const v = axis(0)
    const list: ConsolidationItem[] = [
      { id: 'A', block: 'global', v },
      { id: 'B', block: 'project:x', v },
    ]
    expect(candidatePairs(list, { threshold: 0.85 })).toEqual([])
  })

  it('keys group scopes by author and personal scopes by scope alone', () => {
    const base = { statement: 's', status: 'active' } as never
    expect(blockKeyFor({ ...(base as object), scope: 'global', attribution: { asserted_by: 'a' } } as never))
      .toBe(blockKeyFor({ ...(base as object), scope: 'global', attribution: { asserted_by: 'b' } } as never))
    expect(blockKeyFor({ ...(base as object), scope: 'group:org/team', attribution: { asserted_by: 'a' } } as never))
      .not.toBe(blockKeyFor({ ...(base as object), scope: 'group:org/team', attribution: { asserted_by: 'b' } } as never))
  })
})

describe('polarity check (D7)', () => {
  it('a negation pair ("always X" / "never X") is a mixed-polarity cluster', () => {
    const always = { statement: 'Always rebase before pushing to main', polarity: null } as never
    const never = { statement: 'Never rebase before pushing to main', polarity: null } as never
    expect(polarityOf(always)).toBe('do')
    expect(polarityOf(never)).toBe('dont')
    expect(mixedPolarity([always, never])).toBe(true)
    expect(mixedPolarity([never, { statement: 'Do not rebase before pushing to main', polarity: null } as never])).toBe(false)
  })
})

describe('the merge prompt reuses the duplicate checker\'s decision guide', () => {
  it('asks per cluster for MERGE (with one statement) or SPLIT, and parses both', () => {
    const prompt = buildConsolidationPrompt([
      { members: [{ id: 'E1', statement: 'Use pnpm here' }, { id: 'E2', statement: 'This repo uses pnpm' }] },
      { members: [{ id: 'E3', statement: 'Port 8080 for staging' }, { id: 'E4', statement: 'Port 8081 for staging' }] },
    ])
    expect(prompt).toContain('NOOP')
    expect(prompt).toContain('UPDATE')
    expect(prompt).toContain('CLUSTER_1')
    expect(prompt).toContain('[E4]')
    const parsed = parseConsolidationResponse(
      'CLUSTER_1:\nDECISION: MERGE\nSTATEMENT: Use pnpm, not npm, in this repository\nREASON: same rule\n\nCLUSTER_2:\nDECISION: SPLIT\nSTATEMENT: none\nREASON: different ports',
      2,
    )
    expect(parsed[0]).toEqual({ decision: 'merge', statement: 'Use pnpm, not npm, in this repository', reason: 'same rule' })
    expect(parsed[1]).toMatchObject({ decision: 'split' })
  })

  it('treats an unparseable answer as undecided, never as a merge', () => {
    expect(parseConsolidationResponse('I think they are the same', 1)[0].decision).toBe('pending')
    expect(parseConsolidationResponse('CLUSTER_1:\nDECISION: MERGE\nSTATEMENT: none', 1)[0].decision).toBe('pending')
  })
})

describe('nightly sample (R9)', () => {
  it('derives the seed from the date and samples deterministically', () => {
    expect(nightlySeed(new Date('2026-11-10T23:30:00Z'))).toBe('2026-11-10')
    const ids = Array.from({ length: 500 }, (_, i) => `E${i}`)
    const a = seededSample(ids, '2026-11-10', 50)
    const b = seededSample(ids, '2026-11-10', 50)
    const c = seededSample(ids, '2026-11-11', 50)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(new Set(a).size).toBe(50)
  })
})

describe('candidate generation at scale', () => {
  function plantedStore(n: number, dim: number, dups: number) {
    const vs = randomUnitVectors(n, dim, 7)
    const list = items(vs)
    // Plant duplicates: copy of item i nudged to ~0.95.
    const planted: Array<[string, string]> = []
    const noise = randomUnitVectors(dups, dim, 99)
    for (let d = 0; d < dups; d++) {
      const src = list[d * Math.floor(n / dups)]
      const v = new Float32Array(dim)
      let norm = 0
      for (let k = 0; k < dim; k++) { v[k] = src.v[k] * 0.95 + noise[d][k] * 0.31; norm += v[k] * v[k] }
      norm = Math.sqrt(norm)
      for (let k = 0; k < dim; k++) v[k] /= norm
      const id = `DUP${d}`
      list.push({ id, block: 'global', v })
      planted.push([src.id, id])
    }
    return { list, planted }
  }

  it('finds planted duplicates in a store above the exact-block limit (approximate pass)', () => {
    const { list, planted } = plantedStore(3000, 64, 30)
    const pairs = candidatePairs(list, { threshold: 0.85, exactBlockMax: 500, seed: 'test' })
    const found = new Set(pairs.map(p => [p.a, p.b].sort().join('|')))
    const hit = planted.filter(([a, b]) => found.has([a, b].sort().join('|'))).length
    expect(hit / planted.length).toBeGreaterThanOrEqual(0.9)
    for (const p of pairs) expect(p.score).toBeGreaterThanOrEqual(0.85)
  })

  it.skipIf(process.env.PLUR_SCALE_TESTS !== '1')('100k engrams: candidate generation completes within the bound', () => {
    const { list, planted } = plantedStore(100_000, 384, 200)
    const t0 = Date.now()
    const pairs = candidatePairs(list, { threshold: 0.85, seed: 'scale' })
    const ms = Date.now() - t0
    const found = new Set(pairs.map(p => [p.a, p.b].sort().join('|')))
    const hit = planted.filter(([a, b]) => found.has([a, b].sort().join('|'))).length
    // eslint-disable-next-line no-console
    console.log(`100k candidate pass: ${ms} ms, ${pairs.length} pairs, ${hit}/${planted.length} planted found`)
    expect(ms).toBeLessThan(180_000)
    expect(hit / planted.length).toBeGreaterThanOrEqual(0.85)
  }, 600_000)
})
