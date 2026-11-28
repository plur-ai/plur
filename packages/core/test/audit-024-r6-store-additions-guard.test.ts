/**
 * 0.24 review round 6: under `pinning.agents: request` or `deny`, only the
 * owner adds a store source (a server address or a local store file) or a
 * new scope on one, whatever method does it. The two writers of config.yaml's
 * stores list apply this one rule under the config lock; a refused write
 * leaves config.yaml byte-identical. A server's own scope refresh may add
 * scopes to an entry already listed (#1940) and never a new source.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'r6-guard-token'
const ME = 'user:x:alice'
const TEAM = 'group:x/team'
const OTHER = 'group:x/other'
let server: StubServer
let url: string

beforeAll(async () => { server = new StubServer(TOKEN); url = (await server.start()).url })
afterAll(async () => { await server.stop() })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }

function setup(agents: 'allow' | 'request' | 'deny', stores: unknown[] = []): string {
  const dir = tmp('plur-r6-guard-')
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ embeddings: { enabled: false }, index: false, pinning: { agents }, ...(stores.length ? { stores } : {}) }, { lineWidth: 120, noRefs: true }))
  return dir
}
const cfg = (dir: string) => readFileSync(join(dir, 'config.yaml'), 'utf8')
const as = (dir: string, actor: 'owner' | 'agent') => new Plur({ path: dir, autoDiscover: false, actor })
function localStoreFile(): string {
  const d = tmp('plur-r6-src-')
  writeFileSync(join(d, 'engrams.yaml'), 'engrams: []\n')
  return join(d, 'engrams.yaml')
}

describe('round 6: the round-6 repro — a second server for an already-served personal scope', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: an agent cannot add a new server address even when its scopes are already served`, async () => {
      const dir = setup(agents)
      await as(dir, 'owner').registerEnterpriseServer('https://a.example.test', { token: 'a', personalScope: ME })
      const before = cfg(dir)
      await expect(as(dir, 'agent').registerEnterpriseServer('https://evil.example.test', { token: 'e', personalScope: ME }))
        .rejects.toMatchObject({ code: 'pin_denied' })
      expect(cfg(dir)).toBe(before)
    })
  }
})

type Adder = { name: string; seed: () => unknown[]; run: (p: Plur) => Promise<unknown> }
const adders: Adder[] = [
  { name: 'addStore (local path)', seed: () => [], run: async p => p.addStore(localStoreFile(), 'project:demo') },
  { name: 'addStore (url)', seed: () => [], run: async p => p.addStore('', TEAM, { url: 'https://new.example.test', token: 't' }) },
  { name: 'addStore (new scope on a known url)', seed: () => [{ url: 'https://known.example.test', token: 't', scope: TEAM }], run: async p => p.addStore('', OTHER, { url: 'https://known.example.test', token: 't' }) },
  { name: 'addRemoteStore', seed: () => [], run: async p => p.addRemoteStore({ url, token: TOKEN, scope: TEAM }) },
  { name: 'registerEnterpriseServer (new server)', seed: () => [], run: async p => p.registerEnterpriseServer('https://srv.example.test', { token: 'k', personalScope: ME }) },
  { name: 'registerDiscoveredScopes', seed: () => [{ url, token: TOKEN, scope: TEAM }], run: async p => p.registerDiscoveredScopes() },
  { name: 'registerScope', seed: () => [{ url, token: TOKEN, scope: TEAM }], run: async p => p.registerScope(OTHER) },
  // Round 7: folding the owner's per-scope entry into a server entry (which a
  // later scope refresh would grow).
  { name: 'registerEnterpriseServer (fold a per-scope entry)', seed: () => [{ url: 'https://fold.example.test', token: 't', scope: ME }], run: async p => p.registerEnterpriseServer('https://fold.example.test', { token: 't', personalScope: ME }) },
]

describe('round 6: every method that can add a store follows the one rule', () => {
  for (const a of adders) {
    for (const agents of ['request', 'deny'] as const) {
      it(`${a.name}, ${agents}: an agent is refused and config.yaml is unchanged`, async () => {
        server.reset(); server.setMe({ username: 'alice', org_id: 'x', role: 'developer', scopes: [TEAM, OTHER] })
        const dir = setup(agents, a.seed())
        const before = cfg(dir)
        await expect(a.run(as(dir, 'agent'))).rejects.toMatchObject({ code: 'pin_denied' })
        expect(cfg(dir)).toBe(before)
      })
    }
    it(`${a.name}, deny: the owner adds it`, async () => {
      server.reset(); server.setMe({ username: 'alice', org_id: 'x', role: 'developer', scopes: [TEAM, OTHER] })
      const dir = setup('deny', a.seed())
      const before = cfg(dir)
      await a.run(as(dir, 'owner'))
      expect(cfg(dir)).not.toBe(before)
    })
    it(`${a.name}, allow: an agent adds it`, async () => {
      server.reset(); server.setMe({ username: 'alice', org_id: 'x', role: 'developer', scopes: [TEAM, OTHER] })
      const dir = setup('allow', a.seed())
      const before = cfg(dir)
      await a.run(as(dir, 'agent'))
      expect(cfg(dir)).not.toBe(before)
    })
  }
})

describe('round 7: folder-map auto-discovery follows the same rule', () => {
  // Discovery skips temp roots unless this test-only switch is set.
  beforeEach(() => { vi.stubEnv('PLUR_TEST_DISCOVER_IN_TMP', '1') })
  afterEach(() => { vi.unstubAllEnvs() })
  function decidedRepo(agents: 'allow' | 'request' | 'deny'): { dir: string; repo: string } {
    const dir = setup(agents)
    const repo = join(tmp('plur-r6-repo-'), 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.plur'), { recursive: true })
    writeFileSync(join(repo, '.plur', 'engrams.yaml'), 'engrams: []\n')
    const p = as(dir, 'agent')
    p.setFolder(repo, { mode: 'on' }, { nonce: p.issueFolderNonce('s', repo, { mode: 'on' }) })
    return { dir, repo }
  }
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: discovery for an agent, or for no one named, connects nothing`, () => {
      const { dir, repo } = decidedRepo(agents)
      const before = cfg(dir)
      expect(as(dir, 'agent').autoDiscoverStores(repo)).toEqual([])
      expect(new Plur({ path: dir, autoDiscover: false }).autoDiscoverStores(repo)).toEqual([])
      expect(cfg(dir)).toBe(before)
      expect(as(dir, 'owner').autoDiscoverStores(repo, { actor: 'owner' })).toHaveLength(1)
    })
  }
  it('allow: discovery connects the decided folder\'s store', () => {
    const { dir, repo } = decidedRepo('allow')
    expect(as(dir, 'agent').autoDiscoverStores(repo)).toHaveLength(1)
  })
})

describe('round 6: not additions, and the refresh exception', () => {
  it('deny: an agent may rotate the key of a registered server', async () => {
    const dir = setup('deny')
    await as(dir, 'owner').registerEnterpriseServer('https://a.example.test', { token: 'a', personalScope: ME })
    expect((await as(dir, 'agent').registerEnterpriseServer('https://a.example.test', { token: 'b', personalScope: ME })).status).toBe('updated')
    expect(cfg(dir)).toContain('token: b')
  })

  it('deny: a server refresh adds the scopes the server grants to an entry already listed (#1940)', async () => {
    server.reset(); server.setMe({ username: 'alice', org_id: 'x', role: 'developer', scopes: [ME, TEAM], scopes_status: 'ok', scope_metadata_status: 'ok' })
    const dir = setup('deny', [{ url, token: TOKEN, scope: ME, enterprise: { hello_engram_id: 'ENG-1' }, scopes: [] }])
    const [o] = await as(dir, 'agent').refreshServerScopes()
    expect(o).toMatchObject({ status: 'ok', applied: true })
    expect(cfg(dir)).toContain(TEAM)
  })

  it('a server refresh that would add a new source is an internal error and writes nothing', () => {
    const dir = setup('allow', [{ url: 'https://a.example.test', token: 't', scope: ME, enterprise: {}, scopes: [] }])
    const before = cfg(dir)
    const p = as(dir, 'owner') as unknown as { _updateRawStores(m: (s: unknown[]) => boolean, a: unknown): void }
    expect(() => p._updateRawStores(s => { s.push({ url: 'https://new.example.test', token: 't', scope: TEAM }); return true }, { kind: 'server-refresh' }))
      .toThrow(/new store/)
    expect(cfg(dir)).toBe(before)
  })

  it('a metadata write that would add anything is an internal error and writes nothing', () => {
    const dir = setup('allow', [{ url: 'https://a.example.test', token: 't', scope: TEAM }])
    const before = cfg(dir)
    const p = as(dir, 'owner') as unknown as { persistStores(s: unknown[], o: unknown): void; config: { stores?: unknown[] } }
    expect(() => p.persistStores([...(p.config.stores ?? []), { url: 'https://a.example.test', token: 't', scope: OTHER, shared: true, readonly: false }], { authority: { kind: 'metadata' } }))
      .toThrow(/metadata/)
    expect(cfg(dir)).toBe(before)
  })
})
