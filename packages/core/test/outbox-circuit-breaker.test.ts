/**
 * #785 — the write leg must consult the breaker the read leg maintains.
 *
 * The recall leg has a per-host circuit breaker: three consecutive
 * network-class failures open a five-minute cooldown, 429s honour
 * Retry-After, and the whole thing is persisted cross-process in
 * `<root>/cache/remote-health.json`.
 *
 * `flushOutbox()` consulted none of it. So a host the read leg already knew was
 * down still received one full-timeout write attempt PER QUEUED ENGRAM, on
 * every session start — and those failures never fed back, so the read leg
 * learned nothing from them either. Two legs, one host, two independent
 * opinions about whether it is reachable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import {
  isHostInCooldown, recordWriteOutcome, remoteHealthPath,
  BREAKER_FAILURE_THRESHOLD, BREAKER_COOLDOWN_MS,
} from '../src/remote-recall.js'

const REMOTE = 'https://plur.example.com/sse'

describe('breaker helpers are shared, not duplicated (#785)', () => {
  let dir: string
  let statePath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-breaker-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    statePath = join(dir, 'cache', 'remote-health.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports no cooldown for an unknown host', () => {
    expect(isHostInCooldown(REMOTE, Date.now(), statePath).inCooldown).toBe(false)
  })

  it('opens the breaker after the threshold of write failures', () => {
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) recordWriteOutcome(REMOTE, false, Date.now(), statePath)
    const r = isHostInCooldown(REMOTE, Date.now(), statePath)
    expect(r.inCooldown).toBe(true)
    expect(r.reason).toBe('breaker')
  })

  it('does not open it before the threshold', () => {
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD - 1; i++) recordWriteOutcome(REMOTE, false, Date.now(), statePath)
    expect(isHostInCooldown(REMOTE, Date.now(), statePath).inCooldown).toBe(false)
  })

  it('a write SUCCESS clears the count, so both legs see a recovered host', () => {
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) recordWriteOutcome(REMOTE, false, Date.now(), statePath)
    recordWriteOutcome(REMOTE, true, Date.now(), statePath)
    expect(isHostInCooldown(REMOTE, Date.now(), statePath).inCooldown).toBe(false)
  })

  it('the cooldown expires rather than parking the host forever', () => {
    const t0 = Date.now()
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) recordWriteOutcome(REMOTE, false, t0, statePath)
    expect(isHostInCooldown(REMOTE, t0 + BREAKER_COOLDOWN_MS + 1, statePath).inCooldown).toBe(false)
  })

  it('writes into the same file the recall leg reads', () => {
    recordWriteOutcome(REMOTE, false, Date.now(), statePath)
    const f = JSON.parse(readFileSync(statePath, 'utf8'))
    // Keyed by the normalised endpoint, exactly as the recall leg keys it —
    // otherwise the two legs would maintain parallel entries for one host.
    expect(Object.keys(f.hosts)).toContain('https://plur.example.com')
  })

  it('never throws on unreadable health state — it is an optimisation, not a gate', () => {
    writeFileSync(statePath, 'not json at all')
    expect(() => isHostInCooldown(REMOTE, Date.now(), statePath)).not.toThrow()
    expect(isHostInCooldown(REMOTE, Date.now(), statePath).inCooldown).toBe(false)
    expect(() => recordWriteOutcome(REMOTE, false, Date.now(), statePath)).not.toThrow()
  })
})

describe('flushOutbox honours the breaker (#785)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let attempts: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-outbox-breaker-'))
    process.env.PLUR_PATH = dir
    originalFetch = globalThis.fetch
    attempts = 0
    globalThis.fetch = vi.fn(async () => { attempts++; throw new Error('fetch failed') }) as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: 'group:acme/team', shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.PLUR_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  /** Queue several engrams against the unreachable remote. */
  async function queue(plur: Plur, n: number) {
    for (let i = 0; i < n; i++) {
      await plur.learn(`queued team fact number ${i}`, { scope: 'group:acme/team', type: 'behavioral' })
    }
    await new Promise(r => setTimeout(r, 60))
  }

  it('stops attempting once the breaker is open, instead of one timeout per engram', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 4)

    // Force the breaker open, as the recall leg would have.
    const statePath = remoteHealthPath({ PLUR_PATH: dir } as never)
    mkdirSync(join(dir, 'cache'), { recursive: true })
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) recordWriteOutcome(REMOTE, false, Date.now(), statePath)

    attempts = 0
    const res = await plur.flushOutbox()

    expect(attempts, 'a host in cooldown must not be dialled at all').toBe(0)
    expect(res.flushed).toBe(0)
    expect(res.expired_warnings.some(w => w.includes('circuit breaker open'))).toBe(true)
  })

  it('warns once per host, not once per queued engram', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 4)
    const statePath = remoteHealthPath({ PLUR_PATH: dir } as never)
    mkdirSync(join(dir, 'cache'), { recursive: true })
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) recordWriteOutcome(REMOTE, false, Date.now(), statePath)

    const res = await plur.flushOutbox()
    const breakerWarnings = res.expired_warnings.filter(w => w.includes('circuit breaker open'))
    expect(breakerWarnings).toHaveLength(1)
  })

  it('leaves the engrams queued — skipping is not discarding', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, 3)
    const statePath = remoteHealthPath({ PLUR_PATH: dir } as never)
    mkdirSync(join(dir, 'cache'), { recursive: true })
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) recordWriteOutcome(REMOTE, false, Date.now(), statePath)

    await plur.flushOutbox()

    const doc = yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as
      { engrams: Array<{ structured_data?: { _outbox?: unknown } }> }
    const stillQueued = doc.engrams.filter(e => e.structured_data?._outbox)
    expect(stillQueued.length).toBe(3)
  })

  it('write failures feed the shared breaker, so the read leg learns from them', async () => {
    const plur = new Plur({ path: dir })
    await queue(plur, BREAKER_FAILURE_THRESHOLD)

    // No pre-existing cooldown: the flush itself should open the breaker.
    const statePath = remoteHealthPath({ PLUR_PATH: dir } as never)
    await plur.flushOutbox()

    expect(isHostInCooldown(REMOTE, Date.now(), statePath).inCooldown).toBe(true)
  })
})

/**
 * The two legs must use ONE health file even when PLUR_PATH and `path` differ.
 *
 * Every test above sets both to the same directory — the one configuration in
 * which this cannot fail. The write leg called `isHostInCooldown` and
 * `recordWriteOutcome` without a `statePath`, so it took the default, which
 * resolves from PLUR_PATH; the recall leg passes `remoteHealthStatePath()`,
 * which resolves from `paths.root`. For `new Plur({ path })`, `plur --path`,
 * and every embedded consumer those are different files, so #785's "one host,
 * one opinion" held only by coincidence of the fixture (2026-08-13 panel).
 */
describe('both legs share one health file across path configurations (#785)', () => {
  let storeDir: string
  let envDir: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'plur-store-'))
    envDir = mkdtempSync(join(tmpdir(), 'plur-env-'))
    // Deliberately DIFFERENT from the engine's root.
    process.env.PLUR_PATH = envDir
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as never
    writeFileSync(join(storeDir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: 'group:acme/team', shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.PLUR_PATH
    rmSync(storeDir, { recursive: true, force: true })
    rmSync(envDir, { recursive: true, force: true })
  })

  it('a flush failure lands in the file the recall leg reads', async () => {
    const plur = new Plur({ path: storeDir })
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await plur.learn(`queued team fact ${i}`, { scope: 'group:acme/team', type: 'behavioral' })
    }
    await new Promise(r => setTimeout(r, 60))
    await plur.flushOutbox()

    // The engine's own answer to "where does health state live".
    const recallLegPath = plur.remoteHealthStatePath()
    expect(recallLegPath.startsWith(storeDir), 'fixture assumption: root drives the recall leg').toBe(true)
    expect(
      isHostInCooldown(REMOTE, Date.now(), recallLegPath).inCooldown,
      'the write leg recorded its failures somewhere the recall leg never reads',
    ).toBe(true)

    // …and NOT in the PLUR_PATH-derived file, which is where they used to go.
    expect(existsSync(join(envDir, 'cache', 'remote-health.json'))).toBe(false)
  })
})
