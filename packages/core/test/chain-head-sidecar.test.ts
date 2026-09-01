/**
 * The chain-head caches may only be written by a writer holding the chain lock.
 *
 * The sidecar and the in-process map exist to avoid an 8 KiB tail-seek on every
 * append. Both are validated on read against the month file's size and inode,
 * which is what makes them safe to trust — but only if what they RECORD was
 * observed under exclusion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, readHistory } from '../src/history.js'

// ── The unlocked fallback must not poison the caches ────────────────────────

describe('a write that could not take the lock records no observation', () => {
  /**
   * writeEventLine ran on BOTH paths — under the chain lock, and in the
   * lock-failure fallback — and updated the memory cache and the sidecar in
   * both. On the unlocked path that is unsound: `statSync` after the append can
   * observe a size that already includes a CONCURRENT writer's append, so the
   * record is {hash: mine, size: combined}. That observation then PASSES the
   * size+inode validation while naming the wrong tail, and the next writer
   * chains from a head that is not the head — the silent cross-process fork
   * this sidecar exists to eliminate, reintroduced on the one path where
   * exclusion is known to be absent.
   *
   * INVARIANT: the chain-head caches are written only by a writer that held the
   * chain lock. Anyone else invalidates.
   */
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-sidecar-lock-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** Hold the chain lock so appendHistory is forced down the fallback path. */
  function holdChainLock(historyDir: string): () => void {
    mkdirSync(historyDir, { recursive: true })
    const lockPath = join(historyDir, 'chain.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'held-by-test', ts: Date.now() }), 'utf8')
    return () => { try { rmSync(lockPath) } catch { /* already gone */ } }
  }

  it('leaves no sidecar behind when the lock could not be taken', () => {
    const historyDir = join(dir, 'history')
    const release = holdChainLock(historyDir)
    try {
      appendHistory(dir, {
        event: 'engram_created', engram_id: 'ENG-001',
        timestamp: '2026-01-01T00:00:00.000Z', data: {},
      })
      // The event itself must still land — history NAMES what a restore cannot
      // recover, so dropping the record is not an option.
      const events = readHistory(dir, '2026-01')
      expect(events).toHaveLength(1)
      expect(events[0].prev, 'unlocked write must declare a gap').toBeNull()

      // But it must not have recorded a chain head it cannot vouch for.
      expect(existsSync(join(historyDir, '.chain-head'))).toBe(false)
    } finally { release() }
  })

  it('removes a PRE-EXISTING sidecar rather than leaving a stale one', () => {
    // A stale sidecar is worse than none: another process would trust it.
    const historyDir = join(dir, 'history')
    appendHistory(dir, {
      event: 'engram_created', engram_id: 'ENG-000',
      timestamp: '2026-01-01T00:00:00.000Z', data: {},
    })
    expect(existsSync(join(historyDir, '.chain-head'))).toBe(true)

    const release = holdChainLock(historyDir)
    try {
      appendHistory(dir, {
        event: 'engram_created', engram_id: 'ENG-001',
        timestamp: '2026-01-01T00:01:00.000Z', data: {},
      })
      expect(existsSync(join(historyDir, '.chain-head'))).toBe(false)
    } finally { release() }
  })

  it('the next LOCKED write re-establishes the sidecar correctly', () => {
    // Invalidation must be recoverable, not a permanent downgrade.
    const historyDir = join(dir, 'history')
    const release = holdChainLock(historyDir)
    appendHistory(dir, {
      event: 'engram_created', engram_id: 'ENG-001',
      timestamp: '2026-01-01T00:00:00.000Z', data: {},
    })
    release()

    appendHistory(dir, {
      event: 'engram_created', engram_id: 'ENG-002',
      timestamp: '2026-01-01T00:02:00.000Z', data: {},
    })
    expect(existsSync(join(historyDir, '.chain-head'))).toBe(true)

    const events = readHistory(dir, '2026-01')
    expect(events).toHaveLength(2)
    // The recovered write chained onto the gapped one via tail-seek.
    expect(events[1].prev).toBe(events[0].hash)
  })
})
