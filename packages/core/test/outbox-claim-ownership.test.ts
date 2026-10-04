/**
 * Decision C3, applied on #1228 over main's per-entry claims (#1277). Two
 * properties #1228 kept:
 *   1. only the writer that took a claim can release it — two `Plur`
 *      instances in one process share a pid, so pid alone does not say who;
 *   2. `listOutbox().leased_until` is read from the claim file alone: a live
 *      claim's expiry, nothing from the row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-claim-owner-'))
  writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ID = 'ENG-2026-09-30-001'
const claimFile = (p: Plur) => join(p.outboxClaimsDir(), `${ID}.json`)

describe('only the writer that took a claim releases it', () => {
  it('another instance in the same process cannot remove the claim', () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    const got = (a as any)._claimOutboxEntry(ID, () => 'key-1')
    expect(got.status).toBe('claimed')
    expect(existsSync(claimFile(a))).toBe(true)
    // B never took it: same pid and host, no token of its own.
    ;(b as any)._releaseOutboxClaim(ID)
    expect(existsSync(claimFile(a)), "B removed A's claim").toBe(true)
    expect((b as any)._claimOutboxEntry(ID, () => 'key-1').status).toBe('busy')
    // A, the writer that took it, releases it.
    ;(a as any)._releaseOutboxClaim(ID)
    expect(existsSync(claimFile(a))).toBe(false)
  })
})

describe('listOutbox reads leased_until from the claim file alone', () => {
  function queue(extraSd: Record<string, unknown> = {}) {
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams: [{
      id: ID, statement: 'queued', type: 'behavioral', scope: 'group:acme/eng', status: 'active', visibility: 'public',
      structured_data: { _outbox: { target_scope: 'group:acme/eng', queued_at: new Date().toISOString(), attempt_count: 1 }, ...extraSd },
    }] }))
  }
  function writeClaim(p: Plur, body: Record<string, unknown>) {
    mkdirSync(p.outboxClaimsDir(), { recursive: true })
    writeFileSync(claimFile(p), JSON.stringify(body))
  }

  it('a live claim reports its expiry; no claim reports nothing', async () => {
    queue()
    const p = new Plur({ path: dir })
    expect((await p.listOutbox())[0].leased_until).toBeUndefined()
    const until = Date.now() + 60_000
    writeClaim(p, { key: 'k', token: 't', pid: process.pid, host: hostname(), at: Date.now(), until })
    expect((await p.listOutbox())[0].leased_until).toBe(new Date(until).toISOString())
  })

  it("a dead holder's claim is not reported", async () => {
    queue()
    const p = new Plur({ path: dir })
    writeClaim(p, { key: 'k', token: 't', pid: 2 ** 22 + 12345, host: hostname(), at: Date.now(), until: Date.now() + 60_000 })
    expect((await p.listOutbox())[0].leased_until).toBeUndefined()
  })

  it('a lease-shaped field on the row is ignored', async () => {
    queue({ _outboxLease: { holder: 'x', expires_at: new Date(Date.now() + 60_000).toISOString() } })
    expect((await new Plur({ path: dir }).listOutbox())[0].leased_until).toBeUndefined()
  })
})
