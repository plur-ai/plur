/**
 * Server-authoritative remote recall (#776, plan A2′/A4′).
 *
 * Covers, against a real-HTTP StubServer (no fetch mocking):
 *   - the full per-host failure table (401/403/404/429/5xx/timeout/bad body)
 *   - 403 revocation requires 2 CONSECUTIVE 403s
 *   - 404 → `unsupported` for a bounded TTL, not process lifetime
 *   - 429 honors Retry-After as a persisted cooldown
 *   - circuit breaker: 3 straight failures → cooldown → `skipped_cooldown`,
 *     and the state is READ BY A FRESH CALL (hooks are one-shot processes —
 *     each remoteRecall() call re-reads the state file, simulating a second
 *     process)
 *   - scope guard admits `global` rows (narrowed during namespacing) and
 *     drops foreign-scope rows
 *   - deterministic namespacing: same row → same namespaced id, twice
 *   - server score passthrough + rank-mapped fallback
 *   - kill-switch (PLUR_REMOTE_RECALL) → zero fetches
 *   - strict scope-relevance dialing on Plur: org-mismatch not dialed,
 *     no-context dials nothing, dial:never honored, dial:always forces
 *   - hook-header suppression policy (state change → line; repeat → silent;
 *     skipped_cooldown/unsupported never print)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import {
  remoteRecall, claimHookDegradationLines, readRemoteHealth,
  BREAKER_FAILURE_THRESHOLD, HOOK_HEADER_REPEAT_MS, UNSUPPORTED_TTL_MS,
  scopeOrg,
  type RemoteRecallHost, type HostRecallOutcome,
} from '../src/remote-recall.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'remote-recall-token'
const TEAM_SCOPE = 'group:plur/plur-ai/engineering'

let server: StubServer
let baseUrl: string
const dirs: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function statePath(): string {
  return join(tmp('plur-rrhealth-'), 'remote-health.json')
}

function host(overrides: Partial<RemoteRecallHost> = {}): RemoteRecallHost {
  return {
    url: baseUrl,
    token: TOKEN,
    scopes: [TEAM_SCOPE],
    entries: [{ scope: TEAM_SCOPE }],
    ...overrides,
  }
}

function serverRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    scope: TEAM_SCOPE,
    status: 'active',
    statement: `remote statement for ${id}`,
    ...overrides,
  }
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

// ---------------------------------------------------------------------------
// Happy path + envelope tolerance
// ---------------------------------------------------------------------------

describe('remoteRecall — ok path', () => {
  it('returns validated, namespaced rows with outcome ok + envelope metadata', async () => {
    server.recallRows = [serverRow('ENG-2026-0731-001', { score: 0.9 })]
    const res = await remoteRecall([host()], 'enterprise recall wiring', { statePath: statePath() })
    expect(res.outcomes).toHaveLength(1)
    expect(res.outcomes[0].state).toBe('ok')
    expect(res.outcomes[0].count).toBe(1)
    expect(res.outcomes[0].mode).toBe('hybrid')
    expect(res.outcomes[0].vector).toBe(true)
    expect(res.engrams).toHaveLength(1)
    // Namespaced: ENG-<prefix(group:plur/...)>-... with provenance fields.
    expect(res.engrams[0].id).not.toBe('ENG-2026-0731-001')
    expect((res.engrams[0] as any)._originalId).toBe('ENG-2026-0731-001')
    expect((res.engrams[0] as any)._storeScope).toBe(TEAM_SCOPE)
  })

  it('tolerates an old server serving a bare envelope without mode/vector/dropped_scopes', async () => {
    server.recallBare = true
    server.recallRows = [serverRow('ENG-2026-0731-002')]
    const res = await remoteRecall([host()], 'bare envelope', { statePath: statePath() })
    expect(res.outcomes[0].state).toBe('ok')
    expect(res.outcomes[0].mode).toBeUndefined()
    expect(res.outcomes[0].vector).toBeUndefined()
    expect(res.outcomes[0].dropped_scopes).toBeUndefined()
    expect(res.engrams).toHaveLength(1)
  })

  it('surfaces dropped_scopes from the envelope on an ok outcome', async () => {
    server.recallEnvelope = { dropped_scopes: ['group:plur/secret'] }
    const res = await remoteRecall([host()], 'narrowed', { statePath: statePath() })
    expect(res.outcomes[0].state).toBe('ok')
    expect(res.outcomes[0].dropped_scopes).toEqual(['group:plur/secret'])
  })

  it('sends the dialed scopes, hybrid mode and timeout_ms on the wire', async () => {
    await remoteRecall([host()], 'wire shape', { statePath: statePath(), timeoutMs: 1234 })
    expect(server.lastRecallBody).not.toBeNull()
    expect(server.lastRecallBody!.scopes).toEqual([TEAM_SCOPE])
    expect(server.lastRecallBody!.mode).toBe('hybrid')
    expect(server.lastRecallBody!.timeout_ms).toBe(1234)
  })

  it('truncates the query to the privacy cap before it leaves the machine', async () => {
    const longQuery = 'q'.repeat(5000)
    await remoteRecall([host()], longQuery, { statePath: statePath() })
    expect((server.lastRecallBody!.query as string).length).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// Failure table
// ---------------------------------------------------------------------------

describe('remoteRecall — failure table', () => {
  it('401 → auth_expired (skip + surface, no breaker)', async () => {
    server.recallStatus = 401
    const sp = statePath()
    const res = await remoteRecall([host()], 'x', { statePath: sp })
    expect(res.outcomes[0].state).toBe('auth_expired')
    expect(res.engrams).toHaveLength(0)
    // No breaker contribution: three 401s never open the cooldown.
    await remoteRecall([host()], 'x', { statePath: sp })
    await remoteRecall([host()], 'x', { statePath: sp })
    const again = await remoteRecall([host()], 'x', { statePath: sp })
    expect(again.outcomes[0].state).toBe('auth_expired')
  })

  it('403 requires 2 CONSECUTIVE before reading as revocation (forbidden)', async () => {
    server.recallStatus = 403
    const sp = statePath()
    const first = await remoteRecall([host()], 'x', { statePath: sp })
    expect(first.outcomes[0].state).toBe('unreachable') // unconfirmed
    expect(first.outcomes[0].detail).toBe('http_403_unconfirmed')
    const second = await remoteRecall([host()], 'x', { statePath: sp })
    expect(second.outcomes[0].state).toBe('forbidden')
  })

  it('a success between two 403s resets the revocation counter', async () => {
    const sp = statePath()
    server.recallStatus = 403
    await remoteRecall([host()], 'x', { statePath: sp })
    server.recallStatus = null
    await remoteRecall([host()], 'x', { statePath: sp })
    server.recallStatus = 403
    const res = await remoteRecall([host()], 'x', { statePath: sp })
    expect(res.outcomes[0].state).toBe('unreachable') // count restarted
  })

  it('404 → unsupported for a TTL, not process lifetime', async () => {
    const sp = statePath()
    let clock = 1_000_000_000_000
    const now = () => clock
    server.recallStatus = 404
    const first = await remoteRecall([host()], 'x', { statePath: sp, now })
    expect(first.outcomes[0].state).toBe('unsupported')
    expect(server.recallCalls).toBe(1)

    // Within the TTL: no fetch at all, still reported unsupported.
    server.recallStatus = null
    const second = await remoteRecall([host()], 'x', { statePath: sp, now })
    expect(second.outcomes[0].state).toBe('unsupported')
    expect(server.recallCalls).toBe(1)

    // Past the TTL: the host is probed again and recovers.
    clock += UNSUPPORTED_TTL_MS + 1
    server.recallRows = [serverRow('ENG-2026-0731-003')]
    const third = await remoteRecall([host()], 'x', { statePath: sp, now })
    expect(third.outcomes[0].state).toBe('ok')
    expect(server.recallCalls).toBe(2)
  })

  it('429 honors Retry-After as a persisted cooldown', async () => {
    const sp = statePath()
    let clock = 1_000_000_000_000
    const now = () => clock
    server.recallStatus = 429
    server.recallRetryAfter = '60'
    const first = await remoteRecall([host()], 'x', { statePath: sp, now })
    expect(first.outcomes[0].state).toBe('rate_limited')

    // 30s later (inside the 60s Retry-After): skipped without a fetch.
    server.recallStatus = null
    clock += 30_000
    const second = await remoteRecall([host()], 'x', { statePath: sp, now })
    expect(second.outcomes[0].state).toBe('skipped_cooldown')
    expect(server.recallCalls).toBe(1)

    // Past the Retry-After: dialed again.
    clock += 31_000
    const third = await remoteRecall([host()], 'x', { statePath: sp, now })
    expect(third.outcomes[0].state).toBe('ok')
    expect(server.recallCalls).toBe(2)
  })

  it('5xx → unreachable', async () => {
    server.recallStatus = 503
    const res = await remoteRecall([host()], 'x', { statePath: statePath() })
    expect(res.outcomes[0].state).toBe('unreachable')
    expect(res.outcomes[0].detail).toBe('http_503')
  })

  it('slow server → timeout within the budget', async () => {
    server.recallDelayMs = 400
    const res = await remoteRecall([host()], 'x', { statePath: statePath(), timeoutMs: 80 })
    expect(res.outcomes[0].state).toBe('timeout')
  })

  it('DNS/conn-refused → unreachable', async () => {
    const dead = host({ url: 'http://127.0.0.1:1' })
    const res = await remoteRecall([dead], 'x', { statePath: statePath(), timeoutMs: 500 })
    expect(res.outcomes[0].state).toBe('unreachable')
  })

  it('oversize body (>128KB) → unreachable (validation class)', async () => {
    server.recallOversize = true
    const res = await remoteRecall([host()], 'x', { statePath: statePath() })
    expect(res.outcomes[0].state).toBe('unreachable')
    expect(res.outcomes[0].detail).toBe('oversize')
  })

  it('invalid envelope body → unreachable (validation class)', async () => {
    server.recallBodyOverride = { results: 'not-an-array' }
    const res = await remoteRecall([host()], 'x', { statePath: statePath() })
    expect(res.outcomes[0].state).toBe('unreachable')
    expect(res.outcomes[0].detail).toBe('bad_envelope')
  })

  it('one dead host never sinks a healthy one (parallel isolation)', async () => {
    server.recallRows = [serverRow('ENG-2026-0731-004')]
    const res = await remoteRecall(
      [host(), host({ url: 'http://127.0.0.1:1' })],
      'x',
      { statePath: statePath(), timeoutMs: 1000 },
    )
    const states = res.outcomes.map(o => o.state).sort()
    expect(states).toEqual(['ok', 'unreachable'])
    expect(res.engrams).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Circuit breaker + cross-process persistence
// ---------------------------------------------------------------------------

describe('remoteRecall — circuit breaker', () => {
  it('trips after 3 straight failures and a FRESH call reads the persisted state', async () => {
    const sp = statePath()
    let clock = 1_000_000_000_000
    const now = () => clock
    server.recallStatus = 500
    for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
      const r = await remoteRecall([host()], 'x', { statePath: sp, now })
      expect(r.outcomes[0].state).toBe('unreachable')
      clock += 1000
    }
    expect(server.recallCalls).toBe(3)

    // Every remoteRecall() call reads the state file fresh — this call IS a
    // second process as far as breaker state is concerned (hooks are
    // one-shot). Server is healthy again, but the breaker is open.
    server.recallStatus = null
    const skipped = await remoteRecall([host()], 'x', { statePath: sp, now })
    expect(skipped.outcomes[0].state).toBe('skipped_cooldown')
    expect(server.recallCalls).toBe(3) // no fetch

    // The file itself carries the cooldown — belt and braces.
    const persisted = readRemoteHealth(sp)
    const key = Object.keys(persisted.hosts)[0]
    expect(persisted.hosts[key].cooldown_until).toBeGreaterThan(clock)

    // After the 5-minute cooldown, dialing resumes.
    clock += 5 * 60 * 1000 + 1
    const resumed = await remoteRecall([host()], 'x', { statePath: sp, now })
    expect(resumed.outcomes[0].state).toBe('ok')
    expect(server.recallCalls).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Scope guard + namespacing + scores
// ---------------------------------------------------------------------------

describe('remoteRecall — row post-processing', () => {
  it('admits global rows (narrowed to the store scope) and drops foreign-scope rows', async () => {
    server.recallRows = [
      serverRow('ENG-2026-0731-010'),                                  // in dialed scope
      serverRow('ENG-2026-0731-011', { scope: 'global' }),             // admitted + narrowed
      serverRow('ENG-2026-0731-012', { scope: 'group:evil/exfil' }),   // foreign → dropped
      serverRow('ENG-2026-0731-013', { scope: 'group:plur/plur-ai' }), // parent ≠ within → dropped
    ]
    const res = await remoteRecall([host()], 'x', { statePath: statePath() })
    expect(res.outcomes[0].count).toBe(2)
    const scopes = res.engrams.map(e => e.scope)
    expect(scopes).toEqual([TEAM_SCOPE, TEAM_SCOPE]) // global narrowed
    const originals = res.engrams.map(e => (e as any)._originalId)
    expect(originals).toEqual(['ENG-2026-0731-010', 'ENG-2026-0731-011'])
  })

  it('sibling string-prefix scopes do not leak through the guard (#383)', async () => {
    server.recallRows = [serverRow('ENG-2026-0731-014', { scope: `${TEAM_SCOPE}-private` })]
    const res = await remoteRecall([host()], 'x', { statePath: statePath() })
    expect(res.outcomes[0].count).toBe(0)
  })

  it('drops rows that fail RemoteRowSchema validation', async () => {
    server.recallRows = [
      serverRow('ENG-2026-0731-015'),
      { id: 'EVIL\nID', scope: TEAM_SCOPE, status: 'active', statement: 'x' },
      { id: 'ENG-2026-0731-016', scope: TEAM_SCOPE, status: 'active', statement: '' },
    ]
    const res = await remoteRecall([host()], 'x', { statePath: statePath() })
    expect(res.outcomes[0].count).toBe(1)
  })

  it('namespacing is deterministic: the same row maps to the same id twice', async () => {
    server.recallRows = [serverRow('ENG-2026-0731-017')]
    const sp = statePath()
    const first = await remoteRecall([host()], 'x', { statePath: sp })
    const second = await remoteRecall([host()], 'x', { statePath: sp })
    expect(first.engrams[0].id).toBe(second.engrams[0].id)
  })

  it('passes server scores through and rank-maps rows without scores', async () => {
    server.recallRows = [
      serverRow('ENG-2026-0731-018', { score: 0.75 }),
      serverRow('ENG-2026-0731-019'), // no score → rank fallback
      serverRow('ENG-2026-0731-020'), // no score → rank fallback
    ]
    const res = await remoteRecall([host()], 'x', { statePath: statePath() })
    const [a, b, c] = res.engrams.map(e => res.scores.get(e.id)!)
    expect(a).toBe(0.75)
    // rank fallback over 3 accepted rows: (3-1)/3, (3-2)/3
    expect(b).toBeCloseTo(2 / 3)
    expect(c).toBeCloseTo(1 / 3)
    // out-of-range server scores clamp to [0,1]
    server.reset()
    server.recallRows = [serverRow('ENG-2026-0731-021', { score: 7 })]
    const clamped = await remoteRecall([host()], 'x', { statePath: statePath() })
    expect(clamped.scores.get(clamped.engrams[0].id)).toBe(1)
  })

  it('normalizes activation: last_accessed = today, strength = server value ?? 0.7', async () => {
    const today = new Date().toISOString().slice(0, 10)
    server.recallRows = [
      serverRow('ENG-2026-0731-022', { activation: { retrieval_strength: 0.4, last_accessed: '2020-01-01' } }),
      serverRow('ENG-2026-0731-023'),
    ]
    const res = await remoteRecall([host()], 'x', { statePath: statePath() })
    expect(res.engrams[0].activation.retrieval_strength).toBe(0.4)
    expect(res.engrams[0].activation.last_accessed).toBe(today)
    expect(res.engrams[1].activation.retrieval_strength).toBe(0.7)
    expect(res.engrams[1].activation.last_accessed).toBe(today)
  })
})

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

describe('remoteRecall — kill-switch', () => {
  it.each(['off', '0', 'false'])('PLUR_REMOTE_RECALL=%s → zero fetches', async (v) => {
    const res = await remoteRecall([host()], 'x', {
      statePath: statePath(),
      env: { PLUR_REMOTE_RECALL: v } as NodeJS.ProcessEnv,
    })
    expect(res.outcomes).toHaveLength(0)
    expect(server.recallCalls).toBe(0)
  })

  it('PLUR_REMOTE_RECALL_TIMEOUT_MS overrides the caller budget', async () => {
    await remoteRecall([host()], 'x', {
      statePath: statePath(),
      timeoutMs: 5000,
      env: { PLUR_REMOTE_RECALL_TIMEOUT_MS: '777' } as NodeJS.ProcessEnv,
    })
    expect(server.lastRecallBody!.timeout_ms).toBe(777)
  })
})

// ---------------------------------------------------------------------------
// Dialing rule (Plur._remoteRecallHosts) — strict scope relevance
// ---------------------------------------------------------------------------

describe('dialing — strict scope relevance', () => {
  function plurWith(storesYaml: string): Plur {
    const dir = tmp('plur-dial-')
    writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n${storesYaml}`)
    return new Plur({ path: dir })
  }
  const hostsOf = (plur: Plur, options?: Record<string, unknown>): RemoteRecallHost[] =>
    (plur as any)._remoteRecallHosts(options)

  it('org-affine host is dialed with shared + user:* scopes; org-mismatch host is NOT dialed', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:plur/plur-ai/engineering"\n` +
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "user:plur:gregor"\n` +
      `  - url: "https://df.example.com"\n    token: "t2"\n    scope: "group:datafund/igea"\n`,
    )
    const hosts = hostsOf(plur, { scope: 'project:plur/plur-ai/enterprise' })
    expect(hosts).toHaveLength(1)
    expect(hosts[0].url).toBe('https://plur.example.com')
    expect(hosts[0].scopes).toEqual(['group:plur/plur-ai/engineering', 'user:plur:gregor'])
  })

  it('no project/work context → zero hosts dialed (personal-only session)', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:plur/eng"\n` +
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "user:plur:gregor"\n`,
    )
    expect(hostsOf(plur)).toHaveLength(0)
    expect(hostsOf(plur, { scope: 'user:gregor' })).toHaveLength(0)
  })

  it('a host holding ONLY user:* scopes is not dialed without an org context implicating it', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "user:plur:gregor"\n`,
    )
    expect(hostsOf(plur, { scope: 'project:plur/plur-ai/enterprise' })).toHaveLength(0)
  })

  it('dial: never excludes the entry; dial: always forces its host even with no context', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:plur/eng"\n    dial: never\n` +
      `  - url: "https://always.example.com"\n    token: "t3"\n    scope: "group:acme/eng"\n    dial: always\n`,
    )
    // No context: only the dial:always host, with only the always entry.
    const noCtx = hostsOf(plur)
    expect(noCtx).toHaveLength(1)
    expect(noCtx[0].url).toBe('https://always.example.com')
    expect(noCtx[0].scopes).toEqual(['group:acme/eng'])
    // Org context for plur: the dial:never entry still never dials.
    const ctx = hostsOf(plur, { scope: 'project:plur/x' })
    expect(ctx.map(h => h.url)).toEqual(['https://always.example.com'])
  })

  it('.plur.yaml remote_project implicates its host (project config wins) and stands alone when unmounted', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:other/eng"\n`,
    )
    // Mounted host, org-mismatched scope — remote_project still implicates it
    // and dials ALL its shared scopes with the project token.
    const mounted = hostsOf(plur, {
      scope: 'project:plur/x',
      remote_project: { url: 'https://plur.example.com', token: 'proj-token' },
    })
    expect(mounted).toHaveLength(1)
    expect(mounted[0].token).toBe('proj-token')
    expect(mounted[0].scopes).toEqual(['group:other/eng'])
    // Unmounted host: dialed standalone with the project's remote_scopes.
    const standalone = hostsOf(plur, {
      remote_project: { url: 'https://solo.example.com', token: 'tk', scopes: ['group:solo/eng'] },
    })
    expect(standalone.map(h => h.url)).toContain('https://solo.example.com')
    const solo = standalone.find(h => h.url === 'https://solo.example.com')!
    expect(solo.scopes).toEqual(['group:solo/eng'])
    // Unmounted host WITHOUT remote_scopes: nothing safe to admit → not dialed.
    const noScopes = hostsOf(plur, {
      remote_project: { url: 'https://solo.example.com', token: 'tk' },
    })
    expect(noScopes.find(h => h.url === 'https://solo.example.com')).toBeUndefined()
  })

  it('groups by (url, token): two tokens on one endpoint dial twice; conflicts surface for doctor', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:plur/eng"\n` +
      `  - url: "https://plur.example.com/sse"\n    token: "t2"\n    scope: "group:plur/comms"\n`,
    )
    const hosts = hostsOf(plur, { scope: 'project:plur/x' })
    expect(hosts).toHaveLength(2)
    expect(new Set(hosts.map(h => h.token))).toEqual(new Set(['t1', 't2']))
    expect(plur.remoteEndpointTokenConflicts()).toEqual([
      { url: 'https://plur.example.com', tokens: 2 },
    ])
  })

  it('scopeOrg extracts the org segment from shared scopes only', () => {
    expect(scopeOrg('project:plur/plur-ai/enterprise')).toBe('plur')
    expect(scopeOrg('group:datafund/igea')).toBe('datafund')
    expect(scopeOrg('group:test')).toBe('test')
    expect(scopeOrg('user:plur:gregor')).toBeNull()
    expect(scopeOrg('global')).toBeNull()
    expect(scopeOrg(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// End-to-end through Plur.recall — merge + outcome tracking + kill switch
// ---------------------------------------------------------------------------

describe('Plur.recall with a live remote host', () => {
  function plurFor(scope: string): { plur: Plur; dir: string } {
    const dir = tmp('plur-rr-e2e-')
    writeFileSync(
      join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${scope}"\n`,
    )
    return { plur: new Plur({ path: dir }), dir }
  }

  it('merges server rows into recall results and records the outcome', async () => {
    server.recallRows = [serverRow('ENG-2026-0731-030', { score: 1 })]
    const { plur } = plurFor(TEAM_SCOPE)
    const results = await plur.recall('remote statement', { scope: 'project:plur/anything' })
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-0731-030')).toBe(true)
    const status = plur.remoteStoreStatus()
    expect(status).toHaveLength(1)
    expect(status[0].status).toBe('ok')
    expect(server.recallCalls).toBe(1)
  })

  it('no project context → recall makes zero remote calls', async () => {
    server.recallRows = [serverRow('ENG-2026-0731-031')]
    const { plur } = plurFor(TEAM_SCOPE)
    const results = await plur.recall('remote statement')
    expect(server.recallCalls).toBe(0)
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-0731-031')).toBe(false)
    expect(plur.remoteStoreStatus()).toHaveLength(0)
  })

  it('remote: false (internal caller contract) → zero remote calls', async () => {
    const { plur } = plurFor(TEAM_SCOPE)
    await plur.recall('remote statement', { scope: 'project:plur/anything', remote: false })
    expect(server.recallCalls).toBe(0)
  })

  it('options.scopes authorization drops server rows outside the allow-list', async () => {
    server.recallRows = [serverRow('ENG-2026-0731-032')]
    const { plur } = plurFor(TEAM_SCOPE)
    const results = await plur.recall('remote statement', {
      scope: 'project:plur/anything',
      scopes: ['project:plur/anything'], // team scope NOT in the allow-list
    })
    expect(server.recallCalls).toBe(1)
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-0731-032')).toBe(false)
  })

  it('host down → local results still served, degradation recorded', async () => {
    const dir = tmp('plur-rr-down-')
    writeFileSync(
      join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "http://127.0.0.1:1"\n    token: "t"\n    scope: "${TEAM_SCOPE}"\n`,
    )
    const plur = new Plur({ path: dir })
    await plur.learn('local fact about recall', { scope: 'project:plur/anything' })
    const results = await plur.recall('local fact about recall', { scope: 'project:plur/anything', remote_timeout_ms: 300 })
    expect(results.length).toBeGreaterThan(0)
    const status = plur.remoteStoreStatus()
    expect(status).toHaveLength(1)
    expect(['unreachable', 'timeout']).toContain(status[0].status)
  })
})

// ---------------------------------------------------------------------------
// A4′ — hook header suppression policy
// ---------------------------------------------------------------------------

describe('claimHookDegradationLines — suppression policy', () => {
  const outcome = (state: HostRecallOutcome['state'], extra: Partial<HostRecallOutcome> = {}) => ({
    host: 'https://plur.example.com',
    status: state,
    ...extra,
  })

  it('prints on first sight, suppresses the same state, prints again on state change', () => {
    const sp = statePath()
    let clock = 1_000_000_000_000
    const now = () => clock
    const first = claimHookDegradationLines([outcome('timeout')], { statePath: sp, now })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatch(/timed out/)

    clock += 60_000
    const repeat = claimHookDegradationLines([outcome('timeout')], { statePath: sp, now })
    expect(repeat).toHaveLength(0) // same (host, state), inside the window

    clock += 60_000
    const changed = claimHookDegradationLines([outcome('auth_expired')], { statePath: sp, now })
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatch(/token expired or revoked/)
    // Re-auth copy must NOT reference `plur login` (dead end on enterprise).
    expect(changed[0]).not.toMatch(/plur login/)
  })

  it('re-prints the same state after the 4h window', () => {
    const sp = statePath()
    let clock = 1_000_000_000_000
    const now = () => clock
    expect(claimHookDegradationLines([outcome('unreachable')], { statePath: sp, now })).toHaveLength(1)
    clock += HOOK_HEADER_REPEAT_MS + 1
    expect(claimHookDegradationLines([outcome('unreachable')], { statePath: sp, now })).toHaveLength(1)
  })

  it('skipped_cooldown and unsupported never print', () => {
    const sp = statePath()
    expect(claimHookDegradationLines([outcome('skipped_cooldown')], { statePath: sp })).toHaveLength(0)
    expect(claimHookDegradationLines([outcome('unsupported')], { statePath: sp })).toHaveLength(0)
  })

  it('recovery to ok resets the marker so a recurrence prints again', () => {
    const sp = statePath()
    let clock = 1_000_000_000_000
    const now = () => clock
    expect(claimHookDegradationLines([outcome('timeout')], { statePath: sp, now })).toHaveLength(1)
    clock += 1000
    expect(claimHookDegradationLines([outcome('ok')], { statePath: sp, now })).toHaveLength(0)
    clock += 1000
    expect(claimHookDegradationLines([outcome('timeout')], { statePath: sp, now })).toHaveLength(1)
  })

  it('ok with dropped_scopes prints the scope-narrowing line once', () => {
    const sp = statePath()
    let clock = 1_000_000_000_000
    const now = () => clock
    const o = outcome('ok', { dropped_scopes: ['group:plur/secret'] })
    const first = claimHookDegradationLines([o], { statePath: sp, now })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatch(/not granted to your key/)
    clock += 1000
    expect(claimHookDegradationLines([o], { statePath: sp, now })).toHaveLength(0)
  })

  it('survives a corrupt state file (fresh state, still prints)', () => {
    const sp = statePath()
    writeFileSync(sp, '{not json')
    const lines = claimHookDegradationLines([outcome('timeout')], { statePath: sp })
    expect(lines).toHaveLength(1)
    // And the rewrite produced a valid file.
    expect(() => JSON.parse(readFileSync(sp, 'utf8'))).not.toThrow()
  })
})
