/**
 * Owner decision C2 (#1354 lock ladder): once a stealer holds its steal-guard
 * slot, it re-checks that the lock is STILL abandoned, not only that it is the
 * same file (same token and inode). A holder whose liveness cannot be probed
 * (another host) shows it is alive only by refreshing the lock's mtime; if it
 * does so between the stealer's first look and its claim, the stealer must back
 * off rather than act on the stale judgement.
 *
 * The refresh is injected at the exact moment the stealer creates its guard
 * slot. Every test runs in its own temp directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync as realWriteFileSync, utimesSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const hooks = vi.hoisted(() => ({ onGuardSlot: null as null | (() => void) }))
const isSlot = (p: unknown) => /\.lock\.guard-/.test(String(p))

vi.mock('fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>()
  const writeFile = (async (p: any, d: any, o?: any) => {
    if (isSlot(p)) hooks.onGuardSlot?.()
    return real.writeFile(p, d, o)
  }) as typeof real.writeFile
  return { ...real, writeFile, default: { ...real, writeFile } }
})
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const writeFileSync = ((p: any, d: any, o?: any) => {
    if (isSlot(p)) hooks.onGuardSlot?.()
    return real.writeFileSync(p, d, o)
  }) as typeof real.writeFileSync
  return { ...real, writeFileSync, default: { ...real, writeFileSync } }
})

const { withAsyncLock, DEFAULT_STALE_THRESHOLD } = await import('../src/store/async-lock.js')
const { withLock } = await import('../src/sync.js')

let dir: string
let filePath: string
let lockPath: string
const FOREIGN = `some-other-machine:4242:${Date.now()}:0`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-takeover-recheck-'))
  filePath = join(dir, 'engrams.yaml')
  lockPath = filePath + '.lock'
  realWriteFileSync(filePath, '')
  // A foreign-host holder, untouched past the stale threshold: judged abandoned.
  realWriteFileSync(lockPath, FOREIGN)
  const old = new Date(Date.now() - DEFAULT_STALE_THRESHOLD - 10_000)
  utimesSync(lockPath, old, old)
  // ...but it refreshes its lock just as the first stealer takes its guard slot.
  let refreshed = false
  hooks.onGuardSlot = () => {
    if (refreshed) return
    refreshed = true
    const now = new Date()
    utimesSync(lockPath, now, now)
  }
})
afterEach(() => {
  hooks.onGuardSlot = null
  rmSync(dir, { recursive: true, force: true })
})

describe('the takeover re-checks abandonment under its guard (decision C2)', () => {
  it('async: a holder that refreshed its lock after being judged is not stolen from', async () => {
    let ran = false
    const pending = withAsyncLock(filePath, async () => { ran = true }, { baseDelay: 20 })
    await new Promise(r => setTimeout(r, 800))
    expect(ran).toBe(false)
    expect(readFileSync(lockPath, 'utf8')).toBe(FOREIGN)
    unlinkSync(lockPath) // the holder finishes
    await pending
    expect(ran).toBe(true)
  })

  it('sync: the same, for withLock', () => {
    expect(() => withLock(filePath, () => 'stolen', { baseDelay: 5, maxRetries: 3 })).toThrow(/Failed to acquire lock/)
    expect(readFileSync(lockPath, 'utf8')).toBe(FOREIGN)
  })
})
