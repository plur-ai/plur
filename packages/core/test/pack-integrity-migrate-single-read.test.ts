/**
 * #1234: `migratePackIntegrity` checked a pack against its v1 value and then
 * read the files again to compute the v2 value. An edit landing between the two
 * reads became the new v2 baseline of a row carried forward from v1, and was
 * never reported as `modified`. Both values now come from one read.
 *
 * `readFileSync` is wrapped so the test can edit the pack right after the
 * migration has read its bytes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let afterRead: ((file: string) => void) | undefined

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const out = (actual.readFileSync as (...a: unknown[]) => unknown)(...args)
    // Raw (Buffer) reads only: those are the integrity reads. Parsing reads
    // the same file as text.
    if (afterRead && args.length === 1 && typeof args[0] === 'string') afterRead(args[0])
    return out
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

const { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } = await import('fs')
const { tmpdir } = await import('os')
const { join } = await import('path')
const yaml = (await import('js-yaml')).default
const { EngramSchema } = await import('../src/schemas/engram.js')
const { exportPack, installPack, computePackHash, migratePackIntegrity, listPacks } = await import('../src/packs.js')

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'plur-integ-single-read-')) })
afterEach(() => { afterRead = undefined; rmSync(tmp, { recursive: true, force: true }) })

describe('migratePackIntegrity computes the v1 check and the v2 value from one read (#1234)', () => {
  it('an edit made after the check is not taken as the new baseline', async () => {
    const packs = join(tmp, 'packs')
    const src = join(tmp, 'src-carried')
    exportPack([EngramSchema.parse({
      id: 'ENG-2026-09-28-001', statement: 'Migrations run before deploys', type: 'behavioral',
      scope: 'global', status: 'active', visibility: 'public', content_hash: 'a'.repeat(64),
    })], src, { name: 'carried', version: '1.0.0', license: 'cc-by-4.0' })
    await installPack(packs, src)
    const installed = join(packs, 'src-carried')
    // A legacy v1 row, and no local source to re-verify against: the row is
    // carried forward on the strength of the v1 match alone.
    const regPath = join(packs, 'registry.yaml')
    const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Array<{ name: string; integrity: string }> }
    reg.packs.find(r => r.name === 'carried')!.integrity = `sha256:${computePackHash(installed)}`
    writeFileSync(regPath, yaml.dump(reg))
    rmSync(src, { recursive: true, force: true })

    const engramsPath = join(installed, 'engrams.yaml')
    afterRead = (file) => {
      if (file !== engramsPath) return
      afterRead = undefined
      appendFileSync(engramsPath, '# edited after the v1 check\n')
    }
    const report = migratePackIntegrity(packs)
    expect(afterRead).toBeUndefined() // the edit happened
    expect(report.packs.map(p => [p.dir, p.action, p.baseline])).toEqual([['src-carried', 'migrated', 'carried-from-v1']])

    // The baseline is what was checked, so the edit shows up.
    expect(listPacks(packs).map(p => [p.name, p.integrity_status])).toEqual([['carried', 'modified']])
  })
})
