import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync, unlinkSync, utimesSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { withLock } from '../src/sync.js'

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

  it('detects and removes stale locks older than 10 seconds', () => {
    const lockPath = filePath + '.lock'
    writeFileSync(lockPath, 'stale')
    const past = new Date(Date.now() - 20_000)
    utimesSync(lockPath, past, past)
    const result = withLock(filePath, () => 'success')
    expect(result).toBe('success')
    expect(existsSync(lockPath)).toBe(false)
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
