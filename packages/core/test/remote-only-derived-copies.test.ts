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
import { fillEmbeddingCache, embeddingSearch, _setCachedEmbedder, resetEmbedder } from '../src/embeddings.js'
import { isRemoteOnlyQueued } from '../src/remote-only-rows.js'
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
