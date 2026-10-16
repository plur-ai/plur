// TEAM-4: A search limited to my personal scopes never sends my question to a team server.
//
// A team server is mounted and live recall is on. First, a search in my
// project (org `acme`, the team's org) does ask the team server: the
// precondition that the server is in play. Then the same question, limited to
// personal scopes (an allow-list of `global` and `user:me`, or the scope
// `global` alone), must send zero requests of any kind to the team server, and
// still find my memory.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTeamStub, startTeamStub, teamStore, withRemoteRecall, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'

const PROJECT = 'project:acme/payments'
const PERSONAL = ['global', 'user:me']
const FACT = 'my standing preference: card numbers are always masked in logs'
const QUERY = 'card numbers masked logs'

describe('TEAM-4 a search limited to personal scopes never reaches a team server', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop() })
  beforeEach(() => resetTeamStub(t))
  afterEach(() => { s?.cleanup(); s = undefined })

  it('keyword search, hybrid search and hybrid inject', async () => {
    s = await teamStore(t.url)
    await s.plur.learn(FACT, { scope: 'global' })
    const plur = s.plur
    await withRemoteRecall(async () => {
      await plur.recallWithMeta(QUERY, { scope: PROJECT })
      expect(t.stub.recallCalls, 'precondition: a search in my project does ask the team server').toBeGreaterThan(0)

      t.hits.length = 0
      const runs: Array<[string, () => Promise<string[]>]> = [
        ['keyword search, personal allow-list', async () => (await plur.recallWithMeta(QUERY, { scope: PROJECT, scopes: PERSONAL })).engrams.map(e => e.statement)],
        ['hybrid search, personal allow-list', async () => (await plur.recallHybridWithMeta(QUERY, { scope: PROJECT, scopes: PERSONAL })).engrams.map(e => e.statement)],
        ['hybrid inject, personal allow-list', async () => {
          const r = await plur.injectHybrid(QUERY, { scope: PROJECT, scopes: PERSONAL, budget: 2000 })
          return [r.directives, r.constraints, r.consider].join('\n').includes(FACT) ? [FACT] : []
        }],
        ['keyword search, scope global', async () => (await plur.recallWithMeta(QUERY, { scope: 'global' })).engrams.map(e => e.statement)],
        ['hybrid search, scope global', async () => (await plur.recallHybridWithMeta(QUERY, { scope: 'global' })).engrams.map(e => e.statement)],
      ]
      for (const [name, run] of runs) {
        const found = await run()
        expect(found, `${name}: expected my personal memory to be found`).toContain(FACT)
        expect(t.hits, `${name}: expected no request to the team server; it received ${JSON.stringify(t.hits)}`).toEqual([])
      }
    })
  })
})
