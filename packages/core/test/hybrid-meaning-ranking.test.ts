/**
 * Hybrid recall: the meaning side ranks well and a weak keyword match does
 * not crowd it out.
 *
 * Three retrieval rules, each pinned with a stub embedder whose vectors are
 * chosen per text, so the tests need no model and no network:
 *
 *  1. Retrieval instruction. Models such as BGE are trained to embed a short
 *     search query with an instruction in front of it ("Represent this
 *     sentence for searching relevant passages: "), and stored text without
 *     one. The ranking leg of search uses the adapter's instruction; stored
 *     text and the symmetric similarity used by duplicate checks never get it.
 *  2. Centring. Sentence embeddings share a large common direction, so raw
 *     cosine partly measures "looks like a typical memory". Ranking subtracts
 *     the candidate set's mean vector from the query and every candidate
 *     before comparing.
 *  3. Fusion. A keyword hit counts in proportion to how much of the query it
 *     explains (IDF-weighted share of query words it matches). One matched word
 *     out of four no longer ties with the best meaning match.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'
import {
  _setCachedEmbedder, embeddingSearch, embeddingSearchWithScores, resetEmbedder, setEmbeddingsEnabled,
} from '../src/embeddings.js'
import { hybridSearchWithMeta } from '../src/hybrid-search.js'
import { searchEngrams } from '../src/fts.js'

const unit = (v: number[]): Float32Array => {
  const n = Math.hypot(...v) || 1
  return new Float32Array(v.map(x => x / n))
}

/** Stub adapter: a fixed vector per exact text, a default for anything else. */
function stub(vectors: Map<string, Float32Array>, fallback: Float32Array, searchInstruction?: string) {
  const seen: string[] = []
  const embed = async (t: string) => { seen.push(t); return vectors.get(t) ?? fallback }
  _setCachedEmbedder({
    name: 'stub-meaning', dim: fallback.length, modelId: 'stub',
    embed, embedBatch: async (ts: string[]) => Promise.all(ts.map(embed)),
    ...(searchInstruction ? { searchInstruction } : {}),
  } as Parameters<typeof _setCachedEmbedder>[0])
  return seen
}

describe('hybrid recall ranks by meaning without being crowded out by weak keyword hits', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-meaning-'))
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\n')
    setEmbeddingsEnabled(true)
    resetEmbedder()
    plur = new Plur({ path: dir, autoDiscover: false })
    await plur.ready()
  })
  afterEach(() => {
    resetEmbedder()
    setEmbeddingsEnabled(true)
    rmSync(dir, { recursive: true, force: true })
  })

  /** Written with embeddings off (no model load, no similarity merge); each test installs its stub after. */
  async function teach(statements: string[]): Promise<Engram[]> {
    setEmbeddingsEnabled(false, 'test: writing fixtures')
    for (const s of statements) await plur.learn(s, { scope: 'global' })
    setEmbeddingsEnabled(true)
    const all = await plur.list()
    expect(new Set(statements.map(s => all.find(e => e.statement === s)?.id)).size).toBe(statements.length)
    return statements.map(s => all.find(e => e.statement === s)!)
  }

  it('the search leg embeds the query with the model\'s retrieval instruction; stored text and similarity scores do not', async () => {
    const [a] = await teach(['Rotate signing keys every ninety days'])
    const INSTR = 'Represent this sentence for searching relevant passages: '
    const seen = stub(new Map(), unit([1, 0, 0]), INSTR)

    await embeddingSearch([a], 'how often do keys change?', 5, dir)
    expect(seen).toContain(INSTR + 'how often do keys change?')
    expect(seen.filter(t => t.startsWith(INSTR))).toHaveLength(1)
    expect(seen.some(t => t.startsWith(INSTR) && t.includes('Rotate signing keys'))).toBe(false)

    seen.length = 0
    await embeddingSearchWithScores([a], 'Rotate signing keys every ninety days', 5, dir)
    expect(seen.some(t => t.startsWith(INSTR)), 'similarity scores feed duplicate thresholds: no instruction there').toBe(false)
  })

  it('an adapter without an instruction embeds the query as typed', async () => {
    const [a] = await teach(['Rotate signing keys every ninety days'])
    const seen = stub(new Map(), unit([1, 0, 0]))
    await embeddingSearch([a], 'how often do keys change?', 5, dir)
    expect(seen).toContain('how often do keys change?')
  })

  it('ranks by the direction that distinguishes a memory, not by the direction every memory shares', async () => {
    // Every memory leans hard on axis 0 (the shared direction). The answer
    // differs from the rest on axis 1, as the query does; a decoy simply leans
    // on axis 0 a little harder than the answer. Raw cosine prefers the decoy.
    const fillers = Array.from({ length: 24 }, (_, i) => `Filler memory number ${i} about routine upkeep`)
    const statements = ['The answer memory', 'The decoy memory', ...fillers]
    const engrams = await teach(statements)
    const vec = new Map<string, Float32Array>()
    vec.set('The answer memory', unit([0.5, 0.866, 0, 0]))
    vec.set('The decoy memory', unit([1, 0, 0.05, 0]))
    fillers.forEach((f, i) => vec.set(f, unit([1, 0, (i % 2 ? 1 : -1) * 0.1, (i % 3 ? 1 : -1) * 0.1])))
    vec.set('which memory answers this?', unit([1, 0.5, 0, 0]))
    stub(vec, unit([0, 0, 0, 1]))

    const top = await embeddingSearch(engrams, 'which memory answers this?', 3, dir)
    expect(top[0].statement).toBe('The answer memory')
  })

  it('a store of one or two memories ranks exactly as raw cosine does', async () => {
    const engrams = await teach(['First memory', 'Second memory'])
    const vec = new Map<string, Float32Array>([
      ['First memory', unit([1, 0.2, 0])],
      ['Second memory', unit([1, 0, 0.2])],
      ['query close to the first', unit([1, 0.15, 0.02])],
      ['query close to the second', unit([1, 0.02, 0.15])],
    ])
    stub(vec, unit([0, 0, 1]))
    expect((await embeddingSearch(engrams, 'query close to the first', 2, dir)).map(e => e.statement))
      .toEqual(['First memory', 'Second memory'])
    expect((await embeddingSearch(engrams, 'query close to the second', 2, dir)).map(e => e.statement))
      .toEqual(['Second memory', 'First memory'])
    expect((await embeddingSearch([engrams[0]], 'query close to the second', 2, dir)).map(e => e.statement))
      .toEqual(['First memory'])
  })

  it('a keyword hit matching one query word in four does not crowd the meaning matches out of the top five', async () => {
    // Ten meaning matches fill the meaning leg's list (twice the limit), so the
    // weak hit is in the keyword list only.
    const meaning = Array.from({ length: 10 }, (_, i) => `Meaning match ${'abcdefghij'[i]} phrased differently`)
    const fillers = Array.from({ length: 12 }, (_, i) => `Unrelated filler entry ${i} concerning lunch`)
    const weak = 'Okapi sightings are logged weekly'
    const engrams = await teach([...meaning, ...fillers, weak])
    const q = 'zebra quokka narwhal okapi'
    const vec = new Map<string, Float32Array>()
    meaning.forEach((m, i) => vec.set(m, unit([1, 0.05 * i, 0])))
    fillers.forEach(f => vec.set(f, unit([0.5, 1, 0])))
    vec.set(weak, unit([0.5, 1, 0]))
    vec.set(q, unit([1, 0, 0]))
    stub(vec, unit([0, 1, 0]))

    const r = await hybridSearchWithMeta(engrams, q, 5, dir)
    expect(r.mode).toBe('hybrid')
    const got = r.engrams.map(e => e.statement)
    expect(got).toEqual(meaning.slice(0, 5))
    expect(got).not.toContain(weak)
  })

  it('a keyword hit matching the whole query still makes the top five when the meaning side misses it', async () => {
    const meaning = Array.from({ length: 6 }, (_, i) => `Meaning match ${'abcdef'[i]} phrased differently`)
    const fillers = Array.from({ length: 12 }, (_, i) => `Unrelated filler entry ${i} concerning lunch`)
    const strong = 'zebra quokka narwhal okapi enclosure rota'
    const engrams = await teach([...meaning, ...fillers, strong])
    const q = 'zebra quokka narwhal okapi'
    const vec = new Map<string, Float32Array>()
    meaning.forEach((m, i) => vec.set(m, unit([1, 0.05 * i, 0])))
    fillers.forEach(f => vec.set(f, unit([0.5, 1, 0])))
    vec.set(strong, unit([0, 0, 1]))
    vec.set(q, unit([1, 0, 0]))
    stub(vec, unit([0, 1, 0]))

    const r = await hybridSearchWithMeta(engrams, q, 5, dir)
    expect(r.engrams.map(e => e.statement)).toContain(strong)
  })

  it('with embeddings off the keyword order is returned unchanged', async () => {
    const engrams = await teach([
      'zebra quokka enclosure', 'zebra only here', 'quokka narwhal okapi zebra all four', 'okapi alone',
    ])
    setEmbeddingsEnabled(false, 'test: keyword only')
    const q = 'zebra quokka narwhal okapi'
    const r = await hybridSearchWithMeta(engrams, q, 5, dir)
    expect(r.mode).toBe('bm25-only')
    expect(r.engrams.map(e => e.id)).toEqual(searchEngrams(engrams, q, 15).slice(0, 5).map(e => e.id))
  })
})
