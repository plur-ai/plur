// DUR-5: A store written by an older version still opens with everything in it, and a failed upgrade leaves it untouched with a backup.
//
// The older store below is written the way early releases wrote it: no
// content_hash, commitment, memory_class or version fields, no schema_version
// in config.yaml, and the write counter under its old name, reference_count.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_MIGRATIONS, Plur, getSchemaVersion, runMigrations } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

const OLD = [
  { id: 'ENG-2026-0105-001', statement: 'Database migrations run before every deploy', type: 'behavioral', refs: 3, tags: ['deploy'], rationale: 'A deploy without them broke production once' },
  { id: 'ENG-2026-0105-002', statement: 'Use UTC timestamps in every log line', type: 'behavioral', refs: 1, tags: ['logging'], rationale: '' },
  { id: 'ENG-2026-0106-001', statement: 'The API gateway times out after thirty seconds', type: 'terminological', refs: 2, tags: ['api'], rationale: 'Measured in the load test' },
  { id: 'ENG-2026-0107-001', statement: 'Prefer feature flags over long-lived branches', type: 'procedural', refs: 5, tags: ['git'], rationale: 'Merge pain' },
  { id: 'ENG-2026-0108-001', statement: 'Rotate the on-call schedule every Monday', type: 'procedural', refs: 1, tags: [], rationale: '' },
]

function oldStoreYaml(): string {
  const lines = ['engrams:']
  for (const e of OLD) {
    lines.push(
      `  - id: ${e.id}`,
      `    statement: ${e.statement}`,
      `    type: ${e.type}`,
      '    scope: global',
      '    status: active',
      `    reference_count: ${e.refs}`,
      `    tags: [${e.tags.join(', ')}]`,
      ...(e.rationale ? [`    rationale: ${e.rationale}`] : []),
      '    activation:',
      '      retrieval_strength: 0.8',
      '      storage_strength: 1.0',
      '      frequency: 2',
      '      last_accessed: "2026-01-10"',
    )
  }
  return lines.join('\n') + '\n'
}

function check(engrams: Array<{ id: string; statement: string; write_count?: number; tags?: string[]; rationale?: string }>, when: string): void {
  for (const want of OLD) {
    const got = engrams.find(e => e.id === want.id)
    expect(got, `${when}: memory ${want.id} ("${want.statement}") is missing`).toBeTruthy()
    expect(got!.statement, `${when}: the text of ${want.id} changed`).toBe(want.statement)
    expect(got!.write_count, `${when}: ${want.id} was saved ${want.refs} time(s) in the old store, but now counts ${got!.write_count}`).toBe(want.refs)
    expect(got!.tags ?? [], `${when}: the tags of ${want.id} changed`).toEqual(want.tags)
    if (want.rationale) expect(got!.rationale, `${when}: the rationale of ${want.id} was lost`).toBe(want.rationale)
  }
}

describe('DUR-5 an older store opens whole, and a failed upgrade leaves it untouched with a backup', () => {
  let s: TempStore
  afterEach(() => { vi.restoreAllMocks(); s?.cleanup() })

  it('a store written by an older version opens with everything in it, and keeps it through saves and the upgrade', async () => {
    s = await tempStore({ embedder: 'off' })
    writeFileSync(join(s.dir, 'engrams.yaml'), oldStoreYaml())

    const opened = new Plur({ path: s.dir, autoDiscover: false })
    const listed = await opened.list()
    expect(listed.length, `the older store should open with its 5 memories; it opened with ${listed.length}`).toBe(5)
    check(listed, 'opening the older store')

    // An ordinary save rewrites the file in the current format; nothing may be lost on the way.
    await opened.learn('A new memory saved after opening the older store', { scope: 'global' })
    check(await new Plur({ path: s.dir, autoDiscover: false }).list(), 'after the first save into the older store')

    // The upgrade itself.
    const res = runMigrations(join(s.dir, 'engrams.yaml'), join(s.dir, 'config.yaml'))
    expect(res.applied.length, 'precondition: the upgrade had steps to apply to an older store').toBeGreaterThan(0)
    check(await new Plur({ path: s.dir, autoDiscover: false }).list(), 'after upgrading the older store')
  })

  it('an upgrade that fails part-way leaves the store byte-for-byte as it was, with a backup', async () => {
    s = await tempStore({ embedder: 'off' })
    const storePath = join(s.dir, 'engrams.yaml')
    const configPath = join(s.dir, 'config.yaml')
    writeFileSync(storePath, oldStoreYaml())
    const before = readFileSync(storePath, 'utf8')
    const versionBefore = getSchemaVersion(configPath)
    expect(ALL_MIGRATIONS.length, 'precondition: there is more than one upgrade step, so one can fail part-way').toBeGreaterThan(1)

    // The last step fails, after the earlier ones have already transformed the memories.
    vi.spyOn(ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1], 'up').mockImplementation(() => { throw new Error('eval: upgrade step failed') })
    let failure: unknown = null
    try { runMigrations(storePath, configPath) } catch (e) { failure = e }
    expect(failure, 'precondition: the injected upgrade failure was reported').toBeTruthy()

    expect(readFileSync(storePath, 'utf8'), 'the failed upgrade changed the live store').toBe(before)
    expect(getSchemaVersion(configPath), 'the failed upgrade changed the recorded store version').toBe(versionBefore)
    const backups = readdirSync(s.dir).filter(f => f.startsWith('engrams.yaml.bak'))
    expect(backups.length, `the failed upgrade left no backup of the store (files: ${readdirSync(s.dir).join(', ')})`).toBeGreaterThan(0)
    expect(backups.map(b => readFileSync(join(s.dir, b), 'utf8')), 'no backup holds the store as it was before the upgrade').toContain(before)
    expect(existsSync(storePath), 'precondition: the store file still exists').toBe(true)
    vi.restoreAllMocks()
    check(await new Plur({ path: s.dir, autoDiscover: false }).list(), 'after the failed upgrade')
  })
})
