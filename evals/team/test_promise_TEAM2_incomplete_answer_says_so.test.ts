// TEAM-2: An answer never claims to be complete when the team server was not reached, and says what happened.
//
// For each search (keyword, hybrid, hybrid inject) the answer's
// `results_complete` must be false, and its `remote` report must name the
// server and what happened (`timeout` when it never answered, `unreachable`
// when nothing listens). The control: when the server answers, the same
// search says it is complete and the server was `ok`, so "false" is not just
// a constant.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTeamStub, startTeamStub, teamStore, withRemoteRecall, TEAM_SCOPE, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'

const PROJECT = 'project:acme/payments' // org `acme`: the team store is dialed for it
const FACT = 'refunds are issued to the original card within five days'
const QUERY = 'refunds original card days'

type Answer = { results_complete?: boolean; remote?: { state: string; hosts: Array<{ host: string; state: string }> } }

async function threeSearches(s: TeamStore): Promise<Array<[string, Answer]>> {
  return withRemoteRecall(async () => [
    ['keyword search', await s.plur.recallWithMeta(QUERY, { scope: PROJECT, remote_timeout_ms: 500 })],
    ['hybrid search', await s.plur.recallHybridWithMeta(QUERY, { scope: PROJECT, remote_timeout_ms: 500 })],
    ['hybrid inject', await s.plur.injectHybrid(QUERY, { scope: PROJECT, budget: 2000, remote_timeout_ms: 500 })],
  ])
}

describe('TEAM-2 an answer never claims to be complete when the team server was not reached', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop() })
  beforeEach(() => resetTeamStub(t))
  afterEach(() => { s?.cleanup(); s = undefined })

  it('control: the server answers, so the answer is complete', async () => {
    t.stub.recallRows = [{ id: 'ENG-SRV-900', scope: TEAM_SCOPE, status: 'active', statement: 'team: refunds over the limit need approval', score: 1 }]
    s = await teamStore(t.url)
    await s.plur.learn(FACT, { scope: PROJECT })
    for (const [name, a] of await threeSearches(s)) {
      expect(a.remote?.state, `${name}: with the server answering, expected the server report to say ok`).toBe('ok')
      expect(a.results_complete, `${name}: with the server answering, expected the answer to say it is complete`).toBe(true)
    }
  })

  it('the server never answers: not complete, and the report says timeout', async () => {
    t.stub.recallDelayMs = 120_000
    s = await teamStore(t.url)
    await s.plur.learn(FACT, { scope: PROJECT })
    for (const [name, a] of await threeSearches(s)) {
      expect(a.results_complete, `${name}: the server never answered, yet the answer claimed to be complete`).toBe(false)
      expect(a.remote?.state, `${name}: expected the report to say the server timed out; got ${JSON.stringify(a.remote)}`).toBe('timeout')
      expect(a.remote?.hosts.map(h => h.host).join(' '), `${name}: expected the report to name the server`).toContain('127.0.0.1')
    }
    expect(t.stub.recallCalls, 'precondition: the server was really asked').toBeGreaterThan(0)
  }, 30_000)

  it('nothing listens at the server address: not complete, and the report says unreachable', async () => {
    s = await teamStore('http://127.0.0.1:1')
    await s.plur.learn(FACT, { scope: PROJECT })
    for (const [name, a] of await threeSearches(s)) {
      expect(a.results_complete, `${name}: the server was unreachable, yet the answer claimed to be complete`).toBe(false)
      expect(a.remote?.state, `${name}: expected the report to say the server was unreachable; got ${JSON.stringify(a.remote)}`).toBe('unreachable')
      expect(a.remote?.hosts.map(h => h.host).join(' '), `${name}: expected the report to name the server`).toContain('127.0.0.1:1')
    }
  }, 30_000)
})
