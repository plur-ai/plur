/**
 * Security audit 2026-11-06: the pack registry (packs/registry.yaml) lives in
 * the same directory packs are installed into. A pack whose install directory
 * name came out as `registry.yaml` (a source folder of that name, or a flat
 * archive whose manifest says `name: registry.yaml`) was swapped in over the
 * registry file and deleted every other pack's integrity baseline; and
 * `uninstallPack(packs, 'registry.yaml')` deleted the registry outright.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPack, uninstallPack, listPacks } from '../src/packs.js'

const engrams = (id: string) => `engrams:
  - id: ${id}
    statement: "Dummy pack rule ${id}"
    type: behavioral
    scope: global
    status: active
    visibility: public
`

let tmp: string
let packs: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plur-reserved-pack-'))
  packs = join(tmp, 'packs')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function source(rel: string, manifestName: string, id: string): string {
  const d = join(tmp, 'src', rel)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${manifestName}\nversion: 1.0.0\n---\nProse.\n`)
  writeFileSync(join(d, 'engrams.yaml'), engrams(id))
  return d
}

async function withAlpha(): Promise<string> {
  await installPack(packs, source('alpha', 'alpha', 'ENG-2026-11-06-001'))
  return readFileSync(join(packs, 'registry.yaml'), 'utf8')
}

describe('pack names reserved for the registry', () => {
  it('refuses a source folder named registry.yaml and leaves the registry intact', async () => {
    const before = await withAlpha()
    await expect(installPack(packs, source('registry.yaml', 'evil', 'ENG-2026-11-06-002'))).rejects.toThrow(/reserved/)
    expect(statSync(join(packs, 'registry.yaml')).isFile()).toBe(true)
    expect(readFileSync(join(packs, 'registry.yaml'), 'utf8')).toBe(before)
    expect(listPacks(packs).map(p => p.manifest?.name)).toEqual(['alpha'])
  })

  it('never installs a flat-archive pack named registry.yaml onto the registry file', async () => {
    const before = await withAlpha()
    // A flat URL archive extracts to a folder called `extracted`; the manifest
    // name then becomes the preferred directory name.
    try { await installPack(packs, source('extracted', 'registry.yaml', 'ENG-2026-11-06-003')) } catch { /* refusing is fine */ }
    expect(statSync(join(packs, 'registry.yaml')).isFile()).toBe(true)
    expect(readFileSync(join(packs, 'registry.yaml'), 'utf8')).toContain('alpha')
    expect(() => listPacks(packs)).not.toThrow()
    expect(before).toContain('alpha')
  })

  it('uninstall refuses the registry file and other non-directory entries', async () => {
    const before = await withAlpha()
    expect(() => uninstallPack(packs, 'registry.yaml')).toThrow()
    expect(() => uninstallPack(packs, 'REGISTRY.YAML')).toThrow()
    writeFileSync(join(packs, 'notes.txt'), 'user file')
    expect(() => uninstallPack(packs, 'notes.txt')).toThrow(/not found/i)
    expect(readFileSync(join(packs, 'registry.yaml'), 'utf8')).toBe(before)
    expect(readFileSync(join(packs, 'notes.txt'), 'utf8')).toBe('user file')
  })
})
