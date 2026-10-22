// OFF-4: In a folder I have not decided about yet, nothing is read from or
// written to memory until I choose, and my choice applies only to that folder.
//
// Driven through the MCP server, the way an agent reaches PLUR, with a stub
// team server mounted and live recall on. Two folders, A and its sibling B,
// neither in the folder map.
//  1. Onboarding: in A every memory tool, called directly or through the
//     general gateway tool (plur_admin, lean profile), answers with the folder
//     question; no memory text comes back, no memory file changes, the team
//     server hears nothing, and nothing on the memory engine runs but the
//     folder lookup and the question's own bookkeeping.
//  2. The choice: answering "yes" for A (the command the question offers, run
//     as `plur folders set` runs it) turns memory on in A, directly and through
//     the gateway. B stays undecided: the map gains an entry for A only, a new
//     session in B still gets the question, and A's answer cannot be redeemed
//     for B or from another session.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { _resetRemoteHostBreaker } from '../../packages/core/src/store/remote-store.js'
import {
  resetTeamStub, startTeamStub, withRemoteRecall, TEAM_SCOPE, TEAM_TOKEN, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'
import { callTool, connectMcp, offlineFetch, snapshotTree, treeChanges } from '../helpers/privacy-folders-team-mcp.js'

const LOCAL_FACT = 'kiwi-fact the deploy target is the blue cluster'
const REMOTE_FACT = 'kiwi-team-fact team builds run on the green runners'
const PROJECT = 'project:acme/web'

const DIRECT_CALLS: Array<[string, Record<string, unknown>]> = [
  ['plur_learn', { statement: 'kiwi-new local learning', scope: 'global' }],
  ['plur_learn', { statement: 'kiwi-new team learning', scope: TEAM_SCOPE }],
  ['plur_recall', { query: 'kiwi deploy target', scope: PROJECT }],
  ['plur_recall_hybrid', { query: 'kiwi deploy target', scope: PROJECT }],
  ['plur_inject', { task: 'kiwi deploy target team builds', scope: PROJECT }],
  ['plur_inject_hybrid', { task: 'kiwi deploy target team builds', scope: PROJECT }],
  ['plur_session_start', { task: 'kiwi deploy target team builds' }],
]
/** The same kind of calls through the general gateway tool, as a lean-profile agent makes them. */
const GATEWAY_CALLS: Array<[string, Record<string, unknown>]> = [
  ['plur_capture', { summary: 'kiwi-new episode', agent: 'evals' }],
  ['plur_timeline', {}],
  ['plur_similarity_search', { query: 'kiwi deploy target' }],
  ['plur_learn', { statement: 'kiwi-new gateway learning', scope: 'global' }],
  ['plur_recall', { query: 'kiwi deploy target' }],
]

/** Folder-question bookkeeping (single-use answer nonces, map locks): not memory. */
const NOT_MEMORY = (rel: string) => rel.startsWith('folder-nonces') || rel.startsWith('.folders') || rel.endsWith('.lock')
const memoryFiles = (root: string) => Object.fromEntries(Object.entries(snapshotTree(root)).filter(([k]) => !NOT_MEMORY(k)))

/** The pieces of an offered `plur folders set` command. */
function parse(command: string): { folder: string; flags: string[]; nonce: string; session: string } {
  const m = /folders set (\S+) (.+?) --nonce ([0-9a-f]+) --session (\S+)$/.exec(command)
  if (!m) throw new Error(`not a folder answer command: ${command}`)
  return { folder: m[1], flags: m[2].split(' '), nonce: m[3], session: m[4] }
}

describe('OFF-4 an undecided folder reads and writes no memory until I choose, and the choice covers that folder only', () => {
  let t: TeamStub
  let net: ReturnType<typeof offlineFetch>
  const dirs: string[] = []
  const closers: Array<() => Promise<void>> = []
  const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d }

  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop(); for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  beforeEach(() => {
    resetTeamStub(t)
    t.stub.recallRows = [{ id: 'ENG-SRV-778', scope: TEAM_SCOPE, status: 'active', statement: REMOTE_FACT, score: 1 }]
    net = offlineFetch()
    _resetRemoteHostBreaker()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const c of closers.splice(0)) await c()
    net.restore()
  })

  async function setup() {
    const home = tmp('plur-eval-off4-home-')
    writeFileSync(join(home, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${t.url}"\n    token: "${TEAM_TOKEN}"\n    scope: "${TEAM_SCOPE}"\n`)
    const plur = new Plur({ path: home, autoDiscover: false })
    await plur.learn(LOCAL_FACT, { scope: 'global' })
    const parent = tmp('plur-eval-off4-ws-')
    const a = join(parent, 'a'); const b = join(parent, 'b')
    for (const d of [a, b]) mkdirSync(d)
    return { home, plur, a, b }
  }

  /** Record every call on the memory engine, by method name. */
  function spyEngine(plur: Plur): string[] {
    const called: string[] = []
    const seen = new Set<string>(['constructor'])
    for (let proto = Object.getPrototypeOf(plur); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (seen.has(key)) continue
        const d = Object.getOwnPropertyDescriptor(proto, key)
        if (!d || typeof d.value !== 'function') continue
        seen.add(key)
        const orig = d.value
        ;(plur as any)[key] = function (...args: unknown[]) { called.push(key); return orig.apply(this, args) }
      }
    }
    return called
  }
  /**
   * The folder lookup, the folder question's own nonces, and the configuration
   * the question reads to suggest a team scope (config file, scope metadata).
   * None of these reads or writes a memory; anything else does.
   */
  const FOLDER_ONLY = /^(resolveFolderPolicy|issueFolderNonce|endFolderNonceSession|listFolders|suggestScope|reloadConfigIfChanged|statConfigMtime|listScopeMetadata|getScopeMetadata)$/

  function expectAsk(r: { raw: any; text: string; json: any }, folder: string, where: string) {
    expect(r.raw.isError, `${where}: should answer without an error; got ${r.text.slice(0, 300)}`).not.toBe(true)
    expect(r.json?.plur, `${where}: should ask the folder question; got ${r.text.slice(0, 300)}`).toBe('ask')
    expect(r.json?.folder, `${where}: the question should be about the undecided folder`).toBe(folder)
    expect(r.text, `${where}: returned memory text before I chose`).not.toContain('kiwi-')
  }

  it('onboarding: in an undecided folder, direct calls and the gateway read and write nothing', async () => {
    const s = await setup()
    await withRemoteRecall(async () => {
      vi.spyOn(process, 'cwd').mockReturnValue(s.a)
      const full = await connectMcp(s.plur, { profile: 'full' })
      closers.push(full.close)
      const lean = await connectMcp(s.plur, { profile: 'lean' })
      closers.push(lean.close)
      const before = memoryFiles(s.home)
      t.hits.length = 0
      const called = spyEngine(s.plur)
      for (const [tool, args] of DIRECT_CALLS) expectAsk(await callTool(full.client, tool, args), s.a, tool)
      for (const [action, args] of GATEWAY_CALLS) {
        expectAsk(await callTool(lean.client, 'plur_admin', { action, args }), s.a, `plur_admin ${action}`)
      }
      expect(treeChanges(before, memoryFiles(s.home)), 'expected no memory file to change before I chose').toEqual([])
      expect(existsSync(join(s.home, 'folders.yaml')), 'expected the folder map not to be written before I chose').toBe(false)
      expect(t.hits, 'expected no request to the team server before I chose').toEqual([])
      expect(called.filter(m => !FOLDER_ONLY.test(m)),
        `expected nothing on the memory engine to run but the folder lookup and the question; ran ${JSON.stringify(called)}`).toEqual([])
    })
  })

  it('my "yes" for one folder turns memory on there only; the sibling folder stays undecided', async () => {
    const s = await setup()
    await withRemoteRecall(async () => {
      vi.spyOn(process, 'cwd').mockReturnValue(s.a)
      const inA = await connectMcp(s.plur, { profile: 'lean' })
      closers.push(inA.close)
      const q = await callTool(inA.client, 'plur_recall', { query: 'kiwi deploy target' })
      expectAsk(q, s.a, 'first call in A')
      const answers = q.json.answers as Array<{ label: string; command: string }>
      const yes = answers.find(x => /^Yes, without/i.test(x.label)) ?? answers.find(x => /^Yes/.test(x.label))
      expect(yes, `the question offered no "yes": ${JSON.stringify(answers)}`).toBeDefined()
      const c = parse(yes!.command)
      expect(c.folder, 'the offered "yes" names the folder I am in').toBe(s.a)

      // A's answer cannot be spent on B, nor from another session; neither attempt changes the map.
      expect(() => s.plur.setFolder(s.b, { mode: 'on' }, { nonce: c.nonce, session: c.session }),
        'expected the answer issued for A to be refused for B').toThrow()
      expect(() => s.plur.setFolder(s.a, { mode: 'on' }, { nonce: c.nonce, session: 'mcp-someone-else' }),
        'expected the answer issued for this session to be refused from another session').toThrow()
      expect(s.plur.listFolders(), 'expected the refused answers to leave the folder map without entries').toEqual([])

      // I answer yes, as `plur folders set` does with the offered command.
      const change = c.flags[0] === '--scope' ? { scope: c.flags[1] } : { mode: 'on' as const }
      s.plur.setFolder(c.folder, change, { nonce: c.nonce, session: c.session })

      const recalled = await callTool(inA.client, 'plur_recall', { query: 'kiwi deploy target', scope: 'global' })
      expect(recalled.json?.plur, `after my yes, recall in A should run; got ${recalled.text.slice(0, 300)}`).toBeUndefined()
      expect(recalled.text, 'after my yes, recall in A should find my memory').toContain('kiwi-fact')
      const viaGateway = await callTool(inA.client, 'plur_admin', { action: 'plur_capture', args: { summary: 'kiwi-after-yes episode', agent: 'evals' } })
      expect(viaGateway.json?.plur, `after my yes, the gateway in A should run; got ${viaGateway.text.slice(0, 300)}`).toBeUndefined()

      const entries = s.plur.listFolders().map(e => e.path)
      expect(entries, 'expected my answer to record a decision for A').toContain(s.a)
      expect(entries.filter(p => p !== s.a), 'expected my answer for A to record nothing for any other folder').toEqual([])
      expect(s.plur.resolveFolderPolicy(s.b).mode, 'expected the sibling folder B to stay undecided').toBe('ask')

      vi.spyOn(process, 'cwd').mockReturnValue(s.b)
      const inB = await connectMcp(s.plur, { profile: 'full' })
      closers.push(inB.close)
      const before = memoryFiles(s.home)
      t.hits.length = 0
      for (const [tool, args] of DIRECT_CALLS.filter(([n]) => n !== 'plur_inject')) {
        expectAsk(await callTool(inB.client, tool, args), s.b, `${tool} in sibling folder B`)
      }
      const inBLean = await connectMcp(s.plur, { profile: 'lean' })
      closers.push(inBLean.close)
      expectAsk(await callTool(inBLean.client, 'plur_admin', { action: 'plur_timeline', args: {} }), s.b, 'plur_admin plur_timeline in sibling folder B')
      expect(treeChanges(before, memoryFiles(s.home)), 'expected nothing written to memory from the undecided sibling folder').toEqual([])
      expect(t.hits, 'expected no request to the team server from the undecided sibling folder').toEqual([])
    })
  })
})
