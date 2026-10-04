/**
 * #1586 audit round 8 (PR #1587).
 *
 *   R8-2  the delta fold never lands inside a recall's reply path: done
 *         before the search only when the time budget allows it, else
 *         deferred until after the reply in a long-lived process; only the
 *         current model's records count toward the threshold.
 *   C-2   startBudgetTimer measures a late tick against the delay it
 *         actually scheduled.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import * as emb from '../src/embeddings.js'
import { startBudgetTimer } from '../src/remote-recall.js'

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

let wasDisabled = false
beforeEach(() => { wasDisabled = emb.embedderStatus().disabled })
afterEach(() => {
  vi.useRealTimers()
  ;(emb as any)._setDeltaCompactBytes?.(undefined)
  ;(emb as any)._setFoldCostMsPerMb?.(undefined)
  ;(emb as any)._resetBackgroundModelLoad?.()
  emb.resetEmbedder()
  emb.setEmbeddingsEnabled(!wasDisabled)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

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

async function storeWith(n: number): Promise<{ plur: Plur; dir: string }> {
  const dir = tmp('plur-1587-r8-store-')
  writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  const plur = new Plur({ path: dir })
  for (let i = 0; i < n; i++) await plur.learn(`release checklist item number ${i} covers step ${i * 7} of the rollout`)
  return { plur, dir }
}

const mainPath = (dir: string) => join(dir, '.embeddings-cache.json')
const deltaFile = (dir: string) => join(dir, '.embeddings-cache.delta.jsonl')

describe('R8-2 — the delta fold stays off the reply path', () => {
  it('no time budget for the fold: a short-lived process does not fold during the recall', async () => {
    const { plur, dir } = await storeWith(40)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(30)
    const setBytes = (emb as any)._setDeltaCompactBytes
    const setCost = (emb as any)._setFoldCostMsPerMb
    expect(typeof setCost).toBe('function')
    setBytes(20_000)
    setCost(1_000_000) // any fold "costs" far more than a recall has left
    for (let i = 0; i < 4; i++) {
      await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 200, remote: false })
      await new Promise(r => setTimeout(r, 50))
    }
    // Never folded: no main cache file, the vectors all still in the delta.
    expect(existsSync(mainPath(dir))).toBe(false)
    expect(statSync(deltaFile(dir)).size).toBeGreaterThan(20_000)
  }, 60_000)

  it('a long-lived process folds after the reply instead', async () => {
    const { plur, dir } = await storeWith(40)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(30)
    ;(emb as any)._setDeltaCompactBytes(20_000)
    ;(emb as any)._setFoldCostMsPerMb(1_000_000)
    emb.allowBackgroundModelLoad(true)
    for (let i = 0; i < 3; i++) {
      await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 200, remote: false })
    }
    const until = Date.now() + 10_000
    while (!existsSync(mainPath(dir)) && Date.now() < until) await new Promise(r => setTimeout(r, 100))
    expect(existsSync(mainPath(dir))).toBe(true)
  }, 60_000)

  it('only the current model\'s records count toward the threshold', async () => {
    const { plur, dir } = await storeWith(10)
    emb.setEmbeddingsEnabled(true)
    slowEmbedder(1)
    ;(emb as any)._setDeltaCompactBytes(20_000)
    // 60 KB of another model's records: over the threshold on their own.
    const other = Array.from({ length: 40 }, (_, i) => JSON.stringify({ id: `o${i}`, hash: 'h', embedding: Array(150).fill(0.123456), embedder: 'other-model', dim: 150 })).join('\n') + '\n'
    writeFileSync(deltaFile(dir), other)
    const res = await plur.recallHybridWithMeta('release checklist rollout', { deadline_ms: 10_000, remote: false })
    expect(res.mode).toBe('hybrid')
    // The completed search folds its own model's vectors (that is expected);
    // what must not happen is a fold triggered at the start of every search
    // by the other model's records. Count folds through the seam.
    const folds = (emb as any)._thresholdFoldCount
    expect(typeof folds).toBe('function')
    expect(folds()).toBe(0)
  }, 30_000)
})

describe('C-2 — a late tick is measured against the delay actually scheduled', () => {
  it('a 20 ms tick that arrives 30 ms late is credited 30 ms of blocked time', () => {
    vi.useFakeTimers()
    let info: { creditMs: number; wallMs: number; clientSlow: boolean } | undefined
    startBudgetTimer(120, i => { info = i }, { tickMs: 50, maxCreditMs: 1000 })
    vi.advanceTimersByTime(50) // on time
    vi.advanceTimersByTime(50) // on time; the next tick is scheduled for 20 ms
    vi.setSystemTime(Date.now() + 30) // the loop is blocked for 30 ms...
    vi.advanceTimersByTime(20) // ...so that 20 ms tick lands 30 ms late
    vi.advanceTimersByTime(200)
    expect(info).toBeDefined()
    expect(info!.creditMs).toBe(30)
  })
})
