// LRN-8: When the duplicate check says a new statement updates an existing
// memory, the new statement is saved as its own memory that supersedes the old
// one: the old text is kept unchanged and marked superseded, and it is no longer
// given to the agent. Through a single save and through a batch save.
//
// Owner decision 2026-10-18: a changed value is "a separate memory that
// supersedes the previous one" (and never an overwrite). LRN-7 measures the same
// rule against a real checker over labelled pairs; this eval pins the mechanism
// with a scripted checker, so it needs no model and runs on every gate.
//
// The checker is forced to answer UPDATE with the existing memory as target, the
// verdict a checker gives for a changed value. What is graded is what a fresh
// instance reads back from disk (helpers/dedup-outcome.ts, classification proven
// in helpers/dedup-outcome.unit.test.ts):
//  * the old memory's text is unchanged;
//  * the new statement is stored as said and is live;
//  * new.relations.supersedes holds the old id and old.relations.superseded_by
//    holds the new id (the link inject.ts honours, COR-1);
//  * the old memory is therefore no longer live.
// Then injection for the subject is checked: the new statement is given, the
// old one is not.
//
// Pairs are from the public dev set (evals/gold/dedup-v2), label `supersede`.
// A control pair labelled `distinct` with an ADD verdict must stay two live
// memories with no link: supersede must not leak onto a different subject.
import { describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { judgeDedupOutcome, type SavePath } from '../helpers/dedup-outcome.js'
import { dedupPairs, type DedupPair } from '../helpers/quality.js'
import { tempStore } from '../helpers/store.js'
import { given } from '../helpers/corrections-inject-feedback-util.js'

const pairs = dedupPairs('dev')
const byId = (id: string): DedupPair => {
  const p = pairs.find(x => x.id === id)
  if (!p) throw new Error(`precondition: dev pair ${id} not found`)
  return p
}
const SUPERSEDE = ['P002', 'P006', 'P042'].map(byId)
const CONTROL = byId('P040')

const target = (prompt: string) => /\[(ENG-[^\]]+)\]/.exec(prompt)?.[1] ?? 'none'
const says = (decision: string) => async (prompt: string) =>
  `DECISION: ${decision}\nTARGET: ${decision === 'ADD' ? 'none' : target(prompt)}\nREASON: scripted`

describe('LRN-8 a changed value is saved as its own memory that supersedes the old one', () => {
  it('precondition: the chosen pairs carry the labels this eval assumes', () => {
    expect(SUPERSEDE.map(p => p.label)).toEqual(['supersede', 'supersede', 'supersede'])
    expect(CONTROL.label).toBe('distinct')
  })

  for (const path of ['single', 'batch'] as SavePath[]) {
    for (const p of SUPERSEDE) {
      it(`${path} save, checker says UPDATE (${p.id}): new memory supersedes, old text kept`, async () => {
        const j = await judgeDedupOutcome(p, says('UPDATE'), 'bag-of-words', path)
        expect(j.asked, `precondition: the checker was shown the pair (${j.detail})`).toBeGreaterThan(0)
        expect(j.outcome, `${path} save of a changed value (${p.id}) did not leave a superseding memory: ${j.detail}`).toBe('superseded')
      })
    }

    it(`${path} save, checker says ADD on a different subject (${CONTROL.id}): two live memories, no link`, async () => {
      const j = await judgeDedupOutcome(CONTROL, says('ADD'), 'bag-of-words', path)
      expect(j.outcome, `${path} save of a different subject (${CONTROL.id}): ${j.detail}`).toBe('kept-separate')
    })
  }

  it('after a single save says UPDATE, injection gives the new statement and not the old one', async () => {
    const p = SUPERSEDE[0]
    const s = await tempStore({ embedder: 'bag-of-words' })
    try {
      const old = await s.plur.learn(p.existing, { scope: 'global' })
      await s.plur.learnAsync(p.incoming, { scope: 'global', llm: says('UPDATE') })
      const fresh = new Plur({ path: s.dir, autoDiscover: false })
      await fresh.ready()
      const stored = await fresh.list()
      const neu = stored.find(e => e.id !== old.id && e.statement === p.incoming)
      expect(neu, `the new statement was not stored as its own memory (stored: ${stored.map(e => e.id).join(', ')})`).toBeTruthy()
      const ids = given(await fresh.inject('write review summaries for Dovren Toolworks', { budget: 4000 }))
      expect(ids, 'precondition: injection for the subject gave the new memory').toContain(neu!.id)
      expect(ids, 'the superseded memory is still given to the agent').not.toContain(old.id)
    } finally {
      s.cleanup()
    }
  })
})
