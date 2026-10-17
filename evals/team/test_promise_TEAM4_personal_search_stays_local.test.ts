// TEAM-4: A search limited to my personal scopes (my user scope, and local
// project scopes not tied to a team store) never sends my question to a team
// server.
//
// A team server is mounted and live recall is on. First, a search in my
// project (org `acme`, the team's org) does ask the team server: the
// precondition that the server is in play. Then the same question, limited to
// personal scopes (an allow-list of `global` and `user:me`, or the scope
// `global` alone), must send zero requests of any kind to the team server, and
// still find my memory.
//
// Definition (2026-10-17): personal = my user scope (`user:me`), `global`, and
// a local project scope that no team store holds (`project:hobby`, no org). A
// project inside a team's org (`project:acme/x`) is not personal. The second
// test searches each personal scope on its own, with a positive control that a
// search in the team scope itself does reach the team server.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTeamStub, startTeamStub, teamStore, withRemoteRecall, TEAM_SCOPE, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'

const PROJECT = 'project:acme/payments'
const PERSONAL = ['global', 'user:me']
const FACT = 'my standing preference: card numbers are always masked in logs'
const QUERY = 'card numbers masked logs'
const USER_SCOPE = 'user:me'
const LOCAL_PROJECT = 'project:hobby'
const USER_FACT = 'my user-scope note: card numbers masked in logs at the hobby shop too'
const PROJECT_FACT = 'hobby project note: card numbers masked in logs of the hobby shop'

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

  it('my user scope and a local project scope, each on its own; the team scope does reach the server', async () => {
    s = await teamStore(t.url)
    await s.plur.learn(USER_FACT, { scope: USER_SCOPE })
    await s.plur.learn(PROJECT_FACT, { scope: LOCAL_PROJECT })
    const plur = s.plur
    await withRemoteRecall(async () => {
      t.hits.length = 0
      await plur.recallWithMeta(QUERY, { scope: TEAM_SCOPE })
      expect(t.stub.recallCalls, `precondition: a search in the team scope (${TEAM_SCOPE}) does ask the team server`).toBeGreaterThan(0)

      const cases: Array<[string, string, Record<string, unknown>]> = [
        ['my user scope', USER_FACT, { scope: USER_SCOPE }],
        ['a local project scope', PROJECT_FACT, { scope: LOCAL_PROJECT }],
        ['an allow-list of my user scope and a local project scope', USER_FACT, { scope: LOCAL_PROJECT, scopes: [USER_SCOPE, LOCAL_PROJECT] }],
      ]
      for (const [what, fact, opts] of cases) {
        const runs: Array<[string, () => Promise<string[]>]> = [
          ['keyword search', async () => (await plur.recallWithMeta(QUERY, opts as any)).engrams.map(e => e.statement)],
          ['hybrid search', async () => (await plur.recallHybridWithMeta(QUERY, opts as any)).engrams.map(e => e.statement)],
          ['hybrid inject', async () => {
            const r = await plur.injectHybrid(QUERY, { ...(opts as any), budget: 2000 })
            return [r.directives, r.constraints, r.consider].join('\n').includes(fact) ? [fact] : []
          }],
        ]
        for (const [name, run] of runs) {
          t.hits.length = 0
          const found = await run()
          expect(found, `${name} in ${what}: expected my memory there to be found`).toContain(fact)
          expect(t.hits, `${name} in ${what}: expected no request to the team server; it received ${JSON.stringify(t.hits)}`).toEqual([])
        }
      }
    })
  })
})
