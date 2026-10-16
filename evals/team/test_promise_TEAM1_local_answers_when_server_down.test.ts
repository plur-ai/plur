// TEAM-1: If the team server is down or slow, I still get my local answers within a bounded time.
//
// The bound, as a literal: 12 seconds per search. That is PLUR's documented
// 10 s recall deadline plus 2 s of slack for a busy test machine. Each search
// is raced against a 12 s timer, so a hang fails the eval at 12 s instead of
// holding the run.
//
// Three servers: one that accepts the request and never answers (slow), one
// where nothing listens (down), and the slow one again with the user's remote
// budget raised to 60 s (a user who told PLUR to be patient with a slow
// server must still get an answer within the bound).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTeamStub, startTeamStub, teamStore, withRemoteRecall, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'

const BOUND_MS = 12_000
const PROJECT = 'project:acme/payments' // org `acme`: the team store is dialed for it
const FACT = 'payments retries use exponential backoff capped at five attempts'
const QUERY = 'payments retries backoff attempts'

/** Run `p`, or fail once BOUND_MS has passed. */
async function withinBound<T>(what: string, p: Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${BOUND_MS / 1000} s with the team server down or slow`)), BOUND_MS)
  })
  try {
    const value = await Promise.race([p, late])
    return { value, ms: Date.now() - t0 }
  } finally { clearTimeout(timer) }
}

describe('TEAM-1 local answers arrive within a bounded time when the team server is down or slow', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  const prevBudget = process.env.PLUR_REMOTE_RECALL_TIMEOUT_MS
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop() })
  beforeEach(() => resetTeamStub(t))
  afterEach(() => {
    s?.cleanup(); s = undefined
    if (prevBudget === undefined) delete process.env.PLUR_REMOTE_RECALL_TIMEOUT_MS
    else process.env.PLUR_REMOTE_RECALL_TIMEOUT_MS = prevBudget
  })

  async function searchAll(store: TeamStore): Promise<void> {
    await withRemoteRecall(async () => {
      const [keyword, hybrid, injected] = await Promise.all([
        withinBound('keyword search', store.plur.recallWithMeta(QUERY, { scope: PROJECT })),
        withinBound('hybrid search', store.plur.recallHybridWithMeta(QUERY, { scope: PROJECT })),
        withinBound('hybrid inject', store.plur.injectHybrid(QUERY, { scope: PROJECT, budget: 2000 })),
      ])
      expect(keyword.value.engrams.map(e => e.statement), 'keyword search should still return my local memory').toContain(FACT)
      expect(hybrid.value.engrams.map(e => e.statement), 'hybrid search should still return my local memory').toContain(FACT)
      expect(injected.value.count, 'hybrid inject should still give my local memory to the agent').toBeGreaterThan(0)
    })
  }

  it('the server accepts the request and never answers', async () => {
    t.stub.recallDelayMs = 120_000
    s = await teamStore(t.url)
    await s.plur.learn(FACT, { scope: PROJECT })
    await searchAll(s)
    expect(t.stub.recallCalls, 'precondition: the team server was really asked (it is in the search)').toBeGreaterThan(0)
  }, 30_000)

  it('nothing listens at the server address', async () => {
    s = await teamStore('http://127.0.0.1:1')
    await s.plur.learn(FACT, { scope: PROJECT })
    await searchAll(s)
  }, 30_000)

  it('the server never answers and my remote budget is raised to 60 s', async () => {
    process.env.PLUR_REMOTE_RECALL_TIMEOUT_MS = '60000'
    t.stub.recallDelayMs = 120_000
    s = await teamStore(t.url)
    await s.plur.learn(FACT, { scope: PROJECT })
    await searchAll(s)
    expect(t.stub.recallCalls, 'precondition: the team server was really asked (it is in the search)').toBeGreaterThan(0)
  }, 30_000)
})
