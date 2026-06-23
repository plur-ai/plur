/**
 * Client scope discovery — closes plur-ai/plur#292.
 *
 * The client can now ask the enterprise server which scopes a token is
 * authorized for (GET /api/v1/me) and register the ones it hasn't yet. These
 * integration tests run against the in-process stub server (real HTTP), with
 * setMe() simulating a multi-team authorization.
 *
 * Depends on the URL+scope dedup from #291 — registering N scopes under one URL
 * is what makes auto-register meaningful.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { RemoteStore } from '../src/store/remote-store.js'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'discovery-test-token'
let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  const info = await server.start()
  baseUrl = info.url
})

afterAll(async () => { await server.stop() })

beforeEach(() => {
  server.reset()
  // Default identity: authorized for one base scope plus three team scopes.
  server.setMe({
    username: 'crtahlin',
    org_id: 'plur',
    role: 'developer',
    scopes: [
      'group:plur/plur-ai',
      'group:plur/plur-ai/engineering',
      'group:plur/plur-ai/comms',
      'group:plur/plur-ai/research',
    ],
  })
})

// ---------------------------------------------------------------------------
// RemoteStore.me() — direct, real HTTP
// ---------------------------------------------------------------------------

describe('RemoteStore.me()', () => {
  it('returns the resolved identity and authorized scopes', async () => {
    const store = new RemoteStore(baseUrl, TOKEN, 'group:plur/plur-ai/engineering')
    const me = await store.me()
    expect(me.username).toBe('crtahlin')
    expect(me.org_id).toBe('plur')
    expect(me.role).toBe('developer')
    expect(me.scopes).toContain('group:plur/plur-ai/comms')
  })

  it('throws on an invalid token (401)', async () => {
    const store = new RemoteStore(baseUrl, 'wrong-token', 'group:plur/plur-ai')
    await expect(store.me()).rejects.toThrow(/\/me failed: 401/)
  })
})

// ---------------------------------------------------------------------------
// Plur.discoverRemoteScopes()
// ---------------------------------------------------------------------------

describe('Plur.discoverRemoteScopes()', () => {
  let dir: string

  const writeConfig = (stores: unknown[]) => {
    dir = mkdtempSync(join(tmpdir(), 'plur-discover-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }))
    return new Plur({ path: dir })
  }

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('splits authorized scopes into registered vs unregistered', async () => {
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false },
    ])
    const [d] = await plur.discoverRemoteScopes()

    expect(d.ok).toBe(true)
    expect(d.url).toBe(baseUrl)
    expect(d.username).toBe('crtahlin')
    expect(d.registered).toEqual(['group:plur/plur-ai/engineering'])
    expect(d.unregistered.sort()).toEqual([
      'group:plur/plur-ai',
      'group:plur/plur-ai/comms',
      'group:plur/plur-ai/research',
    ])
  })

  it('returns [] when no remote stores are configured', async () => {
    const plur = writeConfig([])
    expect(await plur.discoverRemoteScopes()).toEqual([])
  })

  it('reports ok:false with an error when /me fails, without throwing', async () => {
    const plur = writeConfig([
      { url: baseUrl, token: 'bad-token', scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false },
    ])
    const [d] = await plur.discoverRemoteScopes()
    expect(d.ok).toBe(false)
    expect(d.error).toMatch(/401/)
    expect(d.unregistered).toEqual([])
  })

  it('groups multiple entries on the same URL into one discovery', async () => {
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false },
      { url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/comms', shared: true, readonly: false },
    ])
    const discoveries = await plur.discoverRemoteScopes()
    expect(discoveries).toHaveLength(1)
    expect(discoveries[0].registered.sort()).toEqual(['group:plur/plur-ai/comms', 'group:plur/plur-ai/engineering'])
    expect(discoveries[0].unregistered.sort()).toEqual(['group:plur/plur-ai', 'group:plur/plur-ai/research'])
  })
})

// ---------------------------------------------------------------------------
// Plur.registerDiscoveredScopes() — exercises the #291 URL+scope dedup
// ---------------------------------------------------------------------------

describe('Plur.registerDiscoveredScopes()', () => {
  let dir: string

  const freshPlur = () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-register-'))
    writeFileSync(
      join(dir, 'config.yaml'),
      yaml.dump({
        stores: [{ url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }],
        index: false,
      }, { lineWidth: 120, noRefs: true }),
    )
    return new Plur({ path: dir })
  }

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('registers every authorized-but-unregistered scope under the one URL', async () => {
    const plur = freshPlur()
    const [result] = await plur.registerDiscoveredScopes()

    expect(result.ok).toBe(true)
    // The three previously-unregistered scopes are newly added; the one already
    // in config is reported as already_registered.
    expect(result.added.sort()).toEqual([
      'group:plur/plur-ai',
      'group:plur/plur-ai/comms',
      'group:plur/plur-ai/research',
    ])
    expect(result.already_registered).toEqual(['group:plur/plur-ai/engineering'])

    // All four authorized scopes now persist as separate entries on the same URL.
    const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
    expect(config.stores).toHaveLength(4)
    expect(config.stores.every((s: any) => s.url === baseUrl)).toBe(true)
    expect(config.stores.map((s: any) => s.scope).sort()).toEqual([
      'group:plur/plur-ai',
      'group:plur/plur-ai/comms',
      'group:plur/plur-ai/engineering',
      'group:plur/plur-ai/research',
    ])
  })

  it('#382 refuses to auto-register personal-family scopes returned by /me', async () => {
    // A compromised/MITM'd endpoint advertises personal-family scopes alongside
    // a legit shared one. None of the personal scopes may be registered — else
    // the hostile server becomes the routing target for default/unscoped writes.
    server.setMe({
      username: 'crtahlin', org_id: 'plur', role: 'developer',
      scopes: ['global', 'local', 'user:victim', 'agent:bot', 'group:plur/plur-ai/engineering'],
    })
    const plur = freshPlur()
    const [result] = await plur.registerDiscoveredScopes()

    expect(result.ok).toBe(true)
    expect(result.added).toEqual([])                       // nothing new registered
    expect(result.skipped.sort()).toEqual(['agent:bot', 'global', 'local', 'user:victim'])
    expect(result.already_registered).toEqual(['group:plur/plur-ai/engineering'])

    // No personal-family scope was persisted as a remote store.
    const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
    expect(config.stores).toHaveLength(1)
    expect(config.stores.map((s: any) => s.scope)).toEqual(['group:plur/plur-ai/engineering'])
    for (const bad of ['global', 'local', 'user:victim', 'agent:bot']) {
      expect(config.stores.some((s: any) => s.scope === bad)).toBe(false)
    }
  })

  it('is idempotent — a second run reports everything already_registered', async () => {
    const plur = freshPlur()
    await plur.registerDiscoveredScopes()
    const [second] = await plur.registerDiscoveredScopes()

    expect(second.added).toEqual([])
    expect(second.already_registered.sort()).toEqual([
      'group:plur/plur-ai',
      'group:plur/plur-ai/comms',
      'group:plur/plur-ai/engineering',
      'group:plur/plur-ai/research',
    ])
    const config = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any
    expect(config.stores).toHaveLength(4)
  })
})
