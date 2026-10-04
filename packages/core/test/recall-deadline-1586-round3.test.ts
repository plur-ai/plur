/**
 * #1586 audit round 3 (PR #1587).
 *
 *   R1  the recall deadline must never empty the local leg: keyword (BM25)
 *       results are kept when the semantic leg is late, and a model that is
 *       not on disk yet is fetched in the background instead of being charged
 *       to the recall.
 *   R2  with several hosts, a host's earlier success must not overwrite a
 *       newer failure written while a slower host was still pending.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { setEmbeddingsEnabled, resetEmbedder, _setCachedEmbedder, embedderStatus } from '../src/embeddings.js'
import { remoteRecall, BREAKER_COOLDOWN_MS, type RemoteRecallHost } from '../src/remote-recall.js'
import { normalizeEndpointUrl } from '../src/store/remote-store.js'

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

let wasDisabled = false
const savedCacheDir = process.env.PLUR_MODEL_CACHE_DIR
beforeEach(() => { wasDisabled = embedderStatus().disabled })
afterEach(async () => {
  resetEmbedder()
  setEmbeddingsEnabled(!wasDisabled)
  if (savedCacheDir === undefined) delete process.env.PLUR_MODEL_CACHE_DIR
  else process.env.PLUR_MODEL_CACHE_DIR = savedCacheDir
  const warm = await import('../src/model-warmup.js').catch(() => null) as any
  warm?._setModelWarmupSpawner?.(undefined)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A store with three engrams, learned with embeddings off. */
async function seededPlur(): Promise<Plur> {
  const dir = tmp('plur-1587-r3-')
  writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  const plur = new Plur({ path: dir })
  await plur.learn('the deploy checklist lives in the release runbook')
  await plur.learn('rotate the staging certificates every quarter')
  await plur.learn('prefer small pull requests with one concern each')
  return plur
}

describe('R1 — a late semantic leg keeps the keyword results', () => {
  it('a stalled embedder with a 200 ms deadline: the keyword hit is returned, marked degraded and incomplete', async () => {
    const plur = await seededPlur()
    setEmbeddingsEnabled(true)
    _setCachedEmbedder({
      name: 'stalled', dim: 384, modelId: 'test/stalled',
      embed: () => new Promise<Float32Array>(() => { /* never */ }),
      embedBatch: () => new Promise<Float32Array[]>(() => { /* never */ }),
    })
    const t0 = Date.now()
    const res = await plur.recallHybridWithMeta('deploy checklist', { deadline_ms: 200, remote: false })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(res.engrams.some(e => e.statement.includes('deploy checklist'))).toBe(true)
    expect(res.results_complete).toBe(false)
    expect(res.mode).toBe('hybrid-degraded')
    expect(res.embedderError ?? '').toMatch(/deadline/)

    const arr = await plur.recallHybrid('deploy checklist', { deadline_ms: 200, remote: false })
    expect(arr.some(e => e.statement.includes('deploy checklist'))).toBe(true)
  }, 15_000)

  it('a model not yet on disk: keyword results at once, the download is started in the background once', async () => {
    const warm = await import('../src/model-warmup.js').catch(() => null) as any
    const spawned: any[] = []
    warm?._setModelWarmupSpawner?.((job: unknown) => { spawned.push(job); return true })
    const plur = await seededPlur()
    process.env.PLUR_MODEL_CACHE_DIR = tmp('plur-1587-models-') // empty: nothing downloaded
    setEmbeddingsEnabled(true)
    resetEmbedder()
    const t0 = Date.now()
    const res = await plur.recallHybridWithMeta('deploy checklist', { deadline_ms: 3000, remote: false })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(res.engrams.length).toBeGreaterThan(0)
    expect(res.engrams.some(e => e.statement.includes('deploy checklist'))).toBe(true)
    expect(res.results_complete).toBe(false)
    expect(res.mode).toBe('hybrid-degraded')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].modelId).toBe('Xenova/bge-small-en-v1.5')
    // A second recall while that download runs does not start another one.
    const again = await plur.recallHybridWithMeta('certificates', { deadline_ms: 3000, remote: false })
    expect(again.engrams.length).toBeGreaterThan(0)
    expect(spawned).toHaveLength(1)
  }, 15_000)
})

describe('R1 — the background model download', () => {
  it('one download at a time: a live lock skips, a dead holder\'s lock is taken over', async () => {
    const warm = await import('../src/model-warmup.js').catch(() => null) as any
    expect(warm).not.toBeNull()
    const cacheDir = tmp('plur-1587-models-')
    const spawned: any[] = []
    const spawner = (job: unknown) => { spawned.push(job); return true }
    const job = { modelId: 'Xenova/bge-small-en-v1.5', dtype: 'fp32', cacheDir }
    expect(warm.startModelWarmup(job, spawner)).toBe(true)
    expect(warm.startModelWarmup(job, spawner)).toBe(false) // lock held by this (live) pid
    expect(spawned).toHaveLength(1)
    // A lock left by a process that no longer exists does not block.
    writeFileSync(warm.warmupLockPath(cacheDir), JSON.stringify({ pid: 999_999_999, at: Date.now() }))
    expect(warm.startModelWarmup(job, spawner)).toBe(true)
    expect(spawned).toHaveLength(2)
  })

  it('partial downloads left by a killed download are removed; one still being written is kept', async () => {
    const warm = await import('../src/model-warmup.js').catch(() => null) as any
    expect(warm).not.toBeNull()
    const dir = join(tmp('plur-1587-models-'), 'Xenova', 'bge-small-en-v1.5', 'onnx')
    mkdirSync(dir, { recursive: true })
    const stale = join(dir, `model.onnx.tmp.${process.pid}.abc`) // live owner, but older than an hour
    const orphan = join(dir, 'model.onnx.tmp.999999999.ghi') // owner gone
    const fresh = join(dir, `model.onnx.tmp.${process.pid}.def`) // being written
    const done = join(dir, 'model.onnx')
    for (const f of [stale, orphan, fresh, done]) writeFileSync(f, 'x')
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    utimesSync(stale, old, old)
    warm.cleanStaleDownloads(join(dir, '..', '..', '..'))
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(done)).toBe(true)
  })
})

describe('R2 — a host\'s earlier success does not overwrite a newer failure', () => {
  it('two hosts: A answers ok, A\'s breaker opens while B is pending, A\'s success is not forced over it', async () => {
    const statePath = join(tmp('plur-1587-health-'), 'remote-health.json')
    const A = 'https://a-host.example'
    const B = 'https://b-host.example'
    const keyA = normalizeEndpointUrl(A)
    writeFileSync(statePath, JSON.stringify({ version: 1, hosts: { [keyA]: { failures: 0, last_state: 'ok', updated_at: Date.now() - 1000 } } }))
    const host = (url: string): RemoteRecallHost => ({ url, token: 't', scopes: ['group:x'], entries: [{ scope: 'group:x' } as any] })
    const ok = () => new Response(JSON.stringify({ data: { results: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchImpl = (async (input: any) => {
      if (String(input).startsWith(keyA)) return ok()
      // B: after A has answered, three failed saves open A's breaker.
      await new Promise(r => setTimeout(r, 150))
      const cur = JSON.parse(readFileSync(statePath, 'utf8'))
      cur.hosts[keyA] = { ...cur.hosts[keyA], failures: 0, cooldown_until: Date.now() + BREAKER_COOLDOWN_MS, cooldown_opened_at: Date.now(), last_state: 'unreachable', updated_at: Date.now() }
      writeFileSync(statePath, JSON.stringify(cur))
      await new Promise(r => setTimeout(r, 50))
      return ok()
    }) as unknown as typeof fetch
    const r = await remoteRecall([host(A), host(B)], 'q', { statePath, timeoutMs: 2000, fetchImpl })
    expect(r.outcomes.map(o => o.state)).toEqual(['ok', 'ok'])
    const a = JSON.parse(readFileSync(statePath, 'utf8')).hosts[keyA]
    expect(a.cooldown_until).toBeGreaterThan(Date.now())
    expect(a.last_state).toBe('unreachable')
  })
})
