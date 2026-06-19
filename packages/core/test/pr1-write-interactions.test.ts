/**
 * PR-1 (#353) write-side interactions documented alongside the read-side fix:
 *  - auto-route still fires on a confident covers match (revert didn't break it),
 *  - RECURRENCE-INTERACTION: cross-scope recurrence still promotes a local engram
 *    to global on the 2nd hit even under unscoped_default:'local' (index.ts:670
 *    ignores unscoped_default — documented as v2 checklist item (ii)),
 *  - SECONDARY-STORE rename: a global engram in a secondary store is renamed to
 *    the store's scope on load (UNCHANGED, intentional cross-store narrowing).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, SCOPE_MATCH_THRESHOLD } from '../src/index.js'

const dirs: string[] = []
function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('PR-1 — auto-route still fires after the default revert (#353)', () => {
  it('a confident covers match auto-routes an un-scoped write and stamps _routed', () => {
    const dir = makeDir('plur-pr1-autoroute-')
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { path: join(dir, 'core.yaml'), scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings', 'core'] },
      ],
    }, { noRefs: true }))
    const plur = new Plur({ path: dir })
    // domain-prefix hit (plur.core.embeddings ⊂ plur.*) + tag hit clears threshold
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: { scope: string; confidence: number } } }
    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.confidence).toBeGreaterThanOrEqual(SCOPE_MATCH_THRESHOLD)
  })
})

describe('PR-1 — RECURRENCE-INTERACTION under unscoped_default:local (#353, v2 item ii)', () => {
  it('a local engram promoted to global by _recordCrossScopeRecurrence on the 2nd cross-scope hit', () => {
    const dir = makeDir('plur-pr1-recur-')
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, unscoped_default: 'local' }, { noRefs: true }))
    const plur = new Plur({ path: dir })

    // 1st learn, unscoped → lands local under unscoped_default:'local'
    const first = plur.learn('recurrence-interaction probe statement') as { scope: string; id: string }
    expect(first.scope).toBe('local')

    // 1st cross-scope hit: recurrence=1, scope unchanged
    plur.learn('recurrence-interaction probe statement', { scope: 'project:a' })
    // 2nd cross-scope hit: recurrence=2 → promotion to global regardless of unscoped_default
    const promoted = plur.learn('recurrence-interaction probe statement', { scope: 'project:b' }) as { scope: string; id: string }
    expect(promoted.id).toBe(first.id)
    // index.ts:670 hardcodes global on the 2nd cross-scope hit (ignores unscoped_default).
    expect(promoted.scope).toBe('global')
  })
})

describe('PR-1 — SECONDARY-STORE rename preserved (#353)', () => {
  it('a global-scoped engram in a secondary store is renamed to the store scope on load', () => {
    const primaryDir = makeDir('plur-pr1-sec-primary-')
    const storeDir = makeDir('plur-pr1-sec-store-')

    // Seed the secondary store directly with a global-scoped engram.
    const seed = new Plur({ path: storeDir })
    const seeded = seed.learn('secondary store global engram about widgets', { scope: 'global' })

    writeFileSync(join(primaryDir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { path: join(storeDir, 'engrams.yaml'), scope: 'group:plur/core' },
      ],
    }, { noRefs: true }))
    const plur = new Plur({ path: primaryDir })

    // Loaded through the secondary store, the global engram is narrowed to the
    // store's scope (cross-store narrowing) — UNCHANGED behavior.
    const loaded = plur.list().filter(e => (e as any)._originalId === seeded.id)
    expect(loaded.length).toBe(1)
    expect(loaded[0].scope).toBe('group:plur/core')
  })
})
