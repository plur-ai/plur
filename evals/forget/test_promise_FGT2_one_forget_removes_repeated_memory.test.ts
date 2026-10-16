// FGT-2: One explicit forget removes a memory even if it was saved several times.
//
// "Explicit forget" is the forget a user makes: the CLI (`plur forget`) and the
// MCP tool (plur_forget) both call forget with force. That is what is driven here.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

const SAID = 'The staging cluster is rebuilt every Sunday night'

describe('FGT-2 one explicit forget removes a memory saved several times', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('saved three times, forgotten once', async () => {
    s = await tempStore({ embedder: 'off' })
    const a = await s.plur.learn(SAID, { scope: 'global' })
    const b = await s.plur.learn(SAID, { scope: 'global' })
    const c = await s.plur.learn(SAID, { scope: 'global' })
    expect([b.id, c.id], 'precondition: the repeats landed on one memory').toEqual([a.id, a.id])
    const before = await s.plur.getById(a.id)
    expect(before?.write_count, `precondition: the memory records it was saved 3 times; it says ${before?.write_count}`).toBe(3)

    const foundBefore = (await s.plur.recall('staging cluster rebuilt Sunday', { limit: 10 })).map(e => e.id)
    expect(foundBefore, 'precondition: search finds the memory before the forget').toContain(a.id)
    const injectedBefore = await s.plur.inject('rebuild the staging cluster')
    expect(injectedBefore.injected_ids, 'precondition: the agent is given the memory before the forget').toContain(a.id)

    await s.plur.forget(a.id, 'eval: no longer true', { force: true })

    const after = await s.plur.getById(a.id)
    expect(after?.status, `expected the memory to be gone after one forget; its status is ${after?.status}`).toBe('retired')
    const found = (await s.plur.recall('staging cluster rebuilt Sunday', { limit: 10 })).map(e => e.id)
    expect(found, `search still returns the memory after one forget: ${JSON.stringify(found)}`).not.toContain(a.id)
    const injected = await s.plur.inject('rebuild the staging cluster')
    expect(injected.injected_ids, 'the agent is still given the memory after one forget').not.toContain(a.id)
  })
})
