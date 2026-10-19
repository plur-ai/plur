// FDB-3: A memory I do not use fades by half over a stated period and never
// fades away completely.
//
// The stated period is written here as a literal: 14 days. (Today's decay rate
// gives a half-life of about 13.9 days for the strength above the floor; the
// owner may restate the period, but the eval must not read it from the code.)
//
// "Fades by half" is observed where fading matters — the order in which equally
// relevant memories reach the agent. A memory at full strength left unused for
// 14 days must rank like a fresh memory of about half that strength: behind a
// fresh one at 0.55 and ahead of a fresh one at 0.45.
import { afterEach, describe, expect, it } from 'vitest'
import { type TempStore } from '../helpers/store.js'
import { given, positionInText, rawStore, storedMemory } from '../helpers/corrections-inject-feedback-util.js'

const HALF_LIFE_DAYS = 14
const TASK = 'deploy the billing service rollout'
const say = (plan: string) => `Deploy the billing service rollout using plan ${plan}`

describe('FDB-3 an unused memory fades by half over 14 days, and never to nothing', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it(`after ${HALF_LIFE_DAYS} unused days a full-strength memory ranks like one at about half strength`, async () => {
    s = await rawStore([
      storedMemory('ENG-EVAL-STALE', say('alpha'), { strength: 1.0, lastUsedDaysAgo: HALF_LIFE_DAYS }),
      storedMemory('ENG-EVAL-FRESH-055', say('bravo'), { strength: 0.55, lastUsedDaysAgo: 0 }),
      storedMemory('ENG-EVAL-FRESH-045', say('charlie'), { strength: 0.45, lastUsedDaysAgo: 0 }),
    ])
    const r = await s.plur.inject(TASK, { budget: 4000 })
    const ids = given(r)
    expect(ids, 'precondition: all three equally relevant memories are given')
      .toEqual(expect.arrayContaining(['ENG-EVAL-STALE', 'ENG-EVAL-FRESH-055', 'ENG-EVAL-FRESH-045']))
    const stale = positionInText(r, 'ENG-EVAL-STALE')
    expect(stale, `after ${HALF_LIFE_DAYS} days unused, the full-strength memory still ranks ahead of a fresh one at 0.55 — it faded by less than half`)
      .toBeGreaterThan(positionInText(r, 'ENG-EVAL-FRESH-055'))
    expect(stale, `after ${HALF_LIFE_DAYS} days unused, the full-strength memory ranks behind a fresh one at 0.45 — it faded by more than half`)
      .toBeLessThan(positionInText(r, 'ENG-EVAL-FRESH-045'))
  })

  it('a memory unused for ten years has faded but is still given when it is relevant', async () => {
    s = await rawStore([
      storedMemory('ENG-EVAL-ANCIENT', say('alpha'), { strength: 1.0, lastUsedDaysAgo: 3650 }),
      storedMemory('ENG-EVAL-STRONG', say('bravo'), { strength: 0.7, lastUsedDaysAgo: 0 }),
      storedMemory('ENG-EVAL-WEAK', say('charlie'), { strength: 0.2, lastUsedDaysAgo: 0 }),
    ])
    const r = await s.plur.inject(TASK, { budget: 4000 })
    const ids = given(r)
    expect(ids, 'precondition: the fresh memories are given').toEqual(
      expect.arrayContaining(['ENG-EVAL-STRONG', 'ENG-EVAL-WEAK']))
    expect(ids, 'a memory unused for ten years faded away completely: it is no longer given at all')
      .toContain('ENG-EVAL-ANCIENT')
    // It did fade: it now ranks behind even a weak fresh memory.
    expect(positionInText(r, 'ENG-EVAL-ANCIENT'), 'precondition: after ten years the memory has faded below a weak fresh one')
      .toBeGreaterThan(positionInText(r, 'ENG-EVAL-WEAK'))
  })
})
