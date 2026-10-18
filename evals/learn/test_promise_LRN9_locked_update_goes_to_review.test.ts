// LRN-9: When the duplicate check says a new statement updates a memory I
// locked, the locked memory is not superseded on its own: it stays unchanged
// and is still given to my agent, the new statement is saved, and the pair goes
// to my review queue for me to decide. Through a single save and a batch save.
//
// Owner decision 2026-10-18: "there should be a review queue unless the user
// specifies differently". The review queue is the one PLUR already shows me for
// memories that disagree: the tension records (listTensions, plur_tensions),
// whose confirm / dismiss / resolve lifecycle is my decision (COR-5). A pair
// waiting for me is a record linking the two memories that is neither
// dismissed nor resolved.
//
// Not graded here, because the owner has not decided them (promises.yaml
// `decide:`): whether the new statement is given to the agent while the review
// waits, and the setting by which a user "specifies differently". LRN-6 already
// pins that the locked text is never rewritten.
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore } from '../helpers/store.js'
import { deliversText, given } from '../helpers/corrections-inject-feedback-util.js'

// One fixed subject, and one made up at run time so the fixture cannot be special-cased.
const unseen = `Kv${randomBytes(4).toString('hex')} Works`
const SUBJECTS = [
  { name: 'Dovren Toolworks', task: 'write review summaries for Dovren Toolworks' },
  { name: unseen, task: `write review summaries for ${unseen}` },
]

describe('LRN-9 an update onto a locked memory goes to my review queue', () => {
  for (const [path, { name, task }] of (['single', 'batch'] as const).flatMap(p => SUBJECTS.map(x => [p, x] as const))) {
    const LOCKED = `Review summaries for ${name} go to the plant manager every Monday`
    const SAID = `Review summaries for ${name} go to the plant manager every Thursday`
    it(`${path} save, checker says UPDATE onto the locked memory (${name === unseen ? 'unseen subject' : name})`, async () => {
      const s = await tempStore({ embedder: 'bag-of-words' })
      try {
        const locked = await s.plur.learn(LOCKED, { scope: 'global', commitment: 'locked', locked_reason: 'eval: owner rule' })
        let asked = 0
        const llm = async (prompt: string): Promise<string> => {
          if (prompt.includes(locked.id)) asked++
          return `DECISION: UPDATE\nTARGET: ${locked.id}\nREASON: scripted`
        }
        if (path === 'single') await s.plur.learnAsync(SAID, { scope: 'global', llm })
        else await s.plur.learnBatch([{ statement: SAID, context: { scope: 'global' } }], llm)
        expect(asked, 'precondition: the checker was shown the locked memory').toBeGreaterThan(0)

        // What a fresh instance reads back from disk.
        const fresh = new Plur({ path: s.dir, autoDiscover: false })
        await fresh.ready()
        const old = await fresh.getById(locked.id)
        expect(old?.statement, 'the locked memory was rewritten').toBe(LOCKED)
        expect(old?.status, 'the locked memory was retired').toBe('active')
        const supersededBy = (old as any)?.relations?.superseded_by ?? []
        expect(supersededBy, `the locked memory was superseded without my review (superseded_by ${JSON.stringify(supersededBy)})`).toEqual([])

        const neu = (await fresh.list()).find(e => e.id !== locked.id && e.statement === SAID)
        expect(neu, 'the new statement was not saved as its own memory').toBeTruthy()

        const waiting = fresh.listTensions().filter(t =>
          t.status !== 'dismissed' && t.status !== 'resolved' &&
          [t.engram_a, t.engram_b].includes(locked.id) && [t.engram_a, t.engram_b].includes(neu!.id))
        expect(waiting.length, `no review item links the locked memory ${locked.id} and the new statement ${neu!.id}; ` +
          `review queue: ${JSON.stringify(fresh.listTensions().map(t => [t.engram_a, t.engram_b, t.status]))}`).toBe(1)

        const r = await fresh.inject(task, { budget: 4000 })
        expect(given(r), 'the locked memory is no longer given to the agent while my review waits').toContain(locked.id)
        expect(deliversText(r, LOCKED), 'the locked memory is not given whole while my review waits (fourth audit A4-03)').toBe(true)
      } finally {
        s.cleanup()
      }
    })
  }
})
