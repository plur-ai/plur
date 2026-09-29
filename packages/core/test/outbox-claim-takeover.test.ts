/**
 * Decision C3 (owner, 2026-09-29): #1277's per-entry claims are the ONE
 * duplicate-push guard, so the claim itself must hold without a row lease
 * masking its races (spec/formal/findings/outbox.md, open conflict I).
 *
 * - Takeover of a lapsed claim is atomic: a new claim file is renamed over the
 *   stale one, so the claim path is never free and every claimer over a stale
 *   claim is an orphan, which probes by key (`atomic_never_none`,
 *   `atomic_got_orphan_step`). The old rm-then-create left a window in which a
 *   second claimer took a fresh, non-orphan claim and posted unprobed
 *   (`nonatomic_takeover_loses_doubt`).
 * - A claim is released only by the writer that took it. Two writers in one
 *   process share a pid, so a release by pid alone let a writer whose claim
 *   had lapsed and been taken over remove the new holder's claim.
 *
 * No network: the claim methods are driven directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as realFs from 'fs'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'

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
  const stale = (p: InstanceType<typeof Plur>) => {
    mkdirSync(p.outboxClaimsDir(), { recursive: true })
    writeFileSync(claimPath(p), JSON.stringify({ key: 'k-old', pid: process.pid, host: hostname(), until: Date.now() - 1_000 }))
  }

  it('a lapsed claim is taken over without the claim path ever being free', () => {
    const b = new Plur({ path: dir })
    stale(b)
    const got = (b as any)._claimOutboxEntry(ID, (orphanKey: string | undefined) => orphanKey ?? 'k-new')
    expect(got).toMatchObject({ status: 'claimed', orphan: true, key: 'k-old' })
    const removedStale = rmCalls.filter(c => c.path === claimPath(b) && c.content?.includes('k-old'))
    expect(removedStale, 'the stale claim was removed before the new one was written').toEqual([])
    expect(JSON.parse(readFileSync(claimPath(b), 'utf8')).key).toBe('k-old')
  })

  it('a writer whose claim lapsed and was taken over does not release the new holder\'s claim', () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    expect((a as any)._claimOutboxEntry(ID, () => 'k-a').status).toBe('claimed')
    // A's claim lapses (A is slow, not dead); B takes it over as an orphan.
    const held = JSON.parse(readFileSync(claimPath(a), 'utf8'))
    writeFileSync(claimPath(a), JSON.stringify({ ...held, until: Date.now() - 1_000 }))
    expect((b as any)._claimOutboxEntry(ID, (k: string | undefined) => k ?? 'k-b')).toMatchObject({ status: 'claimed', orphan: true })
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
