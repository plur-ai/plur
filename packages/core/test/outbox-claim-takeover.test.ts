/**
 * Decision C3 (owner, 2026-09-29): #1277's per-entry claims are the ONE
 * duplicate-push guard, so the claim itself must hold without a row lease
 * masking its races (spec/formal/findings/outbox.md, open conflict I).
 *
 * - Takeover of a stale claim is atomic: a new claim file is renamed over the
 *   stale one, so the claim path is never free (`atomic_never_none`). The old
 *   rm-then-create left a window in which a second claimer took a fresh claim
 *   (`nonatomic_takeover_loses_doubt`).
 * - A claim is released only by the writer that took it (its token). Two
 *   writers in one process share a pid, so a release by pid alone let a writer
 *   whose claim had been taken over remove the new holder's claim.
 * - #1277 (decision C4 follow-up): a same-host owner holds its claim while its
 *   process is alive, up to an age cap; another host's claim lapses with its
 *   lease.
 *
 * No network: the claim methods are driven directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as realFs from 'fs'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const rmCalls: Array<{ path: string; content: string | null }> = []
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>()
  return {
    ...actual,
    rmSync: (p: realFs.PathLike, opts?: realFs.RmOptions) => {
      const path = String(p)
      let content: string | null = null
      try { content = actual.readFileSync(path, 'utf8') } catch { /* absent */ }
      rmCalls.push({ path, content })
      return actual.rmSync(p, opts)
    },
  }
})

const { Plur } = await import('../src/index.js')

describe('decision C3 — the per-entry claim holds on its own', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claim-takeover-'))
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    rmCalls.length = 0
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const ID = 'ENG-2026-09-29-001'
  const claimPath = (p: InstanceType<typeof Plur>) => join(p.outboxClaimsDir(), `${ID}.json`)

  it('a stale claim (another host, lease run out) is taken over without the claim path ever being free', () => {
    const b = new Plur({ path: dir })
    mkdirSync(b.outboxClaimsDir(), { recursive: true })
    writeFileSync(claimPath(b), JSON.stringify({ key: 'k-old', token: 't-old', pid: 1, host: 'another-host.invalid', until: Date.now() - 1_000 }))
    const got = (b as any)._claimOutboxEntry(ID, () => 'k-new')
    expect(got).toMatchObject({ status: 'claimed', key: 'k-new' })
    const removedStale = rmCalls.filter(c => c.path === claimPath(b) && c.content?.includes('k-old'))
    expect(removedStale, 'the stale claim was removed before the new one was written').toEqual([])
    expect(JSON.parse(readFileSync(claimPath(b), 'utf8')).key).toBe('k-new')
  })

  it("a writer whose claim was taken over does not release the new holder's claim", () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    expect((a as any)._claimOutboxEntry(ID, () => 'k-a').status).toBe('claimed')
    // A's claim outlives the age cap (a recycled pid, say); B takes it over.
    const held = JSON.parse(readFileSync(claimPath(a), 'utf8'))
    writeFileSync(claimPath(a), JSON.stringify({ ...held, at: Date.now() - 60 * 60_000, until: Date.now() - 59 * 60_000 }))
    expect((b as any)._claimOutboxEntry(ID, () => 'k-b')).toMatchObject({ status: 'claimed' })
    ;(a as any)._releaseOutboxClaim(ID)
    expect(existsSync(claimPath(b)), "A's release removed B's claim").toBe(true)
    // B, the holder, can release it.
    ;(b as any)._releaseOutboxClaim(ID)
    expect(existsSync(claimPath(b))).toBe(false)
  })

  it('a live claim of another writer is still busy', () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    expect((a as any)._claimOutboxEntry(ID, () => 'k-a').status).toBe('claimed')
    expect((b as any)._claimOutboxEntry(ID, () => 'k-b').status).toBe('busy')
  })
})
