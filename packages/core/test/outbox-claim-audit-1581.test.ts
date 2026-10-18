/**
 * Follow-ups from the audit of #1581 (fail-closed outbox claim). The audit's
 * probe (A, B, C, D) is the base of this file.
 *
 * - M1: an error while cleaning up AFTER the claim is on disk (removing the
 *   temp file, or the takeover marker) must not turn a recorded claim into
 *   "not claimed". The claim is ours, so the answer is `claimed`, and the
 *   writer can release it.
 * - L2: a temp file written part-way (disk full) is removed.
 * - L1: why an entry is held is visible: the claim error is the row's
 *   `last_error` (no push attempt counted), `listOutbox` gives a reason, and
 *   the summary lists it under `held`.
 * - L3: on a filesystem without hard links the claim is created and written in
 *   two steps, so a racer can read an empty or half-written claim. A claim
 *   that cannot be parsed and is younger than the lease is live, not lapsed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import yaml from 'js-yaml'

const faults = vi.hoisted(() => ({
  rmTmpOnce: false, rmMarkerOnce: false, partialTmp: false, mkdirClaims: false, noLink: false,
}))

vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const rmSync = vi.fn((p: any, o?: any) => {
    const s = String(p)
    if (faults.rmTmpOnce && s.includes('outbox-claims') && s.endsWith('.tmp')) {
      faults.rmTmpOnce = false
      throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${s}'`), { code: 'EPERM' })
    }
    if (faults.rmMarkerOnce && s.includes('outbox-claims') && /\.takeover-[0-9a-f]+$/.test(s)) {
      faults.rmMarkerOnce = false
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${s}'`), { code: 'EBUSY' })
    }
    return real.rmSync(p, o)
  })
  const writeFileSync = vi.fn((p: any, d: any, o?: any) => {
    if (faults.partialTmp && String(p).includes('outbox-claims') && String(p).endsWith('.tmp')) {
      real.writeFileSync(p, String(d).slice(0, 5), o)
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }
    return real.writeFileSync(p, d, o)
  })
  const mkdirSync = vi.fn((p: any, o?: any) => {
    if (faults.mkdirClaims && String(p).includes('outbox-claims')) {
      throw Object.assign(new Error(`EACCES: permission denied, mkdir '${p}'`), { code: 'EACCES' })
    }
    return real.mkdirSync(p, o)
  })
  const linkSync = vi.fn((from: any, to: any) => {
    if (faults.noLink && String(to).includes('outbox-claims')) {
      throw Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' })
    }
    return real.linkSync(from, to)
  })
  const all = { rmSync, writeFileSync, mkdirSync, linkSync }
  return { ...real, ...all, default: { ...real, ...all } }
})

const { Plur, summarizeOutbox, describeHeld } = await import('../src/index.js')
const { StubServer } = await import('./helpers/stub-server.js')

const ID = 'ENG-2026-10-04-001'
let dir: string

beforeEach(() => {
  Object.assign(faults, { rmTmpOnce: false, rmMarkerOnce: false, partialTmp: false, mkdirClaims: false, noLink: false })
  dir = mkdtempSync(join(tmpdir(), 'plur-a1581-'))
  writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const claimFile = (p: any) => join(p.outboxClaimsDir(), `${ID}.json`)
const claim = (p: any, key = 'key-1') => p._claimOutboxEntry(ID, () => key)
const staleBody = () => JSON.stringify({ key: 'key-1', token: 'dead', pid: 2 ** 22 + 12345, host: hostname(), at: Date.now(), until: Date.now() + 60_000 })

describe('M1: cleanup after the claim is on disk does not undo the claim', () => {
  it('A: free entry, removing the temp file throws → claimed, and the writer can release it', () => {
    const a = new Plur({ path: dir })
    faults.rmTmpOnce = true
    const first = claim(a)
    expect(first).toEqual({ status: 'claimed', key: 'key-1' })
    expect(JSON.parse(readFileSync(claimFile(a), 'utf8')).pid).toBe(process.pid)
    expect(claim(new Plur({ path: dir })).status).toBe('busy') // held by us, as it should be
    ;(a as any)._releaseOutboxClaim(ID)
    expect(existsSync(claimFile(a))).toBe(false)
  })

  it('B: takeover, removing the marker throws → claimed, and the writer can release it', () => {
    const a = new Plur({ path: dir })
    mkdirSync(a.outboxClaimsDir(), { recursive: true })
    writeFileSync(claimFile(a), staleBody())
    faults.rmMarkerOnce = true
    const first = claim(a)
    expect(first).toEqual({ status: 'claimed', key: 'key-1' })
    ;(a as any)._releaseOutboxClaim(ID)
    expect(existsSync(claimFile(a))).toBe(false)
  })
})

describe('L2: a temp file written part-way is removed', () => {
  it('C: disk full while writing the temp file → not claimed, and no temp file left', () => {
    const a = new Plur({ path: dir })
    faults.partialTmp = true
    expect(claim(a).status).toBe('busy')
    faults.partialTmp = false
    expect(readdirSync(a.outboxClaimsDir()).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('L3: without hard links, a claim being written is not taken for a lapsed one', () => {
  it('a fresh empty claim file is live', () => {
    const a = new Plur({ path: dir })
    faults.noLink = true
    mkdirSync(a.outboxClaimsDir(), { recursive: true })
    writeFileSync(claimFile(a), '')
    expect(claim(a).status).toBe('busy')
    expect(readFileSync(claimFile(a), 'utf8')).toBe('')
  })

  it('a fresh half-written claim file is live', () => {
    const a = new Plur({ path: dir })
    faults.noLink = true
    mkdirSync(a.outboxClaimsDir(), { recursive: true })
    writeFileSync(claimFile(a), '{"key":"ke')
    expect(claim(a).status).toBe('busy')
  })

  it('an empty claim file older than the lease is lapsed and taken over', () => {
    const a = new Plur({ path: dir })
    faults.noLink = true
    mkdirSync(a.outboxClaimsDir(), { recursive: true })
    writeFileSync(claimFile(a), '')
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(claimFile(a), old, old)
    expect(claim(a)).toEqual({ status: 'claimed', key: 'key-1' })
  })

  it('a free entry is still claimed through the fallback, exactly once', () => {
    const a = new Plur({ path: dir })
    const b = new Plur({ path: dir })
    faults.noLink = true
    expect(claim(a).status).toBe('claimed')
    expect(claim(b).status).toBe('busy')
  })
})

describe('L1: why an entry is held is visible', () => {
  const TOKEN = 't'
  const SCOPE = 'group:test'
  let server: any
  let base: string
  beforeAll(async () => { server = new StubServer(TOKEN); base = (await server.start()).url })
  afterAll(async () => { await server.stop() })

  it('D: claims folder unwritable → last_error and reason name it; the summary lists it; it goes out once writable', async () => {
    const prevHome = process.env.HOME
    process.env.HOME = join(dir, 'home')
    try {
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ url: base, token: TOKEN, scope: SCOPE, shared: true, readonly: false }] }))
      const p = new Plur({ path: dir })
      server.appendErrorResponse = { status: 503, body: 'down' }
      await p.learnRouted('Queued while the server was down', { scope: SCOPE, type: 'behavioral' })
      server.appendErrorResponse = null
      const before = (await p.listOutbox())[0]
      faults.mkdirClaims = true
      const r = await p.flushOutbox({ force: true })
      expect(r.deferred).toBe(1)
      const [entry] = await p.listOutbox()
      expect(entry.last_error).toContain('push claim could not be recorded')
      expect(entry.last_error).toContain('EACCES')
      expect(entry.attempt_count).toBe(before.attempt_count) // not a push attempt
      expect(entry.state).toBe('retrying')
      expect(entry.reason).toContain('push claim could not be recorded')
      expect(entry.next_step).toContain('outbox-claims')
      const summary = summarizeOutbox(await p.listOutbox())
      expect(summary.held?.[0]?.count).toBe(1)
      const lines = describeHeld(summary)
      expect(lines.join('\n')).toContain('push claim could not be recorded')
      faults.mkdirClaims = false
      const after = await p.flushOutbox({ force: true })
      expect(after.flushed).toBe(1)
      expect(await p.listOutbox()).toEqual([])
    } finally { process.env.HOME = prevHome }
  })
})

describe('L1: doctor can tell whether the claims folder can be written', () => {
  it('outboxClaimsProblem: undefined when writable, the error when not', () => {
    const p = new Plur({ path: dir })
    expect((p as any).outboxClaimsProblem()).toBeUndefined()
    faults.mkdirClaims = true
    expect((p as any).outboxClaimsProblem()).toContain('EACCES')
  })
})
