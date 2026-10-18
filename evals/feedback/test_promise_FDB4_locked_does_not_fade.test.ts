// FDB-4: A memory I locked does not fade.
//
// Observed where fading matters — the order equally relevant memories reach
// the agent. A locked memory at strength 0.7 left unused for 60 days must still
// rank like 0.7: ahead of a fresh memory at 0.65. Its unlocked twin, same
// strength and same 60 days, does fade and falls behind — that control proves
// the setup really measures fading.
import { afterEach, describe, expect, it } from 'vitest'
import { type TempStore } from '../helpers/store.js'
import { deliversText, given, positionInText, rawStore, storedMemory } from '../helpers/corrections-inject-feedback-util.js'

const TASK = 'deploy the billing service rollout'
const say = (plan: string) => `Deploy the billing service rollout using plan ${plan}`

describe('FDB-4 a locked memory does not fade with time', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('locked and unused for 60 days, it still ranks at its own strength', async () => {
    s = await rawStore([
      storedMemory('ENG-EVAL-LOCKED', say('alpha'), { strength: 0.7, lastUsedDaysAgo: 60, commitment: 'locked' }),
      storedMemory('ENG-EVAL-UNLOCKED', say('bravo'), { strength: 0.7, lastUsedDaysAgo: 60, commitment: 'decided' }),
      storedMemory('ENG-EVAL-FRESH', say('charlie'), { strength: 0.65, lastUsedDaysAgo: 0, commitment: 'decided' }),
    ])
    expect((await s.plur.getById('ENG-EVAL-LOCKED'))?.commitment, 'precondition: the memory is stored as locked')
      .toBe('locked')

    const r = await s.plur.inject(TASK, { budget: 4000 })
    expect(given(r), 'precondition: all three equally relevant memories are given')
      .toEqual(expect.arrayContaining(['ENG-EVAL-LOCKED', 'ENG-EVAL-UNLOCKED', 'ENG-EVAL-FRESH']))
    // Each memory must be in the text at a real position: -1 means missing, never "first" (fourth audit A4-03).
    for (const [id, word] of [['ENG-EVAL-LOCKED', 'alpha'], ['ENG-EVAL-UNLOCKED', 'bravo'], ['ENG-EVAL-FRESH', 'charlie']]) {
      expect(positionInText(r, id), `precondition: ${id} is in the text the agent receives`).toBeGreaterThanOrEqual(0)
      expect(deliversText(r, say(word)), `${id} is not given whole: its statement is missing from the text`).toBe(true)
    }
    const fresh = positionInText(r, 'ENG-EVAL-FRESH')
    expect(positionInText(r, 'ENG-EVAL-UNLOCKED'), 'precondition: the unlocked twin, unused for 60 days, has faded behind a fresh 0.65')
      .toBeGreaterThan(fresh)
    expect(positionInText(r, 'ENG-EVAL-LOCKED'),
      'the locked memory faded: after 60 days unused it ranks behind a fresh memory weaker than its own 0.7')
      .toBeLessThan(fresh)
  })
})
