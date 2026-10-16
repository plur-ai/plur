// LRN-1: Saying exactly the same thing twice keeps one memory, not two.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

const SAID = 'Staging deploys need a green smoke test before promotion'

describe('LRN-1 saying the same thing twice keeps one memory', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('learn the same sentence twice, with another memory already in the store', async () => {
    s = await tempStore({ embedder: 'off' })
    // Another memory in the same scope, so "the same thing" must really mean the same text.
    const other = await s.plur.learn('Production database backups are kept for thirty days', { scope: 'global' })

    const first = await s.plur.learn(SAID, { scope: 'global' })
    const second = await s.plur.learn(SAID, { scope: 'global' })

    const all = await s.plur.list()
    const copies = all.filter(e => e.statement === SAID && e.status === 'active')
    expect(copies.length, `expected exactly one memory saying it after saying it twice; found ${copies.length}`).toBe(1)
    expect(all.filter(e => e.status === 'active').length,
      `expected two memories in the store (the other one and this one); found ${all.length}`).toBe(2)
    expect(second.id, `expected the second save to answer with the first memory ${first.id}; it answered ${second.id}`)
      .toBe(first.id)

    const kept = await s.plur.getById(first.id)
    expect(kept?.write_count, `expected the kept memory to record that it was said twice (write count 2); it has ${kept?.write_count}`)
      .toBe(2)
    const untouched = await s.plur.getById(other.id)
    expect(untouched?.write_count ?? 1, 'the other memory should not have been counted as a repeat').toBe(1)
  })
})
