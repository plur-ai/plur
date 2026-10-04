/**
 * Formal-verification gap closure, 2026-09-27 (R2-CLI residual, item 3):
 * two hooks could both take over the same STALE inject lock. Hook A saw it
 * stale, unlinked it and created its own; hook B, having also seen it stale,
 * then unlinked A's fresh lock and created one too — both injected.
 * Takeover now moves the lock aside atomically and checks (by inode) that it
 * moved the stale file; a live lock that arrived in between is put back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, unlinkSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { acquireInjectLock, takeInjectLock, releaseInjectLock } from '../src/commands/hook-inject.js'

let dir: string
let lock: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-inject-lock-'))
  lock = join(dir, 'session.injecting')
  writeFileSync(lock, '')
  const old = (Date.now() - 10 * 60_000) / 1000
  utimesSync(lock, old, old) // a crashed holder's lock: stale
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('stale inject-lock takeover is exclusive', () => {
  it('a hook that saw the lock stale does not delete a fresh lock another hook just took', () => {
    // Between B's staleness check and B's takeover, A completes a takeover.
    const aTakesOver = () => { unlinkSync(lock); writeFileSync(lock, '') }
    const b = (acquireInjectLock as any)(lock, 60_000, Date.now, aTakesOver)
    expect(b).toBe('busy')
    expect(existsSync(lock)).toBe(true) // A's lock is intact
    expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(60_000)
    expect(readdirSync(dir)).toEqual(['session.injecting']) // nothing left aside
  })

  it('good case: a lone hook takes over a stale lock', () => {
    expect(acquireInjectLock(lock, 60_000)).toBe('acquired')
    expect(readdirSync(dir)).toEqual(['session.injecting'])
  })

  it('a fresh lock is busy', () => {
    writeFileSync(lock, '')
    expect(acquireInjectLock(lock, 60_000)).toBe('busy')
  })
})

// #1238: a takeover that raced a third hook left `path` holding the third
// hook's lock while the first holder still believed it owned `path`; its
// unconditional unlink on release deleted the third hook's live lock.
describe('inject-lock release deletes only a lock this hook still owns', () => {
  it('a holder whose lock was moved aside does not delete the next holder\'s lock', () => {
    let a: ReturnType<typeof takeInjectLock> | undefined
    let c: ReturnType<typeof takeInjectLock> | undefined
    const b = takeInjectLock(lock, {
      staleMs: 60_000,
      // A completes a takeover of the stale lock between B's check and B's rename.
      _beforeTakeover: () => { unlinkSync(lock); a = takeInjectLock(lock, { staleMs: 60_000 }) },
      // B has moved A's live lock aside; C takes the now-empty path, so B's put-back fails.
      _afterMoveAside: () => { c = takeInjectLock(lock, { staleMs: 60_000 }) },
    })
    expect(b.status).toBe('busy')
    expect(a?.status).toBe('acquired')
    expect(c?.status).toBe('acquired')
    const cIno = statSync(lock).ino
    expect(cIno).toBe(c!.hold!.ino)
    releaseInjectLock(a!.hold) // A finishes: it must not delete C's lock
    expect(existsSync(lock)).toBe(true)
    expect(statSync(lock).ino).toBe(cIno)
    releaseInjectLock(c!.hold) // C still owns it and releases it
    expect(existsSync(lock)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a holder whose lock was taken over as stale leaves the new holder\'s lock', () => {
    unlinkSync(lock)
    const a = takeInjectLock(lock, { staleMs: 60_000 })
    expect(a.status).toBe('acquired')
    const old = (Date.now() - 10 * 60_000) / 1000
    utimesSync(lock, old, old) // A ran past the stale limit
    const b = takeInjectLock(lock, { staleMs: 60_000 })
    expect(b.status).toBe('acquired')
    releaseInjectLock(a.hold)
    expect(existsSync(lock)).toBe(true)
    releaseInjectLock(b.hold)
    expect(existsSync(lock)).toBe(false)
  })
})
