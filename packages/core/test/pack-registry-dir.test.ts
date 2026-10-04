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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
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

type Row = { name: string; dir?: string; integrity: string; ambiguous?: true }
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
    // The row is kept for pack-two to reclaim by reinstalling, but it may be
    // pack-one's baseline, so pack-two is not verified against it (#1245).
    expect(status()).toEqual({ 'pack-two': 'unverified' })
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

// ---------------------------------------------------------------------------
// Audit of #1230.

/** Strip `dir` from the row for `dir`: the row an older version wrote. */
function makeRowLegacy(dir: string): void {
  const regPath = join(packs, 'registry.yaml')
  const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Row[] }
  for (const r of reg.packs) if (r.dir === dir) delete r.dir
  writeFileSync(regPath, yaml.dump(reg))
}

describe('a legacy row next to a new same-name dir row is not ambiguous (finding 1)', () => {
  // pack-one was installed by an older version (legacy row, no `dir`); pack-two,
  // same manifest name, was installed since and owns a `dir` row. pack-two
  // cannot own the legacy row, so it is pack-one's and nobody else's.
  beforeEach(async () => {
    await installPack(packs, source('pack-one', 'shared-name', 'First.'))
    makeRowLegacy('pack-one')
    await installPack(packs, source('pack-two', 'shared-name', 'Second.'))
    expect(rows().map(r => r.dir ?? '(legacy)').sort()).toEqual(['(legacy)', 'pack-two'])
  })

  it('reinstall upgrades the legacy row in place (2 rows, not 3)', async () => {
    await installPack(packs, join(tmp, 'src', 'pack-one'))
    expect(rows().map(r => r.dir).sort()).toEqual(['pack-one', 'pack-two'])
    expect(status()).toEqual({ 'pack-one': 'ok', 'pack-two': 'ok' })
  })

  it('migrate treats the legacy row as pack-one\'s', async () => {
    const { computePackHash, migratePackIntegrity } = await import('../src/packs.js')
    const regPath = join(packs, 'registry.yaml')
    const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Row[] }
    const legacy = reg.packs.find(r => r.dir === undefined)!
    legacy.integrity = `sha256:${computePackHash(join(packs, 'pack-one'))}`
    writeFileSync(regPath, yaml.dump(reg))
    const by = Object.fromEntries(migratePackIntegrity(packs).packs.map(p => [p.dir, p.action]))
    expect(by['pack-one']).toBe('migrated')
  })

  it('uninstall removes the legacy row and leaves pack-two\'s', () => {
    uninstallPack(packs, 'pack-one')
    expect(rows().map(r => r.dir)).toEqual(['pack-two'])
    expect(status()).toEqual({ 'pack-two': 'ok' })
  })

  it('a leftover staging copy does not make the legacy row ambiguous', async () => {
    const { cpSync } = await import('node:fs')
    rmSync(join(packs, 'pack-two'), { recursive: true, force: true })
    cpSync(join(packs, 'pack-one'), join(packs, 'pack-one.installing-1-2'), { recursive: true })
    cpSync(join(packs, 'pack-one'), join(packs, 'pack-x.replacing-1-2'), { recursive: true })
    uninstallPack(packs, 'pack-one')
    expect(rows().map(r => r.dir)).toEqual(['pack-two'])
  })
})

describe('a legacy row shared by two directories (findings 3 and 4)', () => {
  // The state the original defect left: one legacy row, two directories. It
  // belongs to one of them and nothing says which.
  beforeEach(async () => {
    await installPack(packs, source('pack-one', 'shared-name', 'First.'))
    await installPack(packs, source('pack-two', 'shared-name', 'Second.'))
    const regPath = join(packs, 'registry.yaml')
    const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Row[] }
    reg.packs = [reg.packs.find(r => r.dir === 'pack-two')!]
    delete reg.packs[0].dir
    writeFileSync(regPath, yaml.dump(reg))
  })

  it('listPacks reports both unverified, not one of them modified', () => {
    expect(status()).toEqual({ 'pack-one': 'unverified', 'pack-two': 'unverified' })
    for (const p of listPacks(packs)) expect(p.registry_ambiguous).toBe(true)
  })

  it('migrate skips both as skipped-ambiguous-legacy-row and leaves the row alone', async () => {
    const { migratePackIntegrity } = await import('../src/packs.js')
    const before = readFileSync(join(packs, 'registry.yaml'))
    const by = Object.fromEntries(migratePackIntegrity(packs).packs.map(p => [p.dir, p.action]))
    expect(by).toEqual({ 'pack-one': 'skipped-ambiguous-legacy-row', 'pack-two': 'skipped-ambiguous-legacy-row' })
    expect(readFileSync(join(packs, 'registry.yaml')).equals(before)).toBe(true)
  })

  // #1245: uninstall correctly leaves the row, since it cannot tell whose it
  // is. The survivor then used to be the only candidate, was verified against
  // the row — here pack-two's hash — and reported a false `modified`.
  it('uninstalling one leaves the survivor unverified, not modified (#1245)', () => {
    uninstallPack(packs, 'pack-two')
    expect(rows()).toEqual([expect.objectContaining({ name: 'shared-name', ambiguous: true })])
    expect(rows()[0].dir).toBeUndefined()
    expect(status()).toEqual({ 'pack-one': 'unverified' })
    expect(listPacks(packs)[0].registry_ambiguous).toBe(true)
  })

  it('after that uninstall, migrate still skips the survivor as ambiguous (#1245)', async () => {
    const { computePackHash, migratePackIntegrity } = await import('../src/packs.js')
    // Give the row a v1 value that pack-two had: a migration against it would
    // otherwise report the untouched survivor as skipped-modified.
    const regPath = join(packs, 'registry.yaml')
    const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Row[] }
    reg.packs[0].integrity = `sha256:${computePackHash(join(packs, 'pack-two'))}`
    writeFileSync(regPath, yaml.dump(reg))
    uninstallPack(packs, 'pack-two')
    const by = Object.fromEntries(migratePackIntegrity(packs).packs.map(p => [p.dir, p.action]))
    expect(by).toEqual({ 'pack-one': 'skipped-ambiguous-legacy-row' })
  })

  it('after that uninstall, reinstalling the survivor replaces the marked row (#1245)', async () => {
    uninstallPack(packs, 'pack-two')
    await installPack(packs, join(tmp, 'src', 'pack-one'))
    expect(rows()).toEqual([expect.objectContaining({ dir: 'pack-one' })])
    expect(rows()[0]).not.toHaveProperty('ambiguous')
    expect(status()).toEqual({ 'pack-one': 'ok' })
  })

  it('after that uninstall, uninstalling the survivor removes the marked row (#1245)', () => {
    uninstallPack(packs, 'pack-two')
    uninstallPack(packs, 'pack-one')
    expect(rows()).toEqual([])
  })

  it('reinstalling each pack resolves it: both get their own rows', async () => {
    await installPack(packs, join(tmp, 'src', 'pack-one'))
    await installPack(packs, join(tmp, 'src', 'pack-two'))
    const dirs = rows().map(r => r.dir ?? '(legacy)').sort()
    expect(dirs).toContain('pack-one')
    expect(dirs).toContain('pack-two')
    expect(status()).toEqual({ 'pack-one': 'ok', 'pack-two': 'ok' })
  })
})

describe('case-insensitive filesystems: the row follows the directory (finding 2)', () => {
  const caseInsensitive = (() => {
    const d = mkdtempSync(join(tmpdir(), 'plur-case-probe-'))
    try {
      writeFileSync(join(d, 'CaseProbe'), '')
      return existsSync(join(d, 'caseprobe'))
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })()

  it.skipIf(!caseInsensitive)('uninstall spelled in another case removes the directory AND its row', async () => {
    await installPack(packs, source('pack-one', 'n1'))
    await installPack(packs, source('other', 'n2'))
    uninstallPack(packs, 'PACK-ONE')
    expect(existsSync(join(packs, 'pack-one'))).toBe(false)
    expect(rows().map(r => r.dir)).toEqual(['other'])
  })

  it.skipIf(!caseInsensitive)('install from a case-variant source over an existing pack replaces its row', async () => {
    await installPack(packs, source('pack-one', 'n1'))
    await installPack(packs, source('Pack-One', 'n1'))
    expect(rows().map(r => r.dir)).toEqual(['pack-one'])
    expect(readdirSync(packs).filter(e => e.toLowerCase() === 'pack-one')).toEqual(['pack-one'])
    expect(status()).toEqual({ 'pack-one': 'ok' })
  })
})

describe('normalization-insensitive filesystems: the row follows the directory (#1246)', () => {
  const nfd = 'cafe\u0301' // "café", decomposed
  const nfc = 'caf\u00e9'  // "café", composed
  const normalizationInsensitive = (() => {
    const d = mkdtempSync(join(tmpdir(), 'plur-nfd-probe-'))
    try {
      writeFileSync(join(d, nfd), '')
      return existsSync(join(d, nfc))
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })()

  it.skipIf(!normalizationInsensitive)('uninstall spelled in another normalization removes the directory AND its row', async () => {
    await installPack(packs, source(nfd, 'n1'))
    await installPack(packs, source('other', 'n2'))
    expect(rows().map(r => r.dir).sort()).toEqual([nfd, 'other'].sort())
    uninstallPack(packs, nfc)
    expect(readdirSync(packs).some(e => e.normalize('NFC') === nfc)).toBe(false)
    expect(rows().map(r => r.dir)).toEqual(['other'])
  })

  it.skipIf(!normalizationInsensitive)('install from a normalization-variant source over an existing pack replaces its row', async () => {
    await installPack(packs, source(nfd, 'n1'))
    await installPack(packs, source(nfc, 'n1'))
    expect(rows().map(r => r.dir)).toEqual([nfd])
    expect(status()).toEqual({ [nfd]: 'ok' })
  })
})
