/**
 * A save queued from a remote-only folder (#1663, the gate's structural change
 * 1) is the only local copy of that memory, and only until it is delivered or
 * forgotten. Nothing derives a second local copy from it — whatever folder,
 * if any, the instance is bound to. One predicate (`isRemoteOnlyQueued`,
 * remote-only-rows.ts) decides it at every sink:
 *
 *  - the optional local search index (SQLite IndexedStorage, PGLite);
 *  - the embedding cache and the embedder (fill, search, auto-embed);
 *  - local provenance (explicit and automatic on delivery);
 *  - the history a delivery writes (metadata only, no statement).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { IndexedStorage } from '../src/storage-indexed.js'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { fillEmbeddingCache, embeddingSearch, _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled } from '../src/embeddings.js'
import { sync } from '../src/sync.js'
import { execSync } from 'child_process'
import { isRemoteOnlyQueued } from '../src/remote-only-rows.js'
import { queueHoldViolation } from '../src/store/remote-only-store-guard.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'derived-copies-token'
const TEAM = 'group:acme/client'

function row(id: string, statement: string, extra: Record<string, unknown> = {}): any {
  return {
    id, statement, type: 'behavioral', scope: TEAM, domain: 'client.test', status: 'active', tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-10-18' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 }, ...extra,
  }
}
const queued = (id: string, statement: string) => row(id, statement, {
  structured_data: { _outbox: { target_url: 'http://127.0.0.1:9', target_scope: TEAM, attempt_count: 1, idempotency_key: 'k', remote_only: true, remote_only_folder: '/w/client' } },
})
const ordinary = (id: string, statement: string) => row(id, statement, { scope: 'global' })

let dir: string
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-derived-'))) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the shared predicate', () => {
  it('names a queued remote-only save and nothing else', () => {
    expect(isRemoteOnlyQueued(queued('ENG-1', 'x'))).toBe(true)
    expect(isRemoteOnlyQueued(ordinary('ENG-2', 'y'))).toBe(false)
    expect(isRemoteOnlyQueued(row('ENG-3', 'z', { structured_data: { _outbox: { target_scope: TEAM } } }))).toBe(false)
    expect(isRemoteOnlyQueued(undefined)).toBe(false)
  })
})

describe('the local search index never mirrors a queued remote-only save', () => {
  it('SQLite IndexedStorage', async () => {
    const yamlPath = join(dir, 'engrams.yaml')
    writeFileSync(yamlPath, yaml.dump({ engrams: [queued('ENG-2026-10-18-101', 'QUEUEDSQLITE fact'), ordinary('ENG-2026-10-18-102', 'plain fact')] }))
    const store = new IndexedStorage(yamlPath, join(dir, 'plur.db'), [])
    store.syncFromYaml()
    const all = await store.loadFiltered({})
    store.close()
    expect(all.map(e => e.id)).toEqual(['ENG-2026-10-18-102'])
  })

  it('PGLite, by sync and by reindex', async () => {
    const yamlPath = join(dir, 'engrams.yaml')
    writeFileSync(yamlPath, yaml.dump({ engrams: [queued('ENG-2026-10-18-103', 'QUEUEDPGLITE fact'), ordinary('ENG-2026-10-18-104', 'plain fact')] }))
    const adapter = new PGLiteAdapter(yamlPath, join(dir, 'store.pglite'))
    await adapter.syncFromYaml()
    expect((await adapter.loadFiltered({})).map(e => e.id)).toEqual(['ENG-2026-10-18-104'])
    await adapter.reindex()
    expect((await adapter.loadFiltered({})).map(e => e.id)).toEqual(['ENG-2026-10-18-104'])
    await adapter.close()
  }, 60_000)
})

describe('the embedder never sees a queued remote-only save', () => {
  const seen: string[] = []
  beforeAll(() => {
    _setCachedEmbedder({
      name: 'fake', dim: 3, modelId: 'fake',
      embed: async (t: string) => { seen.push(t); return new Float32Array([1, 0, 0]) },
      embedBatch: async (ts: string[]) => { seen.push(...ts); return ts.map(() => new Float32Array([1, 0, 0])) },
    })
  })
  afterAll(() => resetEmbedder())
  beforeEach(() => { seen.length = 0 })

  it('fillEmbeddingCache and embeddingSearch skip it, and the cache holds no entry for it', async () => {
    const rows = [queued('ENG-2026-10-18-105', 'QUEUEDEMBED fact'), ordinary('ENG-2026-10-18-106', 'plain fact')]
    await fillEmbeddingCache(rows, dir)
    await embeddingSearch(rows, 'a query', 5, dir)
    expect(seen.join('\n')).not.toContain('QUEUEDEMBED')
    const cache = existsSync(join(dir, '.embeddings-cache.json')) ? readFileSync(join(dir, '.embeddings-cache.json'), 'utf8') : ''
    const delta = readdirSync(dir).filter(f => f.startsWith('.embeddings-cache')).map(f => readFileSync(join(dir, f), 'utf8')).join('')
    expect(cache + delta).not.toContain('ENG-2026-10-18-105')
  })
})

describe('delivery from an unbound instance keeps no local provenance or history text', () => {
  let server: StubServer
  let url: string
  beforeAll(async () => { server = new StubServer(TOKEN); url = (await server.start()).url })
  afterAll(async () => { await server.stop() })

  it('explicit and automatic provenance, and the delivery history', async () => {
    const home = join(dir, 'home'); const root = join(home, '.plur'); const work = join(home, 'client')
    mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
    const prevHome = process.env.HOME; process.env.HOME = home
    try {
      writeFileSync(join(root, 'config.yaml'), yaml.dump({
        index: false, embeddings: { enabled: false }, provenance: { generate: 'always' },
        stores: [{ url, token: TOKEN, scope: TEAM, shared: true, readonly: false }],
      }))
      writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only', scope: TEAM }] }))
      server.reset()
      server.appendErrorResponse = { status: 503, body: 'down' }
      const bound = new Plur({ path: root })
      bound.bindFolder(work)
      const q = await bound.learnRouted('the client signing key PROVQUEUED rotates', { type: 'procedural' })
      await backgroundPushesSettled(root).catch(() => {})
      const outside = new Plur({ path: root })
      await expect(outside.writeProvenance(q.id, { include_statement: true } as any)).rejects.toThrow()
      server.appendErrorResponse = null
      await outside.flushOutbox({ force: true } as any)
      await backgroundPushesSettled(root).catch(() => {})
      await new Promise(r => setTimeout(r, 200))
      expect(server.appendStatements.join('\n')).toContain('PROVQUEUED')
      const walk = (d: string): string => !existsSync(d) ? '' : readdirSync(d, { withFileTypes: true })
        .map(e => e.isDirectory() ? walk(join(d, e.name)) : readFileSync(join(d, e.name), 'utf8')).join('')
      expect(walk(join(root, 'provenance'))).not.toContain('PROVQUEUED')
      expect(walk(join(root, 'history'))).not.toContain('PROVQUEUED')
    } finally { process.env.HOME = prevHome }
  })
})

describe('Codex round 10 on #1663: the remaining sinks', () => {
  it('git sync never commits a queued remote-only save (personal and shared)', () => {
    for (const remoteType of ['personal', 'shared'] as const) {
      const d = join(dir, remoteType)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'engrams.yaml'), yaml.dump({ engrams: [
        queued('ENG-2026-10-18-111', 'QUEUEDGIT fact'),
        row('ENG-2026-10-18-112', 'shared plain fact', { visibility: 'public' }),
      ] }))
      sync(d, undefined, { remoteType })
      const history = execSync('git log -p --all', { cwd: d, encoding: 'utf8' })
      expect(history, remoteType).not.toContain('QUEUEDGIT')
      expect(history, remoteType).toContain('shared plain fact')
    }
  })

  it('the SQLite index leaves a queued save of a secondary store out too', async () => {
    const yamlPath = join(dir, 'engrams.yaml')
    const second = join(dir, 'second.yaml')
    writeFileSync(yamlPath, yaml.dump({ engrams: [] }))
    writeFileSync(second, yaml.dump({ engrams: [queued('ENG-2026-10-18-113', 'QUEUEDSECOND fact'), row('ENG-2026-10-18-114', 'second plain fact')] }))
    const store = new IndexedStorage(yamlPath, join(dir, 'plur.db'), [{ path: second, scope: TEAM } as any])
    store.syncFromYaml()
    const all = await store.loadFiltered({})
    store.close()
    expect(JSON.stringify(all)).not.toContain('QUEUEDSECOND')
    expect(JSON.stringify(all)).toContain('second plain fact')
  })

  it('provenance, tensions and dedup history for a queued save held in a secondary store or the primary', async () => {
    const root = join(dir, 'home', '.plur')
    mkdirSync(root, { recursive: true })
    const second = join(dir, 'second.yaml')
    writeFileSync(second, yaml.dump({ engrams: [queued('ENG-2026-10-18-115', 'QUEUEDPROVSECOND fact')] }))
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: [queued('ENG-2026-10-18-116', 'QUEUEDDEDUP the client lane is blue'), ordinary('ENG-2026-10-18-117', 'plain personal fact')] }))
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores: [{ path: second, scope: TEAM }] }))
    const plur = new Plur({ path: root })
    const all = await plur.list()
    const ns = all.find(e => e.statement.includes('QUEUEDPROVSECOND'))?.id ?? 'ENG-2026-10-18-115'
    await plur.writeProvenance(ns, { include_statement: true } as any).catch(() => null)
    await plur.recordTensions([{ id_a: 'ENG-2026-10-18-116', id_b: 'ENG-2026-10-18-117', statement_a: 'QUEUEDDEDUP the client lane is blue', statement_b: 'plain personal fact', confidence: 0.9, reason: 'x' } as any]).catch(() => null)
    await plur.learn('QUEUEDDEDUP the client lane is blue', { scope: TEAM }).catch(() => null)
    const walk = (d: string): string => !existsSync(d) ? '' : readdirSync(d, { withFileTypes: true })
      .map(e => e.isDirectory() ? walk(join(d, e.name)) : readFileSync(join(d, e.name), 'utf8')).join('')
    expect(walk(join(root, 'provenance'))).not.toContain('QUEUEDPROVSECOND')
    const tensions = existsSync(join(root, 'tensions.yaml')) ? readFileSync(join(root, 'tensions.yaml'), 'utf8') : ''
    expect(tensions).not.toContain('QUEUEDDEDUP')
    const history = walk(join(root, 'history')).split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(JSON.stringify(history.filter(e => e.engram_id === 'ENG-2026-10-18-116'))).not.toContain('QUEUEDDEDUP')
  })

  it('an unbound read never sees a queued remote-only save', async () => {
    const root = join(dir, 'home2', '.plur')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: [queued('ENG-2026-10-18-118', 'QUEUEDREAD the client lane is blue')] }))
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false } }))
    const plur = new Plur({ path: root })
    const seen = JSON.stringify([await plur.list(), await plur.recall('client lane blue'), (await plur.inject('client lane blue')).directives])
    expect(seen).not.toContain('QUEUEDREAD')
  })

  it('the primary-store embedding pass pages past queued saves instead of stopping', async () => {
    const seen: string[] = []
    _setCachedEmbedder({
      name: 'fake', dim: 3, modelId: 'fake',
      embed: async (t: string) => { seen.push(t); return new Float32Array([1, 0, 0]) },
      embedBatch: async (ts: string[]) => ts.map(() => new Float32Array([1, 0, 0])),
    })
    setEmbeddingsEnabled(true)
    try {
      const rows = [...Array.from({ length: 120 }, (_, i) => queued(`ENG-2026-10-18-${String(200 + i)}`, `QUEUEDPAGE ${i}`)), ordinary('ENG-2026-10-18-400', 'ORDINARYPAGE fact')]
      const done = new Set<string>()
      const adapter = {
        listEngramsMissingEmbeddings: async (limit: number) => rows.filter(r => !done.has(r.id)).slice(0, limit),
        upsertEmbedding: async (id: string) => { done.add(id) },
      }
      const root = join(dir, 'home3', '.plur')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false }))
      const plur = new Plur({ path: root })
      await (plur as any)._autoEmbedPrimaryStore(adapter)
      expect(done.has('ENG-2026-10-18-400')).toBe(true)
      expect(seen.join('\n')).not.toContain('QUEUEDPAGE')
    } finally { resetEmbedder() }
  })
})

describe('construction-time maintenance waits for the binding (Codex round 10 on #1663)', () => {
  it('the legacy tension purge does not rewrite personal rows of an instance bound right after construction', async () => {
    const home = join(dir, 'home4'); const root = join(home, '.plur'); const work = join(home, 'client')
    mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: [row('ENG-2026-10-18-119', 'personal with a legacy conflict', { scope: 'global', relations: { conflicts: ['ENG-2026-10-18-120'] } })] }))
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores: [{ url: 'http://127.0.0.1:9', token: 't', scope: TEAM, shared: true }] }))
    writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only', scope: TEAM }] }))
    const before = readFileSync(join(root, 'engrams.yaml'), 'utf8')
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    await plur.ready().catch(() => {})
    expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(before)
  })
})

describe('Codex round 11 on #1663', () => {
  const homeRoot = () => { const root = join(dir, 'h11', '.plur'); mkdirSync(root, { recursive: true }); return root }
  const walk = (d: string): string => !existsSync(d) ? '' : readdirSync(d, { withFileTypes: true })
    .map(e => e.isDirectory() ? walk(join(d, e.name)) : readFileSync(join(d, e.name), 'utf8')).join('')

  it('a pack export refuses a queued remote-only save, unbound too', async () => {
    const root = homeRoot()
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false } }))
    const plur = new Plur({ path: root })
    const manifest = { name: 'p', version: '1.0.0', license: 'MIT' } as any
    // Control: an ordinary public row exports.
    await plur.exportPack([row('ENG-2026-10-18-120', 'plain exported fact', { visibility: 'public' })], join(dir, 'pack-ok'), manifest)
    expect(walk(join(dir, 'pack-ok'))).toContain('plain exported fact')
    const out = join(dir, 'pack-out')
    let threw = false
    try { await plur.exportPack([queued('ENG-2026-10-18-121', 'QUEUEDEXPORT fact', ) && { ...queued('ENG-2026-10-18-121', 'QUEUEDEXPORT fact'), visibility: 'public' }], out, manifest) } catch { threw = true }
    expect(threw).toBe(true)
    expect(walk(out)).not.toContain('QUEUEDEXPORT')
  })

  it('forgetting a queued save keeps no reason text in history', async () => {
    const root = homeRoot()
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false } }))
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: [queued('ENG-2026-10-18-122', 'QUEUEDFORGET fact')] }))
    await new Plur({ path: root }).forget('ENG-2026-10-18-122', 'Obsolete: QUEUEDFORGET fact')
    expect(walk(join(root, 'history'))).not.toContain('QUEUEDFORGET')
  })

  it('getByIds and the residual filter of the query-adapter path never return a queued save unbound', async () => {
    const root = homeRoot()
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false } }))
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: [queued('ENG-2026-10-18-123', 'QUEUEDBYIDS fact')] }))
    const plur = new Plur({ path: root })
    expect(JSON.stringify(await plur.getByIds(['ENG-2026-10-18-123']))).not.toContain('QUEUEDBYIDS')
    const residual = (plur as any)._applyResidualFilters([queued('ENG-2026-10-18-124', 'QUEUEDRESIDUAL fact')], {})
    expect(JSON.stringify(residual)).not.toContain('QUEUEDRESIDUAL')
  })

  it('getById by the primary-qualified id hides a queued save too, and still finds an ordinary row', async () => {
    const root = homeRoot()
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false } }))
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: [
      queued('ENG-2026-10-18-126', 'QUEUEDQUALIFIED fact'),
      row('ENG-2026-10-18-127', 'ordinary qualified fact', { scope: 'local' }),
    ] }))
    const plur = new Plur({ path: root })
    const qualified = (id: string) => (plur as any)._primaryQualifiedId(id)
    expect(await plur.getById('ENG-2026-10-18-126')).toBeNull()
    expect(JSON.stringify(await plur.getById(qualified('ENG-2026-10-18-126')))).not.toContain('QUEUEDQUALIFIED')
    expect((await plur.getById(qualified('ENG-2026-10-18-127')))?.statement).toBe('ordinary qualified fact')
  })

  it('a half-stripped marker still holds the save: no demotion, and the hold refuses it', () => {
    const half = queued('ENG-2026-10-18-125', 'QUEUEDHALF fact')
    delete half.structured_data._outbox.remote_only
    expect(isRemoteOnlyQueued(half)).toBe(true)
    const demoted = { ...half, scope: 'local', visibility: 'private', structured_data: {} }
    expect(queueHoldViolation(half, demoted as any, () => true)).not.toBeNull()
  })
})

describe('Codex round 12 on #1663', () => {
  const walk = (d: string): string => !existsSync(d) ? '' : readdirSync(d, { withFileTypes: true })
    .map(e => e.isDirectory() ? walk(join(d, e.name)) : readFileSync(join(d, e.name), 'utf8')).join('')

  it('a delegating primary never deduplicates a write into a queued save of a secondary store', async () => {
    const root = join(dir, 'h12', '.plur')
    mkdirSync(root, { recursive: true })
    const second = join(dir, 'second12.yaml')
    writeFileSync(second, yaml.dump({ engrams: [queued('ENG-2026-10-18-130', 'QUEUEDDELEG the client lane is blue')] }))
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores: [{ path: second, scope: TEAM, shared: true, readonly: false }] }))
    const appended: any[] = []
    const store = {
      kind: 'postgres', location: null,
      load: async () => appended, loadCached: async () => appended, invalidate: () => {},
      save: async (rows: any[]) => { appended.splice(0, appended.length, ...rows) },
      findActiveByContentHash: async () => null,
      nextEngramId: async () => 'ENG-2026-10-18-901',
      append: async (e: any) => { appended.push(e) },
      updateMany: async () => {},
      loadByIds: async () => [],
    }
    const plur = new Plur({ path: root, store: store as any })
    expect(await plur.wouldDeduplicate('QUEUEDDELEG the client lane is blue', { scope: TEAM })).toBeNull()
    await plur.learn('QUEUEDDELEG the client lane is blue', { scope: TEAM }).catch(() => null)
    const events = walk(join(root, 'history')).split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(events.filter(e => e.event === 'engram_duplicate_absorbed')).toEqual([])
    expect(readFileSync(second, 'utf8')).toContain('QUEUEDDELEG')
  })

  it('a corrupt personal store shows no excerpt of it in a remote-only status', async () => {
    const home = join(dir, 'h12b'); const root = join(home, '.plur'); const work = join(home, 'client')
    mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
    writeFileSync(join(root, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores: [{ url: 'http://127.0.0.1:9', token: 't', scope: TEAM, shared: true }] }))
    writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only', scope: TEAM }] }))
    writeFileSync(join(root, 'engrams.yaml'), 'engrams:\n  - id: ENG-1\n    statement: MYPRIVATE\n    tags: [unfinished\n')
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    let out = ''
    try { out = JSON.stringify(await plur.status()) } catch (err) { out = String((err as Error).message) + String((err as any).stack ?? '') }
    expect(out).not.toContain('MYPRIVATE')
  })
})

