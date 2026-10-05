/**
 * #1586 audit round (PR #1587) — regression tests for the audit findings.
 *
 *   M1  a recall that lost the trial claim must not erase the winner's claim
 *   M2  a recall must not revert a save's cooldown clear; health writes apply
 *       only the fields the call changed, merged under the lock
 *   L1  an absolute deadline (`deadline_at`) taken by the caller is honoured
 *   L3  the bookkeeping lock wait is bounded by the time left
 *   L4  a run of client_slow calls still lets a dead server open the breaker
 *   L5  a save never clears a host-wide 429 cooldown
 *   L6  injectHybrid has the same deadline and per-call remote report
 *   L7  with several hosts, answered hosts survive a pending one at the deadline
 *   L8  a trial claim that cannot take the lock is denied
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import {
  remoteRecall, recordWriteOutcome, readRemoteHealth, tokenHealthKey,
  BREAKER_COOLDOWN_MS, BREAKER_HALF_OPEN_AFTER_MS, CLIENT_SLOW_STREAK_LIMIT,
  type RemoteRecallHost,
} from '../src/remote-recall.js'
import { normalizeEndpointUrl } from '../src/store/remote-store.js'
import { withAsyncLock, makeToken } from '../src/store/async-lock.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'recall-audit-token'
const TEAM_SCOPE = 'group:plur/plur-ai/engineering'
const TEAM_SCOPE_B = 'group:plur/plur-ai/comms'
const PROJECT = 'project:plur/anything'

const FAKE = 'https://audit-probe.example'
const FAKE_KEY = normalizeEndpointUrl(FAKE)
const fakeHost: RemoteRecallHost = { url: FAKE, token: 'tok', scopes: ['group:x'], entries: [{ scope: 'group:x' } as any] }
const okFetch = (async () => new Response(JSON.stringify({ data: { results: [] } }), {
  status: 200, headers: { 'content-type': 'application/json' },
})) as unknown as typeof fetch

let server: StubServer
let serverB: StubServer
let baseUrl: string
let baseUrlB: string
const dirs: string[] = []
const releasers: Array<() => void> = []
const lockFiles: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function statePathIn(prefix = 'plur-1587-health-'): string {
  return join(tmp(prefix), 'remote-health.json')
}

function seedFake(statePath: string, h: Record<string, unknown>): void {
  writeFileSync(statePath, JSON.stringify({ version: 1, hosts: { [FAKE_KEY]: h } }))
}

const fileHost = (statePath: string, key = FAKE_KEY): Record<string, any> =>
  (JSON.parse(readFileSync(statePath, 'utf8')).hosts ?? {})[key] ?? {}

function plurFor(stores: Array<{ url: string; scope: string }>): { plur: Plur; dir: string } {
  const dir = tmp('plur-1587-')
  const yaml = stores.map(s => `  - url: "${s.url}"\n    token: "${TOKEN}"\n    scope: "${s.scope}"\n`).join('')
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n${yaml}`)
  return { plur: new Plur({ path: dir }), dir }
}

function busyWait(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
  serverB = new StubServer(TOKEN)
  baseUrlB = (await serverB.start()).url
})

afterAll(async () => {
  await server.stop()
  await serverB.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  server.reset()
  serverB.reset()
})

afterEach(() => {
  while (releasers.length) releasers.pop()!()
  while (lockFiles.length) {
    const f = lockFiles.pop()!
    try { if (existsSync(f)) unlinkSync(f) } catch { /* gone */ }
  }
})

// ---------------------------------------------------------------------------
// M1 / M2 — health writes apply only what the call changed
// ---------------------------------------------------------------------------

describe('M1 — a recall that lost the trial claim keeps the winner\'s claim', () => {
  it('the loser does not erase half_open_trial_at, and a third process does not dial a second trial', async () => {
    const statePath = statePathIn()
    const openedAt = Date.now() - BREAKER_HALF_OPEN_AFTER_MS - 1000
    seedFake(statePath, { failures: 0, cooldown_until: openedAt + BREAKER_COOLDOWN_MS, cooldown_opened_at: openedAt, last_state: 'timeout', updated_at: openedAt })
    let first = true
    // Process B's clock: on its first read (after its entry snapshot),
    // process A claims the trial.
    const now = () => {
      if (first) {
        first = false
        const cur = JSON.parse(readFileSync(statePath, 'utf8'))
        cur.hosts[FAKE_KEY].half_open_trial_at = Date.now()
        writeFileSync(statePath, JSON.stringify(cur))
      }
      return Date.now()
    }
    const b = await remoteRecall([fakeHost], 'q', { statePath, now, timeoutMs: 500, fetchImpl: okFetch })
    expect(b.outcomes[0].state).toBe('skipped_cooldown')
    expect(fileHost(statePath).half_open_trial_at).toBeGreaterThan(0)

    let dialed = 0
    const countFetch = (async (...a: any[]) => { dialed++; return (okFetch as any)(...a) }) as unknown as typeof fetch
    const c = await remoteRecall([fakeHost], 'q', { statePath, timeoutMs: 500, fetchImpl: countFetch })
    expect(c.outcomes[0].state).toBe('skipped_cooldown')
    expect(dialed).toBe(0)
  })
})

describe('M2 — a save\'s cooldown clear survives a concurrent recall', () => {
  it('a recall that read the cooldown before the save does not restore it', async () => {
    const statePath = statePathIn()
    const t = Date.now()
    seedFake(statePath, { failures: 0, cooldown_until: t + BREAKER_COOLDOWN_MS, cooldown_opened_at: t, last_state: 'timeout', updated_at: t })
    let first = true
    const now = () => {
      if (first) { first = false; recordWriteOutcome(FAKE, true, Date.now(), statePath) }
      return Date.now()
    }
    const r = await remoteRecall([fakeHost], 'q', { statePath, now, timeoutMs: 500, fetchImpl: okFetch })
    expect(r.outcomes[0].state).toBe('skipped_cooldown')
    expect(fileHost(statePath).cooldown_until ?? 0).toBeLessThanOrEqual(Date.now())
    expect(fileHost(statePath).last_state).toBe('ok')
  })

  it('a dial writes only the fields it changed: another token\'s 429 written meanwhile survives', async () => {
    const statePath = statePathIn()
    seedFake(statePath, { failures: 1, last_state: 'timeout', updated_at: Date.now() })
    const other = tokenHealthKey('another-token')
    const until = Date.now() + 60_000
    const writingFetch = (async (...a: any[]) => {
      // Another process records a 429 for a different token while this dial is in flight.
      const cur = JSON.parse(readFileSync(statePath, 'utf8'))
      cur.hosts[FAKE_KEY].tokens = { ...(cur.hosts[FAKE_KEY].tokens ?? {}), [other]: { rate_limited_until: until } }
      writeFileSync(statePath, JSON.stringify(cur))
      return (okFetch as any)(...a)
    }) as unknown as typeof fetch
    const r = await remoteRecall([fakeHost], 'q', { statePath, timeoutMs: 500, fetchImpl: writingFetch })
    expect(r.outcomes[0].state).toBe('ok')
    const h = fileHost(statePath)
    expect(h.tokens?.[other]?.rate_limited_until).toBe(until)
    expect(h.failures).toBe(0)
    expect(h.last_state).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// L8 — trial claim without the lock is denied
// ---------------------------------------------------------------------------

describe('L8 — a trial claim that cannot take the lock is denied', () => {
  it('with the health-file lock held by a live process, a due trial is not dialed', async () => {
    const statePath = statePathIn()
    const openedAt = Date.now() - BREAKER_HALF_OPEN_AFTER_MS - 1000
    seedFake(statePath, { failures: 0, cooldown_until: openedAt + BREAKER_COOLDOWN_MS, cooldown_opened_at: openedAt, last_state: 'timeout', updated_at: openedAt })
    const lockFile = `${statePath}.lock`
    writeFileSync(lockFile, makeToken()) // a live holder (this pid): never stolen
    lockFiles.push(lockFile)
    let dialed = 0
    const countFetch = (async (...a: any[]) => { dialed++; return (okFetch as any)(...a) }) as unknown as typeof fetch
    const r = await remoteRecall([fakeHost], 'q', { statePath, timeoutMs: 500, fetchImpl: countFetch })
    expect(r.outcomes[0].state).toBe('skipped_cooldown')
    expect(dialed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// L5 — a save never clears a 429 cooldown
// ---------------------------------------------------------------------------

describe('L5 — a successful save clears a network cooldown, never a 429 one', () => {
  it('a host-wide rate-limit cooldown survives a successful save', () => {
    const statePath = statePathIn()
    const until = Date.now() + 120_000
    seedFake(statePath, { failures: 0, cooldown_until: until, last_state: 'rate_limited', updated_at: Date.now() })
    recordWriteOutcome(FAKE, true, Date.now(), statePath)
    expect(fileHost(statePath).cooldown_until).toBe(until)
    expect(fileHost(statePath).last_state).toBe('rate_limited')
  })

  it('a timeout cooldown is still cleared by a successful save', () => {
    const statePath = statePathIn()
    seedFake(statePath, { failures: 0, cooldown_until: Date.now() + 120_000, last_state: 'timeout', updated_at: Date.now() })
    recordWriteOutcome(FAKE, true, Date.now(), statePath)
    expect(fileHost(statePath).cooldown_until ?? 0).toBeLessThanOrEqual(Date.now())
  })
})

// ---------------------------------------------------------------------------
// L4 — a run of client_slow calls does not hide a dead server forever
// ---------------------------------------------------------------------------

describe('L4 — consecutive client_slow calls', () => {
  const host = (): RemoteRecallHost => ({ url: baseUrl, token: TOKEN, scopes: [TEAM_SCOPE], entries: [{ scope: TEAM_SCOPE } as any] })
  // Wide margins (#1586 round 8, C-1): a 2 s block against a 300 ms budget and
  // a 500 ms credit cap is unmistakably client-side, even on a starved CPU.
  const blockingFetch = ((input: any, init?: any) => {
    setTimeout(() => busyWait(2000), 0)
    return fetch(input, init)
  }) as typeof fetch
  const opts = (statePath: string) => ({ statePath, timeoutMs: 300, maxStarvationCreditMs: 500, fetchImpl: blockingFetch })

  it('after CLIENT_SLOW_STREAK_LIMIT in a row, further ones count as host timeouts and open the breaker', async () => {
    expect(CLIENT_SLOW_STREAK_LIMIT).toBeGreaterThanOrEqual(2)
    server.recallDelayMs = 120_000
    const statePath = statePathIn()
    const key = normalizeEndpointUrl(baseUrl)
    for (let i = 0; i < CLIENT_SLOW_STREAK_LIMIT; i++) {
      const r = await remoteRecall([host()], 'q', opts(statePath))
      expect(r.outcomes[0].state).toBe('client_slow')
    }
    expect(fileHost(statePath, key).failures ?? 0).toBe(0)
    // From here on the streak is evidence about the server too.
    for (let i = 0; i < 3; i++) {
      const r = await remoteRecall([host()], 'q', opts(statePath))
      expect(r.outcomes[0].state).toBe('timeout')
      expect(r.outcomes[0].detail).toBe('client_slow_streak')
    }
    expect(fileHost(statePath, key).cooldown_until).toBeGreaterThan(Date.now())
    const skipped = await remoteRecall([host()], 'q', opts(statePath))
    expect(skipped.outcomes[0].state).toBe('skipped_cooldown')
  }, 90_000)

  it('an answer from the host resets the streak', async () => {
    const statePath = statePathIn()
    const key = normalizeEndpointUrl(baseUrl)
    writeFileSync(statePath, JSON.stringify({ version: 1, hosts: { [key]: { client_slow_streak: CLIENT_SLOW_STREAK_LIMIT, last_state: 'client_slow' } } }))
    const ok = await remoteRecall([host()], 'q', { statePath, timeoutMs: 2000 })
    expect(ok.outcomes[0].state).toBe('ok')
    expect(fileHost(statePath, key).client_slow_streak ?? 0).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// L7 — several hosts at the deadline
// ---------------------------------------------------------------------------

describe('L7 — at the deadline, answered hosts keep their rows; only the pending one is a timeout', () => {
  const hostA = (): RemoteRecallHost => ({ url: baseUrl, token: TOKEN, scopes: [TEAM_SCOPE], entries: [{ scope: TEAM_SCOPE } as any] })

  for (const honoursAbort of [true, false]) {
    it(`remoteRecall with deadlineAt (pending fetch ${honoursAbort ? 'honours' : 'ignores'} abort)`, async () => {
      server.recallRows = [{ id: 'ENG-2026-1004-201', scope: TEAM_SCOPE, status: 'active', statement: 'answered host row', score: 1 }]
      const statePath = statePathIn()
      const fetchImpl = ((input: any, init?: any) => {
        if (String(input).startsWith(FAKE_KEY)) {
          return new Promise((_, reject) => {
            if (honoursAbort) init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          })
        }
        return fetch(input, init)
      }) as typeof fetch
      const t0 = Date.now()
      const r = await remoteRecall([hostA(), fakeHost], 'q', { statePath, timeoutMs: 5000, fetchImpl, deadlineAt: Date.now() + 600 })
      expect(Date.now() - t0).toBeLessThan(2000)
      const a = r.outcomes.find(o => o.url === baseUrl)!
      const b = r.outcomes.find(o => o.url === FAKE)!
      expect(a.state).toBe('ok')
      expect(a.count).toBe(1)
      expect(r.engrams.some(e => e.statement === 'answered host row')).toBe(true)
      expect(b.state).toBe('timeout')
      expect(b.detail).toBe('recall_deadline')
      // The recall's deadline is not the host's budget: no failure counted.
      expect(fileHost(statePath).failures ?? 0).toBe(0)
    }, 15_000)
  }

  it('Plur recall with two stores keeps the answering store\'s rows', async () => {
    server.recallRows = [{ id: 'ENG-2026-1004-202', scope: TEAM_SCOPE, status: 'active', statement: 'lighthouse keeper team note', score: 1 }]
    serverB.recallDelayMs = 120_000
    const { plur } = plurFor([{ url: baseUrl, scope: TEAM_SCOPE }, { url: baseUrlB, scope: TEAM_SCOPE_B }])
    const res = await plur.recallWithMeta('lighthouse keeper', { scope: PROJECT, remote_timeout_ms: 5000, deadline_ms: 1000 })
    const a = res.remote.hosts.find(h => h.host === normalizeEndpointUrl(baseUrl))!
    const b = res.remote.hosts.find(h => h.host === normalizeEndpointUrl(baseUrlB))!
    expect(a.state).toBe('ok')
    expect(a.count).toBe(1)
    expect(b.state).toBe('timeout')
    expect(res.engrams.some(e => e.statement === 'lighthouse keeper team note')).toBe(true)
    expect(res.results_complete).toBe(false)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// L1 — an absolute deadline taken by the caller
// ---------------------------------------------------------------------------

describe('L1 — deadline_at is honoured', () => {
  it('recallWithMeta stops at an absolute deadline_at', async () => {
    server.recallDelayMs = 120_000
    const { plur } = plurFor([{ url: baseUrl, scope: TEAM_SCOPE }])
    await plur.learn('absolute deadline fact about ferries', { scope: PROJECT })
    const t0 = Date.now()
    const res = await plur.recallWithMeta('ferries deadline', { scope: PROJECT, remote_timeout_ms: 5000, deadline_at: t0 + 700 })
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(res.remote.state).toBe('timeout')
    expect(res.results_complete).toBe(false)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// L3 — the bookkeeping write never starts after the reply
// ---------------------------------------------------------------------------

describe('L3 — the bookkeeping lock wait is bounded by the time left', () => {
  it('a lock released just after the deadline does not let the write land', async () => {
    server.recallDelayMs = 120_000
    const { plur, dir } = plurFor([{ url: baseUrl, scope: TEAM_SCOPE }])
    await plur.learn('bookkeeping fact about lanterns', { scope: PROJECT })
    const before = (await plur.list()).find(e => e.statement.includes('lanterns'))!
    const f0 = before.activation.frequency
    // The store lock is held until 250 ms after the recall's deadline.
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    releasers.push(release)
    void withAsyncLock(join(dir, 'engrams.yaml'), () => held)
    const t0 = Date.now()
    const res = await plur.recallWithMeta('lanterns bookkeeping', { scope: PROJECT, remote_timeout_ms: 5000, deadline_ms: 1000 })
    expect(res.engrams.some(e => e.statement.includes('lanterns'))).toBe(true)
    setTimeout(release, Math.max(0, t0 + 1250 - Date.now()))
    await sleep(Math.max(0, t0 + 2000 - Date.now()))
    const after = (await plur.list()).find(e => e.id === before.id)!
    expect(after.activation.frequency).toBe(f0)
  }, 15_000)
})

// ---------------------------------------------------------------------------
// L6 — injectHybrid: deadline and per-call report
// ---------------------------------------------------------------------------

describe('L6 — injectHybrid has the recall deadline and the per-call remote report', () => {
  it('a never-answering server: returns within the deadline, remote.state timeout, results_complete false', async () => {
    server.recallDelayMs = 120_000
    const { plur } = plurFor([{ url: baseUrl, scope: TEAM_SCOPE }])
    await plur.learn('inject deadline fact about tides', { scope: PROJECT })
    const t0 = Date.now()
    const res = await plur.injectHybrid('tides inject deadline', { scope: PROJECT, remote_timeout_ms: 5000, deadline_ms: 800 })
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(res.remote?.state).toBe('timeout')
    expect(res.results_complete).toBe(false)
  }, 15_000)

  it('a healthy server: remote.state ok, results_complete true', async () => {
    server.recallRows = [{ id: 'ENG-2026-1004-203', scope: TEAM_SCOPE, status: 'active', statement: 'inject report fact', score: 1 }]
    const { plur } = plurFor([{ url: baseUrl, scope: TEAM_SCOPE }])
    const res = await plur.injectHybrid('inject report fact', { scope: PROJECT })
    expect(res.remote?.state).toBe('ok')
    expect(res.remote?.hosts[0].host).toBe(normalizeEndpointUrl(baseUrl))
    expect(res.results_complete).toBe(true)
  })

  it('no host: remote.state not_dialed, results_complete true', async () => {
    const { plur } = plurFor([{ url: baseUrl, scope: TEAM_SCOPE }])
    const res = await plur.injectHybrid('anything', { remote: false })
    expect(res.remote?.state).toBe('not_dialed')
    expect(res.results_complete).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Round 2 (re-audit of bf990fe7)
// ---------------------------------------------------------------------------

describe('N1 — the injection-counter write is bounded by the deadline', () => {
  for (const holder of ['in-process', 'lock-file'] as const) {
    it(`injectHybrid returns near a 20 ms deadline with the store lock held (${holder})`, async () => {
      const { plur, dir } = plurFor([{ url: baseUrl, scope: TEAM_SCOPE }])
      await plur.learn('injection counter fact about buoys', { scope: PROJECT })
      const before = (await plur.list()).find(e => e.statement.includes('buoys'))!
      if (holder === 'in-process') {
        let release!: () => void
        const held = new Promise<void>(r => { release = r })
        releasers.push(release)
        void withAsyncLock(join(dir, 'engrams.yaml'), () => held)
      } else {
        // A live holder by the lock-file protocol (this pid, another token),
        // as another process holding the store would leave it.
        const lockFile = join(dir, 'engrams.yaml.lock')
        writeFileSync(lockFile, makeToken())
        lockFiles.push(lockFile)
      }
      const t0 = Date.now()
      await plur.injectHybrid('buoys injection counter', { remote: false, deadline_ms: 20 })
      expect(Date.now() - t0).toBeLessThan(1500)
      // Released after the reply: the counter is not written behind its back.
      while (releasers.length) releasers.pop()!()
      while (lockFiles.length) { const f = lockFiles.pop()!; try { unlinkSync(f) } catch { /* gone */ } }
      await sleep(700)
      const after = (await plur.list()).find(e => e.id === before.id)!
      expect(after.injection_count ?? 0).toBe(before.injection_count ?? 0)
    }, 15_000)
  }

  it('uncontended, the injection counter is still written', async () => {
    const { plur } = plurFor([{ url: baseUrl, scope: TEAM_SCOPE }])
    await plur.learn('injection counter fact about jetties', { scope: PROJECT })
    const before = (await plur.list()).find(e => e.statement.includes('jetties'))!
    const res = await plur.injectHybrid('jetties injection counter', { remote: false })
    expect(res.injected_ids).toContain(before.id)
    const after = (await plur.list()).find(e => e.id === before.id)!
    expect(after.injection_count ?? 0).toBe((before.injection_count ?? 0) + 1)
  })
})

describe('N2 — a successful recall clears a cooldown opened while it was in flight', () => {
  it('the host answered: failures, cooldown and last_state are written even though they look unchanged', async () => {
    const statePath = statePathIn()
    seedFake(statePath, { failures: 0, cooldown_until: 0, last_state: 'ok', updated_at: Date.now() })
    const openingFetch = (async (...a: any[]) => {
      // Three failed writes in another process open the breaker meanwhile.
      const cur = JSON.parse(readFileSync(statePath, 'utf8'))
      Object.assign(cur.hosts[FAKE_KEY], { failures: 0, cooldown_until: Date.now() + BREAKER_COOLDOWN_MS, cooldown_opened_at: Date.now(), last_state: 'unreachable' })
      writeFileSync(statePath, JSON.stringify(cur))
      return (okFetch as any)(...a)
    }) as unknown as typeof fetch
    const r = await remoteRecall([fakeHost], 'q', { statePath, timeoutMs: 500, fetchImpl: openingFetch })
    expect(r.outcomes[0].state).toBe('ok')
    const h = fileHost(statePath)
    expect(h.cooldown_until ?? 0).toBeLessThanOrEqual(Date.now())
    expect(h.last_state).toBe('ok')
    expect(h.failures ?? 0).toBe(0)
  })
})

describe('N3 — a successful save resets the client_slow streak', () => {
  it('client_slow_streak is 0 after a successful save', () => {
    const statePath = statePathIn()
    seedFake(statePath, { client_slow_streak: CLIENT_SLOW_STREAK_LIMIT, last_state: 'client_slow', updated_at: Date.now() })
    recordWriteOutcome(FAKE, true, Date.now(), statePath)
    expect(fileHost(statePath).client_slow_streak ?? 0).toBe(0)
  })
})

describe('N5 — a 422 breaks the token\'s 403 streak', () => {
  it('403, 422, 403 is not a revocation', async () => {
    const statePath = statePathIn()
    const statuses = [403, 422, 403]
    const seqFetch = (async () => new Response('{}', { status: statuses.shift()!, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const states: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await remoteRecall([fakeHost], 'q', { statePath, timeoutMs: 500, fetchImpl: seqFetch })
      states.push(r.outcomes[0].state)
    }
    expect(states[2]).not.toBe('forbidden')
    expect(fileHost(statePath).forbidden_count).toBeUndefined()
  })
})
