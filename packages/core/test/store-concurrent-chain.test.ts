/**
 * Two-process concurrency test for the hash-chain store lock (#1051 acceptance).
 *
 * Acceptance criteria (#1051): two concurrent writers under the store lock cannot
 * fork the chain. A fork is defined as two events with the same `prev` value —
 * both claiming to follow the same predecessor, which means the chain is no
 * longer a linear sequence.
 *
 * How this test works
 * -------------------
 * Two Node.js child processes are spawned (via tsx) against the SAME store path.
 * Each calls Plur.learn() N times sequentially. Plur.learn() holds the store
 * write lock (withAsyncLock → O_EXCL file lock on the engrams file) and, while
 * holding it, calls appendHistory to write a hash-chained event to the JSONL.
 * If the cross-process O_EXCL lock serialises the writes correctly, no two
 * events can read the same predecessor hash and both commit with it as `prev`,
 * so the resulting JSONL is fork-free.
 *
 * Why child processes, not Promise.all()
 * ---------------------------------------
 * The in-process mutex (KeyedAsyncMutex inside withAsyncLock) serialises all
 * concurrent callers in ONE process trivially. Two Promise.all() writers in one
 * process would queue behind the in-process mutex and never touch the O_EXCL
 * cross-process code path. Only separate OS processes expose the cross-process
 * lock that O_EXCL is meant to protect.
 *
 * Expected outcomes
 * -----------------
 * PASS (0 forks): the O_EXCL lock works correctly — the cross-process write
 *   path serialises appendHistory calls, so each writer reads a unique
 *   predecessor and the chain remains linear.
 *
 * FAIL (>0 forks): the lock is absent or broken. This is a bug: the test
 *   exists precisely to catch this, and a fork-detection failure means
 *   the chain integrity guarantee of #1051 is not met.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import type { HistoryEvent } from '../src/history.js'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dir = dirname(__filename)

// tsx ships as a devDependency of @plur-ai/core; locate it via the package root
// so the test is self-contained and does not depend on the shell's PATH.
const PKG_ROOT = join(__dir, '..')
const TSX = join(PKG_ROOT, 'node_modules/.bin/tsx')
const WORKER = join(__dir, 'helpers/chain-writer-worker.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn one worker process. Resolves when the process exits 0; rejects with a
 * descriptive error on non-zero exit (includes captured stderr).
 */
function runWorker(storePath: string, n: number): Promise<{ pid: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stderrChunks: Buffer[] = []
    const child = spawn(TSX, [WORKER], {
      env: { ...process.env, STORE_PATH: storePath, N: String(n) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      if (code === 0) {
        resolve({ pid: child.pid ?? -1, stderr })
      } else {
        reject(new Error(`worker exited ${code}${stderr ? `: ${stderr}` : ''}`))
      }
    })
    child.on('error', reject)
  })
}

/**
 * Read all history events from every JSONL shard in {root}/history/.
 * Files are processed in lexicographic (chronological) order; events are
 * returned in append-order within each file.
 */
function readHistoryAll(root: string): HistoryEvent[] {
  const historyDir = join(root, 'history')
  if (!existsSync(historyDir)) return []

  const files = readdirSync(historyDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort()

  const events: HistoryEvent[] = []
  for (const f of files) {
    const content = readFileSync(join(historyDir, f), 'utf8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as HistoryEvent)
      } catch {
        // Skip malformed lines (shouldn't happen in a well-written test)
      }
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hash-chain store lock — two-process concurrency (#1051)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-chain-conc-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it(
    'two concurrent child-process writers produce zero fork violations in the history chain',
    async () => {
      // Each worker writes N_PER_WORKER events sequentially. The concurrency
      // is between the two processes, not within each process.
      //
      // N=10 per worker = 20 total events and ~10 lock hand-offs between
      // processes — enough to expose a race without making the test slow.
      const N_PER_WORKER = 10

      // Run both workers simultaneously. They race for the O_EXCL lock on
      // every learn() call. Promise.all rejects if either worker exits non-zero,
      // which means a write failed under lock contention — itself a bug worth
      // catching separately from a fork.
      const [w1, w2] = await Promise.all([
        runWorker(dir, N_PER_WORKER),
        runWorker(dir, N_PER_WORKER),
      ])

      // Surface any worker stderr for diagnosis even on a clean run.
      if (w1.stderr) process.stderr.write(`worker1 stderr: ${w1.stderr}\n`)
      if (w2.stderr) process.stderr.write(`worker2 stderr: ${w2.stderr}\n`)

      // Read the resulting JSONL across all shards.
      const events = readHistoryAll(dir)

      // All N_PER_WORKER * 2 engram_created events must be present.
      // (Each learn() call fires one history event.)
      expect(
        events.length,
        `Expected ${N_PER_WORKER * 2} history events but found ${events.length}. ` +
        `Some writes may have been silently lost.`,
      ).toBe(N_PER_WORKER * 2)

      // Fork detection: if two events share a non-null `prev` value, both
      // writers read the same predecessor hash and committed simultaneously —
      // the chain is forked. Count each unique prev value that appears more
      // than once.
      const prevCounts = new Map<string, number>()
      for (const evt of events) {
        if (evt.prev == null) continue // genesis or gap — not a fork
        prevCounts.set(evt.prev, (prevCounts.get(evt.prev) ?? 0) + 1)
      }

      const forkEntries = [...prevCounts.entries()].filter(([, count]) => count > 1)

      if (forkEntries.length > 0) {
        const details = forkEntries.map(([prev, count]) => {
          const forked = events.filter(e => e.prev === prev)
          return (
            `  prev=${prev.slice(0, 16)}… claimed by ${count} events:\n` +
            forked.map(e => `    hash=${e.hash?.slice(0, 16)}…`).join('\n')
          )
        })
        expect.fail(
          `Cross-process write lock failed: ${forkEntries.length} fork violation(s) in the hash chain.\n\n` +
          `Two child processes read the same predecessor hash and both committed with it as\n` +
          `their 'prev', forking the chain. The O_EXCL file lock in withAsyncLock must\n` +
          `prevent this — a fork here means the cross-process lock is absent or broken.\n\n` +
          `Fork details:\n${details.join('\n')}`,
        )
      }
    },
    // tsx startup is ~0.5 s; each process writes 10 events and may wait on the
    // lock. 60 s is generous and avoids flakiness on a loaded CI machine.
    60_000,
  )

  it(
    'chain is internally consistent: every non-null prev points to a known event hash',
    async () => {
      const N_PER_WORKER = 8

      await Promise.all([
        runWorker(dir, N_PER_WORKER),
        runWorker(dir, N_PER_WORKER),
      ])

      const events = readHistoryAll(dir)
      const knownHashes = new Set(events.map(e => e.hash).filter(Boolean))

      const danglingPrevs: string[] = []
      for (const evt of events) {
        if (evt.prev == null) continue // genesis / gap — OK
        if (!knownHashes.has(evt.prev)) {
          danglingPrevs.push(
            `event hash=${evt.hash?.slice(0, 16)}… has prev=${evt.prev.slice(0, 16)}… ` +
            `which does not correspond to any event in the written history`,
          )
        }
      }

      expect(
        danglingPrevs.length,
        `Chain integrity violation — ${danglingPrevs.length} event(s) reference an unknown prev:\n` +
        danglingPrevs.join('\n'),
      ).toBe(0)
    },
    60_000,
  )
})
