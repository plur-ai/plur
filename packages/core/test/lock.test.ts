import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync, unlinkSync, utimesSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { withLock } from '../src/sync.js'
import { DEFAULT_STALE_THRESHOLD } from '../src/store/async-lock.js'

describe('withLock', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-lock-'))
    filePath = join(dir, 'test.yaml')
    writeFileSync(filePath, 'test content')
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('executes the function and returns its result', () => {
    const result = withLock(filePath, () => 42)
    expect(result).toBe(42)
  })

  it('creates and removes lock file', () => {
    const lockPath = filePath + '.lock'
    expect(existsSync(lockPath)).toBe(false)
    withLock(filePath, () => {
      expect(existsSync(lockPath)).toBe(true)
    })
    expect(existsSync(lockPath)).toBe(false)
  })

  it('removes lock file even when function throws', () => {
    const lockPath = filePath + '.lock'
    expect(() => {
      withLock(filePath, () => { throw new Error('boom') })
    }).toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('detects and removes locks older than the stale threshold', () => {
    const lockPath = filePath + '.lock'
    writeFileSync(lockPath, 'stale')
    // The threshold was raised from 10s (audit #794, F9): a 50k-engram store
    // legitimately holds the lock ~6.3s, and stealing from a process that is
    // still writing corrupts the store. Written relative to the constant so a
    // future raise cannot silently turn this into a test of nothing.
    const past = new Date(Date.now() - DEFAULT_STALE_THRESHOLD - 5_000)
    utimesSync(lockPath, past, past)
    const result = withLock(filePath, () => 'success')
    expect(result).toBe('success')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('does not steal a lock that is younger than the threshold', () => {
    // The other half: a recently-touched lock belongs to a holder that may
    // still be writing, so the sync variant must fail rather than steal. Its
    // retry budget is deliberately short — it busy-waits (F10) — so a caller
    // that needs to wait one out belongs on withAsyncLock.
    const lockPath = filePath + '.lock'
    writeFileSync(lockPath, 'active')
    const recent = new Date(Date.now() - 1_000)
    utimesSync(lockPath, recent, recent)
    let ran = false
    expect(() => withLock(filePath, () => { ran = true }, { maxRetries: 1, baseDelay: 5 })).toThrow(/lock/)
    expect(ran).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
    unlinkSync(lockPath)
  })

  it('throws after max retries on active lock', () => {
    const lockPath = filePath + '.lock'
    writeFileSync(lockPath, 'active')
    expect(() => {
      withLock(filePath, () => 'should not run', { maxRetries: 2, baseDelay: 10 })
    }).toThrow(/lock/)
    unlinkSync(lockPath)
  })

  it('concurrent withLock calls serialize correctly', () => {
    // Simulate concurrent read-modify-write by interleaving withLock calls
    // Use a shared counter file to verify no writes are lost
    const counterPath = join(dir, 'counter.txt')
    writeFileSync(counterPath, '0')

    // Run 10 locked increments — each reads, parses, increments, writes
    const results: number[] = []
    for (let i = 0; i < 10; i++) {
      withLock(counterPath, () => {
        const current = parseInt(readFileSync(counterPath, 'utf8'), 10)
        const next = current + 1
        writeFileSync(counterPath, String(next))
        results.push(next)
      })
    }

    // All 10 increments should have been applied in order
    expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(readFileSync(counterPath, 'utf8')).toBe('10')
  })
})
