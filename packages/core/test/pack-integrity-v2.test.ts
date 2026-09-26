/**
 * The `sha256:v2:` pack integrity value (ENGRAM-STANDARD-v1 §5.5).
 *
 * v1 is `SHA256(SKILL.md ‖ engrams.yaml)` with no framing. The formal
 * verification run (spec/formal/findings/persistence.md, candidate 10; Lean
 * theorems `Packs.hash_boundary_collision` and `Packs.hash_missing_eq_empty`)
 * showed it is not injective:
 *
 *   - bytes moved across the file boundary keep the hash, so content can move
 *     between SKILL.md and engrams.yaml and still verify `ok`;
 *   - a missing SKILL.md hashes the same as an empty one.
 *
 * v2 hashes each part as `name ‖ 0x00 ‖ len ‖ 0x00 ‖ bytes`, with an absent part
 * written as `name ‖ 0x00 ‖ "-" ‖ 0x00`. New packs and new registry rows carry
 * v2. A v1 value still verifies exactly as it did, so no shipped pack breaks,
 * and `migratePackIntegrity` re-baselines installed v1 rows — only for a pack
 * that still verifies clean under v1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { EngramSchema } from '../src/schemas/engram.js'
import {
  exportPack,
  installPack,
  listPacks,
  verifyPackIntegrity,
  computePackHash,
  computePackIntegrity,
  packIntegrityMatches,
  migratePackIntegrity,
} from '../src/packs.js'

const engram = (id = 'ENG-2026-09-26-001') => EngramSchema.parse({
  id,
  statement: 'Migrations run before deploys',
  type: 'behavioral',
  scope: 'global',
  status: 'active',
  visibility: 'public',
  content_hash: 'a'.repeat(64),
})

const V2 = /^sha256:v2:[0-9a-f]{64}$/
const v1Of = (dir: string) => `sha256:${computePackHash(dir)}`

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'plur-integ-v2-')) })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Move the last `k` bytes of SKILL.md to the front of engrams.yaml. */
function shiftBoundary(dir: string, k: number): void {
  const s = readFileSync(join(dir, 'SKILL.md'))
  const e = readFileSync(join(dir, 'engrams.yaml'))
  writeFileSync(join(dir, 'SKILL.md'), s.subarray(0, s.length - k))
  writeFileSync(join(dir, 'engrams.yaml'), Buffer.concat([s.subarray(s.length - k), e]))
}

function rawPack(name: string, files: Record<string, string>): string {
  const d = join(tmp, name)
  mkdirSync(d, { recursive: true })
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c)
  return d
}

describe('the v2 hash closes the two v1 counterexamples', () => {
  it('boundary shift: v1 collides, v2 does not', () => {
    // The replay from the finding: the tail of a SKILL.md instruction moved
    // into engrams.yaml.
    const a = rawPack('a', { 'SKILL.md': '---\nname: a\n---\nNever run rm -rf.\n', 'engrams.yaml': 'engrams: []\n' })
    const b = rawPack('b', { 'SKILL.md': '---\nname: a\n---\nNever run rm', 'engrams.yaml': ' -rf.\nengrams: []\n' })
    expect(v1Of(a)).toBe(v1Of(b)) // the v1 defect, pinned so the test means something
    expect(computePackIntegrity(a)).toMatch(V2)
    expect(computePackIntegrity(a)).not.toBe(computePackIntegrity(b))
  })

  it('missing vs empty: v1 collides, v2 does not', () => {
    const empty = rawPack('empty', { 'SKILL.md': '', 'engrams.yaml': 'engrams: []\n' })
    const missing = rawPack('missing', { 'engrams.yaml': 'engrams: []\n' })
    expect(v1Of(empty)).toBe(v1Of(missing))
    expect(computePackIntegrity(empty)).not.toBe(computePackIntegrity(missing))
  })

  it('a deprecated manifest.yaml is covered by v2 (it was outside v1 entirely)', () => {
    const a = rawPack('ma', { 'manifest.yaml': 'name: a\nversion: 1.0.0\n', 'engrams.yaml': 'engrams: []\n' })
    const b = rawPack('mb', { 'manifest.yaml': 'name: a\nversion: 6.6.6\n', 'engrams.yaml': 'engrams: []\n' })
    expect(v1Of(a)).toBe(v1Of(b))
    expect(computePackIntegrity(a)).not.toBe(computePackIntegrity(b))
  })

  it('is the documented construction, byte for byte', () => {
    const d = rawPack('doc', { 'SKILL.md': 'S', 'engrams.yaml': 'EE' })
    const framed = Buffer.concat([
      Buffer.from('SKILL.md\0' + '1\0'), Buffer.from('S'),
      Buffer.from('manifest.yaml\0-\0'),
      Buffer.from('engrams.yaml\0' + '2\0'), Buffer.from('EE'),
    ])
    expect(computePackIntegrity(d)).toBe(`sha256:v2:${createHash('sha256').update(framed).digest('hex')}`)
  })
})

describe('export, verify and install use v2', () => {
  let out: string
  let packs: string
  beforeEach(() => {
    out = join(tmp, 'out')
    packs = join(tmp, 'packs')
    exportPack([engram()], out, { name: 'honest', version: '1.0.0', license: 'cc-by-4.0' })
  })

  it('export writes a sha256:v2: INTEGRITY value', () => {
    expect(readFileSync(join(out, 'INTEGRITY'), 'utf8').trim()).toMatch(V2)
    expect(verifyPackIntegrity(out).status).toBe('ok')
  })

  it('bytes moved across the SKILL.md / engrams.yaml boundary no longer verify', () => {
    const v1Before = v1Of(out)
    shiftBoundary(out, 1) // both files stay valid: SKILL.md loses its final newline, engrams.yaml gains one
    expect(v1Of(out)).toBe(v1Before) // under v1 this pack would still verify `ok`
    expect(verifyPackIntegrity(out).status).toBe('modified')
  })

  it('install records v2 in the registry and list reports ok', async () => {
    const result = await installPack(packs, out)
    expect(result.registry.integrity).toMatch(V2)
    const [p] = listPacks(packs)
    expect(p.integrity).toMatch(V2)
    expect(p.integrity_status).toBe('ok')
  })
})

describe('v1 values still verify', () => {
  it('a pack that shipped a v1 INTEGRITY verifies ok, and a tampered one does not', () => {
    const out = join(tmp, 'legacy')
    exportPack([engram()], out, { name: 'legacy', version: '1.0.0', license: 'cc-by-4.0' })
    writeFileSync(join(out, 'INTEGRITY'), `${v1Of(out)}\n`) // what every pre-v2 export wrote
    const ok = verifyPackIntegrity(out)
    expect(ok.status).toBe('ok')
    expect(ok.computed).toBe(ok.shipped) // compared in the version it shipped in
    const p = join(out, 'engrams.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('Migrations', 'Deployments'))
    expect(verifyPackIntegrity(out).status).toBe('modified')
  })

  it('packIntegrityMatches reads both formats and refuses anything else', () => {
    const d = rawPack('m', { 'SKILL.md': 'S', 'engrams.yaml': 'E' })
    expect(packIntegrityMatches(v1Of(d), d)).toBe(true)
    expect(packIntegrityMatches(computePackIntegrity(d), d)).toBe(true)
    expect(packIntegrityMatches('sha256:v3:' + '0'.repeat(64), d)).toBe(false)
    expect(packIntegrityMatches('md5:abc', d)).toBe(false)
  })
})

// ---------------------------------------------------------------------------

/** An installed pack whose registry row carries a v1 value — the state every pre-v2 install left. */
async function legacyInstall(packs: string, name: string): Promise<string> {
  const out = join(tmp, `src-${name}`)
  exportPack([engram()], out, { name, version: '1.0.0', license: 'cc-by-4.0' })
  await installPack(packs, out)
  const regPath = join(packs, 'registry.yaml')
  const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Array<{ name: string; integrity: string }> }
  const row = reg.packs.find(r => r.name === name)!
  row.integrity = v1Of(join(packs, `src-${name}`))
  writeFileSync(regPath, yaml.dump(reg))
  return join(packs, `src-${name}`)
}

describe('migratePackIntegrity — re-baselining installed v1 rows', () => {
  let packs: string
  let clean: string
  let tampered: string
  beforeEach(async () => {
    packs = join(tmp, 'packs')
    clean = await legacyInstall(packs, 'clean')
    tampered = await legacyInstall(packs, 'tampered')
    const p = join(tampered, 'engrams.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('Migrations', 'Deployments'))
  })

  const rows = () => (yaml.load(readFileSync(join(packs, 'registry.yaml'), 'utf8')) as { packs: Array<{ name: string; integrity: string }> }).packs
  const status = () => Object.fromEntries(listPacks(packs).map(p => [p.name, p.integrity_status]))

  it('legacy rows verify under v1 before migration', () => {
    expect(status()).toEqual({ clean: 'ok', tampered: 'modified' })
  })

  it('dry run reports the plan and writes nothing', () => {
    const before = readFileSync(join(packs, 'registry.yaml'))
    const report = migratePackIntegrity(packs, { dryRun: true })
    expect(report.dry_run).toBe(true)
    const by = Object.fromEntries(report.packs.map(p => [p.name, p.action]))
    expect(by).toEqual({ clean: 'migrated', tampered: 'skipped-modified' })
    expect(report.migrated).toBe(1)
    expect(readFileSync(join(packs, 'registry.yaml')).equals(before)).toBe(true)
  })

  it('a real run re-baselines only the clean pack, and never blesses the modified one', () => {
    const report = migratePackIntegrity(packs)
    expect(report.migrated).toBe(1)
    const r = Object.fromEntries(rows().map(x => [x.name, x.integrity]))
    expect(r.clean).toBe(computePackIntegrity(clean))
    expect(r.tampered).toMatch(/^sha256:[0-9a-f]{64}$/) // untouched v1
    expect(status()).toEqual({ clean: 'ok', tampered: 'modified' })
  })

  it('is idempotent', () => {
    migratePackIntegrity(packs)
    const after = readFileSync(join(packs, 'registry.yaml'))
    const again = migratePackIntegrity(packs)
    expect(again.migrated).toBe(0)
    expect(Object.fromEntries(again.packs.map(p => [p.name, p.action])))
      .toEqual({ clean: 'already-v2', tampered: 'skipped-modified' })
    expect(readFileSync(join(packs, 'registry.yaml')).equals(after)).toBe(true)
  })

  it('a pack with no registry row, or an unreadable one, is reported and never given a baseline', () => {
    const loose = join(packs, 'loose')
    cpSync(clean, loose, { recursive: true })
    writeFileSync(join(loose, 'SKILL.md'), readFileSync(join(loose, 'SKILL.md'), 'utf8').replace('name: clean', 'name: loose'))
    mkdirSync(join(packs, 'broken'))
    writeFileSync(join(packs, 'broken', 'SKILL.md'), 'not a manifest')
    const report = migratePackIntegrity(packs)
    const by = Object.fromEntries(report.packs.map(p => [p.dir, p.action]))
    expect(by.loose).toBe('skipped-no-entry')
    expect(by.broken).toBe('skipped-unreadable')
    expect(rows().map(r => r.name).sort()).toEqual(['clean', 'tampered'])
  })

  it('an empty or absent packs directory is a no-op', () => {
    expect(migratePackIntegrity(join(tmp, 'nowhere')).packs).toEqual([])
  })
})
