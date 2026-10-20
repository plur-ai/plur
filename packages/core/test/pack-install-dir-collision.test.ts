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

  it('a pack displaced by a collision is upgraded in place after the collision is gone', async () => {
    await installPack(packs, source('alice/pack', 'alice-tips', 'Alice tip'))
    await installPack(packs, source('bob/pack', 'bob-tips', 'Bob tip v1'))
    expect(dirs()).toEqual(['bob-tips', 'pack'])
    uninstallPack(packs, 'pack')
    // The preferred directory is free again; bob's installation lives in bob-tips.
    const r = await installPack(packs, source('bob2/pack', 'bob-tips', 'Bob tip v2', '2.0.0'))
    expect(r.registry.dir).toBe('bob-tips')
    expect(dirs()).toEqual(['bob-tips'])
    const installed = listPacks(packs)
    expect(installed.map(p => [p.manifest?.name, p.manifest?.version])).toEqual([['bob-tips', '2.0.0']])
  })

  it('a pack in a numbered fallback directory is upgraded in place after the collisions are gone', async () => {
    await installPack(packs, source('y/x', 'y-tips', 'Lives in packs/x'))
    await installPack(packs, source('a/pack', 'alice-tips', 'Lives in packs/pack'))
    await installPack(packs, source('b/pack', 'x', 'X v1'))
    expect(dirs()).toEqual(['pack', 'x', 'x-2'])
    uninstallPack(packs, 'x')
    uninstallPack(packs, 'pack')
    const r = await installPack(packs, source('c/pack', 'x', 'X v2', '2.0.0'))
    expect(r.registry.dir).toBe('x-2')
    expect(dirs()).toEqual(['x-2'])
    expect(listPacks(packs).map(p => [p.manifest?.name, p.manifest?.version])).toEqual([['x', '2.0.0']])
  })

  it('after an in-place upgrade of a displaced pack, injection carries only the new rule', async () => {
    const { Plur } = await import('../src/index.js')
    const root = join(tmp, 'root')
    const plur = new Plur({ path: root })
    const rootPacks = join(root, 'packs')
    await plur.installPack(source('alice/pack', 'alice-tips', 'Alice rule about gardening tomatoes'))
    await plur.installPack(source('bob/pack', 'bob-tips', 'Release rule: tag the build before publishing'))
    uninstallPack(rootPacks, 'pack')
    await plur.installPack(source('bob2/pack', 'bob-tips', 'Release rule: sign the tag before publishing', '2.0.0'))
    const r = await plur.inject('release rule tag build publishing')
    const rendered = [r.directives, r.constraints, r.consider].join('\n')
    expect(rendered).toContain('sign the tag before publishing')
    expect(rendered).not.toContain('tag the build before publishing')
  })

  it('removing one of the two leaves the other installed', async () => {
    await installPack(packs, source('alice/pack', 'alice-tips', 'A'))
    await installPack(packs, source('bob/pack', 'bob-tips', 'B'))
    uninstallPack(packs, 'bob-tips')
    expect(names()).toEqual(['alice-tips'])
  })
})
