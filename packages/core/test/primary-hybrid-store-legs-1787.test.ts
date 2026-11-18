/**
 * #1787 — hybrid recall takes both legs from a primary store that can search
 * by meaning (`searchVector`) and by keyword (`searchBM25`) itself, and fuses
 * them in core, instead of loading every memory and ranking in process.
 *
 * Pinned here:
 * - both store searches are asked, and no full read (`load`, `loadCached`,
 *   `loadFiltered`) happens during the recall;
 * - the scope restriction, the permitted-scope allow-list and the visibility
 *   grants go INTO both store searches (dropping them is an authorization bug);
 * - `domain` is honoured on the meaning leg, which the store call cannot take;
 * - a store that has not embedded every memory falls back to the in-memory
 *   path and says so in `degraded_reason`, with complete results;
 * - a failing store search falls back rather than failing the recall;
 * - a store without `searchVector` keeps the previous path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EXACT_VECTOR_INDEX, MemoryPrimaryStore, Plur } from '../src/index.js'
import * as emb from '../src/embeddings.js'
import type { Engram } from '../src/schemas/engram.js'

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
}

function bagOfWords(text: string, dim = 64): Float32Array {
  const v = new Float32Array(dim)
  for (const w of words(text)) {
    let h = 2166136261
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    v[(h >>> 0) % dim] += 1
  }
  const n = Math.hypot(...v) || 1
  return v.map(x => x / n)
}

type Opts = Record<string, unknown>

/** A primary store with its own searches; records every call. */
class SearchingStore extends MemoryPrimaryStore {
  readonly role = 'primary' as const
  readonly vectorIndex = EXACT_VECTOR_INDEX
  fullReads: string[] = []
  vectorOpts: Opts[] = []
  keywordOpts: Opts[] = []
  /** Ids the meaning index returns, in order, for any query. */
  meaningAnswer: string[] = []
  missingEmbeddings = false
  vectorFails = false

  private async all(): Promise<Engram[]> { return super.load() }
  override async load(): Promise<Engram[]> { this.fullReads.push('load'); return super.load() }
  override async loadCached(): Promise<Engram[]> { this.fullReads.push('loadCached'); return super.load() }
  async loadFiltered(filter: { status?: string }): Promise<Engram[]> {
    this.fullReads.push('loadFiltered')
    return (await this.all()).filter(e => !filter?.status || e.status === filter.status)
  }
  async count(): Promise<number> { return (await this.all()).length }

  async searchBM25(query: string, opts: { limit: number } & Opts): Promise<Engram[]> {
    this.keywordOpts.push(opts)
    const q = words(query)
    return (await this.all())
      .filter(e => e.status === 'active')
      .map(e => ({ e, n: [...words(e.statement)].filter(w => q.has(w)).length }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, opts.limit)
      .map(x => x.e)
  }

  async searchVector(_q: Float32Array, limit: number, opts?: Opts): Promise<Array<{ engram: Engram; score: number }>> {
    this.vectorOpts.push(opts ?? {})
    if (this.vectorFails) throw new Error('vector index offline')
    const rows = await this.all()
    return this.meaningAnswer
      .map(id => rows.find(e => e.id === id))
      .filter((e): e is Engram => !!e && e.status === 'active')
      .slice(0, limit)
      .map(engram => ({ engram, score: 0.9 }))
  }

  async upsertEmbedding(): Promise<void> {}
  async listEngramsMissingEmbeddings(): Promise<Engram[]> {
    return this.missingEmbeddings ? (await this.all()).slice(0, 1) : []
  }
  async close(): Promise<void> {}
}

/** The same store without a meaning search. */
class KeywordOnlyStore extends SearchingStore {
  declare searchVector: never
  constructor() {
    super()
    ;(this as unknown as { searchVector?: unknown }).searchVector = undefined
  }
}

const QUESTION = 'staging database password rotation'
const KEYWORD = 'Rotate the staging database password every quarter'
const MEANING = 'Credentials for the pre-production cluster expire each season'
const FILLER = [
  'The staging server restarts at midnight',
  'Back up the analytics database every night',
  'A password manager is allowed on work laptops',
  'Lunch orders go in the shared kitchen sheet',
]

describe('hybrid recall uses the primary store\'s own searches (#1787)', () => {
  const dirs: string[] = []
  let wasDisabled = false
  beforeEach(() => {
    wasDisabled = emb.embedderStatus().disabled
    emb.setEmbeddingsEnabled(true)
    emb._setCachedEmbedder({
      name: 'bag-of-words-test', dim: 64, modelId: 'test/bow',
      embed: async (t: string) => bagOfWords(t),
      embedBatch: async (ts: string[]) => ts.map(t => bagOfWords(t)),
    })
  })
  afterEach(() => {
    emb.resetEmbedder()
    emb.setEmbeddingsEnabled(!wasDisabled)
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  async function open<S extends SearchingStore>(store: S, domainOf: (s: string) => string | undefined = () => undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'plur-1787-'))
    dirs.push(dir)
    const plur = new Plur({ path: dir, store, autoDiscover: false })
    await plur.ready()
    const ids: Record<string, string> = {}
    for (const s of [KEYWORD, MEANING, ...FILLER]) {
      const d = domainOf(s)
      ids[s] = (await plur.learn(s, { scope: 'global', ...(d ? { domain: d } : {}) })).id
    }
    store.fullReads = []
    store.vectorOpts = []
    store.keywordOpts = []
    return { plur, store, ids }
  }

  it('asks both store searches, fuses them, and reads no memory in full', async () => {
    const { plur, store, ids } = await open(new SearchingStore())
    store.meaningAnswer = [ids[MEANING]]
    const r = await plur.recallHybridWithMeta(QUESTION, { limit: 5 })
    expect(store.vectorOpts.length).toBeGreaterThan(0)
    expect(store.keywordOpts.length).toBeGreaterThan(0)
    expect(store.fullReads).toEqual([])
    expect(r.mode).toBe('hybrid')
    expect(r.degraded_reason).toBeUndefined()
    expect(r.results_complete).toBe(true)
    expect(r.engrams.slice(0, 2).map(e => e.id).sort()).toEqual([ids[KEYWORD], ids[MEANING]].sort())
    expect(r.topScore).toBeGreaterThan(0)
    expect(r.engrams.length).toBeLessThanOrEqual(5)
  })

  it('passes scope, the permitted-scope allow-list and the visibility grants into both searches', async () => {
    const { plur, store, ids } = await open(new SearchingStore())
    store.meaningAnswer = [ids[MEANING]]
    await plur.recallHybridWithMeta(QUESTION, { limit: 5, scope: 'project:alpha', scopes: ['global', 'project:alpha'] })
    expect(store.vectorOpts[0]).toMatchObject({ scope: 'project:alpha', scopes: ['global', 'project:alpha'] })
    expect(store.vectorOpts[0]).toHaveProperty('visibilityGrants')
    expect(store.keywordOpts[0]).toMatchObject({ status: 'active', scope: 'project:alpha', scopes: ['global', 'project:alpha'] })
    expect(store.keywordOpts[0]).toHaveProperty('visibilityGrants')
  })

  it('applies the domain filter to the meaning leg, which the store call cannot take', async () => {
    const { plur, store, ids } = await open(new SearchingStore(), s => (s === MEANING ? 'ops.secrets' : 'eng.db'))
    store.meaningAnswer = [ids[MEANING]]
    const r = await plur.recallHybridWithMeta(QUESTION, { limit: 5, domain: 'eng' })
    expect(store.keywordOpts[0]).toMatchObject({ domain: 'eng' })
    expect(r.engrams.map(e => e.id)).not.toContain(ids[MEANING])
    expect(r.engrams[0]?.id).toBe(ids[KEYWORD])
  })

  it('falls back to the in-memory ranking while the store lacks embeddings, and says so', async () => {
    const { plur, store, ids } = await open(new SearchingStore())
    store.meaningAnswer = [ids[MEANING]]
    store.missingEmbeddings = true
    const r = await plur.recallHybridWithMeta(QUESTION, { limit: 5 })
    expect(store.vectorOpts).toEqual([])
    expect(store.fullReads.length).toBeGreaterThan(0)
    expect(r.degraded_reason).toBe('store_embeddings_incomplete')
    expect(r.embedderError).toMatch(/vector for every memory/)
    expect(r.results_complete).toBe(true)
    expect(r.engrams[0]?.id).toBe(ids[KEYWORD])
  })

  it('falls back rather than failing when the store\'s meaning search throws', async () => {
    const { plur, store, ids } = await open(new SearchingStore())
    store.vectorFails = true
    const r = await plur.recallHybridWithMeta(QUESTION, { limit: 5 })
    expect(store.fullReads.length).toBeGreaterThan(0)
    expect(r.engrams[0]?.id).toBe(ids[KEYWORD])
    expect(r.degraded_reason).toBeUndefined()
  })

  it('a store without searchVector keeps the previous in-memory path', async () => {
    const { plur, store, ids } = await open(new KeywordOnlyStore())
    const r = await plur.recallHybridWithMeta(QUESTION, { limit: 5 })
    expect(store.vectorOpts).toEqual([])
    expect(store.fullReads).toContain('loadFiltered')
    expect(r.mode).toBe('hybrid')
    expect(r.engrams[0]?.id).toBe(ids[KEYWORD])
  })
})
