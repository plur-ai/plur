/**
 * Scope pushdown — the non-PGLite read paths (Phase 3).
 *
 * The PGLite adapter is covered in pglite-scope-pushdown.test.ts. This file
 * covers the other two places a permitted-scope allow-list can be honoured or
 * silently dropped:
 *
 *   1. `scopeAllowFilter` — the shared predicate every in-memory path uses.
 *   2. `IndexedStorage.loadFiltered` — the legacy better-sqlite3 index; the
 *      filter must run in SQL (`scope IN (…)`), not after the query.
 *   3. `Plur.list({ scopes })` — the YAML/in-memory read path, so the default
 *      no-index configuration is not the one backend that ignores the filter.
 *
 * The invariant across all three: absent = unrestricted, `[]` = NOTHING,
 * non-empty = EXACT membership (no hierarchy expansion, no personal-family
 * pass-through).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildFilterClause } from '../src/storage-postgres.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { IndexedStorage } from '../src/storage-indexed.js'
import { scopeAllowFilter } from '../src/scope-util.js'
import type { Engram } from '../src/schemas/engram.js'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
let hasSqlite = false
try { require('better-sqlite3'); hasSqlite = true } catch { /* optional dep */ }

function mkEngram(id: string, statement: string, opts: Partial<Engram> = {}): Engram {
  return {
    id,
    statement,
    type: opts.type ?? 'behavioral',
    scope: opts.scope ?? 'project:plur',
    domain: opts.domain ?? 'plur.test',
    status: opts.status ?? 'active',
    tags: opts.tags ?? [],
    activation: {
      retrieval_strength: 1.0,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: '2026-07-26',
    },
    feedback_signals: opts.feedback_signals ?? { positive: 0, negative: 0, neutral: 0 },
  } as Engram
}

function seedYaml(path: string, engrams: Engram[]): void {
  writeFileSync(path, yaml.dump({ engrams }), 'utf8')
}

describe('scopeAllowFilter — the shared allow-list predicate', () => {
  it('REGRESSION GUARD: undefined means unrestricted', () => {
    const allow = scopeAllowFilter(undefined)
    for (const s of ['global', 'local', 'project:a', 'group:x/y', 'user:alice']) {
      expect(allow(s)).toBe(true)
    }
  })

  it('SECURITY: an empty list matches NOTHING — it is never widened to "no filter"', () => {
    const allow = scopeAllowFilter([])
    for (const s of ['global', 'local', 'project:a', 'group:x/y', 'user:alice', '']) {
      expect(allow(s)).toBe(false)
    }
  })

  it('matches exactly the listed scopes', () => {
    const allow = scopeAllowFilter(['project:a', 'group:x/y'])
    expect(allow('project:a')).toBe(true)
    expect(allow('group:x/y')).toBe(true)
    expect(allow('project:b')).toBe(false)
  })

  it('does NOT expand descendants and does NOT pass personal-family scopes through', () => {
    const allow = scopeAllowFilter(['project:a'])
    expect(allow('project:a:sub')).toBe(false)
    expect(allow('project:a/sub')).toBe(false)
    expect(allow('project:application')).toBe(false) // sibling string-prefix
    expect(allow('global')).toBe(false)
    expect(allow('local')).toBe(false)
    expect(allow('user:alice')).toBe(false)
  })
})

describe.skipIf(!hasSqlite)('IndexedStorage.loadFiltered — permitted-scope pushdown', () => {
  let dir: string
  let yamlPath: string
  let dbPath: string
  let store: IndexedStorage

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-scope-idx-'))
    yamlPath = join(dir, 'engrams.yaml')
    dbPath = join(dir, 'engrams.db')
  })

  afterEach(() => {
    if (store) store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function seedAndOpen(engrams: Engram[]): Promise<IndexedStorage> {
    seedYaml(yamlPath, engrams)
    store = new IndexedStorage(yamlPath, dbPath)
    await store.reindex()
    return store
  }

  const BASE = [
    mkEngram('ENG-2026-0726-001', 'alpha', { scope: 'project:a' }),
    mkEngram('ENG-2026-0726-002', 'alpha sub', { scope: 'project:a:sub' }),
    mkEngram('ENG-2026-0726-003', 'beta', { scope: 'project:b' }),
    mkEngram('ENG-2026-0726-004', 'global', { scope: 'global' }),
    mkEngram('ENG-2026-0726-005', 'local', { scope: 'local' }),
  ]

  it('REGRESSION GUARD: omitting scopes returns exactly what it returned before', async () => {
    const s = await seedAndOpen(BASE)
    expect((await s.loadFiltered({})).length).toBe(5)
    expect((await s.loadFiltered({ status: 'active' })).length).toBe(5)
    expect((await s.loadFiltered({ scopes: undefined })).map(e => e.id).sort())
      .toEqual((await s.loadFiltered({})).map(e => e.id).sort())
  })

  it('SECURITY: an empty permitted-scope list matches NOTHING', async () => {
    const s = await seedAndOpen(BASE)
    expect(await s.loadFiltered({ scopes: [] })).toEqual([])
    expect(await s.loadFiltered({ status: 'active', scopes: [] })).toEqual([])
    // Combined with the visibility filter, which on its own returns rows.
    expect((await s.loadFiltered({ scope: 'project:a' })).length).toBeGreaterThan(0)
    expect(await s.loadFiltered({ scope: 'project:a', scopes: [] })).toEqual([])
  })

  it('restricts to exactly the listed scopes', async () => {
    const s = await seedAndOpen(BASE)
    expect((await s.loadFiltered({ scopes: ['project:a'] })).map(e => e.id)).toEqual(['ENG-2026-0726-001'])
    expect((await s.loadFiltered({ scopes: ['project:a', 'project:b'] })).map(e => e.id).sort())
      .toEqual(['ENG-2026-0726-001', 'ENG-2026-0726-003'])
  })

  it('does NOT expand the hierarchy and does NOT pass personal scopes through', async () => {
    const s = await seedAndOpen(BASE)
    const ids = (await s.loadFiltered({ scopes: ['project:a'] })).map(e => e.id)
    expect(ids).not.toContain('ENG-2026-0726-002') // project:a:sub
    expect(ids).not.toContain('ENG-2026-0726-004') // global
    expect(ids).not.toContain('ENG-2026-0726-005') // local
    // Contrast: `scope` (visibility) DOES expand + pass personal through.
    const visIds = (await s.loadFiltered({ scope: 'project:a' })).map(e => e.id)
    expect(visIds).toContain('ENG-2026-0726-002')
    expect(visIds).toContain('ENG-2026-0726-004')
    expect(visIds).toContain('ENG-2026-0726-005')
  })

  it('composes with status and domain as an AND (intersection)', async () => {
    const s = await seedAndOpen([
      mkEngram('ENG-2026-0726-010', 'x', { scope: 'project:a', domain: 'plur.search', status: 'active' }),
      mkEngram('ENG-2026-0726-011', 'x', { scope: 'project:a', domain: 'plur.search', status: 'retired' }),
      mkEngram('ENG-2026-0726-012', 'x', { scope: 'project:a', domain: 'other.thing', status: 'active' }),
      mkEngram('ENG-2026-0726-013', 'x', { scope: 'project:b', domain: 'plur.search', status: 'active' }),
    ])
    expect((await s.loadFiltered({ status: 'active', domain: 'plur', scopes: ['project:a', 'project:b'] }))
      .map(e => e.id).sort()).toEqual(['ENG-2026-0726-010', 'ENG-2026-0726-013'])
    expect(await s.loadFiltered({ scope: 'project:a', scopes: ['project:b'] })).toEqual([])
  })

  it('DILUTION: a corpus dominated by out-of-scope rows still yields every in-scope row', async () => {
    const engrams: Engram[] = []
    for (let i = 0; i < 100; i++) {
      engrams.push(mkEngram(`ENG-2026-0726-O${String(i).padStart(3, '0')}`, `other ${i}`, { scope: 'project:other' }))
    }
    for (let j = 0; j < 20; j++) {
      engrams.push(mkEngram(`ENG-2026-0726-M${String(j).padStart(3, '0')}`, `mine ${j}`, { scope: 'project:mine' }))
    }
    const s = await seedAndOpen(engrams)
    const mine = await s.loadFiltered({ status: 'active', scopes: ['project:mine'] })
    expect(mine.length).toBe(20)
    expect(mine.every(e => e.scope === 'project:mine')).toBe(true)
  })

  // --- #775: mounted-scope visibility grants ---

  const GRANTS_CORPUS = [
    mkEngram('ENG-2026-0730-101', 'project row', { scope: 'project:a' }),
    mkEngram('ENG-2026-0730-102', 'personal row', { scope: 'global' }),
    mkEngram('ENG-2026-0730-103', 'team row', { scope: 'group:acme/eng' }),
    mkEngram('ENG-2026-0730-104', 'team sub row', { scope: 'group:acme/eng/sub' }),
    mkEngram('ENG-2026-0730-105', 'team sibling row', { scope: 'group:acme/eng-private' }),
    mkEngram('ENG-2026-0730-106', 'other team row', { scope: 'group:other/team' }),
  ]

  it('#775: visibilityGrants admit the granted scope AND its true descendants under a scope filter', async () => {
    const s = await seedAndOpen(GRANTS_CORPUS)
    const ids = (await s.loadFiltered({ scope: 'project:a', visibilityGrants: ['group:acme/eng'] }))
      .map(e => e.id)
    expect(ids).toContain('ENG-2026-0730-101') // the filter scope itself
    expect(ids).toContain('ENG-2026-0730-102') // personal pass-through, unchanged
    expect(ids).toContain('ENG-2026-0730-103') // the granted scope
    expect(ids).toContain('ENG-2026-0730-104') // its true descendant
    expect(ids, 'sibling string-prefix leaked through a grant (#383)').not.toContain('ENG-2026-0730-105')
    expect(ids, 'an ungranted shared scope leaked').not.toContain('ENG-2026-0730-106')
  })

  it('#775: grants are inert without a scope filter — visibility only widens visibility', async () => {
    const s = await seedAndOpen(GRANTS_CORPUS)
    const withGrants = (await s.loadFiltered({ visibilityGrants: ['group:acme/eng'] })).map(e => e.id).sort()
    const without = (await s.loadFiltered({})).map(e => e.id).sort()
    expect(withGrants).toEqual(without)
  })

  it('#775 SECURITY: grants never widen the scopes authorization allow-list', async () => {
    const s = await seedAndOpen(GRANTS_CORPUS)
    // The allow-list omits the granted scope: the team row must stay out.
    const ids = (await s.loadFiltered({
      scope: 'project:a',
      scopes: ['project:a'],
      visibilityGrants: ['group:acme/eng'],
    })).map(e => e.id)
    expect(ids).toEqual(['ENG-2026-0730-101'])
    // And the empty allow-list still matches NOTHING, grants or no grants.
    expect(await s.loadFiltered({ scopes: [], visibilityGrants: ['group:acme/eng'] })).toEqual([])
  })

  it('#775 SECURITY: LIKE metacharacters in a grant match literally on the SQLite arm', async () => {
    // Same treatment as the pglite/postgres arms (escapeLikePattern +
    // ESCAPE '\'): SQLite's LIKE has NO default escape character, so without
    // the explicit clause a `_` in a grant is a single-character wildcard and
    // a `%` matches across namespaces — a grant of `group:acme/e_g` would
    // admit `group:acme/eXg:*`, and `group:%` would admit every group.
    const s = await seedAndOpen([
      mkEngram('ENG-2026-0731-301', 'exact underscore', { scope: 'group:acme/e_g' }),
      mkEngram('ENG-2026-0731-302', 'true descendant', { scope: 'group:acme/e_g:sub' }),
      mkEngram('ENG-2026-0731-303', 'wildcard victim', { scope: 'group:acme/eXg:sub' }),
      mkEngram('ENG-2026-0731-304', 'percent victim', { scope: 'group:evil/team:sub' }),
    ])
    const underscore = (await s.loadFiltered({
      scope: 'project:a',
      visibilityGrants: ['group:acme/e_g'],
    })).map(e => e.id)
    expect(underscore).toContain('ENG-2026-0731-301') // equality arm keeps the raw value
    expect(underscore).toContain('ENG-2026-0731-302') // escaped containment still matches literally
    expect(underscore, 'unescaped `_` widened a grant into a sibling namespace')
      .not.toContain('ENG-2026-0731-303')
    const percent = (await s.loadFiltered({
      scope: 'project:a',
      visibilityGrants: ['group:%'],
    })).map(e => e.id)
    expect(percent, 'unescaped `%` in a grant matched across namespaces')
      .not.toContain('ENG-2026-0731-304')
    expect(percent).not.toContain('ENG-2026-0731-303')
  })

  it('#775 SECURITY: LIKE metacharacters in the filter scope match literally too', async () => {
    const s = await seedAndOpen([
      mkEngram('ENG-2026-0731-310', 'literal target', { scope: 'project:a_b:sub' }),
      mkEngram('ENG-2026-0731-311', 'wildcard victim', { scope: 'project:aXb:sub' }),
    ])
    const ids = (await s.loadFiltered({ scope: 'project:a_b' })).map(e => e.id)
    expect(ids).toContain('ENG-2026-0731-310')
    expect(ids, 'unescaped `_` in the filter scope crossed namespaces')
      .not.toContain('ENG-2026-0731-311')
  })
})

describe('Plur read paths — permitted-scope pushdown', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-scope-list-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * `index: false` exercises the in-memory YAML branch of _filterEngrams;
   * `index: true` exercises IndexedStorage.loadFiltered. Both must agree.
   */
  async function makePlur(indexed: boolean): Promise<Plur> {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: indexed }, { noRefs: true }))
    const plur = new Plur({ path: dir })
    await plur.learn('the deployment pipeline uses snake_case for alpha', { scope: 'project:a' })
    await plur.learn('the deployment pipeline uses snake_case for alpha sub', { scope: 'project:a:sub' })
    await plur.learn('the deployment pipeline uses snake_case for beta', { scope: 'project:b' })
    await plur.learn('the deployment pipeline uses snake_case for everyone', { scope: 'global' })
    await plur.learn('the deployment pipeline uses snake_case for me', { scope: 'local' })
    return plur
  }

  const modes: Array<[string, boolean]> = hasSqlite
    ? [['yaml path (index:false)', false], ['indexed path (index:true)', true]]
    : [['yaml path (index:false)', false]]

  for (const [label, indexed] of modes) {
    describe(label, () => {
      it('REGRESSION GUARD: omitting scopes lists the whole active corpus', async () => {
        const plur = await makePlur(indexed)
        expect((await plur.list()).length).toBe(5)
        expect((await plur.list({ scopes: undefined })).length).toBe(5)
      })

      it('SECURITY: an empty permitted-scope list lists NOTHING', async () => {
        const plur = await makePlur(indexed)
        expect(await plur.list({ scopes: [] })).toEqual([])
      })

      it('lists exactly the listed scopes — no descendants, no personal pass-through', async () => {
        const plur = await makePlur(indexed)
        const scopes = (await plur.list({ scopes: ['project:a'] })).map(e => e.scope)
        expect(scopes).toEqual(['project:a'])
      })

      it('composes with the visibility scope filter as an intersection', async () => {
        const plur = await makePlur(indexed)
        // `scope: project:a` alone is wide (descendants + personal pass-through)…
        expect((await plur.list({ scope: 'project:a' })).length).toBeGreaterThan(1)
        // …and intersecting it with an allow-list can only narrow it.
        expect(await plur.list({ scope: 'project:a', scopes: ['project:b'] })).toEqual([])
        expect((await plur.list({ scope: 'project:a', scopes: ['project:a'] })).map(e => e.scope))
          .toEqual(['project:a'])
      })
    })
  }
})

describe('LIKE metacharacters in a caller-supplied scope or domain', () => {
  // `buildFilterClause` puts `filter.scope` and `filter.domain` into LIKE
  // patterns. Unescaped, a caller's `%` WIDENS the match instead of narrowing
  // it — verified against a live database: `{ domain: '%' }` returned every
  // domain, and `{ scope: '%' }` returned engrams from two unrelated groups,
  // which is precisely the segment-aware containment the #383 guard exists to
  // enforce.
  //
  // Both adapters are checked, because the scope rules have drifted between the
  // Postgres and PGLite copies before and that drift was an authorization
  // bypass.
  it('a wildcard domain matches literally, not everything', () => {
    const { where, params } = buildFilterClause({ status: 'active', domain: '%' })
    expect(where).toMatch(/ESCAPE/)
    expect(params).toContain('\\%')
  })

  it('a wildcard scope matches literally, not across namespaces', () => {
    const { where, params } = buildFilterClause({ status: 'active', scope: '%' })
    expect(where).toMatch(/ESCAPE/)
    // The equality arm keeps the raw value; the two LIKE arms are escaped.
    expect(params.filter(p => p === '\\%').length).toBe(2)
  })

  it('an underscore is escaped too — it is LIKE\'s single-character wildcard', () => {
    const { params } = buildFilterClause({ status: 'active', domain: 'ops_deploy' })
    expect(params).toContain('ops\\_deploy')
  })

  it('an ordinary scope is unchanged', () => {
    const { params } = buildFilterClause({ status: 'active', domain: 'ops/deploy' })
    expect(params).toContain('ops/deploy')
  })
})

describe('buildFilterClause — mounted-scope visibility grants (#775)', () => {
  it('each grant appends one segment-aware containment triple to the visibility clause', () => {
    const { where, params } = buildFilterClause({
      scope: 'project:a',
      visibilityGrants: ['group:acme/eng'],
    })
    // 3 params for the filter scope + 3 per grant, in order.
    expect(params).toEqual([
      'project:a', 'project:a', 'project:a',
      'group:acme/eng', 'group:acme/eng', 'group:acme/eng',
    ])
    // Two LIKE arms per triple, all escaped.
    expect((where.match(/LIKE \$\d+ \|\| ':%' ESCAPE/g) ?? []).length).toBe(2)
    expect((where.match(/LIKE \$\d+ \|\| '\/%' ESCAPE/g) ?? []).length).toBe(2)
  })

  it('a wildcard grant matches literally, not across namespaces', () => {
    const { params } = buildFilterClause({ scope: 'project:a', visibilityGrants: ['group:%'] })
    // The equality arm keeps the raw grant; both LIKE arms are escaped.
    expect(params.filter(p => p === 'group:%').length).toBe(1)
    expect(params.filter(p => p === 'group:\\%').length).toBe(2)
  })

  it('grants without a scope filter contribute nothing', () => {
    const bare = buildFilterClause({ status: 'active' })
    const granted = buildFilterClause({ status: 'active', visibilityGrants: ['group:acme/eng'] })
    expect(granted.where).toBe(bare.where)
    expect(granted.params).toEqual(bare.params)
  })

  it('grants never touch the scopes authorization clause', () => {
    const { where, params } = buildFilterClause({ scopes: [], visibilityGrants: ['group:acme/eng'] })
    // The empty allow-list still compiles to `= ANY` over the empty array —
    // matching nothing — and no grant parameter appears anywhere.
    expect(where).toContain('= ANY')
    expect(params).toEqual([[]])
  })
})
