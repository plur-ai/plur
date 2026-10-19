// COR-4: A correction and the memory it replaces are never reported to me as a
// contradiction.
//
// Drives the contradiction scan the way the plur_tensions tool does: the
// stored memories (plur.list) go to scanForTensions with a judge, and what it
// finds is recorded and listed. The judge is a stub that calls EVERY pair it is
// shown a contradiction, so the only thing that can keep the correction pair
// out of the report is PLUR itself deciding not to put it in front of a judge.
import { afterEach, describe, expect, it } from 'vitest'
import { scanForTensions } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

/** A judge that says "contradiction" to everything, in batch and single form. */
const alwaysContradiction = async (prompt: string): Promise<string> => {
  const n = Math.max(1, ...[...prompt.matchAll(/PAIR[_\s]*(\d+)/gi)].map(m => Number(m[1])))
  return Array.from({ length: n }, (_, i) =>
    `PAIR ${i + 1}: CONTRADICTS: yes | CONFIDENCE: 0.95 | REASON: eval stub says every pair conflicts`).join('\n')
}

const pairKey = (a: string, b: string) => [a, b].sort().join(' vs ')

describe('COR-4 a correction is never reported as contradicting what it replaces', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('the scan reports an unlinked conflicting pair but not the correction pair', async () => {
    s = await tempStore({ embedder: 'off' })
    const old = await s.plur.learn('Deploy the billing service with blue-green rollouts', { scope: 'global' })
    const fix = await s.plur.learn('Deploy the billing service with canary rollouts, never blue-green',
      { scope: 'global', supersedes: [old.id] })
    // Control: two memories that disagree and are NOT linked by a correction.
    const c1 = await s.plur.learn('The staging database runs on Postgres version fourteen', { scope: 'global' })
    const c2 = await s.plur.learn('The staging database runs on Postgres version sixteen', { scope: 'global' })

    const engrams = await s.plur.list()
    const result = await scanForTensions(engrams, alwaysContradiction)
    await s.plur.recordTensions(result.tensions)

    const reported = result.tensions.map(t => pairKey(t.id_a, t.id_b))
    const listed = s.plur.listTensions().map(t => pairKey(t.engram_a, t.engram_b))

    // Precondition: the scan does report contradictions — the unlinked pair.
    expect(reported, 'precondition: the scan reports the unlinked conflicting pair, so it is really judging')
      .toContain(pairKey(c1.id, c2.id))
    expect(listed, 'precondition: the unlinked pair is listed as a contradiction afterwards')
      .toContain(pairKey(c1.id, c2.id))

    expect(reported, `the scan reported the correction ${fix.id} as contradicting the memory it replaces ${old.id}`)
      .not.toContain(pairKey(old.id, fix.id))
    expect(listed, `the correction ${fix.id} and the memory it replaces ${old.id} are listed as a contradiction`)
      .not.toContain(pairKey(old.id, fix.id))
  })
})
