// PRV-3: My agent is never given a memory from a scope it is not allowed to see.
//
// Four memories on the same topic sit in four scopes. The agent is allowed to
// see two of them (the allow-list `scopes`). Injection, keyword or hybrid, must
// give it only memories from those two scopes.
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

const ALLOWED = ['project:billing', 'global']

describe('PRV-3 an agent is never given a memory from a scope it may not see', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`inject and hybrid inject with an allow-list (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      const project = await s.plur.learn('Invoices are rounded half-up to two decimals before tax', { scope: 'project:billing' })
      const global = await s.plur.learn('Invoices always state the currency next to every amount', { scope: 'global' })
      const otherUser = await s.plur.learn('Invoices for my side gig go out on the first of the month', { scope: 'user:someone-else' })
      const team = await s.plur.learn('Invoices above the limit need a second approver from finance', { scope: 'group:acme/finance' })
      const forbidden = [otherUser.id, team.id]

      const task = 'how are invoices rounded, approved and sent'
      const open = (await s.plur.inject(task, { budget: 4000 })).injected_ids
      expect(open, 'precondition: without an allow-list, injection does pick the memories from the other scopes').toEqual(
        expect.arrayContaining(forbidden))

      for (const [name, run] of [
        ['inject', () => s.plur.inject(task, { budget: 4000, scopes: ALLOWED })],
        ['hybrid inject', () => s.plur.injectHybrid(task, { budget: 4000, scopes: ALLOWED })],
      ] as const) {
        const ids = (await run()).injected_ids
        expect(ids.length, `${name}: expected the allowed memories to be injected, got none`).toBeGreaterThan(0)
        expect(ids, `${name}: expected the allowed memories to be injected; got ${JSON.stringify(ids)}`).toEqual(
          expect.arrayContaining([project.id, global.id]))
        expect(ids, `${name}: gave the agent a memory from user:someone-else, which is not on its allow-list`).not.toContain(otherUser.id)
        expect(ids, `${name}: gave the agent a memory from group:acme/finance, which is not on its allow-list`).not.toContain(team.id)
      }
    })
  }
})
