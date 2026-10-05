/**
 * #1586 audit round 7 (PR #1587).
 *
 *   D-1  a torn last line in the delta file never swallows the next record
 *   D-2  the delta file is compacted once it passes a threshold, even when
 *        no search ever completes
 *   D-3  compaction keeps the records of a different model or dimension
 *   D-4  a malformed config.json is "not present" for that cache (fallback
 *        still works); external chunks under device_config.cpu count; the
 *        migration import is never overridden by an older delta record
 *   D-5  an existing store's .gitignore gains the delta and lock lines;
 *        none is ever created
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import * as emb from '../src/embeddings.js'
import * as tb from '../src/embedders/transformers-base.js'

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

const ENV_KEYS = ['PLUR_MODEL_CACHE_DIR', 'HF_HOME', 'HF_HUB_OFFLINE', 'PLUR_EMBEDDER'] as const
const savedEnv: Record<string, string | undefined> = {}
let wasDisabled = false
beforeEach(() => {
  wasDisabled = emb.embedderStatus().disabled
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  ;(emb as any)._setDeltaCompactBytes?.(undefined)
  ;(tb as any)._setDefaultModelCacheDir?.(undefined)
  tb._resetTransformersPipelineCache()
  emb.resetEmbedder()
  emb.setEmbeddingsEnabled(!wasDisabled)
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const A = { name: 'model-a', dim: 2 }
const B = { name: 'model-b', dim: 3 }
const append = (emb as any)._appendEmbeddingCacheEntries as (p: string, m: object, e: object) => boolean
const read = (emb as any)._readEmbeddingCacheEntries as (p: string, m: object) => Record<string, unknown>

describe('D-1 — a torn last line does not swallow the next record', () => {
  it('a partial line, then an append: the appended record is recovered', () => {
    const dir = tmp('plur-1587-r7-')
    const p = join(dir, '.embeddings-cache.json')
    writeFileSync(join(dir, '.embeddings-cache.delta.jsonl'), '{"id":"torn')
    expect(append(p, A, { valid: { hash: 'h', embedding: [1, 0] } })).toBe(true)
    expect(Object.keys(read(p, A))).toContain('valid')
  })
})

describe('D-3 — compaction keeps other models\' records', () => {
  it('a process on model A compacting leaves model B\'s delta records in place', () => {
    const dir = tmp('plur-1587-r7-')
    const p = join(dir, '.embeddings-cache.json')
    append(p, A, { a1: { hash: 'h', embedding: [1, 0] } })
    append(p, B, { b1: { hash: 'h', embedding: [0, 1, 0] } })
    const compact = (emb as any)._compactEmbeddingCache
    expect(typeof compact).toBe('function')
    expect(compact(p, A)).toBe(true)
    expect(Object.keys(read(p, A))).toContain('a1')
    expect(Object.keys(read(p, B))).toContain('b1')
  })
})

/** A deterministic stand-in embedder that takes `ms` per text. */
function slowEmbedder(ms: number): void {
  const vec = (text: string): Float32Array => {
    const v = new Float32Array(384)
    for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 384] += 1
    let n = 0
    for (const x of v) n += x * x
    n = Math.sqrt(n) || 1
    return v.map(x => x / n)
  }
  emb._setCachedEmbedder({
    name: 'slow-test', dim: 384, modelId: 'test/slow',
    embed: (t: string) => new Promise<Float32Array>(r => setTimeout(() => r(vec(t)), ms)),
    embedBatch: async (ts: string[]) => ts.map(vec),
  })
}

describe('D-2 — the delta file stays bounded without a completed search', () => {
  it('many cut-off recalls: the delta is folded in once it passes the threshold', async () => {
    const dir = tmp('plur-1587-r7-store-')
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    const plur = new Plur({ path: dir })
    for (let i = 0; i < 60; i++) await plur.learn(`release checklist item number ${i} covers step ${i * 7} of the rollout`)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(30)
    const setBytes = (emb as any)._setDeltaCompactBytes
    expect(typeof setBytes).toBe('function')
    setBytes(30_000) // about 4 vectors of 384 floats
    const delta = join(dir, '.embeddings-cache.delta.jsonl')
    let maxBytes = 0
    for (let i = 0; i < 8; i++) {
      await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 200, remote: false })
      await new Promise(r => setTimeout(r, 60))
      if (existsSync(delta)) maxBytes = Math.max(maxBytes, readFileSync(delta).length)
    }
    // Bounded: one recall's worth past the threshold at most, never the sum.
    expect(maxBytes).toBeLessThan(30_000 + 8 * 8_000)
    expect(existsSync(join(dir, '.embeddings-cache.json'))).toBe(true)
  }, 60_000)
})

describe('D-4 — presence edge cases and the migration import', () => {
  const BGE = 'Xenova/bge-small-en-v1.5'
  function provision(root: string, config: string): void {
    mkdirSync(join(root, BGE, 'onnx'), { recursive: true })
    writeFileSync(join(root, BGE, 'onnx', 'model.onnx'), 'w')
    writeFileSync(join(root, BGE, 'config.json'), config)
    writeFileSync(join(root, BGE, 'tokenizer.json'), '{}')
    writeFileSync(join(root, BGE, 'tokenizer_config.json'), '{}')
  }

  it('a malformed config.json in the override cache does not block the default-cache fallback', async () => {
    const override = tmp('plur-1587-r7-override-')
    const def = tmp('plur-1587-r7-default-')
    provision(override, '{ not json')
    provision(def, '{}')
    ;(tb as any)._setDefaultModelCacheDir(def)
    process.env.PLUR_MODEL_CACHE_DIR = override
    expect(await (tb as any).resolveLoadCacheDir(BGE, 'model.onnx')).toBe(def)
  })

  it('external chunks declared under device_config.cpu are required', async () => {
    const cache = tmp('plur-1587-r7-cache-')
    provision(cache, JSON.stringify({ 'transformers.js_config': { device_config: { cpu: { use_external_data_format: { 'model.onnx': 1 } } } } }))
    ;(tb as any)._setDefaultModelCacheDir(tmp('plur-1587-r7-empty-'))
    process.env.PLUR_MODEL_CACHE_DIR = cache
    expect(await (tb as any).modelPresence(BGE, 'model.onnx')).toBe(false)
    writeFileSync(join(cache, BGE, 'onnx', 'model.onnx_data'), 'd')
    expect(await (tb as any).modelPresence(BGE, 'model.onnx')).toBe(true)
  })

  it('the migration import is not overridden by an older delta record', () => {
    const dir = tmp('plur-1587-r7-')
    const p = join(dir, '.embeddings-cache.json')
    const meta = { name: 'model-a', dim: 2 }
    append(p, meta, { e1: { hash: 'old-hash', embedding: [0, 1] } }) // older, in the delta
    const written = emb.mergeEmbeddingsIntoCache(dir, meta, [{ engramId: 'e1', searchText: 'new text', embedding: [1, 0] }])
    expect(written).toBe(1)
    const entries = read(p, meta) as Record<string, { embedding: number[] }>
    expect(entries.e1.embedding).toEqual([1, 0])
  })
})

describe('D-5 (round 8) — opening a store never edits its .gitignore', () => {
  for (const git of [false, true]) {
    it(`an existing .gitignore is left byte for byte (${git ? 'a git repository' : 'not a git repository'})`, () => {
      const dir = tmp('plur-1587-r8-ign-')
      if (git) mkdirSync(join(dir, '.git'))
      const original = '# mine\nconfig.yaml\n.embeddings-cache.json\n'
      writeFileSync(join(dir, '.gitignore'), original)
      writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
      new Plur({ path: dir })
      new Plur({ path: dir })
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(original)
    })
  }

  it('a store without a .gitignore does not get one on open', () => {
    const dir = tmp('plur-1587-r8-noign-')
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    new Plur({ path: dir })
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
  })
})
