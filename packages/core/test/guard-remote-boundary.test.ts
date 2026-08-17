/**
 * Remote-boundary leak guard (#353 — Stage 1.5a).
 *
 * The write-time leak guard (`_guardSensitiveScope`) sat ONLY in
 * learn()/learnRouted(). Three mutation paths reached a shared/remote store
 * without it: reportFailure (LLM-evolved statement), updateEngram(Async)
 * (caller-supplied statement), and learnAsync UPDATE/MERGE. These tests pin the
 * Q2 invariant — sensitive content never crosses the remote boundary — across
 * those paths, AND prove the guard does not over-block clean content.
 *
 * Harness mirrors remote-routing.test.ts / outbox.test.ts: a vi.fn() over
 * globalThis.fetch, asserting on POST (append) and PATCH (mutate) calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import type { LlmFunction } from '../src/types.js'

const REMOTE_SCOPE = 'group:plur/plur-ai/engineering'
const REMOTE_URL = 'https://plur.example.com/sse'
// A real (public) droplet-shaped IPv4 — the exact shape that leaked in 2026-06.
const PUBLIC_IP = '139.59.155.82'

function writeStoresConfig(dir: string, stores: Array<Record<string, unknown>>) {
  writeFileSync(
    join(dir, 'config.yaml'),
    yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }),
  )
}

function storeConfig() {
  return [{
    url: REMOTE_URL,
    token: 'plur_sk_test',
    scope: REMOTE_SCOPE,
    shared: true,
    readonly: false,
  }]
}

function readLocalEngrams(dir: string): any[] {
  const path = join(dir, 'engrams.yaml')
  if (!existsSync(path)) return []
  const data = yaml.load(readFileSync(path, 'utf-8')) as { engrams?: unknown[] } | null
  return (data?.engrams ?? []) as any[]
}

describe('remote-boundary leak guard (#353)', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-guard-remote-'))
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

  /** Empty-list mock for the load() page-walk; POST append succeeds. */
  function mockEmptyRemote() {
    fetchMock.mockImplementation((async (_url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'ENG-REMOTE-001' }), text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any)
  }

  /**
   * Mock a single procedural engram resident at the remote scope. The load()
   * page-walk returns it so getById()/list() see it; any PATCH succeeds (so a
   * test that asserts "no PATCH" is proving the GUARD skipped it, not that the
   * server refused). `data` carries the engram contents per the DB-row shape.
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
        return {
          ok: true, status: 200,
          json: async () => ({ engram: { ...row, data: { ...row.data } } }),
          text: async () => '',
        } as Response
      }
      // Single-engram GET /engrams/:id
      if (method === 'GET' && typeof url === 'string' && /\/engrams\/[^?]+$/.test(url)) {
        return { ok: true, status: 200, json: async () => row, text: async () => '' } as Response
      }
      // load() page-walk GET /engrams?scope=...
      return { ok: true, status: 200, json: async () => ({ rows: [row], total_count: 1 }), text: async () => '' } as Response
    }) as any)
  }

  /** Prime the lazy remote cache, then return the namespaced engram id list sees. */
  async function primedRemoteId(plur: Plur, serverId: string): Promise<string> {
    plur.list()                                   // triggers background load()
    await new Promise(r => setTimeout(r, 50))     // let the load() settle
    const found = plur.list().find(e => (e as any)._originalId === serverId || e.id.endsWith(serverId))
    if (!found) throw new Error(`remote engram ${serverId} not in cache after prime`)
    return found.id
  }

  // (a) Q2 invariant: a public-IP statement learned to a writable shared remote
  // must NOT reach the remote (0 appends) and must NOT sit in the outbox — it is
  // demoted to local instead.
  it('(a) learn() of a public-IP statement to a shared remote is demoted, never appended', async () => {
    mockEmptyRemote()
    writeStoresConfig(dir, storeConfig())
    const plur = new Plur({ path: dir })

    const engram = plur.learn(`deploy target is ${PUBLIC_IP}`, {
      scope: REMOTE_SCOPE,
      type: 'behavioral',
    }) as { scope: string; visibility: string }

    // Demoted at the guard.
    expect(engram.scope).toBe('local')
    expect(engram.visibility).toBe('private')

    // Give any (erroneous) fire-and-forget push time to fire.
    await new Promise(r => setTimeout(r, 50))

    // The remote append spy saw ZERO engrams, and nothing queued for retry.
    expect(postCalls().length).toBe(0)
    expect(plur.outboxCount()).toBe(0)

    // It is kept locally (demoted), not lost.
    const local = readLocalEngrams(dir)
    expect(local.find(e => e.scope === 'local' && String(e.statement).includes(PUBLIC_IP))).toBeDefined()
  })

  // (b) reportFailure on a remote-resident procedural engram whose LLM-improved
  // statement is sensitive: the remote PATCH must be skipped, result not-evolved
  // and blocked.
  it('(b) reportFailure with a sensitive improved statement does not PATCH the remote', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-001', 'Run the deploy script')
    writeStoresConfig(dir, storeConfig())
    const plur = new Plur({ path: dir })

    const id = await primedRemoteId(plur, 'ENG-2026-0601-001')

    const sensitiveLlm: LlmFunction = async () =>
      `Run the deploy script against ${PUBLIC_IP} after exporting the key`

    const result = await plur.reportFailure(id, 'deploy kept failing', sensitiveLlm)

    expect(patchCalls().length).toBe(0)        // never pushed
    expect(result.evolved).toBe(false)         // not-evolved
    expect(result.blocked).toBe(true)          // explicitly blocked
  })

  // (c) updateEngram / updateEngramAsync targeting a remote/shared engram with a
  // sensitive statement: throws, and never PATCHes.
  it('(c) updateEngramAsync with a sensitive statement on a remote engram throws, no PATCH', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-002', 'a clean procedure')
    writeStoresConfig(dir, storeConfig())
    const plur = new Plur({ path: dir })

    const id = await primedRemoteId(plur, 'ENG-2026-0601-002')
    const found = plur.list().find(e => e.id === id)!
    const sensitive = { ...found, statement: `connect to ${PUBLIC_IP}:8877 for the dashboard` } as any

    await expect(plur.updateEngramAsync(sensitive)).rejects.toThrow(/sensitive content/i)
    expect(patchCalls().length).toBe(0)
  })

  it('(c-sync) updateEngram with a sensitive statement on a remote engram throws, no PATCH', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-003', 'a clean procedure')
    writeStoresConfig(dir, storeConfig())
    const plur = new Plur({ path: dir })

    const id = await primedRemoteId(plur, 'ENG-2026-0601-003')
    const found = plur.list().find(e => e.id === id)!
    const sensitive = { ...found, statement: `the prod box is ${PUBLIC_IP}` } as any

    expect(() => plur.updateEngram(sensitive)).toThrow(/sensitive content/i)
    expect(patchCalls().length).toBe(0)
  })

  // (d) a CLEAN improved statement on the same remote path DOES reach the remote
  // — proves the guard is not over-blocking.
  it('(d) reportFailure with a CLEAN improved statement DOES PATCH the remote', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-004', 'Run the deploy script')
    writeStoresConfig(dir, storeConfig())
    const plur = new Plur({ path: dir })

    const id = await primedRemoteId(plur, 'ENG-2026-0601-004')

    const cleanLlm: LlmFunction = async () =>
      'Run the deploy script and verify the health check before declaring success'

    const result = await plur.reportFailure(id, 'deploy kept failing', cleanLlm)

    expect(patchCalls().length).toBe(1)        // pushed to remote
    expect(result.evolved).toBe(true)
    expect(result.blocked).toBeUndefined()
  })

  it('(d-update) updateEngramAsync with a CLEAN statement on a remote engram DOES PATCH', async () => {
    mockRemoteWithProcedure('ENG-2026-0601-005', 'a clean procedure')
    writeStoresConfig(dir, storeConfig())
    const plur = new Plur({ path: dir })

    const id = await primedRemoteId(plur, 'ENG-2026-0601-005')
    const found = plur.list().find(e => e.id === id)!
    const clean = { ...found, statement: 'a slightly improved but still clean procedure' } as any

    const patched = await plur.updateEngramAsync(clean)
    expect(patched).not.toBeNull()
    expect(patchCalls().length).toBe(1)
  })
})
