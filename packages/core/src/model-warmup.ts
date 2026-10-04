/**
 * Background download of the embedding model (#1586 audit round 3, R1).
 *
 * The first hybrid recall on a fresh install used to download the model
 * (~130 MB) inside the recall. Under the recall deadline that meant the recall
 * gave up and, worse, a short-lived process — the CLI, an editor hook — exits
 * right after its reply, killing the download. The library writes each file to
 * a `.tmp` name and renames it when complete, so a killed download never leaves
 * a corrupt model, but it never resumes either: every run would start the
 * download again and be cut again, and leave a partial `.tmp` file each time.
 *
 * So when the model is not on disk, a recall answers by keyword and starts ONE
 * detached download process that outlives it. A lock file in the model cache
 * keeps it to one download per cache at a time; a lock whose process is gone
 * is taken over. The download process removes partial files that a killed
 * download left more than an hour ago, then fetches and loads the model once.
 */
import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

export interface ModelWarmupJob {
  modelId: string
  dtype?: string
  /** The model cache directory, or null for the library default. */
  cacheDir: string | null
}

/** Starts the detached process; returns false when it could not be started. */
export type ModelWarmupSpawner = (job: ModelWarmupJob & { transformersUrl: string | null }) => boolean

/** A lock older than this is taken over even if its process looks alive
 *  (a pid can be reused); a 130 MB download on a slow line fits well inside. */
const LOCK_MAX_AGE_MS = 30 * 60 * 1000
/** Partial downloads older than this are left over from a killed process. */
const STALE_PARTIAL_MS = 60 * 60 * 1000

let spawnerOverride: ModelWarmupSpawner | undefined

/** Test seam: replace the process spawner (undefined restores the real one). */
export function _setModelWarmupSpawner(fn: ModelWarmupSpawner | undefined): void {
  spawnerOverride = fn
}

export function warmupLockPath(cacheDir: string): string {
  return join(cacheDir, '.plur-model-warmup.lock')
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Claim the one-download-at-a-time lock. True when this caller should start it. */
function claimLock(lockPath: string, now: number): boolean {
  try {
    if (existsSync(lockPath)) {
      const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; at?: number }
      const fresh = typeof held.at === 'number' && now - held.at < LOCK_MAX_AGE_MS
      if (fresh && typeof held.pid === 'number' && pidAlive(held.pid)) return false
    }
  } catch { /* unreadable lock → take it over */ }
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: now }))
    return true
  } catch {
    return false
  }
}

/**
 * Start a background download of the model unless one is already running for
 * this cache. Returns true when a download was started.
 */
export function startModelWarmup(job: ModelWarmupJob, spawner?: ModelWarmupSpawner): boolean {
  const run = spawner ?? spawnerOverride ?? spawnDetached
  const lockDir = job.cacheDir
  if (lockDir) {
    try { mkdirSync(lockDir, { recursive: true }) } catch { return false }
    if (!claimLock(warmupLockPath(lockDir), Date.now())) return false
  }
  let ok = false
  try {
    ok = run({ ...job, transformersUrl: resolveTransformersUrl() })
  } catch {
    ok = false
  }
  if (!ok && lockDir) { try { unlinkSync(warmupLockPath(lockDir)) } catch { /* gone */ } }
  return ok
}

/** The process id transformers.js writes into a partial file's name
 *  (`<file>.tmp.<pid>.<random>`), or null. */
function partialOwner(name: string): number | null {
  const m = /\.tmp\.(\d+)\.[^.]+$/.exec(name)
  return m ? Number(m[1]) : null
}

/** Remove `.tmp` partial downloads left by a killed download, anywhere under
 *  `root`: those whose process is gone, and any older than an hour. */
export function cleanStaleDownloads(root: string, now: number = Date.now()): void {
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (!/\.tmp\.[^/]+$/.test(name)) continue
      const owner = partialOwner(name)
      const orphaned = owner !== null && owner !== process.pid && !pidAlive(owner)
      if (orphaned || now - st.mtimeMs > STALE_PARTIAL_MS) {
        try { unlinkSync(p) } catch { /* in use or gone */ }
      }
    }
  }
  walk(root, 0)
}

function resolveTransformersUrl(): string | null {
  try {
    const resolve = (import.meta as { resolve?: (s: string) => string }).resolve
    return typeof resolve === 'function' ? resolve('@huggingface/transformers') : null
  } catch {
    return null
  }
}

/** The detached process: clean stale partials, download, load once, release the lock. */
const WARMUP_SCRIPT = `
const job = JSON.parse(process.env.PLUR_MODEL_WARMUP_JOB)
const fs = await import('node:fs')
const path = await import('node:path')
const lock = job.cacheDir ? path.join(job.cacheDir, '.plur-model-warmup.lock') : null
// This process holds the lock now (the one that started it may exit at once).
if (lock) { try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() })) } catch {} }
try {
  process.env.HF_HUB_DISABLE_XET ??= '1'
  const t = await import(job.transformersUrl)
  if (job.cacheDir) t.env.cacheDir = job.cacheDir
  const root = t.env.cacheDir
  const walk = (dir, depth) => {
    if (!root || depth > 6) return
    let names = []
    try { names = fs.readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = path.join(dir, n)
      let st; try { st = fs.statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (/\\.tmp\\.[^/]+$/.test(n)) {
        const m = /\\.tmp\\.(\\d+)\\.[^.]+$/.exec(n)
        const owner = m ? Number(m[1]) : null
        let gone = false
        if (owner !== null && owner !== process.pid) { try { process.kill(owner, 0) } catch (e) { gone = e.code !== 'EPERM' } }
        if (gone || Date.now() - st.mtimeMs > ${STALE_PARTIAL_MS}) { try { fs.unlinkSync(p) } catch {} }
      }
    }
  }
  walk(root, 0)
  const pipe = await t.pipeline('feature-extraction', job.modelId, job.dtype ? { dtype: job.dtype } : undefined)
  await pipe('warm up', { pooling: 'cls', normalize: true })
  walk(root, 0)
} catch {}
finally {
  if (lock) { try { fs.unlinkSync(lock) } catch {} }
}
`

function spawnDetached(job: ModelWarmupJob & { transformersUrl: string | null }): boolean {
  if (!job.transformersUrl) return false
  const child = spawn(process.execPath, ['--input-type=module', '-e', WARMUP_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PLUR_MODEL_WARMUP_JOB: JSON.stringify(job) },
  })
  child.on('error', () => { /* best effort */ })
  child.unref()
  return true
}
