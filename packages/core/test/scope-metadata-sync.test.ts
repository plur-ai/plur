/**
 * persistScopeMetadata() — closes plur-ai/plur#668.
 *
 * discoverRemoteScopes() fetches scope_metadata (covers/description/sensitivity)
 * from /me but historically never persisted it into local config store entries.
 * persistScopeMetadata() closes that gap: after any /me pull, each registered
 * scope's store entry is updated so suggestScope() can actually route.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'metadata-sync-test-token'
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
  server.setMe({
    username: 'tester',
    org_id: 'plur',
    role: 'developer',
    scopes: [
      'group:plur/engineering',
      'group:plur/comms',
    ],
    scope_metadata: [
      {
        scope: 'group:plur/engineering',
        description: 'Engineering knowledge',
        covers: ['plur.engineering', 'ci', 'deploy'],
      },
      {
        scope: 'group:plur/comms',
        description: 'Comms and marketing',
        covers: ['plur.comms', 'marketing'],
      },
    ],
  })
})

function makeDir(stores: unknown[]): { dir: string; plur: Plur } {
  const dir = mkdtempSync(join(tmpdir(), 'plur-meta-sync-'))
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }))
  return { dir, plur: new Plur({ path: dir }) }
}

function readStores(dir: string): unknown[] {
  const raw = readFileSync(join(dir, 'config.yaml'), 'utf8')
  return ((yaml.load(raw) as Record<string, unknown>).stores ?? []) as unknown[]
}

// ---------------------------------------------------------------------------
// persistScopeMetadata()
// ---------------------------------------------------------------------------

describe('persistScopeMetadata()', () => {
  it('persists covers+description into a registered shared scope', async () => {
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    try {
      const discoveries = await plur.discoverRemoteScopes()
      plur.persistScopeMetadata(discoveries)

      const stores = readStores(dir) as Array<Record<string, unknown>>
      const eng = stores.find(s => s.scope === 'group:plur/engineering')!
      expect(eng.covers).toEqual(['plur.engineering', 'ci', 'deploy'])
      expect(eng.description).toBe('Engineering knowledge')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('persists covers for all registered scopes in one call', async () => {
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
      { url: baseUrl, token: TOKEN, scope: 'group:plur/comms', shared: true, readonly: false },
    ])
    try {
      const discoveries = await plur.discoverRemoteScopes()
      plur.persistScopeMetadata(discoveries)

      const stores = readStores(dir) as Array<Record<string, unknown>>
      expect((stores.find(s => s.scope === 'group:plur/engineering') as Record<string, unknown>).covers)
        .toEqual(['plur.engineering', 'ci', 'deploy'])
      expect((stores.find(s => s.scope === 'group:plur/comms') as Record<string, unknown>).covers)
        .toEqual(['plur.comms', 'marketing'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('updates covers when the server value changes on re-sync', async () => {
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    try {
      const d1 = await plur.discoverRemoteScopes()
      plur.persistScopeMetadata(d1)

      // Server updates covers for engineering
      server.setMe({
        scope_metadata: [{ scope: 'group:plur/engineering', description: 'Eng v2', covers: ['plur.engineering', 'testing'] }],
      })
      const d2 = await plur.discoverRemoteScopes()
      plur.persistScopeMetadata(d2)

      const stores = readStores(dir) as Array<Record<string, unknown>>
      const eng = stores.find(s => s.scope === 'group:plur/engineering')!
      expect(eng.covers).toEqual(['plur.engineering', 'testing'])
      expect(eng.description).toBe('Eng v2')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('does NOT write covers to personal-family scopes', async () => {
    // Simulate a discovery where the server metadata includes a personal-family scope.
    // persistScopeMetadata must skip personal scopes even if there's a store entry for them.
    const dir2 = mkdtempSync(join(tmpdir(), 'plur-meta-sync-personal-'))
    writeFileSync(
      join(dir2, 'config.yaml'),
      yaml.dump({
        stores: [
          // A shared scope registered to the remote
          { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
        ],
        index: false,
      }),
    )
    const plur2 = new Plur({ path: dir2 })
    try {
      // Server metadata includes a personal-family scope entry — must be ignored
      const discoveries = [{
        url: baseUrl, ok: true as const, username: 'u',
        authorized: ['group:plur/engineering', 'global'],
        registered: ['group:plur/engineering'],
        unregistered: [],
        metadata: [
          { scope: 'global', description: 'Personal', covers: ['everything'] },
          { scope: 'group:plur/engineering', description: 'Eng', covers: ['plur.engineering'] },
        ],
      }]
      plur2.persistScopeMetadata(discoveries)

      const stores = readStores(dir2) as Array<Record<string, unknown>>
      // global is not in stores → no entry to update (personal scopes are never registered)
      expect(stores.find(s => s.scope === 'global')).toBeUndefined()
      // The shared scope does get updated
      expect((stores.find(s => s.scope === 'group:plur/engineering') as Record<string, unknown>).covers)
        .toEqual(['plur.engineering'])
    } finally { rmSync(dir2, { recursive: true, force: true }) }
  })

  it('skips scopes not in the discovery metadata (unregistered)', async () => {
    // group:plur/comms is registered but NOT in metadata → store entry unchanged
    server.setMe({
      scope_metadata: [
        { scope: 'group:plur/engineering', description: 'Eng', covers: ['plur.engineering'] },
        // group:plur/comms intentionally absent from metadata
      ],
    })
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
      { url: baseUrl, token: TOKEN, scope: 'group:plur/comms', shared: true, readonly: false },
    ])
    try {
      const discoveries = await plur.discoverRemoteScopes()
      plur.persistScopeMetadata(discoveries)

      const stores = readStores(dir) as Array<Record<string, unknown>>
      const comms = stores.find(s => s.scope === 'group:plur/comms')!
      expect(comms.covers).toBeUndefined()  // untouched — no metadata for it
      const eng = stores.find(s => s.scope === 'group:plur/engineering')!
      expect(eng.covers).toEqual(['plur.engineering'])  // was synced
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('is a no-op when metadata matches existing covers (no spurious write)', async () => {
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false,
        description: 'Engineering knowledge', covers: ['plur.engineering', 'ci', 'deploy'] },
    ])
    try {
      const mtimeBefore = (await import('fs')).statSync(join(dir, 'config.yaml')).mtimeMs
      const discoveries = await plur.discoverRemoteScopes()
      plur.persistScopeMetadata(discoveries)
      const mtimeAfter = (await import('fs')).statSync(join(dir, 'config.yaml')).mtimeMs
      expect(mtimeAfter).toBe(mtimeBefore)  // file not rewritten
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('is a no-op when discovery ok:false', async () => {
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    try {
      plur.persistScopeMetadata([
        { url: baseUrl, ok: false as const, authorized: [], registered: [], unregistered: [], metadata: [], error: 'simulated failure' },
      ])
      const stores = readStores(dir) as Array<Record<string, unknown>>
      expect(stores[0].covers).toBeUndefined()  // not written on failure
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------
// suggestScope() with synced covers
// ---------------------------------------------------------------------------

describe('suggestScope() activates after persistScopeMetadata()', () => {
  it('returns the matching scope for a covers-vocabulary statement', async () => {
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    try {
      const discoveries = await plur.discoverRemoteScopes()
      plur.persistScopeMetadata(discoveries)

      const candidates = plur.suggestScope({ statement: 'deploy pipeline config', domain: 'plur.engineering' })
      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates[0].scope).toBe('group:plur/engineering')
      expect(candidates[0].confidence).toBeGreaterThanOrEqual(0.5)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns [] before covers are synced (inert state)', async () => {
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    try {
      // No persistScopeMetadata call — covers never written
      const candidates = plur.suggestScope({ statement: 'deploy pipeline config', domain: 'plur.engineering' })
      expect(candidates).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------
// registerDiscoveredScopes() calls persistScopeMetadata internally
// ---------------------------------------------------------------------------

describe('registerDiscoveredScopes() auto-syncs metadata', () => {
  it('persists covers for all newly registered scopes', async () => {
    const { dir, plur } = makeDir([
      // One pre-registered scope with token
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    try {
      await plur.registerDiscoveredScopes()

      const stores = readStores(dir) as Array<Record<string, unknown>>
      // engineering was already registered; comms is newly registered — both get covers
      const eng = stores.find(s => s.scope === 'group:plur/engineering')!
      expect(eng.covers).toEqual(['plur.engineering', 'ci', 'deploy'])
      const comms = stores.find(s => s.scope === 'group:plur/comms')!
      expect(comms?.covers).toEqual(['plur.comms', 'marketing'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------
// registerScope() calls persistScopeMetadata internally
// ---------------------------------------------------------------------------

describe('registerScope() auto-syncs metadata', () => {
  it('persists covers for the single registered scope', async () => {
    const { dir, plur } = makeDir([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    try {
      await plur.registerScope('group:plur/comms')

      const stores = readStores(dir) as Array<Record<string, unknown>>
      const comms = stores.find(s => s.scope === 'group:plur/comms')!
      expect(comms.covers).toEqual(['plur.comms', 'marketing'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
