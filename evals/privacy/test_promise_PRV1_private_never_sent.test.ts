// PRV-1: A memory I mark private is never sent to a team server, whichever way it is saved.
//
// A real in-process team server (stub) is mounted as the store for a team
// scope. Each save path is driven twice: once with a private memory and once
// with an ordinary team memory (the control). The control proves the path
// really does push to the server, and the private memory must never arrive,
// not on save and not on a later outbox flush.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTeamStub, startTeamStub, teamStore, waitFor, TEAM_SCOPE, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'

const PRIVATE = 'my private note: the staging password rotates on Mondays'
const CONTROL = 'team note: the staging cluster is rebuilt every Monday'

describe('PRV-1 a memory marked private is never sent to a team server', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop() })
  beforeEach(() => resetTeamStub(t))
  afterEach(() => { s?.cleanup(); s = undefined })

  const sentPrivate = () => t.stub.appendStatements.filter(x => x.includes('private note')).length

  it('learn(): saved with visibility private to a team scope', async () => {
    s = await teamStore(t.url)
    const saved = await s.plur.learn(PRIVATE, { scope: TEAM_SCOPE, visibility: 'private' })
    await s.plur.learn(CONTROL, { scope: TEAM_SCOPE })
    // learn() pushes in the background: wait until the control has arrived.
    const controlArrived = await waitFor(() => t.stub.appendCountFor(CONTROL) === 1)
    expect(controlArrived, 'precondition: an ordinary team memory saved with learn() reached the team server').toBe(true)
    await s.plur.flushOutbox({ force: true })
    expect(sentPrivate(), `expected the private memory never to reach the team server; it arrived ${sentPrivate()} time(s)`).toBe(0)
    expect((await s.plur.getById(saved.id))?.statement, 'the private memory is still kept on this machine').toBe(PRIVATE)
  })

  it('learnRouted() (the MCP and CLI save path): saved with visibility private to a team scope', async () => {
    s = await teamStore(t.url)
    const saved = await s.plur.learnRouted(PRIVATE, { scope: TEAM_SCOPE, visibility: 'private' })
    await s.plur.learnRouted(CONTROL, { scope: TEAM_SCOPE })
    expect(t.stub.appendCountFor(CONTROL), 'precondition: an ordinary team memory saved with learnRouted() reached the team server').toBe(1)
    await s.plur.flushOutbox({ force: true })
    expect(sentPrivate(), `expected the private memory never to reach the team server; it arrived ${sentPrivate()} time(s)`).toBe(0)
    expect((await s.plur.getById(saved.id))?.statement, 'the private memory is still kept on this machine').toBe(PRIVATE)
  })

  it('saved while the server is down, then the server comes back and the outbox is flushed', async () => {
    s = await teamStore(t.url)
    t.stub.appendErrorResponse = { status: 503, body: 'down for maintenance' }
    await s.plur.learnRouted(PRIVATE, { scope: TEAM_SCOPE, visibility: 'private' })
    await s.plur.learnRouted(CONTROL, { scope: TEAM_SCOPE })
    t.stub.appendErrorResponse = null
    await s.plur.flushOutbox({ force: true })
    expect(t.stub.appendCountFor(CONTROL), 'precondition: the ordinary team memory was delivered once the server came back').toBe(1)
    expect(sentPrivate(), `expected the private memory never to reach the team server; it arrived ${sentPrivate()} time(s)`).toBe(0)
  })
})
