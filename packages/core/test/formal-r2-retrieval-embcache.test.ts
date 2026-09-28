// Formal verification round 2, core-retrieval#12 (spec/formal/findings/r2-retrieval.md §6).
// mergeEmbeddingsIntoCache: "existing entries win" is only sound when the existing entry
// was computed from the SAME text as the (freshness-verified) import. An existing entry
// keyed to older text must be replaced, or the export's vector is thrown away and the
// engram is re-embedded anyway. Model: PlurSpec.R2Retrieval.EmbCache.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { mergeEmbeddingsIntoCache } from '../src/embeddings.js'

const h = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16)
const active = { name: 'stub', dim: 3 }

function seed(dir: string, entries: Record<string, { hash: string; embedding: number[] }>) {
  writeFileSync(join(dir, '.embeddings-cache.json'), JSON.stringify({
    meta: { embedder_name: 'stub', embedder_dim: 3, version: 1 }, entries,
  }))
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, '.embeddings-cache.json'), 'utf8')).entries

describe('formal R2 core-retrieval#12 — embedding cache merge compares hashes', () => {
  it('replaces an existing entry computed from older text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-r2-embcache-'))
    seed(dir, { 'ENG-1': { hash: h('old text'), embedding: [1, 0, 0] } })
    const n = mergeEmbeddingsIntoCache(dir, active, [{ engramId: 'ENG-1', searchText: 'new text', embedding: [0, 1, 0] }])
    expect(n).toBe(1) // pre-fix: 0
    expect(read(dir)['ENG-1']).toEqual({ hash: h('new text'), embedding: [0, 1, 0] })
  })

  it('keeps an existing entry for the same text (existing still wins when equally fresh)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-r2-embcache-'))
    seed(dir, { 'ENG-1': { hash: h('same text'), embedding: [1, 0, 0] } })
    const n = mergeEmbeddingsIntoCache(dir, active, [{ engramId: 'ENG-1', searchText: 'same text', embedding: [0, 1, 0] }])
    expect(n).toBe(0)
    expect(read(dir)['ENG-1'].embedding).toEqual([1, 0, 0])
  })
})
