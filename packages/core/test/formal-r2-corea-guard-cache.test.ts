/**
 * core-index#7 (round 2, R2-CoreA): the forget/feedback ambiguity guard (#831,
 * #850) must not take a PARTIAL or STALE remote cache as proof that an id is
 * absent remotely.
 *
 * RemoteStore.append() on a cold cache seeds `{ ts: 0, engrams: [stored] }` —
 * explicitly marked stale, "one engram is not all engrams in this scope". The
 * guard read any non-empty cache as authoritative, so after one push the local
 * engram was retired (or rated) although the same id lived remotely.
 *
 * Model: spec/formal/PlurSpec/R2CoreA.lean §2. `globalThis.fetch` is mocked;
 * nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const SCOPE = 'group:acme/team'

function fakeRemote(remoteIds: Set<string>) {
  const probes: string[] = []
  const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET'
    const u = String(url)
    const ok = (body: unknown, status = 200) =>
      ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
    if (method === 'POST') return ok({ id: 'SRV-1' }, 201)
    const m = u.match(/\/engrams\/([^/?]+)$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      probes.push(id)
      if (!remoteIds.has(id)) return ok({ error: 'not found' }, 404)
      return ok({ id, scope: SCOPE, status: 'active', data: { statement: 'remote twin', type: 'behavioral' } })
    }
    return ok({ rows: [], total_count: 0 })
  })
  return { fetchImpl, probes }
}

describe('core-index#7 — a partial or stale remote cache is not proof of absence', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-guard-'))
    originalFetch = globalThis.fetch
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  async function setup(cache: 'append' | 'stale' | 'fresh') {
    const plur = new Plur({ path: dir })
    const local = await plur.learn('A local memory about tabs', { scope: 'global' })
    const remote = fakeRemote(new Set([local.id]))
    globalThis.fetch = remote.fetchImpl as never
    const driver = (plur as any)._getRemoteDriver({ url: REMOTE, token: 'tok', scope: SCOPE })
    if (cache === 'append') {
      // The real cold-cache append path: seeds a ts:0 partial view.
      await driver.append({ id: 'ENG-LOCAL-DRAFT', statement: 'pushed', type: 'behavioral', scope: SCOPE } as any)
      expect(driver.cache.ts).toBe(0)
    } else {
      const age = cache === 'stale' ? 10 * 60_000 : 0
      driver.cache = { ts: Date.now() - age, engrams: [{ id: 'SRV-OTHER', statement: 'x', type: 'behavioral', scope: SCOPE }] }
    }
    remote.probes.length = 0
    return { plur, local, remote }
  }

  it('forget: after a cold-cache push, an id that also lives remotely is refused as ambiguous', async () => {
    const { plur, local } = await setup('append')
    await expect(plur.forget(local.id)).rejects.toThrow(/Ambiguous engram ID/)
    expect((await plur.getById(local.id))?.status).toBe('active')
  })

  it('forget: a stale (past its TTL) cache is re-checked live', async () => {
    const { plur, local, remote } = await setup('stale')
    await expect(plur.forget(local.id)).rejects.toThrow(/Ambiguous engram ID/)
    expect(remote.probes).toContain(local.id)
  })

  it('feedback: after a cold-cache push, an id that also lives remotely is refused as ambiguous', async () => {
    const { plur, local } = await setup('append')
    await expect(plur.feedback(local.id, 'positive')).rejects.toThrow(/Ambiguous engram ID/)
  })

  it('good case: a fresh complete cache still answers without a probe', async () => {
    const { plur, local, remote } = await setup('fresh')
    await plur.forget(local.id)
    expect(remote.probes).not.toContain(local.id)
    expect((await plur.getById(local.id))?.status).toBe('retired')
  })
})
