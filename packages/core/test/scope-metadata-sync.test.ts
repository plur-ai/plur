/**
 * Server → local-config scope-metadata sync — closes plur-ai/plur#668.
 *
 * The client-side ranker (`suggestScope` → `getScopeMetadata` → `listScopeMetadata`)
 * reads `covers` from `config.stores[]`, but nothing populated them from the
 * server, so it returned no candidates for remote scopes. `discoverRemoteScopes`
 * now mirrors the server's `/me` `scope_metadata` (covers/description/sensitivity)
 * into the matching registered store entries. These integration tests run against
 * the in-process stub server (real HTTP).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'metasync-test-token'
let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

beforeEach(() => {
  server.reset()
  server.setMe({
    username: 'crtahlin', org_id: 'plur', role: 'developer',
    scopes: ['group:plur/plur-ai/engineering', 'group:plur/plur-ai/comms'],
  })
})

describe('Scope-metadata sync to local config (#668)', () => {
  let dir: string
  const writeConfig = (stores: unknown[]) => {
    dir = mkdtempSync(join(tmpdir(), 'plur-metasync-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }))
    return new Plur({ path: dir })
  }
  const readStores = (): Array<Record<string, unknown>> =>
    (yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { stores: Array<Record<string, unknown>> }).stores
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('persists server covers into the registered store entry and activates suggestScope', async () => {
    server.setMe({
      scope_metadata: [
        { scope: 'group:plur/plur-ai/engineering', description: 'Engineering', covers: ['plur.engineering', 'cli'] },
      ],
    })
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false },
    ])
    // Before the /me pull the ranker has no covers to work with.
    expect(plur.suggestScope({ statement: 'x', domain: 'plur.engineering.storage' })).toEqual([])

    await plur.discoverRemoteScopes()

    // Covers landed on disk...
    const eng = readStores().find(s => s.scope === 'group:plur/plur-ai/engineering')!
    expect(eng.covers).toEqual(['plur.engineering', 'cli'])
    expect(eng.description).toBe('Engineering')
    // ...and the ranker now routes a matching domain to the scope.
    const [top] = plur.suggestScope({ statement: 'fixed a storage bug', domain: 'plur.engineering.storage' })
    expect(top?.scope).toBe('group:plur/plur-ai/engineering')
    expect(top?.confidence).toBeGreaterThanOrEqual(0.5)
  })

  it('is idempotent — a second discover with unchanged metadata does not duplicate or churn', async () => {
    server.setMe({
      scope_metadata: [{ scope: 'group:plur/plur-ai/engineering', description: 'Eng', covers: ['plur.engineering'] }],
    })
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false },
    ])
    await plur.discoverRemoteScopes()
    const after1 = readStores()
    await plur.discoverRemoteScopes()
    const after2 = readStores()
    expect(after2).toEqual(after1)
    expect(after2).toHaveLength(1)
    expect(after2[0].covers).toEqual(['plur.engineering'])
  })

  it('refreshes covers when the server value changes (freshness, #648)', async () => {
    server.setMe({
      scope_metadata: [{ scope: 'group:plur/plur-ai/engineering', description: 'Eng', covers: ['plur.engineering'] }],
    })
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false },
    ])
    await plur.discoverRemoteScopes()
    server.setMe({
      scope_metadata: [{ scope: 'group:plur/plur-ai/engineering', description: 'Eng', covers: ['plur.engineering', 'plur.core'] }],
    })
    await plur.discoverRemoteScopes()
    expect(readStores().find(s => s.scope === 'group:plur/plur-ai/engineering')!.covers)
      .toEqual(['plur.engineering', 'plur.core'])
  })

  it('does not create store entries for authorized-but-unregistered scopes', async () => {
    server.setMe({
      scope_metadata: [
        { scope: 'group:plur/plur-ai/engineering', description: 'Eng', covers: ['plur.engineering'] },
        { scope: 'group:plur/plur-ai/comms', description: 'Comms', covers: ['plur.comms'] }, // authorized, NOT registered
      ],
    })
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false },
    ])
    await plur.discoverRemoteScopes()
    const stores = readStores()
    expect(stores).toHaveLength(1)
    expect(stores.map(s => s.scope)).toEqual(['group:plur/plur-ai/engineering'])
  })

  it('leaves local (path) stores untouched', async () => {
    server.setMe({
      scope_metadata: [{ scope: 'group:plur/plur-ai/engineering', description: 'Eng', covers: ['plur.engineering'] }],
    })
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false },
      { path: join(tmpdir(), 'nope', 'engrams.yaml'), scope: 'project:local', shared: true, readonly: false },
    ])
    await plur.discoverRemoteScopes()
    const local = readStores().find(s => s.scope === 'project:local')!
    expect(local.covers).toBeUndefined()
  })

  it('preserves existing covers when a remote is unreachable (ok:false)', async () => {
    // A registered store at a dead endpoint, already carrying covers. A failed
    // /me must not wipe them — the sync only reads from ok discoveries.
    const plur = writeConfig([
      { url: 'https://127.0.0.1:1/sse', token: 'x', scope: 'group:dead/scope', shared: true, readonly: false, covers: ['keep.me'] },
    ])
    const discs = await plur.discoverRemoteScopes({ timeoutMs: 500 })
    expect(discs.every(d => !d.ok)).toBe(true)
    expect(readStores().find(s => s.scope === 'group:dead/scope')!.covers).toEqual(['keep.me'])
  })
})
