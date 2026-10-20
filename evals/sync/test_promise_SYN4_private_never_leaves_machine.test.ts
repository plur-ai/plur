// SYN-4: Private memories never leave my machine through sync to a shared
// repository; my own personal repository receives them (it is my backup).
//
// Owner decision 2026-10-19 (decision board A4): mirror private memories to my
// own remote. Machine-local memories and side records stay home either way (SYN-6).
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { bareRemote, cloneRemote, isolateGit } from '../helpers/sync-packs-durability-history-git.js'

describe('SYN-4 private memories never reach a shared repository; my own repository mirrors them', () => {
  const cleanups: Array<() => void> = []
  let s: TempStore
  afterEach(() => { s?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  for (const remoteType of ['personal', 'shared'] as const) {
    it(`a ${remoteType} repository gets private memories only if it is my own`, async () => {
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
      if (remoteType === 'shared') {
        expect(pushed, 'a private personal memory left the machine through sync to a shared repository').not.toContain(privMine.id)
        expect(pushed, 'a private team memory left the machine through sync to a shared repository').not.toContain(privTeam.id)
        expect(clone.text, 'private memory text appears in the shared repository').not.toMatch(/bank appointment|draft opinion/)
      } else {
        expect(pushed, 'my own repository did not receive my private memory (it mirrors them, owner decision 2026-10-19)').toContain(privMine.id)
        expect(pushed, 'my own repository did not receive my private team-scoped memory').toContain(privTeam.id)
      }
    })
  }
})
