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
import { isPersonalScope, isSharedScope } from '../src/scope-util.js'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
let hasSqlite = false
try { require('better-sqlite3'); hasSqlite = true } catch {}

const PROJECT = 'project:myapp'
// A statement and a recall query that share keywords so injection/recall surface it.
const STMT = (who: string) => `the deployment pipeline uses snake_case naming for ${who}`
const QUERY = 'deployment pipeline snake_case naming'

function recallSeesId(plur: Plur, scope: string, id: string): boolean {
  return plur.recall(QUERY, { scope }).some(e => e.id === id)
}
function injectSeesId(plur: Plur, scope: string, id: string): boolean {
  const res = plur.inject(QUERY, { scope })
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
  it('a global-scoped engram IS visible under project-scope recall AND inject', () => {
    const e = plur.learn(STMT('global'), { scope: 'global' })
    expect(recallSeesId(plur, PROJECT, e.id)).toBe(true)
    expect(injectSeesId(plur, PROJECT, e.id)).toBe(true)
  })

  // --- REGRESSION local invisibility: was 0 before ---
  it('a local-scoped engram IS visible under project-scope recall AND inject', () => {
    const e = plur.learn(STMT('local'), { scope: 'local' })
    expect(recallSeesId(plur, PROJECT, e.id)).toBe(true)
    expect(injectSeesId(plur, PROJECT, e.id)).toBe(true)
  })

  // --- REGRESSION non-two-value personal: user:alice ---
  it('a user:alice-scoped engram IS visible under project-scope recall AND inject', () => {
    const e = plur.learn(STMT('useralice'), { scope: 'user:alice' })
    expect(recallSeesId(plur, PROJECT, e.id)).toBe(true)
    expect(injectSeesId(plur, PROJECT, e.id)).toBe(true)
  })

  // --- A genuinely-shared NON-matching scope is still excluded ---
  it('a group:other shared engram is NOT visible under a different project-scope filter', () => {
    const e = plur.learn(STMT('grpother'), { scope: 'group:other/team' })
    expect(recallSeesId(plur, PROJECT, e.id)).toBe(false)
    expect(injectSeesId(plur, PROJECT, e.id)).toBe(false)
  })

  // --- END-TO-END: no scope → lands global → visible in project session ---
  it('end-to-end: unscoped learn lands global and appears in a project-scoped recall AND inject', () => {
    const e = plur.learn(STMT('e2e')) // no scope → defaults to global
    expect(e.scope).toBe('global')
    expect(recallSeesId(plur, PROJECT, e.id)).toBe(true)
    expect(injectSeesId(plur, PROJECT, e.id)).toBe(true)
  })

  // --- INDEXED-PATH explicit assertion: loadFiltered returns personal scopes ---
  it('indexedStorage.loadFiltered (default) returns personal-family scopes under a project filter', () => {
    const g = plur.learn(STMT('idxg'), { scope: 'global' })
    const l = plur.learn(STMT('idxl'), { scope: 'local' })
    const u = plur.learn(STMT('idxu'), { scope: 'user:alice' })
    // list() → _filterEngrams → indexedStorage.loadFiltered when index:true
    const visible = plur.list({ scope: PROJECT }).map(e => e.id)
    expect(visible).toContain(g.id)
    expect(visible).toContain(l.id)
    expect(visible).toContain(u.id)
  })

  // --- D1-ASYMMETRY (2 tests) ---
  it('D1-ASYMMETRY (a): explicit scope=global RECALL includes a local-scoped engram', () => {
    const l = plur.learn(STMT('asymrecall'), { scope: 'local' })
    expect(recallSeesId(plur, 'global', l.id)).toBe(true)
  })

  it('D1-ASYMMETRY (b): explicit scope=global INJECT does NOT include a local-scoped engram', () => {
    const l = plur.learn(STMT('asyminject'), { scope: 'local' })
    // global inject is targeted to the global namespace only (INJECT_GLOBAL_IS_TARGETED)
    expect(injectSeesId(plur, 'global', l.id)).toBe(false)
    // …while a global-scoped engram IS surfaced by the same global inject.
    const g = plur.learn(STMT('asyminjectg'), { scope: 'global' })
    expect(injectSeesId(plur, 'global', g.id)).toBe(true)
  })

  // --- DELIBERATE-LOCAL: unscoped_default:'local' still visible under project scope ---
  it('DELIBERATE-LOCAL: with unscoped_default:local a local engram is still visible under project-scope recall/inject', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'plur-readside-local-'))
    writeFileSync(join(dir2, 'config.yaml'), yaml.dump({ index: true, unscoped_default: 'local' }, { noRefs: true }))
    const p2 = new Plur({ path: dir2 })
    try {
      const e = p2.learn(STMT('delibloc')) // no scope → local under this config
      expect(e.scope).toBe('local')
      expect(recallSeesId(p2, PROJECT, e.id)).toBe(true)
      expect(injectSeesId(p2, PROJECT, e.id)).toBe(true)
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

  it('local, global, and user:alice are all visible under a project-scope recall (non-indexed)', () => {
    const g = plur.learn(STMT('niG'), { scope: 'global' })
    const l = plur.learn(STMT('niL'), { scope: 'local' })
    const u = plur.learn(STMT('niU'), { scope: 'user:alice' })
    const ids = plur.recall(QUERY, { scope: PROJECT }).map(e => e.id)
    expect(ids).toContain(g.id)
    expect(ids).toContain(l.id)
    expect(ids).toContain(u.id)
  })

  it('explicit personal sub-scope (user:alice) still catches its sub-scopes via startsWith (non-indexed)', () => {
    const sub = plur.learn(STMT('niSub'), { scope: 'user:alice:notes' })
    // recalling with scope user:alice must include user:alice:notes (startsWith arm)
    const ids = plur.recall(QUERY, { scope: 'user:alice' }).map(e => e.id)
    expect(ids).toContain(sub.id)
  })
})
