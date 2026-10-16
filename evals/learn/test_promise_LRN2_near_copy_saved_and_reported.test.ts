// LRN-2: Saying something new that merely resembles an existing memory saves it, and I am told which memory it resembles.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

describe('LRN-2 a near-copy is saved, and I am told what it resembles', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('learnAsync without an AI checker, using the bag-of-words similarity stub', async () => {
    s = await tempStore({ embedder: 'bag-of-words' })
    const existing = await s.plur.learn('Always run the database migrations before deploying the api service', { scope: 'global' })
    await s.plur.learn('Team lunch is on Thursdays at noon', { scope: 'global' })

    const said = 'Always run the database migrations before deploying the web service'
    const result = await s.plur.learnAsync(said, { scope: 'global' })

    // Saved: a new memory with the new text exists.
    expect(result.engram.id, 'expected a new memory, not the existing one').not.toBe(existing.id)
    const saved = await s.plur.getById(result.engram.id)
    expect(saved?.statement, `expected the new statement to be stored as said; stored ${JSON.stringify(saved?.statement)}`).toBe(said)
    expect(saved?.status, 'expected the new memory to be active').toBe('active')
    const all = (await s.plur.list()).filter(e => e.status === 'active')
    expect(all.length, `expected three memories after saving a near-copy; found ${all.length}`).toBe(3)
    const original = await s.plur.getById(existing.id)
    expect(original?.statement, 'the memory it resembles must be left as it was').toBe('Always run the database migrations before deploying the api service')

    // Told: the answer names the memory it resembles.
    const named = (result.dedup?.near_duplicates ?? []).map(n => n.id)
    expect(named, `expected to be told it resembles ${existing.id}; was told ${JSON.stringify(named)}`).toContain(existing.id)
  })
})
