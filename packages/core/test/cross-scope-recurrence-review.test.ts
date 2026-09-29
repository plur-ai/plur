import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import type { Engram } from '../src/schemas/engram.js'
import type { PrimaryStore, PrimaryStoreKind } from '../src/store/primary-store.js'

/**
 * Code-review findings on #1268 (copy-on-promote), each pinned by a test that
 * failed before its fix.
 */
const TEAM = 'group:example/eng'
const URL = 'https://store.example.test/sse'

/** A row store with the write-path seams, counting whole-corpus loads. */
class SeamStore implements PrimaryStore {
  readonly kind: PrimaryStoreKind = 'memory'
  readonly location: string | null = null
  fullLoads = 0
  nextIdCalls = 0
  rows: Engram[] = []
  async load(): Promise<Engram[]> { this.fullLoads++; return this.rows.map(e => structuredClone(e)) }
  async loadCached(): Promise<Engram[]> { return this.load() }
  async save(engrams: Engram[]): Promise<void> { this.rows = engrams.map(e => structuredClone(e)) }
  invalidate(): void {}
  async append(engram: Engram): Promise<void> {
    if (this.rows.some(e => e.id === engram.id)) throw new Error(`append: ${engram.id} exists`)
    this.rows.push(structuredClone(engram))
  }
  async updateMany(engrams: Engram[]): Promise<void> {
    for (const e of engrams) {
      const i = this.rows.findIndex(r => r.id === e.id)
      if (i === -1) this.rows.push(structuredClone(e)); else this.rows[i] = structuredClone(e)
    }
  }
  async loadByIds(ids: string[]): Promise<Engram[]> {
    const w = new Set(ids); return this.rows.filter(e => w.has(e.id)).map(e => structuredClone(e))
  }
  async findActiveByContentHash(hash: string, scope: string): Promise<Engram | null> {
    const hit = this.rows.find(e => e.status === 'active' && (e as any).content_hash === hash && e.scope === scope)
    return hit ? structuredClone(hit) : null
  }
  async nextEngramId(datePrefix: string): Promise<string> {
    this.nextIdCalls++
    // Deliberately a different sequence from generateEngramId, so a copy
    // minted from a snapshot is recognisable.
    return `${datePrefix}${String(900 + this.nextIdCalls)}`
  }
}

describe('#1268 review findings', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  const dirs: string[] = []
  const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }
  beforeEach(() => { dir = tmp('plur-review-'); originalFetch = globalThis.fetch })
  afterEach(() => {
    globalThis.fetch = originalFetch
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  // Finding 1: learnRouted's remote route decided "team validation" AFTER the
  // recurrence had already rewritten the matched engram to global, so the
  // same save that learn() absorbs was ALSO POSTed as a second team engram.
  it('1: learn() and learnRouted() agree when a shared save graduates a shared engram', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false, stores: [{ url: URL, token: 't', scope: TEAM, shared: true, readonly: false }],
    }))
    const posts: any[] = []
    globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push(JSON.parse(init!.body!))
        return { ok: true, status: 201, json: async () => ({ id: 'ENG-2026-09-29-950' }), text: async () => '' } as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as Response
    }) as any
    const plur = new Plur({ path: dir })
    const a = await plur.learnRouted('ship behind a flag', { scope: 'project:a' })
    await plur.learnRouted('ship behind a flag', { scope: 'project:b' })        // recurrence 1
    const r = await plur.learnRouted('ship behind a flag', { scope: TEAM })      // recurrence 2 → graduates
    expect(r.id).toBe(a.id)
    expect(r.scope).toBe('global')
    expect(posts).toHaveLength(0)   // absorbed, exactly as learn() does
  })

  // Finding 2: after one engram graduated, the next shared saves wrote a new
  // team copy that later graduated too — two global engrams, same statement.
  it('2: repeated shared saves never produce a second global engram with the same text', async () => {
    const plur = new Plur({ path: dir })
    for (const p of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      await plur.learn('document every breaking change', { scope: `project:${p}` })
    }
    const globals = (await plur.list()).filter(e => e.statement === 'document every breaking change' && e.scope === 'global')
    expect(globals).toHaveLength(1)
  })

  // Finding 3: the copy's id came from generateEngramId over a snapshot, not
  // the store's allocator, and the whole corpus was loaded to find/insert it.
  it('3: copy-on-promote uses the store id allocator and loads no corpus', async () => {
    const storeDir = tmp('plur-review-team-')
    await new Plur({ path: storeDir }).learn('pair on schema changes', { scope: TEAM })
    const store = new SeamStore()
    const plur = new Plur({ path: dir, store, autoDiscover: false } as any)
    await plur.ready()
    plur.addStore(join(storeDir, 'engrams.yaml'), TEAM, { shared: true, readonly: false })
    await plur.learn('pair on schema changes', { scope: 'project:a' })    // recurrence 1 (in the team file)
    store.fullLoads = 0
    store.nextIdCalls = 0
    const copy = await plur.learn('pair on schema changes', { scope: 'project:b' })
    expect(copy.scope).toBe('global')
    expect(store.nextIdCalls).toBe(1)
    expect(copy.id).toMatch(/-901$/)
    expect(store.fullLoads).toBe(0)
    expect(store.rows.some(e => e.id === copy.id)).toBe(true)
  })

  // Finding 4: the copy dropped the team engram's validity window, so an
  // expiring team engram produced a copy that never expired.
  it('4: the global copy carries the validity window and content anchors, not the pin', async () => {
    const storeDir = tmp('plur-review-team-')
    await new Plur({ path: storeDir }).learn('freeze merges during the audit', {
      scope: TEAM,
      valid_from: '2026-09-01',
      valid_until: '2099-12-31',
      pinned: true,
      knowledge_anchors: [{ path: 'docs/audit.md' }],
    } as any)
    const plur = new Plur({ path: dir })
    plur.addStore(join(storeDir, 'engrams.yaml'), TEAM, { shared: true, readonly: false })
    await plur.learn('freeze merges during the audit', { scope: 'project:a' })
    const copy = await plur.learn('freeze merges during the audit', { scope: 'project:b' })
    expect(copy.scope).toBe('global')
    expect(copy.temporal?.valid_from).toBe('2026-09-01')
    expect(copy.temporal?.valid_until).toBe('2099-12-31')
    expect((copy as any).knowledge_anchors?.[0]?.path).toBe('docs/audit.md')
    expect((copy as any).pinned).not.toBe(true)
  })
})
