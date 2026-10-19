// FDB-5: A memory outside its valid dates is hidden from search, listing and my
// agent, and an unreadable date never hides a memory.
import { afterEach, describe, expect, it } from 'vitest'
import type { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'
import { given, rawStore, storedMemory } from '../helpers/corrections-inject-feedback-util.js'

const TASK = 'deploy the billing service rollout'
const QUERY = 'billing service rollout'

/** What I see on every path: four searches/listings and two injections, each run once. */
type Seen = Record<'recall' | 'recallHybrid' | 'list' | 'inject' | 'injectHybrid', string[]>
async function lookEverywhere(plur: Plur): Promise<Seen> {
  return {
    recall: (await plur.recall(QUERY, { limit: 20 })).map(e => e.id),
    recallHybrid: (await plur.recallHybrid(QUERY, { limit: 20 })).map(e => e.id),
    list: (await plur.list()).map(e => e.id),
    inject: given(await plur.inject(TASK, { budget: 4000 })),
    injectHybrid: given(await plur.injectHybrid(TASK, { budget: 4000 })),
  }
}
/** For one memory: on which paths it showed up. */
function whereSeen(seen: Seen, id: string): Record<keyof Seen, boolean> {
  return Object.fromEntries(Object.entries(seen).map(([k, ids]) => [k, ids.includes(id)])) as Record<keyof Seen, boolean>
}
const EVERYWHERE = { recall: true, recallHybrid: true, list: true, inject: true, injectHybrid: true }
const NOWHERE = { recall: false, recallHybrid: false, list: false, inject: false, injectHybrid: false }

describe('FDB-5 validity dates hide a memory; unreadable dates never do', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('a memory past its end date or before its start date is hidden everywhere', async () => {
    s = await tempStore({ embedder: 'bag-of-words' })
    const current = await s.plur.learn('Deploy the billing service rollout with blue-green switching', { scope: 'global' })
    const expired = await s.plur.learn('Deploy the billing service rollout with the old Jenkins job',
      { scope: 'global', valid_until: '2020-01-31' })
    const notYet = await s.plur.learn('Deploy the billing service rollout with the new pipeline',
      { scope: 'global', valid_from: '2999-01-01' })

    const seen = await lookEverywhere(s.plur)
    expect(whereSeen(seen, current.id), 'precondition: a memory inside its dates shows up everywhere')
      .toEqual(EVERYWHERE)
    expect((await s.plur.list({ include_expired: true })).map(e => e.id),
      'precondition: both out-of-date memories are really stored').toEqual(expect.arrayContaining([expired.id, notYet.id]))

    expect(whereSeen(seen, expired.id), 'a memory past its end date (2020-01-31) showed up here (true = seen)')
      .toEqual(NOWHERE)
    expect(whereSeen(seen, notYet.id), 'a memory before its start date (2999-01-01) showed up here (true = seen)')
      .toEqual(NOWHERE)
  })

  it('a memory whose dates cannot be read is never hidden', async () => {
    // The write path refuses an unreadable date, so these are written to the
    // store file by hand, as an import or a hand edit could leave them.
    s = await rawStore([
      storedMemory('ENG-EVAL-BAD-UNTIL', 'Deploy the billing service rollout with canary steps',
        { strength: 0.7, lastUsedDaysAgo: 0, temporal: { valid_until: 'end of next quarter' } }),
      storedMemory('ENG-EVAL-BAD-FROM', 'Deploy the billing service rollout after the freeze lifts',
        { strength: 0.7, lastUsedDaysAgo: 0, temporal: { valid_from: 'sometime soon' } }),
      // Control: a readable past end date in the same hand-written store is hidden.
      storedMemory('ENG-EVAL-EXPIRED', 'Deploy the billing service rollout with the old Jenkins job',
        { strength: 0.7, lastUsedDaysAgo: 0, temporal: { valid_until: '2020-01-31' } }),
    ])
    // Keyword search only (rawStore), so recallHybrid and injectHybrid run their keyword leg.
    const seen = await lookEverywhere(s.plur)
    expect(whereSeen(seen, 'ENG-EVAL-EXPIRED'),
      'precondition: a readable past end date in this hand-written store does hide its memory everywhere').toEqual(NOWHERE)

    expect(whereSeen(seen, 'ENG-EVAL-BAD-UNTIL'), 'an unreadable end date hid the memory here (false = hidden)')
      .toEqual(EVERYWHERE)
    expect(whereSeen(seen, 'ENG-EVAL-BAD-FROM'), 'an unreadable start date hid the memory here (false = hidden)')
      .toEqual(EVERYWHERE)
  })
})
