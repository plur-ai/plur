import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync, unlinkSync, utimesSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { withAsyncLock } from '../src/store/async-lock.js'

describe('withAsyncLock', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-async-lock-'))
    filePath = join(dir, 'test.yaml')
    writeFileSync(filePath, 'test content')
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('executes the function and returns its result', async () => {
    const result = await withAsyncLock(filePath, async () => 42)
    expect(result).toBe(42)
  })

  it('creates and removes lock file', async () => {
    const lockPath = filePath + '.lock'
    expect(existsSync(lockPath)).toBe(false)
    await withAsyncLock(filePath, async () => {
      expect(existsSync(lockPath)).toBe(true)
    })
    expect(existsSync(lockPath)).toBe(false)
  })

  it('removes lock file even when function throws', async () => {
    const lockPath = filePath + '.lock'
    await expect(
      withAsyncLock(filePath, async () => { throw new Error('boom') })
    ).rejects.toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('detects and removes stale locks', async () => {
    const lockPath = filePath + '.lock'
    writeFileSync(lockPath, 'stale')
    const past = new Date(Date.now() - 20_000)
    utimesSync(lockPath, past, past)
    const result = await withAsyncLock(filePath, async () => 'success')
    expect(result).toBe('success')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('throws after max retries on active lock', async () => {
    const lockPath = filePath + '.lock'
    writeFileSync(lockPath, 'active')
    await expect(
      withAsyncLock(filePath, async () => 'should not run', { maxRetries: 2, baseDelay: 10 })
    ).rejects.toThrow(/lock/)
    unlinkSync(lockPath)
  })

  it('concurrent calls serialize correctly', async () => {
    const counterPath = join(dir, 'counter.txt')
    await writeFile(counterPath, '0')

    // Run 5 locked increments concurrently with generous retries and short base delay
    const N = 5
    const promises = Array.from({ length: N }, () =>
      withAsyncLock(counterPath, async () => {
        const current = parseInt(await readFile(counterPath, 'utf8'), 10)
        const next = current + 1
        await writeFile(counterPath, String(next))
        return next
      }, { maxRetries: 30, baseDelay: 5 })
    )

    const results = await Promise.all(promises)
    // All should complete and end at N
    expect(readFileSync(counterPath, 'utf8')).toBe(String(N))
    // Results should contain all values 1-N (order may vary due to lock contention)
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1))
  }, 30_000)
})
