// PRV-6: A memory saved to a team scope is shared with the team unless I mark
// it private, and the save tells me where it went.
//
// Replaces PRV-5 (owner decision 2026-10-17: team-scoped memories are shared
// unless marked private; safety rests on server-side review and on the save
// saying where each memory went).
//
// A stub team server is mounted for the team scope. Driven two ways: the
// engine (learn, learnRouted, then deliveryOf for "where did it go"), and the
// MCP server's plur_learn reply, which is what an agent reads.
//  - No visibility: the memory reaches the team server exactly once, and the
//    answer says it went to the team store (delivery "remote", the team scope).
//  - visibility "private": nothing reaches the team server, the memory is in
//    the local store, and the answer says it stayed on this machine.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetTeamStub, startTeamStub, teamStore, waitFor, TEAM_SCOPE, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'
import { callTool, connectMcp, offlineFetch, writeFolderMap } from '../helpers/privacy-folders-team-mcp.js'

const SHARED = 'the on-call rotation swaps every second Thursday'
const PRIVATE = 'my own reminder: I cover on-call poorly after late flights'

describe('PRV-6 a team-scope memory is shared unless marked private, and the save says where it went', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  let net: ReturnType<typeof offlineFetch> | undefined
  const dirs: string[] = []
  const closers: Array<() => Promise<void>> = []
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop(); for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  beforeEach(() => resetTeamStub(t))
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const c of closers.splice(0)) await c()
    net?.restore(); net = undefined
    s?.cleanup(); s = undefined
  })

  for (const method of ['learn', 'learnRouted'] as const) {
    it(`engine ${method}(): no visibility goes to the team; private stays here; each says where`, async () => {
      s = await teamStore(t.url)
      const shared = await s.plur[method](SHARED, { scope: TEAM_SCOPE })
      const arrived = await waitFor(() => t.stub.appendCountFor(SHARED) === 1)
      expect(arrived, `expected a team-scope memory saved with no visibility to reach the team server once; it arrived ${t.stub.appendCountFor(SHARED)} times`).toBe(true)
      const whereShared = s.plur.deliveryOf(shared, TEAM_SCOPE)
      if (method === 'learnRouted') {
        // The routed save waits for the team server, so it can say it arrived.
        expect(whereShared.delivery, `expected the save to say it went to the team store ("remote"); it said ${JSON.stringify(whereShared)}`).toBe('remote')
      } else {
        // learn() returns before the send: it may say "remote" or "queued for
        // the team scope", but never that the memory stays on this machine.
        expect(['remote', 'outbox'], `expected the save to say it went, or is on its way, to the team store; it said ${JSON.stringify(whereShared)}`).toContain(whereShared.delivery)
        if (whereShared.delivery === 'outbox') {
          expect(whereShared.reason ?? '', `expected the save to name the team scope it is queued for; it said ${JSON.stringify(whereShared)}`).toContain(TEAM_SCOPE)
        }
      }
      expect(shared.scope, 'expected the saved memory to carry the team scope').toBe(TEAM_SCOPE)

      const priv = await s.plur[method](PRIVATE, { scope: TEAM_SCOPE, visibility: 'private' })
      await new Promise(r => setTimeout(r, 200))
      expect(t.stub.appendCountFor(PRIVATE), 'expected a memory marked private to stay on this machine; it was sent to the team server').toBe(0)
      const local = (await s.plur.list()).find(e => e.statement === PRIVATE)
      expect(local?.id ?? null, 'expected the private memory to be kept in the local store').not.toBeNull()
      const wherePriv = s.plur.deliveryOf(priv, TEAM_SCOPE)
      expect(wherePriv.delivery, `expected the save to say the private memory stayed here ("local"); it said ${JSON.stringify(wherePriv)}`).toBe('local')
      expect(wherePriv.warning ?? '', `expected the save to say in words that it stayed on this machine; it said ${JSON.stringify(wherePriv)}`).toMatch(/this machine/i)
    })
  }

  it('MCP plur_learn: the reply names where each memory went', async () => {
    s = await teamStore(t.url)
    net = offlineFetch()
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'plur-eval-prv6-ws-')))
    dirs.push(folder)
    writeFolderMap(s.dir, [{ path: folder, plur: 'on' }])
    vi.spyOn(process, 'cwd').mockReturnValue(folder)
    const conn = await connectMcp(s.plur)
    closers.push(conn.close)

    const shared = await callTool(conn.client, 'plur_learn', { statement: SHARED, scope: TEAM_SCOPE })
    expect(shared.raw.isError, `plur_learn failed: ${shared.text}`).not.toBe(true)
    expect(await waitFor(() => t.stub.appendCountFor(SHARED) === 1),
      `expected the team-scope memory (no visibility) to reach the team server once; it arrived ${t.stub.appendCountFor(SHARED)} times`).toBe(true)
    expect(shared.json?.delivery, `expected the reply to say it went to the team store ("remote"); reply: ${shared.text.slice(0, 600)}`).toBe('remote')
    expect(shared.json?.scope, `expected the reply to name the team scope; reply: ${shared.text.slice(0, 600)}`).toBe(TEAM_SCOPE)

    const priv = await callTool(conn.client, 'plur_learn', { statement: PRIVATE, scope: TEAM_SCOPE, visibility: 'private' })
    expect(priv.raw.isError, `plur_learn failed: ${priv.text}`).not.toBe(true)
    await new Promise(r => setTimeout(r, 200))
    expect(t.stub.appendCountFor(PRIVATE), 'expected the memory marked private to stay on this machine; it was sent to the team server').toBe(0)
    expect(priv.json?.delivery, `expected the reply to say the private memory stayed here ("local"); reply: ${priv.text.slice(0, 600)}`).toBe('local')
    expect(String(priv.json?.delivery_warning ?? ''), `expected the reply to say in words that it stayed on this machine; reply: ${priv.text.slice(0, 600)}`).toMatch(/this machine/i)
  })
})
