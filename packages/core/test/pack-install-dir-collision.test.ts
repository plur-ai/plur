/**
 * Two different packs that arrive in same-named folders are both kept (#1188).
 *
 * The install directory was the source folder's basename, so `a/pack` and
 * `b/pack` both installed to `packs/pack` and the second silently replaced the
 * first. A reinstall of the SAME pack (same manifest name) must still replace
 * it in place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPack, uninstallPack, listPacks } from '../src/packs.js'

const engrams = (id: string, statement: string) => `engrams:
  - id: ${id}
    statement: "${statement}"
    type: behavioral
    scope: global
    status: active
    visibility: public
`

let tmp: string
let packs: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plur-dir-collision-'))
  packs = join(tmp, 'packs')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function source(rel: string, manifestName: string, statement: string, version = '1.0.0'): string {
  const d = join(tmp, 'src', rel)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${manifestName}\nversion: ${version}\n---\nProse.\n`)
  writeFileSync(join(d, 'engrams.yaml'), engrams('ENG-2026-10-19-001', statement))
  return d
}

const names = () => listPacks(packs).map(p => p.manifest?.name).sort()
const dirs = () => readdirSync(packs).filter(e => e !== 'registry.yaml' && !e.startsWith('.')).sort()

describe('install directory collisions', () => {
  it('a second, different pack from a same-named folder does not replace the first', async () => {
    await installPack(packs, source('alice/pack', 'alice-tips', 'Pin toolchain versions'))
    const r = await installPack(packs, source('bob/pack', 'bob-tips', 'Keep secrets out of the repo'))
    expect(r.installed).toBe(1)
    expect(names()).toEqual(['alice-tips', 'bob-tips'])
    expect(dirs()).toEqual(['bob-tips', 'pack'])
    expect(r.registry.dir).toBe('bob-tips')
  })

  it('falls back to a numbered directory when the manifest name is also taken by another pack', async () => {
    await installPack(packs, source('y/x', 'y-tips', 'Lives in packs/x'))
    await installPack(packs, source('a/pack', 'alice-tips', 'Lives in packs/pack'))
    // Basename `pack` holds alice-tips and manifest name `x` holds y-tips.
    const r = await installPack(packs, source('b/pack', 'x', 'Needs a third directory'))
    expect(r.registry.dir).toBe('x-2')
    expect(names()).toEqual(['alice-tips', 'x', 'y-tips'])
  })

  it('reinstalling the same pack from a same-named folder replaces it in place', async () => {
    await installPack(packs, source('alice/pack', 'alice-tips', 'Old tip'))
    await installPack(packs, source('bob/pack', 'bob-tips', 'Bob tip'))
    await installPack(packs, source('alice2/pack', 'alice-tips', 'New tip', '2.0.0'))
    await installPack(packs, source('bob2/pack', 'bob-tips', 'Bob tip v2', '2.0.0'))
    expect(dirs()).toEqual(['bob-tips', 'pack'])
    expect(listPacks(packs).map(p => p.manifest?.version)).toEqual(['2.0.0', '2.0.0'])
  })

  it('removing one of the two leaves the other installed', async () => {
    await installPack(packs, source('alice/pack', 'alice-tips', 'A'))
    await installPack(packs, source('bob/pack', 'bob-tips', 'B'))
    uninstallPack(packs, 'bob-tips')
    expect(names()).toEqual(['alice-tips'])
  })
})
