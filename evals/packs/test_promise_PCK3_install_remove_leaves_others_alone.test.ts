// PCK-3: Installing or removing a pack never changes or deletes my own memories or another pack.
//
// today: broken — two different packs that arrive in same-named folders
// overwrite each other (issue 1188). The first case is expected red until fixed.
import { existsSync, readFileSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { authorPack, scratch } from '../helpers/sync-packs-durability-history-packs.js'

describe('PCK-3 installing or removing a pack leaves my memories and other packs alone', () => {
  const cleanups: Array<() => void> = []
  let me: TempStore
  afterEach(() => { me?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  it('two different packs that arrive in same-named folders are both kept', async () => {
    const src = scratch('plur-eval-pck3-'); cleanups.push(src.cleanup)
    // Two authors, two different packs, each downloaded into a folder called "pack".
    const a = await authorPack(join(src.dir, 'from-alice', 'pack'), 'alice-tips', ['Alice tip: pin your toolchain versions'])
    const b = await authorPack(join(src.dir, 'from-bob', 'pack'), 'bob-tips', ['Bob tip: keep secrets out of the repository'])

    me = await tempStore({ embedder: 'off' })
    const ra = await me.plur.installPack(a)
    expect(ra.installed, 'precondition: the first pack installs with its memory').toBe(1)
    const rb = await me.plur.installPack(b)
    expect(rb.installed, 'precondition: the second pack installs with its memory').toBe(1)

    const names = me.plur.listPacks().map(p => p.manifest?.name ?? p.name)
    expect(names, `installing a second, different pack removed the first one (installed packs now: ${JSON.stringify(names)})`).toEqual(
      expect.arrayContaining(['alice-tips', 'bob-tips']))
  })

  it('installing then removing a pack leaves my own memories exactly as they were', async () => {
    const src = scratch('plur-eval-pck3-'); cleanups.push(src.cleanup)
    me = await tempStore({ embedder: 'off' })
    const mine = await me.plur.learn('My rule: write the failing test first', { scope: 'global' })
    await me.plur.learn('My rule: small commits with plain messages', { scope: 'global' })
    // The pack carries a near-copy of my memory, to tempt a merge into my store.
    const p = await authorPack(join(src.dir, 'x', 'testing-pack'), 'testing-pack', ['My rule: write the failing test first', 'Run the whole suite before pushing'])
    const storePath = join(me.dir, 'engrams.yaml')
    const before = readFileSync(storePath, 'utf8')
    expect(before, 'precondition: my memories are on disk').toContain(mine.id)

    const r = await me.plur.installPack(p)
    expect(r.installed, 'precondition: the pack installed its two memories').toBe(2)
    expect(readFileSync(storePath, 'utf8'), 'installing a pack changed my own memory file').toBe(before)
    me.plur.uninstallPack('testing-pack')
    expect(existsSync(join(me.dir, 'packs', 'testing-pack')), 'precondition: the pack was removed').toBe(false)
    expect(readFileSync(storePath, 'utf8'), 'removing a pack changed my own memory file').toBe(before)
    const ids = (await me.plur.list()).map(e => e.id)
    expect(ids, 'my memory is gone after installing and removing a pack').toContain(mine.id)
  })

  it('removing one pack leaves another installed pack intact', async () => {
    const src = scratch('plur-eval-pck3-'); cleanups.push(src.cleanup)
    const keep = await authorPack(join(src.dir, 'k', 'keep-pack'), 'keep-pack', ['Keep tip: document every public function'])
    const drop = await authorPack(join(src.dir, 'd', 'drop-pack'), 'drop-pack', ['Drop tip: this pack will be removed'])
    me = await tempStore({ embedder: 'off' })
    await me.plur.installPack(keep)
    await me.plur.installPack(drop)
    const keptFile = join(me.dir, 'packs', 'keep-pack', 'engrams.yaml')
    const keptBefore = readFileSync(keptFile, 'utf8')
    expect(keptBefore, 'precondition: the pack to keep is installed with its memory').toContain('document every public function')

    me.plur.uninstallPack('drop-pack')
    expect(me.plur.listPacks().map(p => p.name), 'precondition: the removed pack is gone').not.toContain('drop-pack')
    expect(me.plur.listPacks().map(p => p.name), 'removing one pack removed another').toContain('keep-pack')
    expect(readFileSync(keptFile, 'utf8'), 'removing one pack changed another pack').toBe(keptBefore)
  })

  it('a pack name that points outside the packs folder cannot touch my memories', async () => {
    const src = scratch('plur-eval-pck3-'); cleanups.push(src.cleanup)
    me = await tempStore({ embedder: 'off' })
    const mine = await me.plur.learn('My rule: never deploy on Fridays', { scope: 'global' })
    const storePath = join(me.dir, 'engrams.yaml')
    const before = readFileSync(storePath, 'utf8')
    expect(before, 'precondition: my memory is on disk').toContain(mine.id)
    mkdirSync(join(me.dir, 'packs'), { recursive: true })

    // Removing "..": the packs folder's parent is my whole store.
    let removeErr: unknown = null
    try { me.plur.uninstallPack('..') } catch (e) { removeErr = e }
    expect(removeErr, 'removing a pack named ".." was not refused').toBeTruthy()
    expect(String(removeErr), "the refusal should be about the pack name pointing outside the packs folder").toMatch(/refusing to uninstall pack/)
    expect(existsSync(storePath) ? readFileSync(storePath, 'utf8') : '<deleted>', 'removing a pack named ".." changed or deleted my memories').toBe(before)

    // Installing from a source whose folder name is "..": its engrams.yaml would land on mine.
    const evil = await authorPack(join(src.dir, 'a', 'b', 'evil'), 'evil', ['Evil tip: overwrite the host store'])
    cpSync(join(evil, 'engrams.yaml'), join(src.dir, 'a', 'engrams.yaml'))
    cpSync(join(evil, 'SKILL.md'), join(src.dir, 'a', 'SKILL.md'))
    cpSync(join(evil, 'INTEGRITY'), join(src.dir, 'a', 'INTEGRITY'))
    let installErr: unknown = null
    // Built by hand: path.join would normalise the ".." away.
    try { await me.plur.installPack(`${join(src.dir, 'a', 'b')}/..`) } catch (e) { installErr = e }
    expect(installErr, 'installing from a folder named ".." was not refused').toBeTruthy()
    expect(String(installErr), "the refusal should be about the folder name pointing outside the packs folder").toMatch(/refusing to install pack/)
    expect(readFileSync(storePath, 'utf8'), 'installing from a folder named ".." changed my memories').toBe(before)
  })
})
