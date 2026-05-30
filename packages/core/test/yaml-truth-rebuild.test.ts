/**
 * YAML-as-truth invariant — Test A: nuke-the-db rebuild
 *
 * Issue plur-ai/plur#249, ADR-0001 (#226), engram ENG-2026-0530-019.
 *
 * Principle: YAML is the source of truth. Any derived state (in-memory cache,
 * PGLite indexes, AGE graph, embedding vectors) must be rebuildable from YAML
 * with no observable change in API behavior.
 *
 * This test seeds a realistic store, captures results from public methods,
 * deletes all derived state, rebuilds from YAML alone, and asserts the
 * results are identical.
 *
 * Today (pre-PGLite), "derived state" is just the in-memory cache, and
 * "rebuild from YAML" is constructing a fresh Plur instance from the same
 * path. After PR 2 (feat/pglite-adapter) lands, the helper below also wipes
 * the PGLite directory and forces `plur sync` to rebuild it from YAML. The
 * test contract does not change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

/**
 * Wipe all derived state under `dir`, leaving YAML untouched.
 *
 * Future-proofing: when PGLite lands, add `store.pglite` to the wiped paths.
 * The contract is "anything that is NOT the YAML source goes."
 */
function nukeDerivedState(dir: string): void {
  const derivedPaths = [
    join(dir, 'store.pglite'),     // PR 2 (#226) — PGLite index dir
    join(dir, '.fts-cache'),       // potential future BM25 disk cache
    join(dir, '.embeddings-cache'),// potential future embedding cache
  ]
  for (const p of derivedPaths) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
  }
}

describe('yaml-as-truth: nuke-the-db rebuild (Test A)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-yaml-truth-rebuild-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('recall results survive a full rebuild from YAML', () => {
    // 1. Seed a realistic store with engrams across types and scopes
    const seed = new Plur({ path: dir })
    seed.learn('always run tests before merging', {
      scope: 'project:plur',
      domain: 'workflow.testing',
      type: 'procedural',
    })
    seed.learn('YAML is the source of truth', {
      scope: 'project:plur',
      domain: 'plur.architecture',
      type: 'architectural',
    })
    seed.learn('embedding model influences recall quality more than fusion', {
      scope: 'project:plur',
      domain: 'plur.retrieval',
      type: 'terminological',
    })
    seed.learn('the user prefers terse responses', {
      scope: 'global',
      domain: 'workflow.communication',
      type: 'behavioral',
    })

    // 2. Capture results from every public read method
    const beforeList = seed.list().map(e => e.id).sort()
    const beforeRecall = seed.recall('source of truth').map(e => e.id)
    const beforeInject = seed.inject('about to merge a PR').injected_ids
    const firstId = beforeList[0]
    const beforeGetById = seed.getById(firstId)?.id

    // 3. Nuke derived state. YAML on disk is untouched.
    nukeDerivedState(dir)

    // 4. Rebuild — fresh Plur instance loads from YAML and reconstructs
    //    every derived data structure (in-memory cache today, PGLite tomorrow).
    const rebuilt = new Plur({ path: dir })

    // 5. Recapture the same operations
    const afterList = rebuilt.list().map(e => e.id).sort()
    const afterRecall = rebuilt.recall('source of truth').map(e => e.id)
    const afterInject = rebuilt.inject('about to merge a PR').injected_ids
    const afterGetById = rebuilt.getById(firstId)?.id

    // 6. Identical results — derived state is rebuildable
    expect(afterList).toEqual(beforeList)
    expect(afterRecall).toEqual(beforeRecall)
    expect(afterInject).toEqual(beforeInject)
    expect(afterGetById).toEqual(beforeGetById)
  })

  it('list returns same engrams in same order after rebuild', () => {
    const seed = new Plur({ path: dir })
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const e = seed.learn(`statement number ${i}`, {
        scope: 'project:plur',
        type: 'behavioral',
      })
      ids.push(e.id)
    }

    const before = seed.list().map(e => e.id)
    nukeDerivedState(dir)
    const after = new Plur({ path: dir }).list().map(e => e.id)

    expect(after).toEqual(before)
    expect(after).toEqual(expect.arrayContaining(ids))
  })

  it('forget persists across rebuild (YAML stores the tombstone)', () => {
    const seed = new Plur({ path: dir })
    const e1 = seed.learn('to be forgotten', { scope: 'global', type: 'behavioral' })
    seed.learn('to be remembered', { scope: 'global', type: 'behavioral' })

    // forget the first engram (marks it as inactive)
    return seed.forget(e1.id, 'test cleanup').then(() => {
      const before = seed.list().map(e => e.id)
      expect(before).not.toContain(e1.id)

      nukeDerivedState(dir)
      const after = new Plur({ path: dir }).list().map(e => e.id)

      // Forget must be a YAML-resident operation, not DB-only state
      expect(after).toEqual(before)
      expect(after).not.toContain(e1.id)
    })
  })

  it('scope-filtered recall is identical after rebuild', () => {
    const seed = new Plur({ path: dir })
    seed.learn('project a fact', { scope: 'project:a', type: 'behavioral' })
    seed.learn('project b fact', { scope: 'project:b', type: 'behavioral' })
    seed.learn('global fact', { scope: 'global', type: 'behavioral' })

    const before = seed.list({ scope: 'project:a' }).map(e => e.id)
    nukeDerivedState(dir)
    const after = new Plur({ path: dir }).list({ scope: 'project:a' }).map(e => e.id)

    expect(after).toEqual(before)
  })
})
