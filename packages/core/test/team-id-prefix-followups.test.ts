/**
 * Review of #1576 (the H1 id-prefix fix), round 2.
 *
 *   - M1: an id that only LOOKS like an old-form store id — a pack id such as
 *     `ENG-PFR-001` while a store's old prefix is `PFR` — must be left alone.
 *   - The prefix is three letters plus EIGHT digest letters, and two configured
 *     scopes that still share one are refused for actions by namespaced id.
 *   - A store that answered the existence probe but whose fetch then failed is
 *     "cannot tell", never "does not hold it".
 *   - Tensions and injection records keyed by 0.21.0 (old-form) ids still match.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, storePrefix, legacyStorePrefix } from '../src/index.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'plur-prefix-r2-')); dirs.push(d); return d }

function row(id: string, scope: string, statement: string) {
  return {
    id, version: 2, status: 'active', consolidated: false, type: 'behavioral', scope, visibility: 'public', statement,
    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-10-01' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    associations: [], derivation_count: 1, tags: [], pack: null, abstract: null, derived_from: null, sources: [],
  }
}

/** A plur dir with path stores, each holding the given rows. */
function withPathStores(stores: Array<{ scope: string; rows: any[] }>): { dir: string; files: string[] } {
  const dir = tmp()
  const files = stores.map((s, i) => {
    const f = join(dir, `store-${i}.yaml`)
    writeFileSync(f, yaml.dump({ engrams: s.rows }))
    return f
  })
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({
    embeddings: { enabled: false }, index: false,
    stores: stores.map((s, i) => ({ path: files[i], scope: s.scope, readonly: false })),
  }))
  return { dir, files }
}

describe('M1: a pack id that only looks like an old-form store id is left alone', () => {
  it('rates the pack engram ENG-PFR-001 while a store scoped project:frontend (old prefix PFR) is configured', async () => {
    expect(legacyStorePrefix('project:frontend')).toBe('PFR')
    const { dir } = withPathStores([{ scope: 'project:frontend', rows: [] }])
    const packDir = join(dir, 'packs', 'fin'); mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'SKILL.md'), '---\nname: fin\nversion: "1.0"\nx-datacore:\n  id: fin\n  injection_policy: on_match\n  engram_count: 1\n---\n')
    writeFileSync(join(packDir, 'engrams.yaml'), yaml.dump({ engrams: [{ ...row('ENG-PFR-001', 'global', 'Pack engram PFR'), pack: 'fin', visibility: 'private' }] }))
    const plur = new Plur({ path: dir })
    expect((await plur.getById('ENG-PFR-001'))?.id).toBe('ENG-PFR-001')
    await plur.feedback('ENG-PFR-001', 'positive')
    const raw = yaml.load(readFileSync(join(packDir, 'engrams.yaml'), 'utf8')) as any
    expect(raw.engrams[0].feedback_signals.positive).toBe(1)
  })

  it('a dated old-form id with no row in the store is left unchanged, not rewritten', async () => {
    const { dir } = withPathStores([{ scope: 'project:frontend', rows: [] }])
    const plur = new Plur({ path: dir })
    await expect(plur.forget('ENG-PFR-2026-10-03-001')).rejects.toThrow(/ENG-PFR-2026-10-03-001/)
  })
})

describe('the prefix is three letters plus eight, and a remaining collision is refused', () => {
  // Found by brute force: the only pair among ~1.1M `group:acme/t<N>` scopes.
  const A = 'group:acme/t901721'
  const B = 'group:acme/t1094233'

  it('is eleven uppercase letters', () => {
    expect(storePrefix('group:plur/eng')).toMatch(/^GPL[A-Z]{8}$/)
  })

  it('two configured scopes sharing a prefix: an action by namespaced id is refused and changes nothing', async () => {
    expect(storePrefix(A)).toBe(storePrefix(B))
    const bare = 'ENG-2026-10-03-001'
    const { dir, files } = withPathStores([
      { scope: A, rows: [row(bare, A, 'team a rule')] },
      { scope: B, rows: [row(bare, B, 'team b rule')] },
    ])
    const plur = new Plur({ path: dir })
    const id = `ENG-${storePrefix(A)}-2026-10-03-001`
    await expect(plur.forget(id)).rejects.toThrow(/share the id prefix/)
    await expect(plur.feedback(id, 'positive')).rejects.toThrow(/share the id prefix/)
    for (const f of files) {
      const r = (yaml.load(readFileSync(f, 'utf8')) as any).engrams[0]
      expect(r.status).toBe('active')
      expect(r.feedback_signals.positive).toBe(0)
    }
  })
})

describe('a store whose probe succeeded but whose fetch failed is "cannot tell"', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('refuses an old-form id instead of resolving it to the other store', async () => {
    const ENG = 'group:acme/eng', OPS = 'group:acme/ops'
    const bare = 'ENG-2026-10-03-001'
    let aGets = 0
    const deletes: string[] = []
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string }) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const ok = (body: unknown, status = 200) =>
        ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() }) as unknown as Response
      if (u.includes(`/engrams/${bare}`)) {
        if (method === 'DELETE') { deletes.push(new URL(u).host); return ok({ id: bare, status: 'retired' }) }
        if (u.startsWith('https://a.')) {
          aGets++
          return aGets === 1 ? ok({ id: bare, scope: ENG, status: 'active', data: { statement: 'a row', type: 'behavioral' } }) : ok({ error: 'boom' }, 500)
        }
        return ok({ id: bare, scope: OPS, status: 'active', data: { statement: 'b row', type: 'behavioral' } })
      }
      return ok({ rows: [], total_count: 0 })
    }) as never
    const dir = tmp()
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      embeddings: { enabled: false }, index: false,
      stores: [
        { url: 'https://a.example.com/sse', token: 't', scope: ENG, shared: true, readonly: false },
        { url: 'https://b.example.com/sse', token: 't', scope: OPS, shared: true, readonly: false },
      ],
    }))
    const plur = new Plur({ path: dir })
    const legacy = `ENG-${legacyStorePrefix(OPS)}-2026-10-03-001`
    await expect(plur.forget(legacy)).rejects.toThrow(/could not be reached/)
    expect(deletes).toEqual([])
  })
})

describe('records keyed by a 0.21.0 (old-form) id still match', () => {
  const SCOPE = 'group:acme/eng'
  const bare = 'ENG-2026-10-03-001'

  it('a tension recorded under the old id still guards the engram under its new id', async () => {
    const { dir } = withPathStores([{ scope: SCOPE, rows: [row(bare, SCOPE, 'deploys on tuesdays')] }])
    const plur = new Plur({ path: dir })
    const oldId = `ENG-${legacyStorePrefix(SCOPE)}-2026-10-03-001`
    await plur.recordTensions([{ id_a: oldId, id_b: 'ENG-2026-10-01-009', statement_a: 'deploys on tuesdays', statement_b: 'deploys on fridays', confidence: 0.9, reason: 'day' }])
    expect(plur.hasUnresolvedTension(`ENG-${storePrefix(SCOPE)}-2026-10-03-001`)).toBe(true)
  })

  it('getByIds finds an engram by the old id an injection record holds, under that id', async () => {
    const { dir } = withPathStores([{ scope: SCOPE, rows: [row(bare, SCOPE, 'deploys on tuesdays')] }])
    const plur = new Plur({ path: dir })
    const oldId = `ENG-${legacyStorePrefix(SCOPE)}-2026-10-03-001`
    const got = await plur.getByIds([oldId])
    expect(got.map(e => [e.id, e.statement])).toEqual([[oldId, 'deploys on tuesdays']])
  })
})
