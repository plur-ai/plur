/**
 * Every backend's read-side scope filter returns exactly the rows the in-memory
 * visibility predicate (makeVisibilityPredicate) admits, including scopes whose
 * case differs from the canonical prefix (`Group:x`, `PROJECT:plur:sub`).
 *
 * isSharedScope case-folds the family prefix, isScopeWithin compares exactly.
 * The SQL arms must do the same: Postgres LIKE is case-sensitive (so a
 * `Group:` row must not pass as personal), SQLite LIKE is case-insensitive
 * (so `PROJECT:plur:sub` must not pass as a descendant of `project:plur`).
 * Model: spec/formal/PlurSpec/BackendScopes.lean.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import yaml from 'js-yaml'
import { PGLiteAdapter } from '../src/storage-pglite.js'
import { IndexedStorage } from '../src/storage-indexed.js'
import { buildFilterClause } from '../src/storage-postgres.js'
import { makeVisibilityPredicate } from '../src/scope-util.js'
import type { StorageFilter } from '../src/storage-adapter.js'
import type { Engram } from '../src/schemas/engram.js'

const require = createRequire(import.meta.url)
let hasSqlite = false
try { require('better-sqlite3'); hasSqlite = true } catch { /* optional dep */ }

const TIMEOUT = 60_000

const SCOPES = [
  'global', 'local', 'user:alice', 'agent:bot', 'public-roadmap',
  'group:other', 'Group:other', 'GROUP:acme', 'Project:other', 'SPACE:x', 'Team:t', 'Org:o',
  'Public', 'PUBLIC:x', 'public/y',
  'project:plur', 'project:plur:sub', 'project:plur/x', 'project:plurality',
  'PROJECT:plur', 'Project:plur:sub', 'project:PLUR/x',
  'group:acme', 'group:acme/eng', 'Group:acme/eng', 'group:ACME:x', 'group:acmex',
]

const DOMAINS = ['plur.core', 'Plur.core', 'plurXcore', 'other']

function mk(i: number, scope: string, domain: string): Engram {
  return {
    id: `ENG-2026-1101-${String(i).padStart(3, '0')}`,
    statement: `row ${i} ${scope}`,
    type: 'behavioral',
    scope,
    domain,
    status: 'active',
    tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-10-01' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

const CORPUS: Engram[] = []
SCOPES.forEach((s, i) => CORPUS.push(mk(i, s, 'plur.core')))
DOMAINS.forEach((d, j) => CORPUS.push(mk(100 + j, 'global', d)))

const FILTERS: Array<[string, StorageFilter]> = [
  ['project scope', { scope: 'project:plur' }],
  ['project scope + grant', { scope: 'project:plur', visibilityGrants: ['group:acme'] }],
  ['domain', { domain: 'plur.core' }],
  ['domain with a LIKE wildcard', { domain: 'plur_core' }],
]

/** The in-memory read path (recall.ts): scope via the shared predicate, domain via startsWith. */
function expected(f: StorageFilter): string[] {
  return CORPUS.filter(e =>
    (!f.scope || makeVisibilityPredicate(f.scope, f.visibilityGrants)(e.scope))
    && (!f.domain || (e.domain ?? '').startsWith(f.domain)),
  ).map(e => e.id).sort()
}

const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort()

describe('backend scope filters agree with the in-memory predicate', () => {
  let dir: string
  let yamlPath: string
  let pglite: PGLiteAdapter
  let rawPg: any
  let sqlite: IndexedStorage | undefined

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-scopes-'))
    yamlPath = join(dir, 'engrams.yaml')
    writeFileSync(yamlPath, yaml.dump({ engrams: CORPUS }), 'utf8')
    pglite = new PGLiteAdapter(yamlPath, join(dir, 'store.pglite'), { vectorDim: 8 })
    await pglite.reindex()
    const { PGlite } = await import('@electric-sql/pglite')
    rawPg = new PGlite()
    await rawPg.exec('CREATE TABLE engrams (id text PRIMARY KEY, status text, scope text, domain text)')
    for (const e of CORPUS) {
      await rawPg.query('INSERT INTO engrams VALUES ($1, $2, $3, $4)', [e.id, e.status, e.scope, e.domain])
    }
    if (hasSqlite) {
      sqlite = new IndexedStorage(yamlPath, join(dir, 'engrams.db'))
      await sqlite.reindex()
    }
  }, TIMEOUT)

  afterAll(async () => {
    await pglite?.close()
    await rawPg?.close()
    sqlite?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  for (const [name, f] of FILTERS) {
    it(`PGLite adapter: ${name}`, async () => {
      expect(ids(await pglite.loadFiltered(f))).toEqual(expected(f))
    }, TIMEOUT)

    it(`Postgres clause run on a real Postgres engine: ${name}`, async () => {
      const { where, params } = buildFilterClause(f)
      const res = await rawPg.query(`SELECT id FROM engrams ${where}`, params)
      expect(ids(res.rows)).toEqual(expected(f))
    }, TIMEOUT)

    it.skipIf(!hasSqlite)(`SQLite index: ${name}`, async () => {
      expect(ids(await sqlite!.loadFiltered(f))).toEqual(expected(f))
    }, TIMEOUT)
  }

  it('the corpus exercises both directions of the divergence', () => {
    const see = makeVisibilityPredicate('project:plur')
    expect(see('Group:other')).toBe(false)
    expect(see('Project:plur:sub')).toBe(false)
    expect(see('user:alice')).toBe(true)
    expect(see('project:plur/x')).toBe(true)
  })
})
