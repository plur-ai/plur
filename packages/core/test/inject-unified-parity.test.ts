/**
 * Ranking parity (overhaul W1, audit finding 11): unified injection ranks with
 * the SAME search recall runs — BM25 over the rewritten query and the meaning
 * leg fused by RRF, intent routing, the reranker only when configured — so its
 * general task list is recall's top-K after the gates. The only differences
 * allowed are gate removals (here: pins, kept out of the task list) and the
 * packing caps; the budget is generous so nothing is skipped for size.
 *
 * Generated 3,000-engram fixture, a deterministic stub embedder (hashed bag of
 * words, with a retrieval instruction like BGE's), N sampled queries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled } from '../src/embeddings.js'
import { MAX_PER_DOMAIN } from '../src/inject.js'
import { buildLargeFixture, writeFixtureStore, prng, LARGE_QUERY } from './helpers/injection-fixture.js'
import type { Engram } from '../src/schemas/engram.js'

const DIM = 64

function hashWord(w: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

/** Hashed bag of words: two buckets per word, unit length. */
function stubVector(text: string): Float32Array {
  const v = new Float32Array(DIM)
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const h = hashWord(w)
    v[h % DIM] += 1
    v[(h >>> 8) % DIM] += 0.5
  }
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < DIM; i++) v[i] /= n
  return v
}

describe('unified injection ranks with recall\'s search (finding 11)', () => {
  let dir: string
  let fixture: ReturnType<typeof buildLargeFixture>
  let plur: Plur

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-unified-parity-'))
    fixture = buildLargeFixture(3000)
    writeFixtureStore(dir, fixture.engrams, 'injection:\n  mode: unified\n  prohibition_ratio: 0\n')
    setEmbeddingsEnabled(true)
    _setCachedEmbedder({
      name: 'stub-parity', dim: DIM, modelId: 'stub-parity',
      searchInstruction: 'Represent this sentence for searching relevant passages: ',
      embed: async (t: string) => stubVector(t),
      embedBatch: async (ts: string[]) => ts.map(stubVector),
    })
    plur = new Plur({ path: dir, autoDiscover: false })
  }, 60_000)
  afterAll(() => {
    resetEmbedder()
    rmSync(dir, { recursive: true, force: true })
  })

  function sampledQueries(n: number): string[] {
    const rnd = prng(11)
    const words = (e: Engram) => e.statement.toLowerCase().match(/[a-z]{4,}/g) ?? []
    const pool = fixture.engrams.filter(e => !(e as { pinned?: boolean }).pinned)
    const out = [LARGE_QUERY]
    while (out.length < n) {
      const a = words(pool[Math.floor(rnd() * pool.length)])
      const b = words(pool[Math.floor(rnd() * pool.length)])
      const pick = (ws: string[], k: number) => Array.from({ length: k }, () => ws[Math.floor(rnd() * ws.length)])
      if (a.length < 3 || b.length < 2) continue
      out.push(`${pick(a, 3).join(' ')} ${pick(b, 2).join(' ')}`)
    }
    return out
  }

  /** Recall's top-K after the gates: pins out (include_pinned: false), the per-domain cap, at most `limit`. */
  function expectedTaskList(recalled: Engram[], limit: number): string[] {
    const domains = new Map<string, number>()
    const out: string[] = []
    for (const e of recalled) {
      if (out.length >= limit) break
      if ((e as { pinned?: boolean }).pinned) continue
      const top = (e.domain ?? '__none__').split('.')[0]
      if ((domains.get(top) ?? 0) >= MAX_PER_DOMAIN) continue
      domains.set(top, (domains.get(top) ?? 0) + 1)
      out.push(e.id)
    }
    return out
  }

  it('for sampled queries, the unified task list is recall\'s top-K after the gates, in recall\'s order', async () => {
    const limit = plur.injectionSettings().recall_limit
    const mismatches: string[] = []
    for (const q of sampledQueries(12)) {
      const recalled = (await plur.recallHybridWithMeta(q, { limit, remote: false })).engrams
      expect(recalled.length).toBeGreaterThan(0)
      const r = await plur.injectHybrid(q, { budget: 100_000, include_pinned: false, remote: false })
      expect(r.selection).toBe('unified')
      const expected = expectedTaskList(recalled, limit)
      const got = (r.task_ids ?? []).slice(0, expected.length)
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches.push(`${q}\n  recall:  ${expected.join(' ')}\n  unified: ${got.join(' ')}`)
    }
    expect(mismatches, mismatches.join('\n')).toEqual([])
  }, 120_000)
})
