/**
 * Binary companion of the embedding cache. Every cold process (each hook run)
 * used to JSON-parse the whole cache — 132 MB and ~2.2 s on a 14k-engram
 * store, enough to push a unified first-prompt injection past the hook's
 * hybrid deadline. After a JSON parse the vectors are also written to
 * `.embeddings-cache.vectors.bin` (float64, so values come back bit-exact),
 * stamped with the JSON file's size, mtime and inode. A later load reads it
 * only while that stamp still matches; anything else falls back to the JSON.
 * The JSON stays the file of record.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, truncateSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { _readEmbeddingCacheEntries } from '../src/embeddings.js'

const META = { name: 'test-embedder', dim: 4 }
const vec = (seed: number) => [Math.PI / seed, -Math.E / (seed + 1), 1 / 3 + seed * 1e-9, -0.1 * seed]
function writeJsonCache(path: string, ids: string[], seedBase = 1): void {
  const entries: Record<string, { hash: string; embedding: number[] }> = {}
  ids.forEach((id, i) => { entries[id] = { hash: `h${i}${seedBase}`, embedding: vec(i + seedBase) } })
  writeFileSync(path, JSON.stringify({ meta: { embedder_name: META.name, embedder_dim: META.dim, version: 1 }, entries }))
}

describe('embedding cache vector sidecar', () => {
  let dir: string, cache: string, side: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-vec-sidecar-'))
    cache = join(dir, '.embeddings-cache.json')
    side = join(dir, '.embeddings-cache.vectors.bin')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is written after a JSON load and reproduces the entries bit-exactly', () => {
    writeJsonCache(cache, ['ENG-A', 'ENG-B', 'ENG-C'])
    const first = _readEmbeddingCacheEntries(cache, META)
    expect(existsSync(side)).toBe(true)
    const second = _readEmbeddingCacheEntries(cache, META)
    expect(second).toEqual(first)
    expect(second['ENG-B'].embedding[0]).toBe(Math.PI / 2)
  })

  it('is used while the JSON stamp matches (proved by an in-place edit that keeps size and mtime)', () => {
    writeJsonCache(cache, ['ENG-A', 'ENG-B'])
    const t = 1_700_000_000 // whole seconds: utimes cannot restore a sub-ms mtime exactly
    utimesSync(cache, t, t)
    _readEmbeddingCacheEntries(cache, META)
    const text = readFileSync(cache, 'utf8').replace('"hash":"h01"', '"hash":"h0X"')
    writeFileSync(cache, text)
    utimesSync(cache, t, t)
    expect(_readEmbeddingCacheEntries(cache, META)['ENG-A'].hash).toBe('h01')
  })

  it('is ignored once the JSON is rewritten, and refreshed', () => {
    writeJsonCache(cache, ['ENG-A', 'ENG-B'])
    _readEmbeddingCacheEntries(cache, META)
    writeJsonCache(cache, ['ENG-A', 'ENG-B', 'ENG-NEW'], 7)
    utimesSync(cache, new Date(), new Date(Date.now() + 5000))
    const e = _readEmbeddingCacheEntries(cache, META)
    expect(Object.keys(e).sort()).toEqual(['ENG-A', 'ENG-B', 'ENG-NEW'])
    expect(e['ENG-A'].embedding[0]).toBe(Math.PI / 7)
  })

  it('falls back to the JSON when the sidecar is damaged', () => {
    writeJsonCache(cache, ['ENG-A', 'ENG-B'])
    const good = _readEmbeddingCacheEntries(cache, META)
    truncateSync(side, 20)
    expect(_readEmbeddingCacheEntries(cache, META)).toEqual(good)
  })

  it('is not used for a different embedder', () => {
    writeJsonCache(cache, ['ENG-A'])
    _readEmbeddingCacheEntries(cache, META)
    expect(_readEmbeddingCacheEntries(cache, { name: 'other', dim: 4 })).toEqual({})
  })
})
