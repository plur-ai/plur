// SYN-3: When a sync cannot push, it says so instead of reporting success, and a damaged store is never published.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { bareRemote, cloneRemote, isolateGit } from '../helpers/sync-packs-durability-history-git.js'

describe('SYN-3 a failed push is reported and a damaged store is never published', () => {
  const cleanups: Array<() => void> = []
  let s: TempStore
  afterEach(() => { s?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  it('a push that fails is reported as not pushed', async () => {
    isolateGit()
    s = await tempStore({ embedder: 'off' })
    await s.plur.learn('Tag releases from the main branch only', { scope: 'global' })
    const remote = bareRemote(); cleanups.push(remote.cleanup)
    const first = await s.plur.sync(remote.path)
    expect(first.push_error, 'precondition: the first sync to a working remote pushed cleanly').toBeFalsy()

    // The remote worked when it was set up and is now gone.
    rmSync(remote.path, { recursive: true, force: true })
    await s.plur.learn('Never force-push to main', { scope: 'global' })
    const res = await s.plur.sync()

    expect(res.push_error, `the push failed but the sync result carried no push error (message: "${res.message}")`).toBeTruthy()
    expect(res.message, `the sync message should say the memories were not pushed; it said "${res.message}"`).toMatch(/not pushed/i)
  })

  it('a damaged store is refused and nothing of it reaches the remote', async () => {
    isolateGit()
    s = await tempStore({ embedder: 'off' })
    await s.plur.learn('Deploys need two approvals', { scope: 'global' })
    const remote = bareRemote(); cleanups.push(remote.cleanup)
    await s.plur.sync(remote.path)
    const before = cloneRemote(remote.path); cleanups.push(before.cleanup)
    expect(before.engrams.length, 'precondition: the first sync published the healthy store').toBe(1)

    // A merge conflict left in the store, carrying a private memory.
    const storePath = join(s.dir, 'engrams.yaml')
    const healthy = readFileSync(storePath, 'utf8')
    // (Markers built at runtime so this file itself never carries a literal one.)
    const [ours, mid, theirs] = ['<', '=', '>'].map(c => c.repeat(7))
    writeFileSync(storePath, `${ours} HEAD\n${healthy}${mid}\nengrams:\n  - id: ENG-PRIVATE-1\n    statement: DAMAGED-PRIVATE-c41e\n    scope: local\n${theirs} other\n`)

    let threw: unknown = null
    let res: unknown = null
    try { res = await s.plur.sync() } catch (e) { threw = e }
    expect(threw, `sync of a damaged store should be refused, but it returned ${JSON.stringify(res)}`).toBeTruthy()

    const after = cloneRemote(remote.path); cleanups.push(after.cleanup)
    expect(after.text, 'conflict markers from the damaged store were published').not.toContain(ours)
    expect(after.text, 'a private memory from the damaged store was published').not.toContain('DAMAGED-PRIVATE-c41e')
  })
})
