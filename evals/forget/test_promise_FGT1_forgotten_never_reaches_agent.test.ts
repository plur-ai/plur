// FGT-1: A memory I forget no longer reaches my agent, in search or at session start.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

const KEEP = 'Review the payroll export with finance before sending it'
const GONE = 'Send the payroll export to the accountant by email'
const TASK = 'prepare and send the payroll export'

describe('FGT-1 a forgotten memory reaches my agent neither in search nor at session start', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`search and injection (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      const keep = await s.plur.learn(KEEP, { scope: 'global' })
      const gone = await s.plur.learn(GONE, { scope: 'global' })

      const before = await s.plur.inject(TASK)
      expect(before.injected_ids, `precondition: both memories reach the agent before the forget; injected ${JSON.stringify(before.injected_ids)}`)
        .toEqual(expect.arrayContaining([keep.id, gone.id]))

      // The forget a user makes (CLI and MCP both pass force).
      await s.plur.forget(gone.id, 'eval: no longer true', { force: true })

      const searches = {
        'keyword search': (await s.plur.recall(TASK, { limit: 10 })).map(e => e.id),
        'hybrid search': (await s.plur.recallHybrid(TASK, { limit: 10 })).map(e => e.id),
      }
      const injects = {
        'session-start injection': await s.plur.inject(TASK),
        'hybrid injection': await s.plur.injectHybrid(TASK),
      }
      for (const [name, ids] of Object.entries(searches)) {
        expect(ids, `${name} should still find the memory I kept`).toContain(keep.id)
        expect(ids, `${name} returned the forgotten memory ${gone.id}`).not.toContain(gone.id)
      }
      for (const [name, r] of Object.entries(injects)) {
        expect(r.injected_ids, `${name} should still give the agent the memory I kept`).toContain(keep.id)
        expect(r.injected_ids, `${name} gave the agent the forgotten memory ${gone.id}`).not.toContain(gone.id)
        const text = `${r.directives}\n${r.constraints}\n${r.consider}`
        expect(text, `${name} text still contains the forgotten statement`).not.toContain(GONE)
      }
    })
  }
})
