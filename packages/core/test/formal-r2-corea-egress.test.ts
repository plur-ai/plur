/**
 * core-index#9 (round 2, R2-CoreA): the egress guard.
 *
 * (a) The flush re-guard says it honours the target scope's CURRENT policy
 *     (R2-D #12), and an explicit-scope learn is guarded against the scope's
 *     policy — but neither re-read config.yaml, so a policy tightened out of
 *     process (another MCP server, a hand edit) was not seen by a long-running
 *     process: content the current policy forbids was pushed.
 * (c) updateEngram's remote walk ran every store's guard — and sent the PATCH —
 *     before ownership was known, so an id NAMESPACED to store B was refused by
 *     store A's policy, and its content was PATCHed to A first.
 * (b) provenance: a readonly URL store is not a write path, so it does not make
 *     a scope "remote-backed" for Decision E6.
 *
 * Model: spec/formal/PlurSpec/R2CoreA.lean §4. `globalThis.fetch` is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { storePrefix } from '../src/engrams.js'

const REMOTE_A = 'https://a.example.com/sse'
const REMOTE_B = 'https://b.example.com/sse'
const SCOPE = 'group:acme/team'
const INFRA = 'The staging box answers on 10.1.2.3:8080'

function fakeRemote(opts: { failPosts?: boolean } = {}) {
  const posts: Array<{ url: string; body: any }> = []
  const patches: Array<{ url: string; body: any }> = []
  let failPosts = opts.failPosts ?? false
  const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    const ok = (body: unknown, status = 200) =>
      ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
    if (method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      if (failPosts) throw new Error('fetch failed')
      return ok({ id: `SRV-${posts.length}` }, 201)
    }
    if (method === 'PATCH') {
      patches.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      const id = decodeURIComponent(String(url).split('/engrams/')[1] ?? '')
      if (!String(url).startsWith('https://b.')) return ok({ error: 'nf' }, 404)
      return ok({ engram: { id, scope: 'group:beta/two', status: 'active', data: { statement: init?.body ? JSON.parse(String(init.body)).statement : '', type: 'behavioral' } } })
    }
    return ok({ rows: [], total_count: 0 })
  })
  return { fetchImpl, posts, patches, setFailPosts(v: boolean) { failPosts = v } }
}

describe('core-index#9a — egress guards read the CURRENT config', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  const writeConfig = (allowInfra: boolean, bumpMs = 0) => {
    const p = join(dir, 'config.yaml')
    writeFileSync(p, yaml.dump({
      stores: [{
        url: REMOTE_A, token: 'tok', scope: SCOPE, shared: true, readonly: false,
        sensitivity: allowInfra ? { forbid: ['secrets'], allow: ['infra'] } : { forbid: ['secrets', 'infra'] },
      }],
      index: false,
    }))
    if (bumpMs) { const t = new Date(Date.now() + bumpMs); utimesSync(p, t, t) }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-egress-'))
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it('explicit-scope learn: a policy tightened out of process is applied (no POST, demoted)', async () => {
    const remote = fakeRemote()
    globalThis.fetch = remote.fetchImpl as never
    writeConfig(true)
    const plur = new Plur({ path: dir })
    await plur.learn('warm-up: the team wiki is canonical', { scope: SCOPE })
    remote.posts.length = 0
    writeConfig(false, 5_000)  // another process tightens the team policy
    const e = await plur.learn(INFRA, { scope: SCOPE })
    await new Promise(r => setTimeout(r, 50))
    expect(remote.posts.map(p => p.body.statement ?? p.body.data?.statement)).not.toContain(INFRA)
    expect(e.scope).toBe('local')
  })

  it('flushOutbox: a policy tightened out of process after queueing is applied (not pushed)', async () => {
    const remote = fakeRemote({ failPosts: true })
    globalThis.fetch = remote.fetchImpl as never
    writeConfig(true)
    const plur = new Plur({ path: dir })
    const e = await plur.learn(INFRA, { scope: SCOPE })
    await new Promise(r => setTimeout(r, 50))
    expect(((await plur.getById(e.id)) as any)?.structured_data?._outbox).toBeDefined()
    remote.setFailPosts(false)
    remote.posts.length = 0
    writeConfig(false, 5_000)
    const res = await plur.flushOutbox()
    expect(remote.posts.length).toBe(0)
    expect(res.expired_warnings.join('\n')).toMatch(/now forbidden/)
    expect((await plur.getById(e.id))?.scope).toBe('local')
  })
})

describe('core-index#9c — updateEngram guards and PATCHes only the store a namespaced id names', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-upd-'))
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const setup = (strictA: boolean) => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [
        { url: REMOTE_A, token: 'ta', scope: 'group:alpha/one', shared: true, readonly: false,
          ...(strictA ? { sensitivity: { forbid: ['secrets', 'infra'] } } : { sensitivity: { forbid: ['secrets'], allow: ['infra'] } }) },
        { url: REMOTE_B, token: 'tb', scope: 'group:beta/two', shared: true, readonly: false,
          sensitivity: { forbid: ['secrets'], allow: ['infra'] } },
      ],
      index: false,
    }))
    expect(storePrefix('group:alpha/one')).not.toBe(storePrefix('group:beta/two'))
    const remote = fakeRemote()
    globalThis.fetch = remote.fetchImpl as never
    const plur = new Plur({ path: dir })
    const id = `ENG-${storePrefix('group:beta/two')}-2026-09-26-001`
    const engram = { id, statement: INFRA, type: 'behavioral', scope: 'group:beta/two', status: 'active' } as any
    return { plur, remote, engram }
  }

  it('store A\'s stricter policy does not refuse an update of store B\'s engram', async () => {
    const { plur, engram } = setup(true)
    await expect(plur.updateEngram(engram)).resolves.toBe(true)
  })

  it('store A never receives the PATCH for store B\'s namespaced engram', async () => {
    const { plur, remote, engram } = setup(false)
    await plur.updateEngram(engram)
    expect(remote.patches.map(p => new URL(p.url).host)).toEqual(['b.example.com'])
  })
})

describe('core-index#9b — provenance: a readonly URL store does not make a scope remote-backed', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-ro-'))
    originalFetch = globalThis.fetch
    globalThis.fetch = fakeRemote().fetchImpl as never
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it('a local row in a readonly-remote personal scope is withheld unless public', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE_A, token: 'tok', scope: 'user:alice', readonly: true }],
      index: false,
    }))
    const seedPlur = new Plur({ path: join(dir, 'seed') })
    const seeded = await seedPlur.learn('Alice prefers tabs', { scope: 'global', visibility: 'template' } as any)
    const row = { ...(await seedPlur.getById(seeded.id)), scope: 'user:alice', visibility: 'template' }
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams: [row] }))
    const plur = new Plur({ path: dir })
    const rec: any = await plur.provenanceFor(seeded.id)
    const subj = rec['@graph'].find((n: any) => String(n['@id']).startsWith('engram:ENG'))
    expect(subj['engram:maySharePlainly']).toBe(false)
  })
})
