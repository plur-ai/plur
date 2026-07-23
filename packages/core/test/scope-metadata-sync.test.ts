/**
 * Server-to-local-config scope metadata sync (#668).
 *
 * Verifies that covers/description from the remote /me endpoint are persisted
 * into local config store entries after each /me pull, so suggestScope() has
 * covers to rank against and is no longer inert for remote scopes.
 *
 * The bug: registerScope / registerDiscoveredScopes / session_start all called
 * discoverRemoteScopes() but never wrote scope_metadata.covers into the local
 * config store entries. getScopeMetadata() found no covers, listScopeMetadata()
 * returned [], and suggestScope() returned [] for every input.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'meta-sync-test-token'
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
      'group:plur/research',
      'group:plur/comms',
    ],
    scope_metadata: [
      {
        scope: 'group:plur/engineering',
        description: 'Engineering team knowledge',
        covers: ['ci', 'deploy', 'plur.*'],
      },
      {
        scope: 'group:plur/research',
        description: 'Research and benchmarking',
        covers: ['plur.research.benchmarking', 'papers', 'longevity'],
      },
      {
        scope: 'group:plur/comms',
        description: 'Marketing and communications',
        covers: ['marketing', 'positioning', 'copy'],
      },
    ],
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string

const makeDir = () => {
  dir = mkdtempSync(join(tmpdir(), 'plur-meta-sync-'))
  return dir
}

const cleanup = () => { if (dir) rmSync(dir, { recursive: true, force: true }) }

const writeCfg = (stores: unknown[]) => {
  const d = makeDir()
  writeFileSync(join(d, 'config.yaml'), yaml.dump({ stores, index: false }, { lineWidth: 120 }))
  return new Plur({ path: d })
}

const readCfg = (d: string) => yaml.load(readFileSync(join(d, 'config.yaml'), 'utf8')) as Record<string, unknown>

// ---------------------------------------------------------------------------
// syncScopeMetadata() — direct API
// ---------------------------------------------------------------------------

describe('Plur.syncScopeMetadata()', () => {
  afterEach(cleanup)

  it('writes covers and description into a registered shared-scope store entry', () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    plur.syncScopeMetadata([
      { scope: 'group:plur/engineering', description: 'Eng knowledge', covers: ['ci', 'deploy'] },
    ])
    const cfg = readCfg(dir)
    const entry = (cfg.stores as unknown[]).find((s: unknown) => (s as { scope?: string }).scope === 'group:plur/engineering') as Record<string, unknown>
    expect(entry.covers).toEqual(['ci', 'deploy'])
    expect(entry.description).toBe('Eng knowledge')
  })

  it('is a no-op when serverMetadata is empty', () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
    plur.syncScopeMetadata([])
    const after = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(after).toBe(before)
  })

  it('is a no-op when nothing changed (covers already match)', () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false, covers: ['ci', 'deploy'], description: 'Eng knowledge' },
    ])
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
    plur.syncScopeMetadata([
      { scope: 'group:plur/engineering', description: 'Eng knowledge', covers: ['ci', 'deploy'] },
    ])
    const after = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(after).toBe(before)
  })

  it('skips personal-family scopes — they are never routing targets', () => {
    const plur = writeCfg([
      { path: join(dir, 'engrams.yaml'), scope: 'global', shared: false, readonly: false },
      { url: baseUrl, token: TOKEN, scope: 'user:plur:tester', shared: false, readonly: false },
    ])
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
    plur.syncScopeMetadata([
      { scope: 'global', description: 'Personal global', covers: ['everything'] },
      { scope: 'user:plur:tester', description: 'My scope', covers: ['personal-docs'] },
    ])
    const after = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(after).toBe(before)
  })

  it('refreshes covers when the server value changes (ties into #648)', () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false, covers: ['old-cover'], description: 'old desc' },
    ])
    plur.syncScopeMetadata([
      { scope: 'group:plur/engineering', description: 'Updated desc', covers: ['ci', 'deploy', 'plur.*'] },
    ])
    const cfg = readCfg(dir)
    const entry = (cfg.stores as unknown[]).find((s: unknown) => (s as { scope?: string }).scope === 'group:plur/engineering') as Record<string, unknown>
    expect(entry.covers).toEqual(['ci', 'deploy', 'plur.*'])
    expect(entry.description).toBe('Updated desc')
  })

  it('preserves other store fields (url, token, shared, readonly) during the writeback', () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    plur.syncScopeMetadata([
      { scope: 'group:plur/engineering', description: 'Eng', covers: ['ci'] },
    ])
    const cfg = readCfg(dir)
    const entry = (cfg.stores as unknown[]).find((s: unknown) => (s as { scope?: string }).scope === 'group:plur/engineering') as Record<string, unknown>
    expect(entry.url).toBe(baseUrl)
    expect(entry.token).toBe(TOKEN)
    expect(entry.shared).toBe(true)
    expect(entry.readonly).toBe(false)
  })

  it('updates multiple scopes in a single call', () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
      { url: baseUrl, token: TOKEN, scope: 'group:plur/research', shared: true, readonly: false },
    ])
    plur.syncScopeMetadata([
      { scope: 'group:plur/engineering', description: 'Eng', covers: ['ci'] },
      { scope: 'group:plur/research', description: 'Research', covers: ['plur.research.benchmarking'] },
    ])
    const cfg = readCfg(dir)
    const stores = cfg.stores as Record<string, unknown>[]
    const eng = stores.find(s => s.scope === 'group:plur/engineering')!
    const res = stores.find(s => s.scope === 'group:plur/research')!
    expect(eng.covers).toEqual(['ci'])
    expect(res.covers).toEqual(['plur.research.benchmarking'])
  })
})

// ---------------------------------------------------------------------------
// registerDiscoveredScopes() syncs metadata as a side-effect (#668)
// ---------------------------------------------------------------------------

describe('Plur.registerDiscoveredScopes() — covers synced after registration', () => {
  afterEach(cleanup)

  it('persists server covers for all authorized scopes after bulk-register', async () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    await plur.registerDiscoveredScopes()
    const cfg = readCfg(dir)
    const stores = cfg.stores as Record<string, unknown>[]

    // Originally-registered scope gets its covers synced
    const eng = stores.find(s => s.scope === 'group:plur/engineering')!
    expect(eng.covers).toEqual(['ci', 'deploy', 'plur.*'])

    // Newly-registered scopes also carry their covers
    const research = stores.find(s => s.scope === 'group:plur/research')!
    expect(research).toBeDefined()
    expect(research.covers).toEqual(['plur.research.benchmarking', 'papers', 'longevity'])
  })

  it('activates suggestScope after registerDiscoveredScopes', async () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    // Before: suggestScope returns [] because no covers in local config
    expect(plur.suggestScope({ statement: 'update the CI pipeline and deploy scripts' })).toEqual([])

    await plur.registerDiscoveredScopes()

    // After: the engineering scope's covers match the input
    const candidates = plur.suggestScope({ statement: 'update the CI pipeline and deploy scripts' })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].scope).toBe('group:plur/engineering')
  })
})

// ---------------------------------------------------------------------------
// registerScope() syncs metadata for the registered scope (#668)
// ---------------------------------------------------------------------------

describe('Plur.registerScope() — covers synced after single-scope registration', () => {
  afterEach(cleanup)

  it('persists covers for the newly registered scope', async () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    await plur.registerScope('group:plur/research')
    const cfg = readCfg(dir)
    const stores = cfg.stores as Record<string, unknown>[]
    const research = stores.find(s => s.scope === 'group:plur/research')!
    expect(research).toBeDefined()
    expect(research.covers).toEqual(['plur.research.benchmarking', 'papers', 'longevity'])
    expect(research.description).toBe('Research and benchmarking')
  })

  it('also syncs already-registered scopes on the same endpoint', async () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    // The /me discovery surfaces metadata for all scopes on this URL, so
    // syncing after registerScope should also update the existing entry.
    await plur.registerScope('group:plur/comms')
    const cfg = readCfg(dir)
    const stores = cfg.stores as Record<string, unknown>[]
    const eng = stores.find(s => s.scope === 'group:plur/engineering')
    expect(eng?.covers).toEqual(['ci', 'deploy', 'plur.*'])
  })

  it('activates suggestScope for the newly registered scope', async () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    await plur.registerScope('group:plur/research')
    const candidates = plur.suggestScope({
      statement: 'LongMemEval benchmark result for the hybrid reranker pass',
      domain: 'plur.research.benchmarking',
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].scope).toBe('group:plur/research')
  })
})

// ---------------------------------------------------------------------------
// suggestScope end-to-end: server → local config → ranker (#668)
// ---------------------------------------------------------------------------

describe('suggestScope activated end-to-end via server covers', () => {
  afterEach(cleanup)

  it('returns [] before sync and candidates after sync — proving server covers were missing', () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/engineering', shared: true, readonly: false },
    ])
    // Before: inert — no covers in local config
    expect(plur.suggestScope({ statement: 'update the CI pipeline', domain: 'plur.engineering' })).toEqual([])

    // After: server covers written
    plur.syncScopeMetadata([
      { scope: 'group:plur/engineering', description: 'Eng', covers: ['plur.*', 'ci', 'deploy'] },
    ])
    const after = plur.suggestScope({ statement: 'update the CI pipeline', domain: 'plur.engineering' })
    expect(after.length).toBeGreaterThan(0)
    expect(after[0].scope).toBe('group:plur/engineering')
  })

  it('a covers-vocabulary statement from issue #668 ranks the owning scope first', async () => {
    const plur = writeCfg([
      { url: baseUrl, token: TOKEN, scope: 'group:plur/research', shared: true, readonly: false },
    ])
    // Reproduce the exact failure from the issue report: domain='plur.research.benchmarking'
    // is one of the scope's covers but was never persisted — both calls returned [].
    expect(plur.suggestScope({ statement: 'benchmark result', domain: 'plur.research.benchmarking' })).toEqual([])

    await plur.registerDiscoveredScopes()  // triggers syncScopeMetadata

    const candidates = plur.suggestScope({
      statement: 'benchmark result for the reranker ablation study',
      domain: 'plur.research.benchmarking',
    })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].scope).toBe('group:plur/research')
  })
})
