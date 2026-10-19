// SYN-4: Private memories never leave my machine through sync, even to my own personal repository.
//
// today: broken (decide-needed). A personal repository receives private
// memories by design today, with a warning. This eval is expected red until the
// owner decides to keep the promise (and change the default) or retire it.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { bareRemote, cloneRemote, isolateGit } from '../helpers/sync-packs-durability-history-git.js'

describe('SYN-4 private memories never leave my machine, even to my own repository', () => {
  const cleanups: Array<() => void> = []
  let s: TempStore
  afterEach(() => { s?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  for (const remoteType of ['personal', 'shared'] as const) {
    it(`a ${remoteType} repository does not receive a private memory`, async () => {
      isolateGit()
      s = await tempStore({ embedder: 'off' })
      const shareable = await s.plur.learn('Team rule: every PR needs a linked issue', { scope: 'group:acme/eng', visibility: 'public' })
      const privMine = await s.plur.learn('Private: my bank appointment is on Thursday morning', { scope: 'global', visibility: 'private' })
      const privTeam = await s.plur.learn('Private: my draft opinion of the reorg', { scope: 'group:acme/eng', visibility: 'private' })

      const remote = bareRemote(); cleanups.push(remote.cleanup)
      await s.plur.sync(remote.path, { remoteType })
      const clone = cloneRemote(remote.path); cleanups.push(clone.cleanup)

      const pushed = clone.engrams.map(e => String(e.id))
      expect(pushed, `precondition: the sync to the ${remoteType} repository pushed the memory cleared for sharing`).toContain(shareable.id)
      expect(pushed, `a private personal memory left the machine through sync to a ${remoteType} repository`).not.toContain(privMine.id)
      expect(pushed, `a private team memory left the machine through sync to a ${remoteType} repository`).not.toContain(privTeam.id)
      expect(clone.text, `private memory text appears in the ${remoteType} repository`).not.toMatch(/bank appointment|draft opinion/)
    })
  }
})
