/**
 * PR-1 (#353) read-side scope visibility — ALL THREE read paths.
 *
 * The un-scoped WRITE default was reverted local→global, but the revert alone is
 * insufficient: the read filters hardcoded a `global`-only personal pass-through
 * and dropped other personal-family scopes (local, user:alice) under a
 * project-scope filter. This file proves that EVERY personal-family scope is
 * visible under a project-scope recall AND inject, on the DEFAULT indexed path
 * (config.index: true → storage-indexed.ts loadFiltered), plus the two
 * D1-RECALL/INJECT-ASYMMETRY behaviors.
 *
 * `recall` exercises the indexed SQL path (storage-indexed.ts:89). `inject`
 * exercises inject.ts scoreEngram. The non-indexed recall filter (index.ts:1812)
 * is exercised by the config.index:false sibling at the bottom.
 *
 * All tests use config.index:true (the production path) unless they explicitly
 * test the non-indexed branch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { isPersonalScope, isSharedScope, isScopeWithin } from '../src/scope-util.js'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
let hasSqlite = false
try { require('better-sqlite3'); hasSqlite = true } catch {}

const PROJECT = 'project:myapp'
// A statement and a recall query that share keywords so injection/recall surface it.
const STMT = (who: string) => `the deployment pipeline uses snake_case naming for ${who}`
const QUERY = 'deployment pipeline snake_case naming'

async function recallSeesId(plur: Plur, scope: string, id: string): Promise<boolean> {
  return (await plur.recall(QUERY, { scope })).some(e => e.id === id)
}
async function injectSeesId(plur: Plur, scope: string, id: string): Promise<boolean> {
  const res = await plur.inject(QUERY, { scope })
  return res.injected_ids.includes(id)
}

describe.skipIf(!hasSqlite)('PR-1 read-side scope visibility (indexed path, #353)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-readside-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: true }, { noRefs: true }))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('predicate sanity: personal-family scopes are personal, shared are not', () => {
    for (const s of ['local', 'global', 'user:alice', 'agent:bot', 'user:alice:notes']) {
      expect(isPersonalScope(s)).toBe(true)
      expect(isSharedScope(s)).toBe(false)
    }
    for (const s of ['group:x', 'project:y', 'space:z', 'team:t', 'org:o', 'public']) {
      expect(isSharedScope(s)).toBe(true)
      expect(isPersonalScope(s)).toBe(false)
    }
  })

  // --- REGRESSION HIGH-7/8: global visible under project-scope ---
  it('a global-scoped engram IS visible under project-scope recall AND inject', async () => {
    const e = await plur.learn(STMT('global'), { scope: 'global' })
    expect(await recallSeesId(plur, PROJECT, e.id)).toBe(true)
    expect(await injectSeesId(plur, PROJECT, e.id)).toBe(true)
  })

  // --- REGRESSION local invisibility: was 0 before ---
  it('a local-scoped engram IS visible under project-scope recall AND inject', async () => {
    const e = await plur.learn(STMT('local'), { scope: 'local' })
    expect(await recallSeesId(plur, PROJECT, e.id)).toBe(true)
    expect(await injectSeesId(plur, PROJECT, e.id)).toBe(true)
  })

  // --- REGRESSION non-two-value personal: user:alice ---
  it('a user:alice-scoped engram IS visible under project-scope recall AND inject', async () => {
    const e = await plur.learn(STMT('useralice'), { scope: 'user:alice' })
    expect(await recallSeesId(plur, PROJECT, e.id)).toBe(true)
    expect(await injectSeesId(plur, PROJECT, e.id)).toBe(true)
  })

  // --- A genuinely-shared NON-matching scope is still excluded ---
  it('a group:other shared engram is NOT visible under a different project-scope filter', async () => {
    const e = await plur.learn(STMT('grpother'), { scope: 'group:other/team' })
    expect(await recallSeesId(plur, PROJECT, e.id)).toBe(false)
    expect(await injectSeesId(plur, PROJECT, e.id)).toBe(false)
  })

  // --- END-TO-END: no scope → lands global → visible in project session ---
  it('end-to-end: unscoped learn lands global and appears in a project-scoped recall AND inject', async () => {
    const e = await plur.learn(STMT('e2e')) // no scope → defaults to global
    expect(e.scope).toBe('global')
    expect(await recallSeesId(plur, PROJECT, e.id)).toBe(true)
    expect(await injectSeesId(plur, PROJECT, e.id)).toBe(true)
  })

  // --- INDEXED-PATH explicit assertion: loadFiltered returns personal scopes ---
  it('indexedStorage.loadFiltered (default) returns personal-family scopes under a project filter', async () => {
    const g = await plur.learn(STMT('idxg'), { scope: 'global' })
    const l = await plur.learn(STMT('idxl'), { scope: 'local' })
    const u = await plur.learn(STMT('idxu'), { scope: 'user:alice' })
    // list() → _filterEngrams → indexedStorage.loadFiltered when index:true
    const visible = (await plur.list({ scope: PROJECT })).map(e => e.id)
    expect(visible).toContain(g.id)
    expect(visible).toContain(l.id)
    expect(visible).toContain(u.id)
  })

  // --- D1-ASYMMETRY (2 tests) ---
  it('D1-ASYMMETRY (a): explicit scope=global RECALL includes a local-scoped engram', async () => {
    const l = await plur.learn(STMT('asymrecall'), { scope: 'local' })
    expect(await recallSeesId(plur, 'global', l.id)).toBe(true)
  })

  it('D1-ASYMMETRY (b): explicit scope=global INJECT does NOT include a local-scoped engram', async () => {
    const l = await plur.learn(STMT('asyminject'), { scope: 'local' })
    // global inject is targeted to the global namespace only (INJECT_GLOBAL_IS_TARGETED)
    expect(await injectSeesId(plur, 'global', l.id)).toBe(false)
    // …while a global-scoped engram IS surfaced by the same global inject.
    const g = await plur.learn(STMT('asyminjectg'), { scope: 'global' })
    expect(await injectSeesId(plur, 'global', g.id)).toBe(true)
  })

  // --- DELIBERATE-LOCAL: unscoped_default:'local' still visible under project scope ---
  it('DELIBERATE-LOCAL: with unscoped_default:local a local engram is still visible under project-scope recall/inject', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'plur-readside-local-'))
    writeFileSync(join(dir2, 'config.yaml'), yaml.dump({ index: true, unscoped_default: 'local' }, { noRefs: true }))
    const p2 = new Plur({ path: dir2 })
    try {
      const e = await p2.learn(STMT('delibloc')) // no scope → local under this config
      expect(e.scope).toBe('local')
      expect(await recallSeesId(p2, PROJECT, e.id)).toBe(true)
      expect(await injectSeesId(p2, PROJECT, e.id)).toBe(true)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})

// --- Non-indexed read filter (index.ts:1812) ---
describe('PR-1 read-side scope visibility (NON-indexed path, #353)', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-readside-noidx-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false }, { noRefs: true }))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('local, global, and user:alice are all visible under a project-scope recall (non-indexed)', async () => {
    const g = await plur.learn(STMT('niG'), { scope: 'global' })
    const l = await plur.learn(STMT('niL'), { scope: 'local' })
    const u = await plur.learn(STMT('niU'), { scope: 'user:alice' })
    const ids = (await plur.recall(QUERY, { scope: PROJECT })).map(e => e.id)
    expect(ids).toContain(g.id)
    expect(ids).toContain(l.id)
    expect(ids).toContain(u.id)
  })

  it('explicit personal sub-scope (user:alice) still catches its sub-scopes via startsWith (non-indexed)', async () => {
    const sub = await plur.learn(STMT('niSub'), { scope: 'user:alice:notes' })
    // recalling with scope user:alice must include user:alice:notes (startsWith arm)
    const ids = (await plur.recall(QUERY, { scope: 'user:alice' })).map(e => e.id)
    expect(ids).toContain(sub.id)
  })
})

// --- #383: segment-aware scope membership — no sibling-prefix bleed ---
describe('#383 isScopeWithin predicate', () => {
  it('matches a descendant only on a real delimiter (`:` / `/`), never a string-prefix sibling', () => {
    // exact + true descendants
    expect(isScopeWithin('project:app', 'project:app')).toBe(true)
    expect(isScopeWithin('project:app:sub', 'project:app')).toBe(true)
    expect(isScopeWithin('project:app/x', 'project:app')).toBe(true)
    expect(isScopeWithin('group:plur/eng/team', 'group:plur/eng')).toBe(true)
    // sibling string-prefixes must NOT match (the leak)
    expect(isScopeWithin('project:application', 'project:app')).toBe(false)
    expect(isScopeWithin('project:app-secret', 'project:app')).toBe(false)
    expect(isScopeWithin('group:plur/eng-private', 'group:plur/eng')).toBe(false)
  })
})

// End-to-end isolation across BOTH read paths (indexed SQL + non-indexed filter)
// and BOTH directions, asserting true descendants stay visible. (#383)
for (const indexed of [true, false]) {
  const label = indexed ? 'indexed' : 'non-indexed'
  const block = indexed ? describe.skipIf(!hasSqlite) : describe
  block(`#383 sibling-prefix scope isolation (${label} path)`, () => {
    let dir: string
    let plur: Plur

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'plur-383-'))
      writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: indexed }, { noRefs: true }))
      plur = new Plur({ path: dir })
    })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('a string-prefix sibling is NOT visible under the shorter scope (recall + inject + list)', async () => {
      const collide = await plur.learn(STMT('collide'), { scope: 'project:application' })
      expect(await recallSeesId(plur, 'project:app', collide.id)).toBe(false)
      expect(await injectSeesId(plur, 'project:app', collide.id)).toBe(false)
      expect((await plur.list({ scope: 'project:app' })).map(e => e.id)).not.toContain(collide.id)
    })

    it('the reverse direction is isolated too (group:plur/eng-private under group:plur/eng)', async () => {
      const priv = await plur.learn(STMT('grppriv'), { scope: 'group:plur/eng-private' })
      expect(await recallSeesId(plur, 'group:plur/eng', priv.id)).toBe(false)
      expect(await injectSeesId(plur, 'group:plur/eng', priv.id)).toBe(false)
    })

    it('a true descendant (project:app:sub) IS still visible under the parent scope', async () => {
      const sub = await plur.learn(STMT('appsub'), { scope: 'project:app:sub' })
      expect(await recallSeesId(plur, 'project:app', sub.id)).toBe(true)
      expect(await injectSeesId(plur, 'project:app', sub.id)).toBe(true)
    })

    it('an exact-scope engram remains visible (sanity)', async () => {
      const exact = await plur.learn(STMT('exact'), { scope: 'project:app' })
      expect(await recallSeesId(plur, 'project:app', exact.id)).toBe(true)
      expect(await injectSeesId(plur, 'project:app', exact.id)).toBe(true)
    })
  })
}
