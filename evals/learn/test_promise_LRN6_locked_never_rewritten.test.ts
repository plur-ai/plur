// LRN-6: A memory I locked is never rewritten by an automatic merge or update.
import { afterEach, describe, expect, it } from 'vitest'
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
      expect(result.engram.id, `the new statement should be saved as its own memory, not folded into the locked one`).not.toBe(locked.id)
      const saved = await s.plur.getById(result.engram.id)
      expect(saved?.statement, 'the new statement should still be saved as said').toBe(said)
    })
  }
})
