// SYN-5: After two devices save, correct or forget memories offline, syncing keeps both devices' changes and never brings back a forgotten memory.
//
// Two stores share one personal repository (a local bare repo: no network).
// Device A starts the store and syncs it; device B joins by cloning that
// repository into its own store folder, the way a second machine gets the
// store. Then, with neither syncing:
//   device A saves X and forgets Y,
//   device B saves Z and corrects W (a new memory that replaces W).
// Then both sync, in both orders, and the first one syncs again so it picks up
// the other's changes. Afterwards each device must hold X, Z and the
// correction (still linked to the W it replaces), and must not hold Y.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'
import { bareRemote, isolateGit } from '../helpers/sync-packs-durability-history-git.js'

interface Device { name: string; plur: Plur; dir: string }

async function syncOrReport(d: Device, remote?: string): Promise<string | null> {
  try { await d.plur.sync(remote); return null } catch (e) { return `${d.name}: ${(e as Error).message.split('\n')[0]}` }
}

describe("SYN-5 two devices' offline changes both survive sync, and a forgotten memory stays forgotten", () => {
  const cleanups: Array<() => void> = []
  let a: TempStore | undefined
  afterEach(() => { a?.cleanup(); a = undefined; while (cleanups.length) cleanups.pop()!() })

  for (const order of ['A first', 'B first'] as const) {
    it(`both devices end with every change (${order})`, async () => {
      isolateGit()
      a = await tempStore({ embedder: 'off' })
      const A: Device = { name: 'device A', plur: a.plur, dir: a.dir }
      const y = await A.plur.learn('The staging VPN password is kept on the old wiki page', { scope: 'global' })
      const w = await A.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
      const remote = bareRemote(); cleanups.push(remote.cleanup)
      expect(await syncOrReport(A, remote.path), 'precondition: device A pushes its store').toBeNull()

      // Device B joins: clone the repository into a fresh store folder.
      const parent = mkdtempSync(join(tmpdir(), 'plur-eval-deviceB-')); cleanups.push(() => rmSync(parent, { recursive: true, force: true }))
      const dirB = join(parent, 'store')
      execFileSync('git', ['clone', '--quiet', remote.path, dirB], { stdio: 'ignore' })
      writeFileSync(join(dirB, 'config.yaml'), 'backend: yaml\n')
      const B: Device = { name: 'device B', plur: new Plur({ path: dirB, autoDiscover: false }), dir: dirB }
      await B.plur.ready()
      const startB = (await B.plur.list()).map(e => e.id)
      expect(startB, 'precondition: device B starts with the memories device A synced').toEqual(expect.arrayContaining([y.id, w.id]))

      // Offline changes on both devices.
      const x = await A.plur.learn('Release notes go in CHANGELOG.md before tagging', { scope: 'global' })
      await A.plur.forget(y.id, 'no longer true')
      const z = await B.plur.learn('The office printer lives on the third floor', { scope: 'global' })
      const fix = await B.plur.learn('Deploy the billing service with canary rollouts, not blue-green', { scope: 'global', supersedes: [w.id] })

      const [first, second] = order === 'A first' ? [A, B] : [B, A]
      const errors = [await syncOrReport(first), await syncOrReport(second), await syncOrReport(first)].filter(Boolean)
      expect(errors, `a sync failed: ${errors.join(' | ')}`).toEqual([])

      const want: Array<[string, string]> = [
        [x.statement, "device A's new memory"],
        [z.statement, "device B's new memory"],
        [fix.statement, "device B's correction"],
      ]
      for (const d of [A, B]) {
        const active = await d.plur.list()
        const statements = active.map(e => e.statement)
        for (const [text, what] of want) {
          expect(statements, `${d.name} is missing ${what} ("${text}") after both synced`).toContain(text)
        }
        expect(statements, `${d.name} brought back the memory device A forgot ("${y.statement}")`).not.toContain(y.statement)
        const hits = await d.plur.recall('staging VPN password wiki', { limit: 10 })
        expect(hits.map(e => e.statement), `${d.name}: searching finds the memory device A forgot`).not.toContain(y.statement)

        const fixHere = active.find(e => e.statement === fix.statement)
        const old = active.find(e => e.statement === w.statement) ?? await d.plur.getById(w.id)
        expect(old, `precondition: ${d.name} still has the corrected memory W to link the correction to`).toBeTruthy()
        const supersededBy = ((old as any)?.relations?.superseded_by ?? []) as string[]
        expect(fixHere && supersededBy.includes(fixHere.id),
          `${d.name}: the correction no longer replaces W (W.superseded_by=${JSON.stringify(supersededBy)}, correction id=${fixHere?.id})`).toBe(true)
      }
    })
  }
})
