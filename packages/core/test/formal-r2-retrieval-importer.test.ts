// Formal verification round 2, core-retrieval#10 (spec/formal/findings/r2-retrieval.md §4).
// A dry run "predicts the report without writing": for the same store state and
// records it must report what the real run reports. Replayed divergences:
//   - unhashable statements (all punctuation/emoji): learn() never dedups them (#896),
//     the dry run deduped them on the shared empty-string hash;
//   - a secret in a context field learn() scans (e.g. `source`), which the dry run
//     did not scan.
// Model: PlurSpec.R2Retrieval.Importer.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { runImport, type ImportRecord } from '../src/importers/index.js'

const dirs: string[] = []
function fresh(): Plur {
  const d = mkdtempSync(join(tmpdir(), 'plur-r2-import-'))
  dirs.push(d)
  return new Plur({ path: d })
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

type Counts = { imported: number; skipped: number; errors: number; conflicts: number; actions: string[] }
const counts = (r: any): Counts => ({
  imported: r.imported, skipped: r.skipped, errors: r.errors, conflicts: r.conflicts,
  actions: r.records.map((x: any) => x.action),
})

async function dryVsReal(records: ImportRecord[], seed: (p: Plur) => Promise<void> = async () => {}) {
  const a = fresh(); await seed(a)
  const b = fresh(); await seed(b)
  const dry = await runImport(a, records, { from: 'generic', dryRun: true })
  const real = await runImport(b, records, { from: 'generic' })
  return { dry: counts(dry), real: counts(real) }
}

describe('formal R2 core-retrieval#10 — importer dry run predicts the real run', () => {
  it('unhashable statements are not deduplicated in either mode', async () => {
    const { dry, real } = await dryVsReal([{ statement: '🎉🎉🎉' }, { statement: '!!! ???' }])
    expect(real.imported).toBe(2)
    expect(dry).toEqual(real) // pre-fix dry: 1 imported, 1 skipped
  })

  it('a secret in the source field is an error in both modes', async () => {
    const leaked = 'notes from password=hunter2hunter2 session'
    const { dry, real } = await dryVsReal([{ statement: 'deploys go through CI', source: leaked }, { statement: 'a clean fact' }])
    expect(real.errors).toBe(1)
    expect(dry).toEqual(real) // pre-fix dry: 2 imported
  })

  it('non-vacuity: ordinary duplicates, in-file duplicates and conflicts still agree', async () => {
    const { dry, real } = await dryVsReal(
      [{ statement: 'already here', scope: 'global' }, { statement: 'brand new' }, { statement: 'brand new' }],
      async (p) => { await p.learn('already here', { scope: 'global' }) },
    )
    expect(real).toEqual({ imported: 1, skipped: 2, errors: 0, conflicts: 0, actions: ['skipped', 'imported', 'skipped'] })
    expect(dry).toEqual(real)
  })
})
