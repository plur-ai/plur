/**
 * #1586 — intermittent remote recall failures while writes succeed.
 *
 * Four fixes, one test group each (the issue's DONE_WHEN, refined 2026-10-04):
 *
 *   1. One deadline for the whole recall. A server that never answers plus a
 *      store lock that is never released must not hold a recall past its
 *      end-to-end deadline; the post-recall bookkeeping write is best-effort.
 *   2. A timeout caused by this client's own blocked event loop is reported as
 *      `client_slow` and is never counted against the host's breaker.
 *   3. A successful direct write to a host ends that host's read cooldown.
 *   4. A cooldown lets exactly one trial read through after the trial interval.
 *
 * And, across all of them: every recall says, for THAT call, what the remote
 * leg did (`remote.state`, per-host detail) and whether the results are
 * complete (`results_complete`).
 *
 * Real HTTP against the in-process StubServer (no fetch mocking, except where
 * a test wraps fetch to block the event loop mid-request).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import {
  remoteRecall, readRemoteHealth,
  BREAKER_COOLDOWN_MS, BREAKER_HALF_OPEN_AFTER_MS, DEFAULT_RECALL_DEADLINE_MS,
  type RemoteRecallHost,
} from '../src/remote-recall.js'
import { normalizeEndpointUrl } from '../src/store/remote-store.js'
import { withAsyncLock, makeToken } from '../src/store/async-lock.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'recall-deadline-token'
const TEAM_SCOPE = 'group:plur/plur-ai/engineering'
const PROJECT = 'project:plur/anything' // org `plur` implicates the store

let server: StubServer
let baseUrl: string
const dirs: string[] = []
const releasers: Array<() => void> = []
const lockFiles: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function plurFor(url = baseUrl): { plur: Plur; dir: string } {
  const dir = tmp('plur-1586-')
  writeFileSync(
    join(dir, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${TEAM_SCOPE}"\n`,
  )
  return { plur: new Plur({ path: dir }), dir }
}

function healthPathOf(dir: string): string {
  return join(dir, 'cache', 'remote-health.json')
}

function hostHealth(dir: string): Record<string, any> {
  return (readRemoteHealth(healthPathOf(dir)).hosts as Record<string, any>)[normalizeEndpointUrl(baseUrl)] ?? {}
}

function seedHealth(dir: string, h: Record<string, unknown>): void {
  mkdirSync(join(dir, 'cache'), { recursive: true })
  writeFileSync(healthPathOf(dir), JSON.stringify({ version: 1, hosts: { [normalizeEndpointUrl(baseUrl)]: h } }))
}

/** Block the event loop synchronously — what a cold start (YAML parse,
 *  embedder init) does to a process. */
function busyWait(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

function serverRow(id: string, statement: string): Record<string, unknown> {
  return { id, scope: TEAM_SCOPE, status: 'active', statement, score: 1 }
}

beforeAll(async () => {
  server = new StubServer(TOKEN)
  const info = await server.start()
  baseUrl = info.url
})

afterAll(async () => {
  await server.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  server.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  while (releasers.length) releasers.pop()!()
  while (lockFiles.length) {
    const f = lockFiles.pop()!
    try { if (existsSync(f)) unlinkSync(f) } catch { /* gone */ }
  }
})

// ---------------------------------------------------------------------------
// 1. One deadline for the whole recall
// ---------------------------------------------------------------------------

describe('#1586 fix 1 — one end-to-end deadline per recall', () => {
  it('the default deadline is at most 10 s', () => {
    expect(DEFAULT_RECALL_DEADLINE_MS).toBeGreaterThan(0)
    expect(DEFAULT_RECALL_DEADLINE_MS).toBeLessThanOrEqual(10_000)
  })

  it('hybrid recall returns within the deadline with a never-answering server and a store lock held in-process', async () => {
    server.recallDelayMs = 120_000 // never answers within any budget
    const { plur, dir } = plurFor()
    await plur.learn('deadline fact alpha about lighthouses', { scope: PROJECT })
    // A lock holder that never releases (released in afterEach).
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    releasers.push(release)
    void withAsyncLock(join(dir, 'engrams.yaml'), () => held)

    const t0 = Date.now()
    const res = await plur.recallHybridWithMeta('lighthouses deadline fact', { scope: PROJECT, remote_timeout_ms: 2000 })
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThan(DEFAULT_RECALL_DEADLINE_MS)
    expect(res.engrams.some(e => e.statement.includes('lighthouses'))).toBe(true)
    expect(res.remote?.state).toBe('timeout')
    expect(res.results_complete).toBe(false)
  }, 25_000)

  it('keyword recall returns within the deadline with a never-answering server and a live cross-process lock file', async () => {
    server.recallDelayMs = 120_000
    const { plur, dir } = plurFor()
    await plur.learn('deadline fact beta about harbours', { scope: PROJECT })
    // A lock file whose holder is alive (this process's pid, another token):
    // the lock protocol waits for it and never steals it — on main that wait
    // is DEFAULT_ACQUIRE_TIMEOUT, 180 s.
    const lockFile = join(dir, 'engrams.yaml.lock')
    writeFileSync(lockFile, makeToken())
    lockFiles.push(lockFile)

    const t0 = Date.now()
    const res = await plur.recallWithMeta('harbours deadline fact', { scope: PROJECT, remote_timeout_ms: 2000 })
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThan(DEFAULT_RECALL_DEADLINE_MS)
    expect(res.engrams.some(e => e.statement.includes('harbours'))).toBe(true)
    expect(res.remote.state).toBe('timeout')
    expect(res.results_complete).toBe(false)
  }, 25_000)

  it('an explicit deadline shorter than the remote budget cuts the remote leg and says so', async () => {
    server.recallDelayMs = 120_000
    const { plur } = plurFor()
    await plur.learn('deadline fact gamma about canals', { scope: PROJECT })
    const t0 = Date.now()
    const res = await plur.recallHybridWithMeta('canals deadline fact', {
      scope: PROJECT, remote_timeout_ms: 5000, deadline_ms: 800,
    })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(res.engrams.some(e => e.statement.includes('canals'))).toBe(true)
    expect(res.remote?.state).toBe('timeout')
    expect(res.results_complete).toBe(false)
  }, 15_000)

  it('the bookkeeping write still lands when the store lock is free', async () => {
    const { plur } = plurFor()
    await plur.learn('deadline fact delta about bridges', { scope: PROJECT })
    const before = (await plur.recall('bridges', { remote: false }))[0]
    const f0 = before.activation.frequency
    await plur.recallWithMeta('bridges', { remote: false })
    const after = (await plur.list()).find(e => e.id === before.id)!
    expect(after.activation.frequency).toBeGreaterThan(f0)
  })
})

// ---------------------------------------------------------------------------
// 2. The client's own slow start is not blamed on the server
// ---------------------------------------------------------------------------

describe('#1586 fix 2 — a blocked event loop is client_slow, not a host failure', () => {
  it('a 6 s block during a recall is client_slow and leaves the host failure count unchanged', async () => {
    server.recallDelayMs = 120_000
    const { plur, dir } = plurFor()
    seedHealth(dir, { failures: 2, last_state: 'timeout', updated_at: Date.now() })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: any, init?: any) => {
      // The request is in flight; now the process blocks its own loop for 6 s
      // — longer than the remote budget plus the whole starvation credit.
      setTimeout(() => busyWait(6000), 0)
      return realFetch(input, init)
    })

    const res = await plur.recallWithMeta('anything at all', { scope: PROJECT, remote_timeout_ms: 2000 })

    expect(res.remote.state).toBe('client_slow')
    expect(res.remote.hosts[0].state).toBe('client_slow')
    expect(res.results_complete).toBe(false)
    const h = hostHealth(dir)
    // Seeded at 2: one more counted failure would open the breaker.
    expect(h.failures).toBe(2)
    expect(h.cooldown_until ?? 0).toBeLessThanOrEqual(Date.now())
  }, 30_000)

  it('three client-slow calls in a row do not open the breaker', async () => {
    server.recallDelayMs = 120_000
    const statePath = join(tmp('plur-1586-health-'), 'remote-health.json')
    const host: RemoteRecallHost = { url: baseUrl, token: TOKEN, scopes: [TEAM_SCOPE], entries: [{ scope: TEAM_SCOPE }] }
    const realFetch = globalThis.fetch
    const blockingFetch = ((input: any, init?: any) => {
      setTimeout(() => busyWait(600), 0)
      return realFetch(input, init)
    }) as typeof fetch
    for (let i = 0; i < 3; i++) {
      const res = await remoteRecall([host], 'q', {
        statePath, timeoutMs: 100, maxStarvationCreditMs: 300, fetchImpl: blockingFetch,
      })
      expect(res.outcomes[0].state).toBe('client_slow')
    }
    const h = (readRemoteHealth(statePath).hosts as Record<string, any>)[normalizeEndpointUrl(baseUrl)] ?? {}
    expect(h.failures ?? 0).toBe(0)
    expect(h.cooldown_until ?? 0).toBeLessThanOrEqual(Date.now())
    // ...and the next call dials.
    const next = await remoteRecall([host], 'q', { statePath, timeoutMs: 100, fetchImpl: blockingFetch, maxStarvationCreditMs: 300 })
    expect(next.outcomes[0].state).not.toBe('skipped_cooldown')
  }, 30_000)

  it('a server that is simply slow, on a responsive loop, is still a host timeout', async () => {
    server.recallDelayMs = 120_000
    const statePath = join(tmp('plur-1586-health-'), 'remote-health.json')
    const host: RemoteRecallHost = { url: baseUrl, token: TOKEN, scopes: [TEAM_SCOPE], entries: [{ scope: TEAM_SCOPE }] }
    const res = await remoteRecall([host], 'q', { statePath, timeoutMs: 150 })
    expect(res.outcomes[0].state).toBe('timeout')
    const h = (readRemoteHealth(statePath).hosts as Record<string, any>)[normalizeEndpointUrl(baseUrl)]
    expect(h.failures).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. A successful save ends the pause
// ---------------------------------------------------------------------------

describe('#1586 fix 3 — a successful direct write clears the read cooldown', () => {
  it('learn to a host in cooldown clears cooldown_until, and the next recall dials', async () => {
    const { plur, dir } = plurFor()
    seedHealth(dir, { failures: 0, cooldown_until: Date.now() + BREAKER_COOLDOWN_MS, last_state: 'timeout', updated_at: Date.now() })
    // Precondition: reads are paused.
    const paused = await plur.recallWithMeta('anything', { scope: PROJECT })
    expect(paused.remote.state).toBe('skipped_cooldown')
    expect(server.recallCalls).toBe(0)

    const saved = await plur.learnRouted('a team fact written during the cooldown', { scope: TEAM_SCOPE })
    // The save reached the server (not the outbox).
    expect((saved as any).structured_data?._outbox).toBeUndefined()

    const h = hostHealth(dir)
    expect(h.cooldown_until ?? 0).toBeLessThanOrEqual(Date.now())
    expect(h.failures ?? 0).toBe(0)

    server.recallRows = [serverRow('ENG-2026-1004-001', 'a team fact written during the cooldown')]
    const res = await plur.recallWithMeta('team fact cooldown', { scope: PROJECT })
    expect(res.remote.state).toBe('ok')
    expect(res.results_complete).toBe(true)
    expect(server.recallCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. A cooldown allows one trial read
// ---------------------------------------------------------------------------

describe('#1586 fix 4 — the cooldown allows one trial read after the trial interval', () => {
  it('a fresh cooldown skips the host and says so for this call', async () => {
    const { plur, dir } = plurFor()
    seedHealth(dir, { failures: 0, cooldown_until: Date.now() + BREAKER_COOLDOWN_MS, last_state: 'timeout', updated_at: Date.now() })
    const res = await plur.recallHybridWithMeta('anything', { scope: PROJECT })
    expect(res.remote?.state).toBe('skipped_cooldown')
    expect(res.results_complete).toBe(false)
    expect(server.recallCalls).toBe(0)
  })

  it('after the trial interval one recall dials; a success closes the cooldown', async () => {
    expect(BREAKER_HALF_OPEN_AFTER_MS).toBeGreaterThan(0)
    expect(BREAKER_HALF_OPEN_AFTER_MS).toBeLessThan(BREAKER_COOLDOWN_MS)
    const { plur, dir } = plurFor()
    // Opened (BREAKER_HALF_OPEN_AFTER_MS + 1 s) ago.
    const openedAt = Date.now() - BREAKER_HALF_OPEN_AFTER_MS - 1000
    seedHealth(dir, { failures: 0, cooldown_until: openedAt + BREAKER_COOLDOWN_MS, last_state: 'timeout', updated_at: openedAt })
    const res = await plur.recallWithMeta('anything', { scope: PROJECT })
    expect(server.recallCalls).toBe(1)
    expect(res.remote.state).toBe('ok')
    expect(hostHealth(dir).cooldown_until ?? 0).toBeLessThanOrEqual(Date.now())
    // Closed: the next recall dials normally.
    await plur.recallWithMeta('anything else', { scope: PROJECT })
    expect(server.recallCalls).toBe(2)
  })

  it('only one trial: a failed trial re-opens the cooldown and the next recall is skipped', async () => {
    server.recallStatus = 500
    const { plur, dir } = plurFor()
    const openedAt = Date.now() - BREAKER_HALF_OPEN_AFTER_MS - 1000
    seedHealth(dir, { failures: 0, cooldown_until: openedAt + BREAKER_COOLDOWN_MS, last_state: 'timeout', updated_at: openedAt })
    const first = await plur.recallWithMeta('anything', { scope: PROJECT })
    expect(first.remote.state).toBe('unreachable')
    const second = await plur.recallWithMeta('anything', { scope: PROJECT })
    expect(second.remote.state).toBe('skipped_cooldown')
    expect(server.recallCalls).toBe(1)
    // Re-opened for a full cooldown from the trial.
    expect(hostHealth(dir).cooldown_until).toBeGreaterThan(Date.now() + BREAKER_COOLDOWN_MS - 30_000)
  })
})

// ---------------------------------------------------------------------------
// 5. Every recall says what the server leg did
// ---------------------------------------------------------------------------

describe('#1586 — every recall reports the remote leg for that call', () => {
  it('a healthy host: remote.state ok, per-host detail, results_complete true', async () => {
    server.recallRows = [serverRow('ENG-2026-1004-010', 'remote report fact')]
    const { plur } = plurFor()
    const res = await plur.recallHybridWithMeta('remote report fact', { scope: PROJECT })
    expect(res.remote?.state).toBe('ok')
    expect(res.remote?.hosts).toHaveLength(1)
    expect(res.remote?.hosts[0].host).toBe(normalizeEndpointUrl(baseUrl))
    expect(res.remote?.hosts[0].state).toBe('ok')
    expect(typeof res.remote?.hosts[0].ms).toBe('number')
    expect(res.results_complete).toBe(true)
  })

  it('no host implicated: remote.state not_dialed, results_complete true', async () => {
    const { plur } = plurFor()
    const res = await plur.recallWithMeta('anything') // no project context → zero dials
    expect(res.remote.state).toBe('not_dialed')
    expect(res.remote.hosts).toEqual([])
    expect(res.results_complete).toBe(true)
    expect(server.recallCalls).toBe(0)
  })

  it('the report is per call: a later healthy call is ok even after an earlier failure', async () => {
    const { plur } = plurFor()
    server.recallStatus = 500
    const bad = await plur.recallWithMeta('anything', { scope: PROJECT })
    expect(bad.remote.state).toBe('unreachable')
    server.recallStatus = null
    const good = await plur.recallWithMeta('anything', { scope: PROJECT })
    expect(good.remote.state).toBe('ok')
    expect(good.results_complete).toBe(true)
  })

  it('recall() keeps returning a plain array (compatibility)', async () => {
    const { plur } = plurFor()
    const res = await plur.recall('anything', { remote: false })
    expect(Array.isArray(res)).toBe(true)
  })
})
