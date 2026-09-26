/**
 * The pack registry is keyed by install directory (`dir`), with a legacy
 * fallback to the manifest `name` for rows written before `dir` existed.
 *
 * Found by the formal verification run (spec/formal/findings/persistence.md,
 * candidate 11; Lean theorem `Packs.registry_shared_row`): install wrote
 * `registry[manifest.name]` while the pack lived at `packs/<basename>`. Two
 * directories whose manifests share a name shared one row, so an untouched
 * pack reported `modified`; uninstalling one removed the row by manifest name,
 * leaving the other `unverified` — tamper detection silently lost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { installPack, uninstallPack, listPacks } from '../src/packs.js'

const ENGRAMS = `engrams:
  - id: ENG-2026-09-26-001
    statement: "Migrations run before deploys"
    type: behavioral
    scope: global
    status: active
    visibility: public
`

let tmp: string
let packs: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plur-reg-dir-'))
  packs = join(tmp, 'packs')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function source(dir: string, manifestName: string, prose = 'Prose.'): string {
  const d = join(tmp, 'src', dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${manifestName}\nversion: 1.0.0\n---\n${prose}\n`)
  writeFileSync(join(d, 'engrams.yaml'), ENGRAMS)
  return d
}

type Row = { name: string; dir?: string; integrity: string }
const rows = (): Row[] => (yaml.load(readFileSync(join(packs, 'registry.yaml'), 'utf8')) as { packs: Row[] }).packs
const status = () => Object.fromEntries(listPacks(packs).map(p => [p.path.split('/').pop(), p.integrity_status]))

describe('registry rows keyed by directory', () => {
  it('install records the directory in the row', async () => {
    const r = await installPack(packs, source('pack-one', 'shared-name'))
    expect(r.registry.dir).toBe('pack-one')
    expect(rows()).toEqual([expect.objectContaining({ name: 'shared-name', dir: 'pack-one' })])
  })

  it('two directories whose manifests share a name keep separate baselines', async () => {
    await installPack(packs, source('pack-one', 'shared-name', 'First.'))
    await installPack(packs, source('pack-two', 'shared-name', 'Second.'))
    expect(rows().map(r => r.dir).sort()).toEqual(['pack-one', 'pack-two'])
    // The replay in the finding reported pack-one `modified` here.
    expect(status()).toEqual({ 'pack-one': 'ok', 'pack-two': 'ok' })
  })

  it('uninstalling one leaves the other ok, not unverified', async () => {
    await installPack(packs, source('pack-one', 'shared-name', 'First.'))
    await installPack(packs, source('pack-two', 'shared-name', 'Second.'))
    uninstallPack(packs, 'pack-one')
    expect(rows().map(r => r.dir)).toEqual(['pack-two'])
    // The replay in the finding reported pack-two `unverified` here.
    expect(status()).toEqual({ 'pack-two': 'ok' })
  })

  it('reinstalling the same directory replaces its own row only', async () => {
    await installPack(packs, source('pack-one', 'shared-name', 'First.'))
    await installPack(packs, source('pack-two', 'shared-name', 'Second.'))
    await installPack(packs, source('pack-one', 'shared-name', 'First.'))
    expect(rows().map(r => r.dir).sort()).toEqual(['pack-one', 'pack-two'])
    expect(status()).toEqual({ 'pack-one': 'ok', 'pack-two': 'ok' })
  })

  it('tampering is still detected per directory', async () => {
    await installPack(packs, source('pack-one', 'shared-name', 'First.'))
    await installPack(packs, source('pack-two', 'shared-name', 'Second.'))
    const p = join(packs, 'pack-one', 'engrams.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('Migrations', 'Deployments'))
    expect(status()).toEqual({ 'pack-one': 'modified', 'pack-two': 'ok' })
  })
})

describe('legacy rows without `dir` still resolve by name', () => {
  /** Strip `dir` from every row: the registry an older version wrote. */
  const makeLegacy = () => {
    const regPath = join(packs, 'registry.yaml')
    const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Row[] }
    for (const r of reg.packs) delete r.dir
    writeFileSync(regPath, yaml.dump(reg))
  }

  it('an old registry file loads and list verifies against it', async () => {
    await installPack(packs, source('legacy-pack', 'legacy'))
    makeLegacy()
    expect(rows()[0].dir).toBeUndefined()
    expect(status()).toEqual({ 'legacy-pack': 'ok' })
    const p = join(packs, 'legacy-pack', 'engrams.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('Migrations', 'Deployments'))
    expect(status()).toEqual({ 'legacy-pack': 'modified' })
  })

  it('reinstalling a legacy pack upgrades its row in place rather than adding a second', async () => {
    const src = source('legacy-pack', 'legacy')
    await installPack(packs, src)
    makeLegacy()
    await installPack(packs, src)
    expect(rows()).toEqual([expect.objectContaining({ name: 'legacy', dir: 'legacy-pack' })])
  })

  it('uninstalling a legacy pack removes its legacy row', async () => {
    await installPack(packs, source('legacy-pack', 'legacy'))
    await installPack(packs, source('other', 'other-name'))
    makeLegacy()
    uninstallPack(packs, 'legacy-pack')
    expect(rows().map(r => r.name)).toEqual(['other-name'])
    expect(status()).toEqual({ other: 'ok' })
  })

  it('a legacy row shared by two directories is not removed when only one of them is uninstalled', async () => {
    // Legacy state from the old defect: one row, two directories. Which one it
    // belongs to cannot be told, so removing either directory must not take the
    // baseline away from the other.
    await installPack(packs, source('pack-one', 'shared-name', 'Same.'))
    await installPack(packs, source('pack-two', 'shared-name', 'Same.'))
    const regPath = join(packs, 'registry.yaml')
    const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Row[] }
    reg.packs = [{ ...reg.packs[1], dir: undefined }]
    delete reg.packs[0].dir
    writeFileSync(regPath, yaml.dump(reg))
    uninstallPack(packs, 'pack-one')
    expect(rows()).toHaveLength(1)
    expect(status()).toEqual({ 'pack-two': 'ok' })
  })
})

describe('integrity migration follows the directory key (stacked on sha256:v2)', () => {
  it('two directories sharing a manifest name are migrated against their own rows', async () => {
    const { computePackHash, migratePackIntegrity } = await import('../src/packs.js')
    await installPack(packs, source('pack-one', 'shared-name', 'First.'))
    await installPack(packs, source('pack-two', 'shared-name', 'Second.'))
    // Force both rows back to their v1 form, as an install before v2 wrote them.
    const reg = yaml.load(readFileSync(join(packs, 'registry.yaml'), 'utf8')) as { packs: Row[] }
    for (const r of reg.packs) r.integrity = `sha256:${computePackHash(join(packs, r.dir!))}`
    writeFileSync(join(packs, 'registry.yaml'), yaml.dump(reg))
    // pack-two is changed after install: it must never be re-baselined.
    const p = join(packs, 'pack-two', 'engrams.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('Migrations', 'Deployments'))

    const report = migratePackIntegrity(packs)
    const by = Object.fromEntries(report.packs.map(x => [x.dir, x.action]))
    expect(by).toEqual({ 'pack-one': 'migrated', 'pack-two': 'skipped-modified' })
    const after = Object.fromEntries(rows().map(r => [r.dir, r.integrity]))
    expect(after['pack-one']).toMatch(/^sha256:v2:/)
    expect(after['pack-two']).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(status()).toEqual({ 'pack-one': 'ok', 'pack-two': 'modified' })
  })
})
