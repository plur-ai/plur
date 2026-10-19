// LRN-6: A memory I locked is never rewritten by an automatic merge or update.
// Rewritten includes retired or marked superseded: the text, the version, the
// status and the superseded_by link of the locked memory all stay as they were.
//
// Two orders, for UPDATE and MERGE each (the LLM fixture forces the verdict so
// the real persistence guards run):
//  1. locked before the save starts;
//  2. locked IN BETWEEN: the dedup path reads the memory while it is still
//     unlocked, another writer (a second Plur on the same store) locks it, and
//     only then does the dedup write happen. The early check saw "unlocked", so
//     only the check made at write time can protect it (audit C-01; the same
//     interleaving as packages/core/test/formal-persistence-learn-async.test.ts,
//     here through the public Plur surface).
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

const LOCKED = 'Never deploy the ledger service on a Friday'

describe('LRN-6 a locked memory is never rewritten automatically', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const verdict of ['UPDATE', 'MERGE'] as const) {
    it(`the AI dedup check says ${verdict} onto the locked memory`, async () => {
      s = await tempStore({ embedder: 'bag-of-words' })
      const locked = await s.plur.learn(LOCKED, { scope: 'global', commitment: 'locked', locked_reason: 'eval: owner rule' })
      const before = await s.plur.getById(locked.id)
      expect(before?.commitment, 'precondition: the memory is locked').toBe('locked')

      let asked = 0
      const llm = async (prompt: string): Promise<string> => {
        if (prompt.includes(locked.id)) asked++
        return `DECISION: ${verdict}\nTARGET: ${locked.id}\nREASON: eval wants to rewrite it`
      }
      const said = 'Never deploy the ledger service on a Friday or a Saturday'
      const result = await s.plur.learnAsync(said, { scope: 'global', llm })

      expect(asked, 'precondition: the automatic check saw the locked memory as a candidate').toBeGreaterThan(0)
      const after = await s.plur.getById(locked.id)
      expect(after?.statement, `the locked memory was rewritten by an automatic ${verdict}: now ${JSON.stringify(after?.statement)}`)
        .toBe(LOCKED)
      expect(after?.engram_version ?? 1, `the locked memory's version moved (${before?.engram_version ?? 1} -> ${after?.engram_version})`)
        .toBe(before?.engram_version ?? 1)
      // Nor retired or replaced by the automatic check: a locked memory goes to review
      // (LRN-9), it is never marked superseded on its own (round-9 planted-bug refresh).
      expect(after?.status, 'the locked memory was retired by an automatic check').toBe('active')
      expect((after as any)?.relations?.superseded_by ?? [], 'the locked memory was marked superseded by an automatic check').toEqual([])
      expect(result.engram.id, `the new statement should be saved as its own memory, not folded into the locked one`).not.toBe(locked.id)
      const saved = await s.plur.getById(result.engram.id)
      expect(saved?.statement, 'the new statement should still be saved as said').toBe(said)
    })
  }

  for (const verdict of ['UPDATE', 'MERGE'] as const) {
    it(`another writer locks the memory after the dedup check read it, before the ${verdict} write`, async () => {
      s = await tempStore({ embedder: 'bag-of-words' })
      const UNLOCKED = 'Never deploy the billing service on a Friday'
      const target = await s.plur.learn(UNLOCKED, { scope: 'global' })
      const start = await s.plur.getById(target.id)
      expect(start?.commitment, 'precondition: the memory starts unlocked').not.toBe('locked')

      // The second writer: its own Plur instance over the same store folder.
      const other = new Plur({ path: s.dir, autoDiscover: false })
      await other.ready()

      let decided = false
      let asked = 0
      const llm = async (prompt: string): Promise<string> => {
        if (prompt.includes(target.id)) asked++
        decided = true
        return `DECISION: ${verdict}\nTARGET: ${target.id}\nREASON: eval wants to rewrite it`
      }

      // Order the two writers: the first read of the target after the verdict
      // returns the unlocked row, and the other writer locks it before the
      // dedup path goes on to its write.
      let snapshotCommitment: string | undefined = 'not read'
      let lockedInBetween = false
      const realGetById = s.plur.getById.bind(s.plur)
      ;(s.plur as unknown as { getById: typeof realGetById }).getById = async (id: string) => {
        const row = await realGetById(id)
        if (decided && id === target.id && !lockedInBetween) {
          snapshotCommitment = row?.commitment
          const current = await other.getById(target.id)
          lockedInBetween = await other.updateEngram({
            ...current!, commitment: 'locked', locked_at: new Date().toISOString(), locked_reason: 'eval: owner locked it meanwhile',
          } as typeof current & object)
        }
        return row
      }

      const said = 'Never deploy the billing service on a Friday or a Saturday'
      const result = await s.plur.learnAsync(said, { scope: 'global', llm })

      expect(asked, 'precondition: the automatic check saw the memory as a candidate').toBeGreaterThan(0)
      expect(lockedInBetween, 'precondition: the other writer locked the memory between the dedup read and the write').toBe(true)
      expect(snapshotCommitment, 'precondition: the dedup path read the memory while it was still unlocked').not.toBe('locked')

      const fresh = new Plur({ path: s.dir, autoDiscover: false })
      await fresh.ready()
      const after = await fresh.getById(target.id)
      expect(after?.commitment, 'precondition: the memory is locked on disk at the end').toBe('locked')
      expect(after?.statement,
        `a memory locked by another writer just before the write was rewritten by an automatic ${verdict}: now ${JSON.stringify(after?.statement)}`)
        .toBe(UNLOCKED)
      expect(after?.status, 'the memory locked in between was retired by the automatic check').toBe('active')
      expect((after as any)?.relations?.superseded_by ?? [], 'the memory locked in between was marked superseded by the automatic check').toEqual([])
      expect(result.engram.id, 'the new statement should be saved as its own memory, not folded into the locked one').not.toBe(target.id)
      const saved = await fresh.getById(result.engram.id)
      expect(saved?.statement, 'the new statement should still be saved as said').toBe(said)
    })
  }
})
