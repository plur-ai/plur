// FDB-1: Rating a memory helpful raises it by a fixed small step and rating it
// unhelpful lowers it by a larger one, never past the limits.
//
// The steps are written here as literals: helpful +0.05, unhelpful -0.10, and
// strength stays within [0, 1]. They are the values PLUR documents today; the
// owner may change them, but the eval must not read them from the code.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

const HELPFUL_STEP = 0.05
const UNHELPFUL_STEP = 0.10
const LOWEST = 0
const HIGHEST = 1

describe('FDB-1 helpful and unhelpful ratings move a memory by fixed steps, within the limits', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  const strength = async (id: string) => (await s.plur.getById(id))!.activation.retrieval_strength

  it('one helpful rating raises it by the small step; one unhelpful lowers it by the larger step', async () => {
    s = await tempStore({ embedder: 'off' })
    const m = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
    const start = await strength(m.id)
    expect(start, 'precondition: a new memory starts strictly inside the limits, with room both ways')
      .toBeGreaterThan(LOWEST + UNHELPFUL_STEP)
    expect(start).toBeLessThan(HIGHEST - HELPFUL_STEP)

    await s.plur.feedback(m.id, 'positive')
    const up = await strength(m.id)
    expect(up - start, `a helpful rating moved strength from ${start} to ${up}; expected +${HELPFUL_STEP}`)
      .toBeCloseTo(HELPFUL_STEP, 6)

    await s.plur.feedback(m.id, 'negative')
    const down = await strength(m.id)
    expect(up - down, `an unhelpful rating moved strength from ${up} to ${down}; expected -${UNHELPFUL_STEP}`)
      .toBeCloseTo(UNHELPFUL_STEP, 6)
  })

  it('a neutral rating does not move it', async () => {
    s = await tempStore({ embedder: 'off' })
    const m = await s.plur.learn('Rotate the on-call pager every Monday morning', { scope: 'global' })
    const start = await strength(m.id)
    await s.plur.feedback(m.id, 'neutral')
    expect(await strength(m.id), 'a neutral rating changed the strength').toBeCloseTo(start, 6)
  })

  it('many helpful ratings stop at the upper limit; many unhelpful stop at the lower limit', async () => {
    s = await tempStore({ embedder: 'off' })
    const good = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
    const bad = await s.plur.learn('Rotate the on-call pager every Monday morning', { scope: 'global' })

    const seenGood: number[] = []
    const seenBad: number[] = []
    for (let i = 0; i < 25; i++) {
      await s.plur.feedback(good.id, 'positive')
      seenGood.push(await strength(good.id))
      await s.plur.feedback(bad.id, 'negative')
      seenBad.push(await strength(bad.id))
    }
    expect(Math.max(...seenGood), `helpful ratings pushed strength above ${HIGHEST}: ${seenGood.join(', ')}`)
      .toBeLessThanOrEqual(HIGHEST)
    expect(seenGood.at(-1), 'after 25 helpful ratings the memory did not reach the upper limit').toBeCloseTo(HIGHEST, 6)
    expect(Math.min(...seenBad), `unhelpful ratings pushed strength below ${LOWEST}: ${seenBad.join(', ')}`)
      .toBeGreaterThanOrEqual(LOWEST)
    expect(seenBad.at(-1), 'after 25 unhelpful ratings the memory did not reach the lower limit').toBeCloseTo(LOWEST, 6)
  })
})
