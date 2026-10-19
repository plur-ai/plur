// COR-5: When I resolve a contradiction, the memory I picked stays and the
// other is retired, even if two people resolve it at the same time.
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

async function setup(s: TempStore) {
  const a = await s.plur.learn('Deploys happen on Fridays after lunch', { scope: 'global' })
  const b = await s.plur.learn('Deploys never happen on Fridays', { scope: 'global' })
  const { records } = await s.plur.recordTensions([{
    id_a: a.id, id_b: b.id, statement_a: a.statement, statement_b: b.statement,
    confidence: 0.9, reason: 'eval: the two disagree about Friday deploys',
  }])
  expect(records, 'precondition: the contradiction was recorded').toHaveLength(1)
  return { a, b, tensionId: records[0].id }
}

async function statusOf(p: Plur, id: string): Promise<string | undefined> {
  return (await p.getById(id))?.status
}

describe('COR-5 resolving a contradiction keeps the chosen memory and retires the other', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('one person resolves it: the pick stays, the other is retired', async () => {
    s = await tempStore({ embedder: 'off' })
    const { a, b, tensionId } = await setup(s)
    await s.plur.resolveTension(tensionId, b.id)

    expect(await statusOf(s.plur, b.id), 'the memory I picked is no longer active').toBe('active')
    expect(await statusOf(s.plur, a.id), 'the memory I did not pick was not retired').toBe('retired')
    const active = (await s.plur.list()).map(e => e.id)
    expect(active, 'the memory I picked is missing from my list').toContain(b.id)
    expect(active, 'the retired memory still shows in my list').not.toContain(a.id)
  })

  // Two people at once: the same store opened twice (two processes would each
  // have their own Plur), each picking a DIFFERENT winner at the same moment.
  for (const how of ['one Plur instance', 'two Plur instances on the same store'] as const) {
    it(`two people pick opposite winners at the same time (${how})`, async () => {
      s = await tempStore({ embedder: 'off' })
      const { a, b, tensionId } = await setup(s)
      let second = s.plur
      if (how !== 'one Plur instance') {
        second = new Plur({ path: s.dir, autoDiscover: false })
        await second.ready()
      }

      const results = await Promise.allSettled([
        s.plur.resolveTension(tensionId, a.id),
        second.resolveTension(tensionId, b.id),
      ])
      const won = results.flatMap((r, i) => r.status === 'fulfilled' ? [i === 0 ? a.id : b.id] : [])
      expect(won.length, `exactly one resolution should take effect; ${won.length} reported success`).toBe(1)
      const winner = won[0]
      const loser = winner === a.id ? b.id : a.id

      const fresh = new Plur({ path: s.dir, autoDiscover: false })
      await fresh.ready()
      expect(await statusOf(fresh, winner), `the memory picked by the resolution that succeeded (${winner}) is not active`)
        .toBe('active')
      expect(await statusOf(fresh, loser), `the other memory (${loser}) was not retired`).toBe('retired')

      const record = fresh.listTensions({ status: ['resolved'] }).find(t => t.id === tensionId)
      expect(record?.resolved_by, 'the contradiction is not recorded as resolved in favour of the memory that stayed')
        .toBe(winner)
    })
  }
})
