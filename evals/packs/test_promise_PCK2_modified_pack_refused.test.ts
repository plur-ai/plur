// PCK-2: A pack that was changed after it was made is refused unless I deliberately override.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { authorPack, scratch } from '../helpers/sync-packs-durability-history-packs.js'

describe('PCK-2 a pack changed after it was made is refused unless I override', () => {
  const cleanups: Array<() => void> = []
  let me: TempStore
  afterEach(() => { me?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  const tampers: Array<[string, (dir: string) => void]> = [
    ['a memory in the pack was edited', dir => {
      const p = join(dir, 'engrams.yaml')
      writeFileSync(p, readFileSync(p, 'utf8').replace('Run database migrations before deploying', 'Skip database migrations when deploying'))
    }],
    ['the pack description was edited', dir => {
      const p = join(dir, 'SKILL.md')
      writeFileSync(p, readFileSync(p, 'utf8').replace('ops-tips pack', 'ops-tips pack, now with extra advice'))
    }],
  ]

  for (const [what, tamper] of tampers) {
    it(`refused when ${what}; installs only with the override`, async () => {
      const src = scratch('plur-eval-pck2-'); cleanups.push(src.cleanup)
      const untouched = await authorPack(join(src.dir, 'clean', 'ops-tips'), 'ops-tips', ['Run database migrations before deploying'])
      const changed = await authorPack(join(src.dir, 'changed', 'ops-tips'), 'ops-tips', ['Run database migrations before deploying'])
      const before = readFileSync(join(changed, 'engrams.yaml'), 'utf8') + readFileSync(join(changed, 'SKILL.md'), 'utf8')
      tamper(changed)
      const after = readFileSync(join(changed, 'engrams.yaml'), 'utf8') + readFileSync(join(changed, 'SKILL.md'), 'utf8')
      expect(after, 'precondition: the tamper really changed the pack').not.toBe(before)

      me = await tempStore({ embedder: 'off' })
      // Precondition: the same pack, unchanged, installs without any override.
      const ok = await me.plur.installPack(untouched)
      expect(ok.installed, 'precondition: the untouched pack installs and brings its memory').toBe(1)
      me.plur.uninstallPack('ops-tips')

      let refused: unknown = null
      try { await me.plur.installPack(changed) } catch (e) { refused = e }
      expect(refused, `a pack changed after it was made (${what}) was installed without an override`).toBeTruthy()
      expect(me.plur.listPacks().map(p => p.name), 'the refused pack shows up as installed').not.toContain('ops-tips')
      expect(existsSync(join(me.dir, 'packs', 'ops-tips')), 'the refused pack was copied into my packs folder').toBe(false)

      let overridden: Awaited<ReturnType<typeof me.plur.installPack>> | null = null
      let overrideErr: unknown = null
      try { overridden = await me.plur.installPack(changed, { allowModified: true }) } catch (e) { overrideErr = e }
      expect(overrideErr, `with the deliberate override the changed pack should install, but it was refused: ${String(overrideErr)}`).toBeNull()
      expect(overridden!.installed, 'with the deliberate override the changed pack should install').toBe(1)
      expect(overridden!.integrity_check.status, 'the override install should still report the pack as modified').toBe('modified')
    })
  }
})
