/**
 * Formal verification round 2, cluster R2-CoreB — remote host health.
 * Model: spec/formal/PlurSpec/R2CoreB.lean §3–§4. Findings: spec/formal/findings/r2-coreb.md.
 *
 *   core-policy#3 — remote recall dials per (url, token) but kept ONE health
 *   record per url. Authorization facts (the consecutive-403 streak) and the
 *   per-principal 429 budget belong to the credential; only network-class
 *   reachability belongs to the host.
 *
 *   core-policy#10 — RemoteStore.load: a malformed body from a live host must
 *   not trip the host-down breaker ("HTTP responses never trip it").
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  remoteRecall, isHostInCooldown, BREAKER_FAILURE_THRESHOLD, type RemoteRecallHost,
} from '../src/remote-recall.js'
import { RemoteStore, remoteHostDownRemainingMs } from '../src/store/remote-store.js'

const URL = 'http://127.0.0.1:1'
const SCOPE = 'group:plur/plur-ai/engineering'
const REVOKED = 'token-revoked-aaaaaaaa'
const HEALTHY = 'token-healthy-bbbbbbbb'
const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function statePath(): string {
  const d = mkdtempSync(join(tmpdir(), 'plur-r2coreb-h-'))
  dirs.push(d)
  return join(d, 'remote-health.json')
}

const host = (token: string): RemoteRecallHost => ({ url: URL, token, scopes: [SCOPE], entries: [{ scope: SCOPE }] })

/** Mocked fetch answering by bearer token: `plan[token]` is a status (200 = empty envelope) or 'down'. */
function byToken(plan: Record<string, number | 'down'>, retryAfter?: string): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  const f = (async (_url: string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    const token = auth.replace(/^Bearer /, '')
    calls.push(token)
    const p = plan[token]
    if (p === 'down') throw new Error('connect ECONNREFUSED')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (p === 429 && retryAfter) headers['Retry-After'] = retryAfter
    return new Response(p === 200 ? JSON.stringify({ results: [] }) : '{}', { status: p, headers })
  }) as typeof fetch & { calls: string[] }
  f.calls = calls
  return f
}

describe('core-policy#3 — credential state is keyed by (url, token), reachability by url', () => {
  it('a healthy token interleaved with a revoked one does not reset the revoked token\'s 403 streak', async () => {
    const sp = statePath()
    const fetchImpl = byToken({ [REVOKED]: 403, [HEALTHY]: 200 })
    const first = await remoteRecall([host(REVOKED), host(HEALTHY)], 'q', { statePath: sp, fetchImpl })
    expect(first.outcomes.map(o => o.state)).toEqual(['unreachable', 'ok'])
    const second = await remoteRecall([host(REVOKED), host(HEALTHY)], 'q', { statePath: sp, fetchImpl })
    expect(second.outcomes.map(o => o.state)).toEqual(['forbidden', 'ok'])
  })

  it('two tokens each seeing ONE 403 in one call are both unconfirmed, not a revocation', async () => {
    const other = 'token-other-cccccccc'
    const fetchImpl = byToken({ [REVOKED]: 403, [other]: 403 })
    const res = await remoteRecall([host(REVOKED), host(other)], 'q', { statePath: statePath(), fetchImpl })
    expect(res.outcomes.map(o => o.state)).toEqual(['unreachable', 'unreachable'])
    expect(res.outcomes.map(o => o.detail)).toEqual(['http_403_unconfirmed', 'http_403_unconfirmed'])
  })

  it('one token\'s 429 cooldown does not park another token on the same host', async () => {
    const sp = statePath()
    let clock = 1_000_000_000_000
    const now = () => clock
    const limited = 'token-limited-dddddddd'
    const fetchImpl = byToken({ [limited]: 429, [HEALTHY]: 200 }, '60')
    await remoteRecall([host(limited)], 'q', { statePath: sp, fetchImpl, now })
    clock += 1000
    const res = await remoteRecall([host(limited), host(HEALTHY)], 'q', { statePath: sp, fetchImpl, now })
    expect(res.outcomes.map(o => o.state)).toEqual(['skipped_cooldown', 'ok'])
    expect(fetchImpl.calls).toEqual([limited, HEALTHY])
  })

  it('the write leg sees a 429 only for the token that earned it; the host breaker for everyone', async () => {
    const sp = statePath()
    const limited = 'token-limited-eeeeeeee'
    await remoteRecall([host(limited)], 'q', { statePath: sp, fetchImpl: byToken({ [limited]: 429 }, '60') })
    expect(isHostInCooldown(URL, Date.now(), sp, limited)).toMatchObject({ inCooldown: true, reason: 'rate_limit' })
    expect(isHostInCooldown(URL, Date.now(), sp, HEALTHY).inCooldown).toBe(false)
    expect(isHostInCooldown(URL, Date.now(), sp).inCooldown).toBe(false)
  })

  it('non-vacuity: network failures still open ONE breaker for the host, whatever the token', async () => {
    const sp = statePath()
    const fetchImpl = byToken({ [REVOKED]: 'down', [HEALTHY]: 200 })
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      await remoteRecall([host(REVOKED)], 'q', { statePath: sp, fetchImpl, timeoutMs: 500 })
    }
    const res = await remoteRecall([host(HEALTHY)], 'q', { statePath: sp, fetchImpl })
    expect(res.outcomes[0].state).toBe('skipped_cooldown')
    expect(isHostInCooldown(URL, Date.now(), sp)).toMatchObject({ inCooldown: true, reason: 'breaker' })
  })

  it('never persists a token in the health file', async () => {
    const sp = statePath()
    await remoteRecall([host(REVOKED), host(HEALTHY)], 'q', { statePath: sp, fetchImpl: byToken({ [REVOKED]: 403, [HEALTHY]: 429 }) })
    const text = readFileSync(sp, 'utf8')
    expect(text).not.toContain(REVOKED)
    expect(text).not.toContain(HEALTHY)
  })
})

describe('core-policy#10 — a malformed body from a live host does not trip the host-down breaker', () => {
  async function serve(body: string): Promise<string> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    servers.push(server)
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }

  for (const [name, body] of [['unparseable JSON', 'not json {'], ['JSON without rows', '{"total_count": 3}']] as const) {
    it(`${name}: host stays up, logged as a body problem, not a network failure`, async () => {
      const url = await serve(body)
      const errors: string[] = []
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
      const rows = await new RemoteStore(url, 't', SCOPE).load()
      expect(rows).toEqual([])
      expect(remoteHostDownRemainingMs(url)).toBe(0)
      expect(errors.some(e => /load page failed/.test(e))).toBe(false)
      expect(errors.some(e => /malformed|unreadable/.test(e))).toBe(true)
    })
  }

  it('non-vacuity: a real network failure still marks the host down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await new RemoteStore('http://127.0.0.1:9/sse', 't', SCOPE).load()
    expect(remoteHostDownRemainingMs('http://127.0.0.1:9/sse')).toBeGreaterThan(0)
  })
})
