/**
 * ADVERSARIAL LEAK-GUARD FUZZER — every write/update egress path (#353 round-3).
 *
 * THREAT MODEL: sensitive content (public IPv4/IPv6, host:port, basic-auth URLs,
 * internal hosts, credentials) must NEVER reach a SHARED scope
 * (group:/project:/space:/team:/org:/public) or a REMOTE-BACKED scope (a `user:`
 * scope with a remote store entry) without being demoted to scope:local /
 * visibility:private. `global` and `local` are personal and exempt.
 *
 * This file drives EVERY public write/update path that can reach a shared or
 * remote-backed store, with adversarial sensitive payloads, against a Plur
 * instance configured with:
 *   - a SHARED LOCAL-FILE store (scope `project:plur`, path on disk) — exercises
 *     the isSharedScope arm of the guard without a network, and
 *   - a REMOTE-BACKED store (scope `user:plur:gregor`, a `url` → off-machine) with
 *     a vi.fn() over globalThis.fetch as the append/PATCH SPY.
 *
 * For each path we assert BOTH halves of the invariant:
 *   1. the persisted engram is demoted (scope==='local', visibility==='private'),
 *      OR (for the explicit-remote-update path) the call THROWS; and
 *   2. the remote append/PATCH spy received ZERO calls (nothing crossed the
 *      machine boundary) and nothing sits in the outbox awaiting a retry push.
 *
 * Paths covered: learn, learnRouted, reportFailure, updateEngram,
 * updateEngramAsync, saveMetaEngrams, learnAsync UPDATE, learnAsync MERGE, and
 * flushOutbox (re-guard of a stale/poisoned queue entry).
 *
 * Harness mirrors guard-remote-boundary.test.ts / guard-remote-scope.test.ts /
 * outbox.test.ts: a vi.fn() over globalThis.fetch, asserting on POST (append) and
 * PATCH (mutate). A CLEAN counterpart on each path proves the guard does not
 * over-block (else "demote everything" would pass vacuously).
 *
 * DURABLE: keep this file. A FAILURE here is a real leak finding, not a flaky
 * test — do NOT weaken the assertions to make it green.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../../src/index.js'
import { detectSensitive, sensitivityCategory } from '../../src/secrets.js'
import type { LlmFunction, LearnContext } from '../../src/types.js'

// ---- adversarial constants -------------------------------------------------

// A real (public) droplet-shaped IPv4 — the exact shape that leaked in 2026-06.
const PUBLIC_IP = '139.59.155.82'
// Basic-auth URL with an internal staging host. Trips basic_auth_url (secrets)
// AND internal_host (infra) — and notably is NOT caught by detectSecrets (the
// HARD throw), so it must be stopped by the SOFT demotion path on every egress.
const BASIC_AUTH_URL = 'https://t:p@hub-staging.plur.ai'

// The adversarial payload corpus — each must trip detectSensitive.
const SENSITIVE_CORPUS = [
  `deploy target is ${PUBLIC_IP}`,
  `login at ${BASIC_AUTH_URL}`,
  `the prod box is ${PUBLIC_IP}:8877`,
  `ssh into db.internal.corp then run the migration`,
  `the staging api is api.staging.example.com`,
] as const

// Clean control corpus — must NOT trip detectSensitive, must NOT be demoted.
const CLEAN_CORPUS = [
  'I prefer concise commit messages',
  'always run the test suite before shipping',
  'the team retro is on Fridays',
] as const

// SHARED local-file store: isSharedScope by prefix, but a LOCAL file (no url) —
// exercises the isSharedScope guard arm with no network involved.
const SHARED_SCOPE = 'project:plur'
// REMOTE-backed personal scope: NOT isSharedScope, but routes off-machine.
const REMOTE_SCOPE = 'user:plur:gregor'
const REMOTE_URL = 'https://plur.example.com/sse'

// ---- harness ---------------------------------------------------------------

function writeStoresConfig(dir: string, stores: Array<Record<string, unknown>>) {
  writeFileSync(
    join(dir, 'config.yaml'),
    yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }),
  )
}

/** Both stores: a shared local-file store AND a remote-backed user: store. */
function bothStores(dir: string) {
  return [
    { path: join(dir, 'team-store.yaml'), scope: SHARED_SCOPE, readonly: false },
    { url: REMOTE_URL, token: 'plur_sk_test', scope: REMOTE_SCOPE, readonly: false },
  ]
}

function readLocalEngrams(dir: string): any[] {
  const path = join(dir, 'engrams.yaml')
  if (!existsSync(path)) return []
  const data = yaml.load(readFileSync(path, 'utf-8')) as { engrams?: unknown[] } | null
  return (data?.engrams ?? []) as any[]
}

function writeLocalEngrams(dir: string, engrams: any[]) {
  writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams }, { lineWidth: 120, noRefs: true }))
}

function readSharedStore(dir: string): any[] {
  const path = join(dir, 'team-store.yaml')
  if (!existsSync(path)) return []
  const data = yaml.load(readFileSync(path, 'utf-8')) as { engrams?: unknown[] } | null
  return (data?.engrams ?? []) as any[]
}

describe('adversarial leak-guard fuzzer (#353 round-3)', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-guard-fuzz-'))
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  function postCalls() {
    return fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'POST')
  }
  function patchCalls() {
    return fetchMock.mock.calls.filter(([, init]) => (init as any)?.method === 'PATCH')
  }
  /** Any call that mutates the remote (append OR patch). */
  function egressCalls() {
    return fetchMock.mock.calls.filter(
      ([, init]) => (init as any)?.method === 'POST' || (init as any)?.method === 'PATCH',
    )
  }

  /** Empty-list mock for the load() page-walk; POST append + PATCH succeed. */
  function mockEmptyRemote() {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'ENG-REMOTE-001' }), text: async () => '' } as Response
      }
      if (method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ engram: {} }), text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)
  }

  /**
   * Mock a single engram resident at the remote scope, so getById/list see it and
   * any PATCH succeeds — so a "no PATCH" assertion proves the GUARD skipped it,
   * not that the server refused.
   */
  function mockRemoteWithProcedure(serverId: string, statement: string) {
    const row = {
      id: serverId,
      scope: REMOTE_SCOPE,
      status: 'active',
      data: { statement, type: 'procedural', scope: REMOTE_SCOPE, status: 'active', id: serverId },
    }
    fetchMock.mockImplementation((async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ engram: { ...row, data: { ...row.data } } }), text: async () => '' } as Response
      }
      if (method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: serverId }), text: async () => '' } as Response
      }
      if (method === 'GET' && typeof url === 'string' && /\/engrams\/[^?]+$/.test(url)) {
        return { ok: true, status: 200, json: async () => row, text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [row], total_count: 1 }), text: async () => '' } as Response
    }) as any)
  }

  async function primedRemoteId(plur: Plur, serverId: string): Promise<string> {
    plur.list()
    await new Promise(r => setTimeout(r, 50))
    const found = plur.list().find(e => (e as any)._originalId === serverId || e.id.endsWith(serverId))
    if (!found) throw new Error(`remote engram ${serverId} not in cache after prime`)
    return found.id
  }

  // ==========================================================================
  // CORPUS SANITY — every adversarial payload must actually be detected, and
  // every clean control must NOT be. If this drifts, the rest is vacuous.
  // ==========================================================================
  it('corpus sanity: sensitive payloads trip detectSensitive; clean ones do not', () => {
    for (const s of SENSITIVE_CORPUS) {
      const hits = detectSensitive(s)
      expect(hits.length, `sensitive payload should be detected: ${s}`).toBeGreaterThan(0)
    }
    for (const s of CLEAN_CORPUS) {
      expect(detectSensitive(s), `clean payload must not trip: ${s}`).toEqual([])
    }
    // The basic-auth URL specifically belongs to the 'secrets' family AND carries
    // an 'infra' internal_host — both families must be present so a custom
    // forbid:['secrets'] OR forbid:['infra'] policy each catch it.
    const cats = new Set(detectSensitive(BASIC_AUTH_URL).map(h => sensitivityCategory(h.pattern)))
    expect(cats.has('secrets')).toBe(true)
    expect(cats.has('infra')).toBe(true)
  })

  // ==========================================================================
  // PATH 1 — learn() to the SHARED local-file scope and the REMOTE scope.
  // ==========================================================================
  it('learn() to a shared local-file scope demotes every sensitive payload, never written shared', () => {
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })

    for (const payload of SENSITIVE_CORPUS) {
      const e = plur.learn(payload, { scope: SHARED_SCOPE, type: 'behavioral' }) as any
      expect(e.scope, `learn(shared) should demote: ${payload}`).toBe('local')
      expect(e.visibility).toBe('private')
    }
    // Nothing landed in the shared store; only demoted-local engrams in primary.
    expect(readSharedStore(dir).length).toBe(0)
    const local = readLocalEngrams(dir)
    expect(local.length).toBe(SENSITIVE_CORPUS.length)
    expect(local.every(e => e.scope === 'local')).toBe(true)
  })

  it('learn() to a remote-backed scope demotes every sensitive payload, ZERO appends, empty outbox', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })

    for (const payload of SENSITIVE_CORPUS) {
      const e = plur.learn(payload, { scope: REMOTE_SCOPE, type: 'behavioral' }) as any
      expect(e.scope, `learn(remote) should demote: ${payload}`).toBe('local')
      expect(e.visibility).toBe('private')
    }
    await new Promise(r => setTimeout(r, 80)) // let any erroneous fire-and-forget settle
    expect(postCalls().length, 'remote append spy must be ZERO').toBe(0)
    expect(plur.outboxCount(), 'nothing queued for retry push').toBe(0)
  })

  it('learn() does NOT over-block clean content to the remote scope', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const e = plur.learn(CLEAN_CORPUS[0], { scope: REMOTE_SCOPE, type: 'preference' }) as any
    expect(e.scope).toBe(REMOTE_SCOPE) // honored, not demoted
    await new Promise(r => setTimeout(r, 80))
    expect(postCalls().length, 'a clean engram SHOULD reach the remote').toBe(1)
  })

  // COMPOSITE (both round-2 fixes together): an UNSCOPED write that auto-routes
  // (forward domain match) into a SHARED scope must then be demoted by the
  // sensitivity guard — the guard runs AFTER _resolveUnscopedScope. Proves the
  // auto-route fix did not open a back-door around the leak guard.
  it('auto-route into a shared scope is still demoted when the content is sensitive', () => {
    writeStoresConfig(dir, [
      { path: join(dir, 'team-store.yaml'), scope: SHARED_SCOPE, readonly: false, covers: ['plur'] },
      { url: REMOTE_URL, token: 'plur_sk_test', scope: REMOTE_SCOPE, readonly: false },
    ])
    const plur = new Plur({ path: dir })
    // No explicit scope; domain forward-matches `covers:['plur']` → auto-route to
    // project:plur, then the public IP must force a demotion.
    const e = plur.learn(`deploy box is ${PUBLIC_IP}`, { domain: 'plur.infra', type: 'behavioral' }) as any
    expect(e.scope, 'auto-routed shared scope must still demote').toBe('local')
    expect(e.visibility).toBe('private')
    expect(e.structured_data?._routed?.scope).toBe(SHARED_SCOPE) // it DID auto-route
    expect(e.structured_data?._demoted?.from).toBe(SHARED_SCOPE) // and was then demoted
    expect(readSharedStore(dir).length).toBe(0)
  })

  // ==========================================================================
  // PATH 2 — learnRouted() (the remote-routing entry point).
  // ==========================================================================
  it('learnRouted() to a remote-backed scope demotes every sensitive payload, ZERO appends, empty outbox', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })

    for (const payload of SENSITIVE_CORPUS) {
      const e = (await plur.learnRouted(payload, { scope: REMOTE_SCOPE, type: 'behavioral' })) as any
      expect(e.scope, `learnRouted(remote) should demote: ${payload}`).toBe('local')
      expect(e.visibility).toBe('private')
    }
    await new Promise(r => setTimeout(r, 80))
    expect(postCalls().length, 'remote append spy must be ZERO').toBe(0)
    expect(plur.outboxCount(), 'nothing queued for retry push').toBe(0)
  })

  it('learnRouted() to a shared local-file scope demotes sensitive payloads', async () => {
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    for (const payload of SENSITIVE_CORPUS) {
      const e = (await plur.learnRouted(payload, { scope: SHARED_SCOPE, type: 'behavioral' })) as any
      expect(e.scope).toBe('local')
      expect(e.visibility).toBe('private')
    }
    expect(readSharedStore(dir).length).toBe(0)
  })

  it('learnRouted() does NOT over-block clean content (it reaches the remote)', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const e = (await plur.learnRouted(CLEAN_CORPUS[1], { scope: REMOTE_SCOPE, type: 'behavioral' })) as any
    expect(e.scope).toBe(REMOTE_SCOPE)
    await new Promise(r => setTimeout(r, 80))
    expect(postCalls().length).toBe(1)
  })

  // Sensitive material hiding in a CONTEXT FIELD (not the statement) must also be
  // caught — _guardSensitiveScope scans statement + JSON.stringify(context).
  it('learnRouted() catches sensitive content hidden in a context field', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const ctx: LearnContext = {
      scope: REMOTE_SCOPE,
      type: 'behavioral',
      rationale: `because the box at ${PUBLIC_IP} keeps the index`,
    }
    const e = (await plur.learnRouted('a benign-looking statement', ctx)) as any
    expect(e.scope, 'sensitive rationale must demote').toBe('local')
    await new Promise(r => setTimeout(r, 80))
    expect(postCalls().length).toBe(0)
    expect(plur.outboxCount()).toBe(0)
  })

  // ==========================================================================
  // PATH 3 — reportFailure() on a REMOTE-resident procedural engram whose
  // LLM-improved statement is sensitive: remote PATCH skipped, blocked outcome.
  // ==========================================================================
  it('reportFailure() with a sensitive improved statement never PATCHes the remote', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-101', 'Run the deploy script')
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const id = await primedRemoteId(plur, 'ENG-2026-0601-101')

    const sensitiveLlm: LlmFunction = async () => `Run the deploy against ${PUBLIC_IP} after exporting the key`
    const result = await plur.reportFailure(id, 'deploy kept failing', sensitiveLlm)

    expect(patchCalls().length, 'remote PATCH must be ZERO').toBe(0)
    expect(result.evolved).toBe(false)
    expect(result.blocked).toBe(true)
  })

  it('reportFailure() with a CLEAN improved statement DOES PATCH the remote (no over-block)', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-102', 'Run the deploy script')
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const id = await primedRemoteId(plur, 'ENG-2026-0601-102')

    const cleanLlm: LlmFunction = async () => 'Run the deploy script and verify the health check before declaring success'
    const result = await plur.reportFailure(id, 'deploy kept failing', cleanLlm)

    expect(patchCalls().length).toBe(1)
    expect(result.evolved).toBe(true)
    expect(result.blocked).toBeUndefined()
  })

  // ==========================================================================
  // PATH 4 — updateEngram / updateEngramAsync on a REMOTE-resident engram:
  // a sensitive statement THROWS and never PATCHes.
  // ==========================================================================
  it('updateEngramAsync() with a sensitive statement on a remote engram throws, ZERO PATCH', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-103', 'a clean procedure')
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const id = await primedRemoteId(plur, 'ENG-2026-0601-103')
    const found = plur.list().find(e => e.id === id)!

    for (const payload of [`connect to ${PUBLIC_IP}:8877`, `login ${BASIC_AUTH_URL}`]) {
      const sensitive = { ...found, statement: payload } as any
      await expect(plur.updateEngramAsync(sensitive)).rejects.toThrow(/sensitive content/i)
    }
    expect(patchCalls().length, 'remote PATCH must be ZERO').toBe(0)
  })

  it('updateEngram() (sync) with a sensitive statement on a remote engram throws, ZERO PATCH', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-104', 'a clean procedure')
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const id = await primedRemoteId(plur, 'ENG-2026-0601-104')
    const found = plur.list().find(e => e.id === id)!
    const sensitive = { ...found, statement: `the prod box is ${PUBLIC_IP}` } as any

    expect(() => plur.updateEngram(sensitive)).toThrow(/sensitive content/i)
    expect(patchCalls().length).toBe(0)
  })

  // Sensitive content in a CONTEXT FIELD of an explicit remote update must also
  // throw — _guardExplicitUpdate scans context fields, not just the statement.
  it('updateEngramAsync() throws on sensitive content hidden in a context field', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-105', 'a clean procedure')
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const id = await primedRemoteId(plur, 'ENG-2026-0601-105')
    const found = plur.list().find(e => e.id === id)!
    const sensitive = { ...found, statement: 'still clean here', rationale: `because ${PUBLIC_IP} is the box` } as any

    await expect(plur.updateEngramAsync(sensitive)).rejects.toThrow(/sensitive content/i)
    expect(patchCalls().length).toBe(0)
  })

  it('updateEngramAsync() with a CLEAN statement on a remote engram DOES PATCH (no over-block)', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-106', 'a clean procedure')
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const id = await primedRemoteId(plur, 'ENG-2026-0601-106')
    const found = plur.list().find(e => e.id === id)!
    const clean = { ...found, statement: 'a slightly improved but still clean procedure' } as any

    const patched = await plur.updateEngramAsync(clean)
    expect(patched).not.toBeNull()
    expect(patchCalls().length).toBe(1)
  })

  // A LOCAL-resident engram update with sensitive content DEMOTES in place (does
  // not throw) and never reaches any shared store.
  it('updateEngram() on a LOCAL engram demotes a sensitive statement in place', () => {
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    // Create a clean engram at the shared scope; it demotes-on-create, so seed a
    // genuinely shared-scope LOCAL engram by writing directly, then update it.
    const seeded = plur.learn('a clean team note', { scope: SHARED_SCOPE, type: 'behavioral' }) as any
    // It was clean → it should have landed at the shared scope (in the shared file).
    // Re-fetch its canonical id from whichever store holds it.
    const all = plur.list()
    const target = all.find(e => e.statement === 'a clean team note')!
    const sensitive = { ...target, statement: `now mentions ${PUBLIC_IP}`, scope: SHARED_SCOPE } as any
    const ok = plur.updateEngram(sensitive)
    expect(ok).toBe(true)
    const updated = plur.list().find(e => String(e.statement).includes(PUBLIC_IP))!
    expect(updated.scope, 'local-resident sensitive update must demote').toBe('local')
    expect((updated as any).visibility).toBe('private')
    expect(readSharedStore(dir).find(e => String(e.statement).includes(PUBLIC_IP))).toBeUndefined()
  })

  // ==========================================================================
  // PATH 5 — saveMetaEngrams(): the historically-unguarded persist path.
  // ==========================================================================
  it('saveMetaEngrams() demotes a shared-scope meta carrying infra-sensitive content', () => {
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })

    const metas = SENSITIVE_CORPUS
      // basic-auth URL would be caught by the HARD detectSecrets? No — it is NOT
      // (verified in corpus sanity), so it goes through the SOFT demotion path
      // like the rest. The IPv4:port and IP forms are also SOFT (infra).
      .map((statement, i) => ({
        id: `META-FUZZ-${i}`,
        scope: SHARED_SCOPE,
        statement,
        type: 'behavioral',
        status: 'active',
        knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
      })) as any[]

    const res = plur.saveMetaEngrams(metas)
    expect(res.saved).toBe(metas.length)

    const local = readLocalEngrams(dir)
    for (const m of metas) {
      const persisted = local.find(e => e.id === m.id)
      expect(persisted, `meta ${m.id} persisted`).toBeDefined()
      expect(persisted.scope, `meta ${m.id} demoted`).toBe('local')
      expect(persisted.visibility).toBe('private')
      expect(persisted.structured_data?._demoted?.to).toBe('local')
    }
    // None written at the shared scope.
    expect(local.some(e => e.scope === SHARED_SCOPE)).toBe(false)
    expect(readSharedStore(dir).length).toBe(0)
  })

  it('saveMetaEngrams() does NOT demote a clean shared-scope meta', () => {
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    const metas = [{
      id: 'META-FUZZ-CLEAN',
      scope: SHARED_SCOPE,
      statement: CLEAN_CORPUS[2],
      type: 'behavioral',
      status: 'active',
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
    }] as any[]
    plur.saveMetaEngrams(metas)
    const persisted = readLocalEngrams(dir).find(e => e.id === 'META-FUZZ-CLEAN')
    expect(persisted.scope, 'clean meta keeps its scope').toBe(SHARED_SCOPE)
  })

  // ==========================================================================
  // PATH 6 — learnAsync UPDATE: a clean engram is mutated to sensitive via the
  // dedup UPDATE branch; it must demote, and never push to remote.
  // ==========================================================================
  it('learnAsync UPDATE: mutating a clean shared engram to sensitive demotes it, ZERO remote egress', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })

    // Seed a clean engram at the shared LOCAL-FILE scope (no demotion on create).
    plur.learn('the deployment runbook lives in the team wiki', { scope: SHARED_SCOPE, type: 'behavioral' })
    const seededId = plur.list().find(e => e.statement.includes('deployment runbook'))!.id

    // Force the dedup UPDATE decision: an LLM that always says UPDATE this target.
    // parseDedupResponse expects `DECISION:`/`TARGET:` lines (NOT JSON).
    const updateLlm: LlmFunction = async () => `DECISION: UPDATE\nTARGET: ${seededId}\nREASON: same runbook`
    const res = await plur.learnAsync(`the deployment runbook now references ${PUBLIC_IP}`, {
      scope: SHARED_SCOPE,
      llm: updateLlm,
    })

    // The mutation must have been a real UPDATE (not an ADD) and demoted.
    expect(res.decision).toBe('UPDATE')
    expect(res.engram.scope, 'learnAsync UPDATE must demote').toBe('local')
    expect((res.engram as any).visibility).toBe('private')
    expect((res.engram as any).structured_data?._demoted?.to).toBe('local')

    await new Promise(r => setTimeout(r, 80))
    expect(egressCalls().length, 'no append/PATCH to remote').toBe(0)
    expect(readSharedStore(dir).find(e => String(e.statement).includes(PUBLIC_IP))).toBeUndefined()
  })

  // ==========================================================================
  // PATH 7 — learnAsync MERGE: concatenation introduces sensitive content.
  // ==========================================================================
  it('learnAsync MERGE: concatenating sensitive content into a clean shared engram demotes it', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })

    plur.learn('the deployment notes summary for the release', { scope: SHARED_SCOPE, type: 'behavioral' })
    const seededId = plur.list().find(e => e.statement.includes('deployment notes'))!.id

    const mergeLlm: LlmFunction = async () => `DECISION: MERGE\nTARGET: ${seededId}\nREASON: complementary deployment notes`
    const res = await plur.learnAsync(`the deployment target host is ${BASIC_AUTH_URL}`, {
      scope: SHARED_SCOPE,
      llm: mergeLlm,
    })

    expect(res.decision).toBe('MERGE')
    expect(res.engram.scope, 'learnAsync MERGE must demote').toBe('local')
    expect((res.engram as any).visibility).toBe('private')

    await new Promise(r => setTimeout(r, 80))
    expect(egressCalls().length).toBe(0)
    expect(readSharedStore(dir).find(e => String(e.statement).includes('hub-staging'))).toBeUndefined()
  })

  it('learnAsync UPDATE: a CLEAN mutation does NOT demote (no over-block)', async () => {
    writeStoresConfig(dir, bothStores(dir))
    const plur = new Plur({ path: dir })
    plur.learn('original clean note about the deployment wiki', { scope: SHARED_SCOPE, type: 'behavioral' })
    const seededId = plur.list().find(e => e.statement.includes('original clean note'))!.id
    const updateLlm: LlmFunction = async () => `DECISION: UPDATE\nTARGET: ${seededId}\nREASON: same note`
    const res = await plur.learnAsync('a still-clean revised note about the deployment wiki', {
      scope: SHARED_SCOPE,
      llm: updateLlm,
    })
    expect(res.decision).toBe('UPDATE')
    expect(res.engram.scope, 'clean UPDATE keeps the shared scope').toBe(SHARED_SCOPE)
  })

  // ==========================================================================
  // PATH 8 — flushOutbox(): a STALE / POISONED queue entry carrying sensitive
  // content (it bypassed the write-time guard, e.g. injected directly or queued
  // before a policy tightened) must be RE-GUARDED at flush time and never pushed.
  // ==========================================================================
  it('flushOutbox() re-guards a poisoned _outbox entry: ZERO append, demoted in place', async () => {
    mockEmptyRemote() // remote is UP — the re-guard must hold it back anyway
    writeStoresConfig(dir, bothStores(dir))

    // Inject an _outbox engram directly into the local store, carrying sensitive
    // content targeting the REMOTE scope under the DEFAULT (forbid-all) policy.
    // This simulates a stale/poisoned queue entry that never saw the write guard.
    const poisoned = {
      id: 'ENG-FUZZ-OUTBOX-1',
      version: 2,
      status: 'active',
      type: 'behavioral',
      scope: REMOTE_SCOPE,
      visibility: 'public',
      statement: `the prod jump box is ${PUBLIC_IP} reachable at ${BASIC_AUTH_URL}`,
      activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-06-01' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
      tags: [],
      content_hash: 'deadbeef',
      structured_data: {
        _outbox: {
          target_url: REMOTE_URL,
          target_scope: REMOTE_SCOPE,
          queued_at: new Date().toISOString(),
          last_attempt: new Date().toISOString(),
          attempt_count: 0,
          last_error: '',
        },
      },
    }
    writeLocalEngrams(dir, [poisoned])

    const plur = new Plur({ path: dir })
    expect(plur.outboxCount()).toBe(1)

    const result = await plur.flushOutbox()

    // NOT flushed, counted as failed, never POSTed.
    expect(result.flushed).toBe(0)
    expect(result.failed).toBe(1)
    expect(postCalls().length, 'poisoned outbox entry must NEVER be appended').toBe(0)
    expect(result.expired_warnings.some(w => /demoted to local\/private|now forbidden/.test(w))).toBe(true)

    // Demoted in place: scope→local, _outbox dropped, _demoted stamped.
    const found = readLocalEngrams(dir).find(e => e.id === 'ENG-FUZZ-OUTBOX-1')
    expect(found.scope).toBe('local')
    expect(found.visibility).toBe('private')
    expect(found.structured_data?._outbox).toBeUndefined()
    expect(found.structured_data?._demoted?.to).toBe('local')
  })

  it('flushOutbox() still pushes a CLEAN queued entry (no over-block)', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, bothStores(dir))
    const clean = {
      id: 'ENG-FUZZ-OUTBOX-2',
      version: 2,
      status: 'active',
      type: 'behavioral',
      scope: REMOTE_SCOPE,
      visibility: 'public',
      statement: 'a perfectly clean personal note',
      activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-06-01' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
      tags: [],
      content_hash: 'cafef00d',
      structured_data: {
        _outbox: {
          target_url: REMOTE_URL,
          target_scope: REMOTE_SCOPE,
          queued_at: new Date().toISOString(),
          last_attempt: new Date().toISOString(),
          attempt_count: 0,
          last_error: '',
        },
      },
    }
    writeLocalEngrams(dir, [clean])
    const plur = new Plur({ path: dir })
    const result = await plur.flushOutbox()
    expect(result.flushed).toBe(1)
    expect(postCalls().length, 'a clean queued entry SHOULD be appended').toBe(1)
  })
})
