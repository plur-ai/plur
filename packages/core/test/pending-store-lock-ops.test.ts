import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { withAsyncLock, pendingStoreLockOps } from '../src/store/async-lock.js'
import { pendingStoreLockOps as exported } from '../src/index.js'

/**
 * #1343: a force-exiting CLI hook needs to know whether this process is inside
 * a store lock operation. The lock file cannot say so in the gap between one
 * in-process caller's release and the next caller's O_EXCL create.
 */
describe('pendingStoreLockOps', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pending-lock-ops-'))
    filePath = join(dir, 'engrams.yaml')
    writeFileSync(filePath, '')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is exported from the package entry', () => {
    expect(exported).toBe(pendingStoreLockOps)
  })

  it('counts an operation from the synchronous call, before any lock file exists', async () => {
    expect(pendingStoreLockOps()).toBe(0)
    const op = withAsyncLock(filePath, async () => {})
    // Nothing has been awaited yet: no file on disk, but the op is in flight.
    expect(existsSync(filePath + '.lock')).toBe(false)
    expect(pendingStoreLockOps()).toBe(1)
    await op
    expect(pendingStoreLockOps()).toBe(0)
  })

  it('counts a queued caller through the hand-over between two holders', async () => {
    let releaseFirst!: () => void
    const first = withAsyncLock(filePath, () => new Promise<void>(r => { releaseFirst = r }))
    const second = withAsyncLock(filePath, async () => {})
    await new Promise(r => setTimeout(r, 50))
    expect(pendingStoreLockOps()).toBe(2)
    releaseFirst()
    await first
    // The first holder is done and its file is gone; the second is still an
    // operation in progress, whatever the disk says at this instant.
    expect(pendingStoreLockOps()).toBeGreaterThanOrEqual(1)
    await second
    expect(pendingStoreLockOps()).toBe(0)
  })

  it('drops back to zero when the locked function throws', async () => {
    await expect(withAsyncLock(filePath, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(pendingStoreLockOps()).toBe(0)
  })
})
