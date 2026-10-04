import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { runImport } from '../src/importers/engine.js'

/**
 * Owner decision F1 (2026-09-29, round-2 board): the importer follows A1. A
 * record for a SHARED scope whose text already exists in another scope is
 * imported into its own team scope, and the matching engram is credited
 * (recurrence + validated_by), exactly like learn(). A cross-scope match
 * counts as "existing" only when the incoming scope is NOT shared.
 *
 * The dry run must predict the same outcome the real run produces.
 */
const STMT = 'Run the linter before every commit'

describe('importer follows A1 (decision F1)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-import-a1-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const rows = (): any[] => (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any)?.engrams ?? []

  it('a shared-scope record whose text exists in another scope is imported into its own scope', async () => {
    const plur = new Plur({ path: dir })
    const a = await plur.learn(STMT, { scope: 'project:a' })
    const report = await runImport(plur, [{ statement: STMT }], { from: 'generic', scope: 'project:b' })
    expect(report.imported).toBe(1)
    expect(rows().some(e => e.scope === 'project:b' && e.statement === STMT)).toBe(true)
    const credited = rows().find(e => e.id === a.id)
    expect(credited.recurrence_count).toBe(1)
    expect(credited.sources.at(-1).validated_by).toBe('project:b')
  })

  it('dry run predicts the same: imported, not skipped', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn(STMT, { scope: 'project:a' })
    const report = await runImport(plur, [{ statement: STMT }], { from: 'generic', scope: 'project:b', dryRun: true })
    expect(report.imported).toBe(1)
    expect(report.skipped).toBe(0)
  })

  it('a personal-scope record whose text exists in another scope is still skipped (real and dry run)', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn(STMT, { scope: 'project:a' })
    const dry = await runImport(plur, [{ statement: STMT }], { from: 'generic', scope: 'global', dryRun: true })
    expect(dry.skipped).toBe(1)
    const real = await runImport(plur, [{ statement: STMT }], { from: 'generic', scope: 'global' })
    expect(real.skipped).toBe(1)
    expect(real.imported).toBe(0)
  })

  it('a shared-scope record that already exists in the SAME scope is skipped (real and dry run)', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn(STMT, { scope: 'project:b' })
    const dry = await runImport(plur, [{ statement: STMT }], { from: 'generic', scope: 'project:b', dryRun: true })
    expect(dry.skipped).toBe(1)
    const real = await runImport(plur, [{ statement: STMT }], { from: 'generic', scope: 'project:b' })
    expect(real.skipped).toBe(1)
  })
})
