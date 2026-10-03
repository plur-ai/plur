/**
 * A push claim that cannot be recorded is not a claim (finding B1 of the
 * 0.21.1 Windows pre-release check).
 *
 * Taking over a stale claim ends with `renameSync(tmp, claim)`. On Windows
 * that rename fails with EPERM/EBUSY while another process has the claim file
 * open (a losing racer reading it). The catch-all used to log a warning and
 * answer `claimed` with nothing recorded, so a second process could take the
 * same entry too and push the same engram twice. Now any failure to record
 * the claim answers "not claimed": another process may own the entry, and it
 * stays queued for the next flush.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'

const faults = vi.hoisted(() => ({ rename: false, link: false, renames: 0 }))

vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const renameSync = vi.fn((from: any, to: any) => {
    if (faults.rename && String(to).includes('outbox-claims')) {
      faults.renames++
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
    }
    return real.renameSync(from, to)
  })
  const linkSync = vi.fn((from: any, to: any) => {
    if (faults.link && String(to).includes('outbox-claims')) {
      throw Object.assign(new Error('EIO: i/o error, link'), { code: 'EIO' })
    }
    return real.linkSync(from, to)
  })
  return { ...real, renameSync, linkSync, default: { ...real, renameSync, linkSync } }
})

const { Plur } = await import('../src/index.js')

const ID = 'ENG-2026-10-04-001'
let dir: string

beforeEach(() => {
  faults.rename = false
  faults.link = false
  faults.renames = 0
  dir = mkdtempSync(join(tmpdir(), 'plur-claim-fail-closed-'))
  writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const claimFile = (p: InstanceType<typeof Plur>) => join(p.outboxClaimsDir(), `${ID}.json`)
const claim = (p: InstanceType<typeof Plur>, key = 'key-1') => (p as any)._claimOutboxEntry(ID, () => key)

/** A claim left by a process that died: taken over on the next claim. */
function writeStaleClaim(p: InstanceType<typeof Plur>): string {
  mkdirSync(p.outboxClaimsDir(), { recursive: true })
  const body = JSON.stringify({ key: 'key-1', token: 'dead', pid: 2 ** 22 + 12345, host: hostname(), at: Date.now(), until: Date.now() + 60_000 })
  writeFileSync(claimFile(p), body)
  return body
}

describe('a claim that cannot be recorded is not a claim (B1)', () => {
  it('takeover rename fails with EPERM: not claimed, the stale claim and no leftovers remain', () => {
    const a = new Plur({ path: dir })
    const stale = writeStaleClaim(a)
    faults.rename = true
    const got = claim(a)
    expect(faults.renames).toBeGreaterThan(0) // the takeover rename really ran and failed
    expect(got.status).toBe('busy')
    expect(readFileSync(claimFile(a), 'utf8')).toBe(stale)
    // No temp file and no takeover marker left behind.
    expect(readdirSync(a.outboxClaimsDir())).toEqual([`${ID}.json`])
  })

  it('two writers while the rename fails: neither pushes; once it works, exactly one claims, with the row key', () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    writeStaleClaim(a)
    faults.rename = true
    const first = [claim(a), claim(b)]
    expect(first.filter(r => r.status === 'claimed')).toEqual([])
    faults.rename = false
    const second = [claim(a), claim(b)]
    const winners = second.filter(r => r.status === 'claimed')
    expect(winners).toHaveLength(1)
    expect(winners[0].key).toBe('key-1')
    const recorded = JSON.parse(readFileSync(claimFile(a), 'utf8'))
    expect(recorded.key).toBe('key-1')
    expect(recorded.token).not.toBe('dead')
  })

  it('a free entry whose claim cannot be published (EIO): not claimed, and nothing recorded', () => {
    const a = new Plur({ path: dir })
    faults.link = true
    expect(claim(a).status).toBe('busy')
    faults.link = false
    expect(claim(a).status).toBe('claimed')
  })
})
