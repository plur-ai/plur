// HIS-1: Every memory's history shows when it was created, merged with a duplicate, renamed and forgotten.
//
// "Renamed" here is a memory given a new id because another memory already
// carried its id (two machines minting the same id, then meeting in one store).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'
import { yaml } from '../helpers/sync-packs-durability-history-git.js'

const events = (p: Plur, id: string) => p.getEngramHistory(id).map(e => e.event as string)

describe("HIS-1 a memory's history shows created, merged with a duplicate, renamed and forgotten", () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('created, then a duplicate save merged into it, then forgotten', async () => {
    s = await tempStore({ embedder: 'off' })
    const m = await s.plur.learn('Always run the linter before opening a pull request', { scope: 'global' })
    expect(events(s.plur, m.id), 'the history of a new memory does not show it was created').toContain('engram_created')

    const again = await s.plur.learn('Always run the linter before opening a pull request', { scope: 'global' })
    expect(again.id, 'precondition: saving the same text again merged into the existing memory').toBe(m.id)
    expect(events(s.plur, m.id), 'the history does not show the duplicate save that was merged into this memory').toContain('engram_duplicate_absorbed')

    // Forget until it is gone (a memory saved twice needs two forgets).
    for (let i = 0; i < 3; i++) {
      await s.plur.forget(m.id, 'eval: no longer true')
      if ((await s.plur.getById(m.id))?.status === 'retired') break
    }
    expect((await s.plur.getById(m.id))?.status, 'precondition: the memory is forgotten').toBe('retired')
    const h = events(s.plur, m.id)
    expect(h, `the history of a forgotten memory does not show it was forgotten (events: ${h.join(', ')})`).toContain('engram_retired')
    expect(h.indexOf('engram_created'), 'the history is not in the order things happened').toBeLessThan(h.indexOf('engram_retired'))
  })

  it('a memory renamed because its id was taken shows the rename under its new id, and then its forget', async () => {
    s = await tempStore({ embedder: 'off' })
    const first = await s.plur.learn('Staging is rebuilt every night at midnight', { scope: 'global' })
    // Another machine minted the same id for a different memory; both are now in one file.
    const storePath = join(s.dir, 'engrams.yaml')
    const doc = yaml.load(readFileSync(storePath, 'utf8')) as { engrams: Array<Record<string, unknown>> }
    const twin = { ...doc.engrams[0], statement: 'The release train leaves every second Tuesday', content_hash: undefined }
    delete twin.content_hash
    doc.engrams.push(twin)
    writeFileSync(storePath, yaml.dump(doc))

    const fresh = new Plur({ path: s.dir, autoDiscover: false })
    await fresh.learn('An unrelated save that writes the store back', { scope: 'global' })
    const all = await fresh.list()
    const renamed = all.find(e => e.statement === 'The release train leaves every second Tuesday')
    const kept = all.find(e => e.statement === 'Staging is rebuilt every night at midnight')
    expect(renamed && kept, 'precondition: both memories that shared an id are still there').toBeTruthy()
    const [movedId, oldId] = renamed!.id !== first.id ? [renamed!.id, first.id] : [kept!.id, first.id]
    expect(movedId, 'precondition: one of the two memories was given a new id').not.toBe(oldId)

    const h = fresh.getEngramHistory(movedId)
    const rename = h.find(e => (e.event as string) === 'engram_rekeyed')
    expect(rename, `the history under the new id does not show the rename (events: ${h.map(e => e.event).join(', ')})`).toBeTruthy()
    expect((rename!.data as { from?: string })?.from, 'the rename in the history does not say which id it was renamed from').toBe(oldId)

    await fresh.forget(movedId, 'eval: forget the renamed one')
    expect((await fresh.getById(movedId))?.status, 'precondition: the renamed memory is forgotten').toBe('retired')
    expect(events(fresh, movedId), 'the history of the renamed memory does not show it was forgotten').toContain('engram_retired')
  })
})
