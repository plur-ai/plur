import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync, unlinkSync, utimesSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import { withAsyncLock, DEFAULT_STALE_THRESHOLD } from '../src/store/async-lock.js'

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
    // Older than the default threshold, which was raised to 60s (audit #794,
    // F9) because a 50k-engram store legitimately holds the lock ~6.3s and a
    // 10s threshold left almost no margin. The age is written relative to the
    // default rather than hardcoded so raising it again cannot silently turn
    // this into a test of nothing.
    const past = new Date(Date.now() - DEFAULT_STALE_THRESHOLD - 5_000)
    utimesSync(lockPath, past, past)
    const result = await withAsyncLock(filePath, async () => 'success')
    expect(result).toBe('success')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('waits for a holder that is merely slow, rather than stealing from it', async () => {
    // The inversion F9 identified: the old retry budget (~3.1s) expired long
    // before the 10s stale threshold, so a waiter threw while the holder was
    // still legitimately working — and for MCP plur_learn that meant the
    // engram was silently never stored.
    const lockPath = filePath + '.lock'
    writeFileSync(lockPath, 'stale')
    const recent = new Date(Date.now() - 1_000)
    utimesSync(lockPath, recent, recent)

    let ran = false
    const pending = withAsyncLock(filePath, async () => { ran = true; return 'ok' }, { baseDelay: 20 })
    // Well past the old 3.1s budget; the waiter must still be waiting.
    await new Promise(r => setTimeout(r, 600))
    expect(ran).toBe(false)
    // Holder finishes: the waiter should take it, not have given up.
    unlinkSync(lockPath)
    expect(await pending).toBe('ok')
    expect(ran).toBe(true)
  })

  it('steals immediately from a holder whose process is gone', async () => {
    // Raising the stale threshold to 60s would make crash recovery 6x slower
    // if staleness were the only signal. Liveness is what pays for it: a dead
    // holder is not waited for at all.
    const lockPath = filePath + '.lock'
    // A pid that cannot exist, stamped with THIS host so the check applies.
    writeFileSync(lockPath, `${hostname()}:2147483646:${Date.now()}:0`)
    const now = new Date()
    utimesSync(lockPath, now, now)

    const started = Date.now()
    const result = await withAsyncLock(filePath, async () => 'recovered', { baseDelay: 20 })
    expect(result).toBe('recovered')
    // Not waited out — recovery is immediate, far below the stale threshold.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('does not steal from a live holder on another host', async () => {
    // A pid is only meaningful on the machine that owns it, and ~/.plur can
    // live on a synced or networked volume. An unrecognised host must fall
    // back to the stale threshold, never to "assume dead".
    const lockPath = filePath + '.lock'
    writeFileSync(lockPath, `some-other-machine:2147483646:${Date.now()}:0`)
    const now = new Date()
    utimesSync(lockPath, now, now)

    let ran = false
    const pending = withAsyncLock(filePath, async () => { ran = true; return 'ok' }, { baseDelay: 20 })
    await new Promise(r => setTimeout(r, 400))
    expect(ran).toBe(false)
    unlinkSync(lockPath)
    await pending
  })

  it('a holder whose lock was stolen does not delete the thief\'s lock', async () => {
    // The cascade (F9, probe p05b): release was an unconditional unlink, so
    // after a steal the original holder's `finally` removed the THIEF's lock
    // and a third process walked in while the thief was still writing.
    const lockPath = filePath + '.lock'
    let thiefToken = ''
    await withAsyncLock(filePath, async () => {
      // Simulate a steal: someone replaces our lock file while we work.
      thiefToken = `${hostname()}:${process.pid}:${Date.now()}:9999`
      writeFileSync(lockPath, thiefToken)
    })
    // Our release must have left the thief's lock alone.
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf8')).toBe(thiefToken)
    unlinkSync(lockPath)
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
