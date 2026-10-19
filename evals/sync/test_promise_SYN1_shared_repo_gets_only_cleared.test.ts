// SYN-1: Syncing to a shared repository publishes only memories cleared for sharing, never private or personal ones.
//
// "Cleared for sharing" = a shared scope AND visibility deliberately set to
// something other than private. A shared-scope memory that carries NO
// visibility field at all (written by an older client, or by hand) has not been
// cleared, so it must stay home too.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { bareRemote, cloneRemote, isolateGit, yaml } from '../helpers/sync-packs-durability-history-git.js'

describe('SYN-1 a shared repository receives only memories cleared for sharing', () => {
  const cleanups: Array<() => void> = []
  let s: TempStore
  afterEach(() => { s?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  it('publishes the cleared team memory and nothing private, personal or unmarked', async () => {
    isolateGit()
    s = await tempStore({ embedder: 'off' })
    const cleared = await s.plur.learn('Team rule: release notes go in CHANGELOG.md before tagging', { scope: 'group:acme/eng', visibility: 'public' })
    const privTeam = await s.plur.learn('Team scratch: my private note on the release checklist', { scope: 'group:acme/eng', visibility: 'private' })
    const unmarked = await s.plur.learn('Team scratch: unreviewed note with no visibility recorded', { scope: 'group:acme/eng', visibility: 'public' })
    const personal = await s.plur.learn('Personal: I prefer dark mode in every editor', { scope: 'global', visibility: 'public' })

    // Drop the visibility field from one shared memory, as a store written by
    // an older client (or edited by hand) would look.
    const storePath = join(s.dir, 'engrams.yaml')
    const doc = yaml.load(readFileSync(storePath, 'utf8')) as { engrams: Array<Record<string, unknown>> }
    const rec = doc.engrams.find(e => e.id === unmarked.id)
    expect(rec, 'precondition: the unmarked memory is in engrams.yaml').toBeTruthy()
    expect(rec!.scope, 'precondition: the unmarked memory is in a shared scope').toBe('group:acme/eng')
    delete rec!.visibility
    writeFileSync(storePath, yaml.dump(doc))

    const remote = bareRemote(); cleanups.push(remote.cleanup)
    await s.plur.sync(remote.path, { remoteType: 'shared' })
    const clone = cloneRemote(remote.path); cleanups.push(clone.cleanup)

    const pushedIds = clone.engrams.map(e => String(e.id))
    expect(pushedIds, 'the team memory cleared for sharing should reach the shared repository').toContain(cleared.id)
    expect(pushedIds, 'a private team memory was published to the shared repository').not.toContain(privTeam.id)
    expect(pushedIds, 'a shared-scope memory with no visibility recorded (never cleared) was published').not.toContain(unmarked.id)
    expect(pushedIds, 'a personal memory was published to the shared repository').not.toContain(personal.id)
    for (const notCleared of ['my private note', 'unreviewed note', 'dark mode']) {
      expect(clone.text, `text of a memory that was not cleared ("${notCleared}") appears in the shared repository`).not.toContain(notCleared)
    }
  })
})
