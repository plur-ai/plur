// TEAM-3: A team memory saved while the server is down is delivered later, exactly once.
//
// Two ways a server can be "down" for a save:
//  1. it refuses every write (503) — the save is kept locally and queued;
//  2. it stores the write but its answer never reaches PLUR in time — PLUR
//     cannot tell the write landed, so it queues it, and the later retry must
//     not create a second copy on the server.
// In both, once the server is back, flushing the queue (twice, as a session
// start and a sync would) leaves exactly one copy on the server.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTeamStub, startTeamStub, teamStore, waitFor, TEAM_SCOPE, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'

const FACT = 'the release train leaves every Tuesday at noon'

describe('TEAM-3 a team memory saved while the server is down is delivered later, exactly once', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop() })
  beforeEach(() => resetTeamStub(t))
  afterEach(() => { s?.cleanup(); s = undefined })

  const onServer = () => {
    let n = 0
    for (let i = 1; i <= 50; i++) {
      const e = t.stub.getEngram(`ENG-SRV-${String(i).padStart(3, '0')}`)
      if (e && e.data.statement === FACT) n++
    }
    return n
  }

  for (const method of ['learnRouted', 'learn'] as const) {
    it(`${method}(): the server refuses writes, then comes back`, async () => {
      t.stub.appendErrorResponse = { status: 503, body: 'down for maintenance' }
      s = await teamStore(t.url)
      await s.plur[method](FACT, { scope: TEAM_SCOPE })
      // learn() tries the server in the background: wait until that attempt
      // has been refused and recorded on the queued memory.
      await waitFor(() => t.stub.appendCalls >= 1)
      const end = Date.now() + 3000
      while (Date.now() < end && !(await s.plur.listOutbox()).some(o => (o.attempt_count ?? 0) >= 1 && !(o as { leased_until?: string }).leased_until)) {
        await new Promise(r => setTimeout(r, 20))
      }
      expect(onServer(), 'precondition: while the server is down nothing is stored on it').toBe(0)
      expect((await s.plur.list()).some(e => e.statement === FACT), 'precondition: the memory is kept on this machine meanwhile').toBe(true)

      t.stub.appendErrorResponse = null
      await s.plur.flushOutbox({ force: true })
      await s.plur.flushOutbox({ force: true })
      expect(onServer(), `expected the memory on the team server exactly once after the server came back; found ${onServer()}`).toBe(1)
      expect(t.stub.appendCountFor(FACT), `expected one delivery once the server was back; it was sent ${t.stub.appendCountFor(FACT)} times`).toBe(1)
      expect(await s.plur.outboxCount(), 'expected nothing left waiting for delivery').toBe(0)
    })
  }

  it('learnRouted(): the server stores the write but its answer comes too late', async () => {
    t.stub.honourIdempotency = true // a server following the documented contract
    t.stub.appendDelayMs = 1500
    s = await teamStore(t.url)
    await s.plur.learnRouted(FACT, { scope: TEAM_SCOPE }, { remoteTimeoutMs: 200 })
    expect(onServer(), 'precondition: the server did store the first attempt').toBe(1)
    expect(await s.plur.outboxCount(), 'precondition: PLUR could not tell, so it queued the memory for delivery').toBe(1)

    t.stub.appendDelayMs = 0
    await s.plur.flushOutbox({ force: true })
    await s.plur.flushOutbox({ force: true })
    expect(onServer(), `expected exactly one copy on the team server after the retry; found ${onServer()}`).toBe(1)
    expect(await s.plur.outboxCount(), 'expected nothing left waiting for delivery').toBe(0)
  })
})
