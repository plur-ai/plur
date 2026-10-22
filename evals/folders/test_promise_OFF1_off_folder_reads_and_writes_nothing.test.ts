// OFF-1: In a folder where I turned memory off, nothing is read from or written to memory, including team servers.
//
// Driven through the MCP server (the way an agent reaches PLUR). A team server
// (stub) is mounted and live recall is on. In a folder that is `on` the same
// calls do save, find and reach the team server (the control). In the `off`
// folder they must leave every store file unchanged, send nothing to the team
// server, return no memory text, and call nothing on the memory engine but the
// folder lookup. The second case is an editor with two workspace folders, one
// `on` and one `off`: the `off` one still wins.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import {
  resetTeamStub, startTeamStub, withRemoteRecall, TEAM_SCOPE, TEAM_TOKEN, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'
import { _resetRemoteHostBreaker } from '../../packages/core/src/store/remote-store.js'
import {
  callTool, connectMcp, offlineFetch, snapshotTree, treeChanges, writeFolderMap,
} from '../helpers/privacy-folders-team-mcp.js'

const LOCAL_FACT = 'quokka-fact the deploy target is the blue cluster'
const REMOTE_FACT = 'quokka-team-fact team builds run on the green runners'
const PROJECT = 'project:acme/web'

const MEMORY_CALLS: Array<[string, Record<string, unknown>]> = [
  ['plur_learn', { statement: 'quokka-new local learning', scope: 'global' }],
  ['plur_learn', { statement: 'quokka-new team learning', scope: TEAM_SCOPE }],
  ['plur_recall', { query: 'quokka deploy target', scope: PROJECT }],
  ['plur_recall_hybrid', { query: 'quokka deploy target', scope: PROJECT }],
  ['plur_inject', { task: 'quokka deploy target team builds', scope: PROJECT }],
  ['plur_inject_hybrid', { task: 'quokka deploy target team builds', scope: PROJECT }],
  ['plur_session_start', { task: 'quokka deploy target team builds' }],
]

describe('OFF-1 in an off folder nothing is read from or written to memory, team servers included', () => {
  let t: TeamStub
  let net: ReturnType<typeof offlineFetch>
  const dirs: string[] = []
  const closers: Array<() => Promise<void>> = []
  const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d }

  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop(); for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  beforeEach(() => {
    resetTeamStub(t)
    t.stub.recallRows = [{ id: 'ENG-SRV-777', scope: TEAM_SCOPE, status: 'active', statement: REMOTE_FACT, score: 1 }]
    net = offlineFetch()
    _resetRemoteHostBreaker()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const c of closers.splice(0)) await c()
    net.restore()
  })

  async function setup() {
    const home = tmp('plur-eval-off1-home-')
    writeFileSync(join(home, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${t.url}"\n    token: "${TEAM_TOKEN}"\n    scope: "${TEAM_SCOPE}"\n`)
    const plur = new Plur({ path: home, autoDiscover: false })
    await plur.learn(LOCAL_FACT, { scope: 'global' })
    const off = tmp('plur-eval-off1-off-')
    const on = tmp('plur-eval-off1-on-')
    writeFolderMap(home, [{ path: off, plur: 'off' }, { path: on, plur: 'on' }])
    return { home, plur, off, on }
  }

  /** Record every call on the memory engine except the folder lookup. */
  function spyEngine(plur: Plur): string[] {
    const called: string[] = []
    const allowed = new Set(['resolveFolderPolicy', 'constructor'])
    const seen = new Set<string>()
    for (let proto = Object.getPrototypeOf(plur); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (seen.has(key) || allowed.has(key)) continue
        const d = Object.getOwnPropertyDescriptor(proto, key)
        if (!d || typeof d.value !== 'function') continue
        seen.add(key)
        const orig = d.value
        ;(plur as any)[key] = function (...a: unknown[]) { called.push(key); return orig.apply(this, a) }
      }
    }
    return called
  }

  async function expectNothingTouched(s: Awaited<ReturnType<typeof setup>>, client: any, where: string) {
    const before = snapshotTree(s.home)
    t.hits.length = 0
    const called = spyEngine(s.plur)
    for (const [tool, args] of MEMORY_CALLS) {
      const r = await callTool(client, tool, args)
      expect(r.raw.isError, `${where}: ${tool} should answer without an error; got ${r.text}`).not.toBe(true)
      expect(r.json?.plur, `${where}: ${tool} should say PLUR is off here; got ${r.text.slice(0, 300)}`).toBe('off')
      expect(r.text, `${where}: ${tool} returned memory text in an off folder`).not.toContain('quokka')
    }
    expect(treeChanges(before, snapshotTree(s.home)), `${where}: expected no memory file to change`).toEqual([])
    expect(t.hits, `${where}: expected no request to the team server`).toEqual([])
    expect(called, `${where}: expected nothing on the memory engine to run but the folder lookup`).toEqual([])
  }

  it('the editor runs PLUR in the off folder', async () => {
    const s = await setup()
    await withRemoteRecall(async () => {
      // Control: in the `on` folder the same calls save, find and reach the team server.
      vi.spyOn(process, 'cwd').mockReturnValue(s.on)
      const onConn = await connectMcp(s.plur)
      closers.push(onConn.close)
      const recalled = await callTool(onConn.client, 'plur_recall', { query: 'quokka deploy target', scope: PROJECT })
      expect(recalled.text, 'precondition: in an on folder, recall finds my memory').toContain('quokka-fact')
      await callTool(onConn.client, 'plur_learn', { statement: 'quokka-control team learning', scope: TEAM_SCOPE })
      expect(t.stub.appendCountFor('quokka-control team learning'), 'precondition: in an on folder, a team learning reaches the team server').toBe(1)
      expect(t.stub.recallCalls, 'precondition: in an on folder, recall asks the team server').toBeGreaterThan(0)

      vi.spyOn(process, 'cwd').mockReturnValue(s.off)
      const offConn = await connectMcp(s.plur)
      closers.push(offConn.close)
      await expectNothingTouched(s, offConn.client, 'off folder')
    })
  })

  it('the editor has two workspace folders, one on and one off', async () => {
    const s = await setup()
    await withRemoteRecall(async () => {
      vi.spyOn(process, 'cwd').mockReturnValue(s.off)
      const conn = await connectMcp(s.plur, { roots: [s.on] })
      closers.push(conn.close)
      await expectNothingTouched(s, conn.client, 'on root + off folder')
    })
  })
})
