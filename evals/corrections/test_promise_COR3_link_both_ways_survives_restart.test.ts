// COR-3: A correction and the memory it replaces are linked both ways, and the
// link survives a restart.
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'
import { given } from '../helpers/corrections-inject-feedback-util.js'

describe('COR-3 the correction link is two-way and survives a restart', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('both edges are on disk, and a fresh process still treats the old memory as replaced', async () => {
    s = await tempStore({ embedder: 'off' })
    const old = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
    // An unrelated memory written between the two, so the edge is not simply
    // "the previous engram".
    await s.plur.learn('Rotate the on-call pager every Monday morning', { scope: 'global' })
    const fix = await s.plur.learn('Deploy the billing service with canary rollouts, not blue-green',
      { scope: 'global', supersedes: [old.id] })

    // A restart: a brand-new Plur over the same directory, nothing in memory.
    const restarted = new Plur({ path: s.dir, autoDiscover: false })
    await restarted.ready()

    const oldAfter = await restarted.getById(old.id)
    const fixAfter = await restarted.getById(fix.id)
    expect(oldAfter, 'precondition: the old memory is still stored after the restart').not.toBeNull()
    expect(fixAfter, 'precondition: the correction is still stored after the restart').not.toBeNull()

    expect(fixAfter!.relations?.supersedes ?? [],
      `after a restart the correction no longer says which memory it replaces (expected ${old.id})`)
      .toEqual([old.id])
    expect(oldAfter!.relations?.superseded_by ?? [],
      `after a restart the old memory no longer says it was replaced (expected ${fix.id})`)
      .toEqual([fix.id])

    // The link still does its job in the restarted process.
    const ids = given(await restarted.inject('deploy the billing service rollout', { budget: 4000 }))
    expect(ids, 'after a restart the agent is not given the correction').toContain(fix.id)
    expect(ids, 'after a restart the agent is given the replaced memory again').not.toContain(old.id)
  })
})
