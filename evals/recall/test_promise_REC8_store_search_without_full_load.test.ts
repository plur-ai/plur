// REC-8: When the memory store can search by meaning and by keyword itself, hybrid recall uses those searches and does not load every memory; stores that cannot keep working as before.
//
// "A store that can search by meaning and by keyword itself" is a store that
// is its own query engine (`role: 'primary'`) and offers both searches of the
// store interface: `searchVector` (meaning) and `searchBM25` (keyword), the
// names `StorageAdapter` defines and #1787 uses. A database store with its own
// vector index is the real-world case; here an in-process store stands in for
// it, so the eval is deterministic and offline.
//
// "Loading every memory" is any read that hands core the whole store: `load()`,
// `loadCached()`, or `loadFiltered()` (which, without an id list, returns every
// active memory the caller may see). Each is counted from just before the
// recall. Targeted reads by id (`loadByIds`, used to record that the found
// memories were used) are not a full read and are not counted.
//
// The store's meaning search finds one memory that shares no word with the
// question, as a real vector index would. The in-process ranking cannot find
// it by words, so seeing it at the top of the answer shows the store's own
// meaning search was used, not a re-ranking of a full load.
//
// The control arm is a store with neither search. It must still answer a
// hybrid recall correctly, as today.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXACT_VECTOR_INDEX, MemoryPrimaryStore, Plur } from '../../packages/core/src/index.js'
import type { Engram } from '../../packages/core/src/schemas/engram.js'
import { useEmbedder } from '../helpers/store.js'

const QUESTION = 'staging database password rotation'
const KEYWORD_MEMORY = 'Rotate the staging database password every quarter'
/** Shares no word with QUESTION: only a meaning search can connect them. */
const MEANING_MEMORY = 'Credentials for the pre-production cluster expire each season'
/**
 * The first three share one word with QUESTION, so a ranking done in process
 * over a full load puts them above MEANING_MEMORY; only the store's meaning
 * search lifts it into the top two.
 */
const FILLER = [
  'The staging server restarts at midnight',
  'Back up the analytics database every night',
  'A password manager is allowed on work laptops',
  'Lunch orders go in the shared kitchen sheet',
  'The office printer lives on the third floor',
  'Team retro happens on the last Friday of the month',
  'Use tabs, not spaces, in the legacy makefiles',
  'Holiday requests go through the people team',
]

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
}

/** A store that can search by meaning and keyword itself, and counts full reads. */
class SearchingStore extends MemoryPrimaryStore {
  readonly role = 'primary' as const
  readonly vectorIndex = EXACT_VECTOR_INDEX
  fullReads: string[] = []
  meaningCalls = 0
  keywordCalls = 0
  /** Ids the store's own meaning index finds for any question. */
  meaningAnswer: string[] = []

  private async all(): Promise<Engram[]> { return super.load() }
  override async load(): Promise<Engram[]> { this.fullReads.push('load()'); return super.load() }
  override async loadCached(): Promise<Engram[]> { this.fullReads.push('loadCached()'); return super.load() }
  async loadFiltered(filter: { status?: string }): Promise<Engram[]> {
    this.fullReads.push('loadFiltered()')
    return (await this.all()).filter(e => !filter?.status || e.status === filter.status)
  }
  async count(): Promise<number> { return (await this.all()).length }

  async searchBM25(query: string, opts: { limit: number; status?: string }): Promise<Engram[]> {
    this.keywordCalls++
    const q = words(query)
    return (await this.all())
      .filter(e => e.status === (opts.status ?? 'active'))
      .map(e => ({ e, n: [...words(e.statement)].filter(w => q.has(w)).length }))
      .filter(x => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, opts.limit)
      .map(x => x.e)
  }

  async searchVector(_query: Float32Array, limit: number): Promise<Array<{ engram: Engram; score: number }>> {
    this.meaningCalls++
    const rows = await this.all()
    return this.meaningAnswer
      .map(id => rows.find(e => e.id === id))
      .filter((e): e is Engram => !!e && e.status === 'active')
      .slice(0, limit)
      .map(engram => ({ engram, score: 0.9 }))
  }

  async upsertEmbedding(): Promise<void> {}
  /** Every memory has its vector in the store, so the meaning search is complete. */
  async listEngramsMissingEmbeddings(): Promise<Engram[]> { return [] }
  async close(): Promise<void> {}
}

/** A store with no search of its own: the in-process path, as before. */
class PlainStore extends MemoryPrimaryStore {}

describe('REC-8 a store that can search itself is searched, not loaded whole', () => {
  const dirs: string[] = []
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

  async function open<S extends MemoryPrimaryStore>(store: S): Promise<{ plur: Plur; store: S; keyword: string; meaning: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'plur-eval-rec8-'))
    dirs.push(dir)
    useEmbedder('bag-of-words')
    const plur = new Plur({ path: dir, store, autoDiscover: false })
    await plur.ready()
    const keyword = (await plur.learn(KEYWORD_MEMORY, { scope: 'global' })).id
    const meaning = (await plur.learn(MEANING_MEMORY, { scope: 'global' })).id
    for (const f of FILLER) await plur.learn(f, { scope: 'global' })
    return { plur, store, keyword, meaning }
  }

  it('store with meaning and keyword search: recall uses both and loads no memory in full', async () => {
    const { plur, store, keyword, meaning } = await open(new SearchingStore())
    const held = await store.count()
    expect(held, 'precondition: the store holds every memory taught').toBe(2 + FILLER.length)
    expect([...words(MEANING_MEMORY)].filter(w => words(QUESTION).has(w)),
      'precondition: the meaning memory shares no word with the question').toEqual([])
    store.meaningAnswer = [meaning]
    store.fullReads = []
    store.meaningCalls = 0
    store.keywordCalls = 0

    const result = await plur.recallHybridWithMeta(QUESTION, { limit: 5 })
    const ids = result.engrams.map(e => e.id)

    expect.soft(store.meaningCalls,
      `expected hybrid recall to ask the store's own meaning search; it was asked ${store.meaningCalls} times`).toBeGreaterThan(0)
    expect.soft(store.keywordCalls,
      `expected hybrid recall to ask the store's own keyword search; it was asked ${store.keywordCalls} times`).toBeGreaterThan(0)
    expect.soft(ids.slice(0, 2).sort(),
      `expected the store's meaning hit (${meaning}) and keyword hit (${keyword}) as the top two results; got ${JSON.stringify(ids)}`)
      .toEqual([keyword, meaning].sort())
    expect.soft(result.mode, `expected a full hybrid answer; mode was "${result.mode}" (${result.embedderError})`).toBe('hybrid')
    expect.soft(store.fullReads,
      `expected no read of every memory during recall (the store holds ${held}); core read the whole store ${store.fullReads.length} times: ${store.fullReads.join(', ')}`)
      .toEqual([])
  })

  it('control: a store without its own searches still gives correct hybrid results', async () => {
    const { plur, keyword } = await open(new PlainStore())

    const result = await plur.recallHybridWithMeta(QUESTION, { limit: 5 })
    const ids = result.engrams.map(e => e.id)
    expect(ids.length, 'control: expected a non-empty answer').toBeGreaterThan(0)
    expect(ids[0], `control: expected the keyword match ${keyword} first; got ${JSON.stringify(ids)}`).toBe(keyword)
    expect(result.mode, `control: expected a full hybrid answer; mode was "${result.mode}" (${result.embedderError})`).toBe('hybrid')
    expect(result.results_complete, 'control: expected complete results').toBe(true)
  })
})
