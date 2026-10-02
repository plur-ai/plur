/**
 * The MCP server respects the folder map's `off` decision.
 *
 * The editor hooks and the opencode plugin already go silent in a folder the
 * user marked `plur: off` in `<PLUR home>/folders.yaml`. The MCP server did
 * not read the map at all, so an agent that called plur_learn / plur_recall
 * itself still read and wrote memory there. In an `off` folder every memory
 * tool must now touch no store at all — no local file, no outbox row, no
 * request to a remote store — and say, without an error, that PLUR is off for
 * this folder and how to turn it back on. Admin and diagnostic tools keep
 * working. `on` (and `ask`) behave as before.
 *
 * The folder the server resolves is the editor's workspace: each root the
 * client lists over MCP `roots/list`, plus the server process's cwd (the
 * folder the editor started it in). It is resolved on every call, so a
 * decision changed mid-session applies to the next call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync, symlinkSync, lstatSync, readlinkSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { getToolDefinitions } from '../src/tools.js'
import * as folderGate from '../src/folder-gate.js'

const FOLDER_GATED_TOOLS: ReadonlySet<string> = folderGate.FOLDER_GATED_TOOLS
const ADMIN_UNGATED_TOOLS: ReadonlySet<string> = (folderGate as any).ADMIN_UNGATED_TOOLS ?? new Set()
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'folder-off-token'
const SCOPE = 'group:test'
const LOCAL_FACT = 'zebra-local-fact the deploy target is the blue cluster'
const REMOTE_FACT = 'zebra-remote-fact team builds run on the green runners'

let stub: StubServer
let baseUrl: string
/** Every request the stub received, by path — the "no remote call" witness. */
let hits: string[] = []
const dirs: string[] = []
let clients: Client[] = []

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

/** sha256 of every file under `root`, by relative path. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (lstatSync(p).isSymbolicLink()) { out[relative(root, p)] = `link:${readlinkSync(p)}`; continue }
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(root)
  return out
}

function writeFolders(home: string, entries: Array<{ path: string; plur: 'on' | 'off' | 'ask' }>): void {
  writeFileSync(
    join(home, 'folders.yaml'),
    'version: 1\nfolders:\n' + entries.map(e => `  - path: "${e.path}"\n    plur: ${e.plur}\n`).join(''),
  )
}

interface Setup { home: string; plur: Plur; workspace: string; other: string }

/** A throwaway PLUR home with one local engram and the stub as a remote team store. */
async function setup(storeUrl = baseUrl): Promise<Setup> {
  const home = tmp('plur-mcp-folderoff-home-')
  writeFileSync(
    join(home, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${storeUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`,
  )
  const plur = new Plur({ path: home })
  await plur.learn(LOCAL_FACT, { scope: 'global' })
  const workspace = tmp('plur-mcp-folderoff-ws-')
  const other = tmp('plur-mcp-folderoff-other-')
  writeFolders(home, [{ path: workspace, plur: 'off' }, { path: other, plur: 'on' }])
  return { home, plur, workspace, other }
}

async function connect(plur: Plur, opts: { profile?: 'full' | 'lean'; roots?: string[] } = {}): Promise<Client> {
  const server = await createServer(plur, { profile: opts.profile ?? 'full' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: 'folder-off-test', version: '1.0.0' },
    opts.roots ? { capabilities: { roots: { listChanged: true } } } : undefined,
  )
  if (opts.roots) {
    const roots = opts.roots
    client.setRequestHandler('roots/list', async () => ({
      roots: roots.map(r => ({ uri: pathToFileURL(r).href, name: 'ws' })),
    }))
  }
  await client.connect(clientTransport)
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ raw: any; text: string; json: any }> {
  const raw = await client.callTool({ name, arguments: args })
  const text = (raw.content as any)[0].text as string
  let json: any
  try { json = JSON.parse(text) } catch { json = undefined }
  return { raw, text, json }
}

/** The non-error "PLUR is off here" answer every gated tool gives. */
function expectOffAnswer(r: { raw: any; json: any; text: string }, folder: string): void {
  expect(r.raw.isError, r.text).not.toBe(true)
  expect(r.json?.plur, r.text).toBe('off')
  expect(r.json?.folder).toBe(folder)
  expect(r.json?.message).toMatch(/PLUR is off for this folder/)
  expect(r.json?.message).toContain('folders set')
  expect(r.json?.message).toContain('--on')
  expect(r.text).not.toContain('zebra-')
}

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  const info = await stub.start()
  baseUrl = info.url
  const original = (stub as any).handleRequest.bind(stub)
  ;(stub as any).handleRequest = (req: any, res: any) => { hits.push(`${req.method} ${req.url}`); original(req, res) }
})

afterAll(async () => {
  await stub.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  stub.reset()
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [SCOPE] })
  stub.recallRows = [{ id: 'ENG-2026-1001-001', scope: SCOPE, status: 'active', statement: REMOTE_FACT, score: 1 }]
  hits = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.map(c => c.close().catch(() => {})))
  clients = []
})

describe('MCP memory tools in an `off` folder (cwd is the workspace)', () => {
  it('plur_learn writes nothing: store unchanged, no outbox row, no remote call', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const before = snapshot(s.home)
    hits = []
    const local = await call(client, 'plur_learn', { statement: 'zebra-new local learning', scope: 'global' })
    const team = await call(client, 'plur_learn', { statement: 'zebra-new team learning', scope: SCOPE })
    expectOffAnswer(local, s.workspace)
    expectOffAnswer(team, s.workspace)
    expect(snapshot(s.home)).toEqual(before)
    expect(await s.plur.outboxCount()).toBe(0)
    expect(stub.appendCalls).toBe(0)
    expect(hits).toEqual([])
  })

  it('plur_learn_batch writes nothing', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const before = snapshot(s.home)
    hits = []
    const r = await call(client, 'plur_learn_batch', { engrams: [{ statement: 'zebra-batch one', scope: SCOPE }, { statement: 'zebra-batch two' }] })
    expectOffAnswer(r, s.workspace)
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
  })

  it('a team-scoped learn against an unreachable remote queues no outbox row', async () => {
    const s = await setup('http://127.0.0.1:1')
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_learn', { statement: 'zebra-outbox candidate', scope: SCOPE })
    expectOffAnswer(r, s.workspace)
    expect(await s.plur.outboxCount()).toBe(0)
  })

  for (const tool of ['plur_recall', 'plur_recall_hybrid', 'plur_inject', 'plur_inject_hybrid']) {
    it(`${tool} returns no engrams and does not dial the remote`, async () => {
      const s = await setup()
      vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
      const client = await connect(s.plur)
      const before = snapshot(s.home)
      hits = []
      const args = tool.startsWith('plur_inject') ? { task: 'zebra deploy target team builds', scope: SCOPE } : { query: 'zebra deploy target', scope: SCOPE }
      const r = await call(client, tool, args)
      expectOffAnswer(r, s.workspace)
      expect(stub.recallCalls).toBe(0)
      expect(hits).toEqual([])
      expect(snapshot(s.home)).toEqual(before)
    })
  }

  it('plur_session_start injects nothing and touches no store', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const before = snapshot(s.home)
    hits = []
    const r = await call(client, 'plur_session_start', { task: 'zebra deploy target team builds' })
    expectOffAnswer(r, s.workspace)
    expect(hits).toEqual([])
    expect(snapshot(s.home)).toEqual(before)
  })

  it('plur_capture, plur_feedback and plur_session_end write nothing', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const id = (await s.plur.recall('zebra-local-fact'))[0].id
    const client = await connect(s.plur)
    const before = snapshot(s.home)
    hits = []
    expectOffAnswer(await call(client, 'plur_capture', { summary: 'zebra-episode did a thing' }), s.workspace)
    expectOffAnswer(await call(client, 'plur_feedback', { id, signal: 'positive' }), s.workspace)
    expectOffAnswer(await call(client, 'plur_session_end', { summary: 'zebra-session summary', engram_suggestions: [{ statement: 'zebra-suggested' }] }), s.workspace)
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
  })

  it('the plur_admin route is gated the same way (lean profile)', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur, { profile: 'lean' })
    hits = []
    const r = await call(client, 'plur_admin', { action: 'plur_recall_hybrid', args: { query: 'zebra deploy target' } })
    expectOffAnswer(r, s.workspace)
    expect(hits).toEqual([])
    // help is not a memory operation
    const help = await call(client, 'plur_admin', { action: 'help' })
    expect(help.json?.actions?.length).toBeGreaterThan(0)
  })

  it('plur_status still works', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_status')
    expect(r.raw.isError).not.toBe(true)
    expect(r.json?.plur).not.toBe('off')
    expect(r.json?.engram_count).toBeGreaterThanOrEqual(1)
  })

  it('every registered tool is either gated or explicitly admin, never both, never neither', () => {
    const names = getToolDefinitions('full').map(t => t.name)
    for (const n of names) {
      const inGated = FOLDER_GATED_TOOLS.has(n)
      const inAdmin = ADMIN_UNGATED_TOOLS.has(n)
      expect(inGated !== inAdmin, `${n}: gated=${inGated} admin=${inAdmin}`).toBe(true)
    }
    for (const n of [...FOLDER_GATED_TOOLS, ...ADMIN_UNGATED_TOOLS]) expect(names.includes(n), `${n} is not a tool`).toBe(true)
    for (const n of ['plur_status', 'plur_doctor', 'plur_stores_list']) expect(ADMIN_UNGATED_TOOLS.has(n), n).toBe(true)
    for (const n of ['plur_learn', 'plur_learn_batch', 'plur_recall', 'plur_recall_hybrid', 'plur_inject', 'plur_inject_hybrid',
      'plur_capture', 'plur_feedback', 'plur_session_start', 'plur_session_end', 'plur_forget', 'plur_receipt']) {
      expect(FOLDER_GATED_TOOLS.has(n), n).toBe(true)
    }
  })

  it('every gated tool answers off, called directly (full profile)', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const before = snapshot(s.home)
    hits = []
    for (const n of FOLDER_GATED_TOOLS) expectOffAnswer(await call(client, n, {}), s.workspace)
    expect(FOLDER_GATED_TOOLS.size).toBeGreaterThan(30)
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
  })

  it('every gated tool answers off through plur_admin, and core ones directly (lean profile)', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur, { profile: 'lean' })
    const direct = new Set((await client.listTools()).tools.map(t => t.name))
    hits = []
    for (const n of FOLDER_GATED_TOOLS) {
      const r = direct.has(n) ? await call(client, n, {}) : await call(client, 'plur_admin', { action: n, args: {} })
      expectOffAnswer(r, s.workspace)
    }
    expect(hits).toEqual([])
  })

  it('a gated call calls nothing on the Plur instance but the folder lookup (no local reads either)', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const called: string[] = []
    const allowed = new Set(['resolveFolderPolicy', 'constructor'])
    let proto = Object.getPrototypeOf(s.plur)
    const seen = new Set<string>()
    while (proto && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (seen.has(key) || allowed.has(key)) continue
        const d = Object.getOwnPropertyDescriptor(proto, key)
        if (!d || typeof d.value !== 'function') continue
        seen.add(key)
        const orig = d.value
        ;(s.plur as any)[key] = function (...a: unknown[]) { called.push(key); return orig.apply(this, a) }
      }
      proto = Object.getPrototypeOf(proto)
    }
    for (const n of ['plur_recall', 'plur_learn', 'plur_inject_hybrid', 'plur_session_start', 'plur_receipt']) {
      expectOffAnswer(await call(client, n, { query: 'zebra', statement: 'zebra-x', task: 'zebra' }), s.workspace)
    }
    expect(called).toEqual([])
  })

  it('the answer names every off entry covering the folder', async () => {
    const s = await setup()
    const nested = join(s.workspace, 'inner')
    mkdirSync(nested)
    writeFolders(s.home, [{ path: s.workspace, plur: 'off' }, { path: nested, plur: 'off' }])
    vi.spyOn(process, 'cwd').mockReturnValue(nested)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_recall', { query: 'zebra' })
    expect(r.json?.plur).toBe('off')
    expect(r.json?.message).toContain(`folders set ${s.workspace} --on`)
    expect(r.json?.message).toContain(`folders set ${nested} --on`)
  })
})

describe('MCP memory tools resolve the folder per call and from client roots', () => {
  it('an `on` folder behaves as before: learn writes and recall returns engrams', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const client = await connect(s.plur)
    const learned = await call(client, 'plur_learn', { statement: 'zebra-on folder learning', scope: 'global' })
    expect(learned.json?.plur).toBeUndefined()
    expect(learned.text).toContain('zebra-on folder learning')
    const r = await call(client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(r.json?.plur).toBeUndefined()
    expect(r.text).toContain('zebra-local-fact')
  })

  it('a decision changed mid-session applies to the next call', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const client = await connect(s.plur)
    const first = await call(client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(first.text).toContain('zebra-local-fact')
    writeFolders(s.home, [{ path: s.other, plur: 'off' }])
    const second = await call(client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expectOffAnswer(second, s.other)
  })

  it('a client root in an `off` folder turns the memory tools off even when cwd is elsewhere', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const client = await connect(s.plur, { roots: [s.workspace] })
    const before = snapshot(s.home)
    hits = []
    const r = await call(client, 'plur_learn', { statement: 'zebra-roots learning', scope: SCOPE })
    expectOffAnswer(r, s.workspace)
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
  })

  it('a folder inside an `off` entry is off, and the answer names the entry to turn on', async () => {
    const s = await setup()
    const nested = join(s.workspace, 'sub', 'dir')
    mkdirSync(nested, { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(nested)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_recall', { query: 'zebra' })
    expect(r.json?.plur).toBe('off')
    expect(r.json?.folder).toBe(nested)
    expect(r.json?.message).toContain(`folders set ${s.workspace} --on`)
  })
})

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A client whose roots/list answer is scripted per request (request index n). */
async function connectScripted(
  plur: Plur,
  rootsFn: (n: number) => Promise<string[]>,
  opts: { listChanged?: boolean } = {},
): Promise<{ client: Client; requests: () => number }> {
  const server = await createServer(plur, { profile: 'full' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client(
    { name: 'folder-off-scripted', version: '1.0.0' },
    { capabilities: { roots: opts.listChanged === false ? {} : { listChanged: true } } },
  )
  let n = 0
  client.setRequestHandler('roots/list', async () => {
    const roots = await rootsFn(n++)
    // A string that is already a URI is sent as is (for unconvertible roots).
    return { roots: roots.map(r => ({ uri: r.startsWith('file:') ? r : pathToFileURL(r).href, name: 'ws' })) }
  })
  await client.connect(ct)
  clients.push(client)
  return { client, requests: () => n }
}

describe('the roots cache never lets a memory call through an off root', () => {
  it('calls made while roots/list is in flight all wait for it and are gated', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other) // cwd is an `on` folder
    const { client, requests } = await connectScripted(s.plur, async () => { await sleep(300); return [s.workspace] })
    const before = snapshot(s.home)
    const [a, b, c] = await Promise.all([
      call(client, 'plur_recall', { query: 'zebra-local-fact deploy target' }),
      (async () => { await sleep(50); return call(client, 'plur_learn', { statement: 'zebra-race leaked learning', scope: 'global' }) })(),
      (async () => { await sleep(100); return call(client, 'plur_recall', { query: 'zebra-local-fact' }) })(),
    ])
    expectOffAnswer(a, s.workspace)
    expectOffAnswer(b, s.workspace)
    expectOffAnswer(c, s.workspace)
    expect(snapshot(s.home)).toEqual(before)
    expect(requests()).toBe(1)
  })

  it('a failed roots/list is not cached: the next call asks again and is gated', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const sc = await connectScripted(s.plur, async (i) => { if (i === 0) throw new Error('client busy'); return [s.workspace] })
    await call(sc.client, 'plur_status')
    await call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    const second = await call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expectOffAnswer(second, s.workspace)
    expect(sc.requests()).toBe(2)
  })

  it('a failed roots/list fails closed for that call (no start-folder fallback); the next call retries and works', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other) // the start folder is `on`
    const sc = await connectScripted(s.plur, async (i) => { if (i === 0) throw new Error('client busy'); return [s.other] })
    const before = snapshot(s.home)
    hits = []
    const refused = await call(sc.client, 'plur_learn', { statement: 'zebra-fallback learning', scope: 'global' })
    expect(refused.raw.isError, refused.text).not.toBe(true)
    expect(refused.json?.plur).toBe('off')
    expect(refused.json?.reason).toBe('workspace-unknown')
    expect(refused.json?.message).toMatch(/workspace folders/)
    expect(refused.json?.message).toMatch(/memory is off for this call/)
    expect(refused.json?.message).toMatch(/next call will ask (for them )?again/)
    expect(refused.json?.message).not.toMatch(/will retry/)
    expect(refused.text).not.toContain('zebra-')
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
    const next = await call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(next.json?.plur).toBeUndefined()
    expect(next.text).toContain('zebra-local-fact')
    expect(sc.requests()).toBe(2)
  })

  it('a roots/list timeout fails closed for that call too', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const sc = await connectScripted(s.plur, async (i) => { if (i === 0) { await sleep(3000); return [s.other] } return [s.other] })
    const refused = await call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(refused.json?.reason).toBe('workspace-unknown')
    expect(refused.text).not.toContain('zebra-')
  })

  it('list_changed during an in-flight roots/list discards the stale answer, for the waiting call too', async () => {
    const s = await setup()
    const thirdOn = tmp('plur-mcp-folderoff-third-')
    writeFolders(s.home, [{ path: s.workspace, plur: 'off' }, { path: s.other, plur: 'on' }, { path: thirdOn, plur: 'on' }])
    vi.spyOn(process, 'cwd').mockReturnValue(thirdOn)
    // request 0: the old workspace (on), answered slowly; later requests: the new one (off)
    const sc = await connectScripted(s.plur, async (i) => { if (i === 0) { await sleep(300); return [s.other] } return [s.workspace] })
    const before = snapshot(s.home)
    const first = call(sc.client, 'plur_learn', { statement: 'zebra-waiting call learning', scope: 'global' })
    await sleep(50)
    await sc.client.sendRootsListChanged()
    // The call that was already waiting must not run on the stale (on) answer.
    expectOffAnswer(await first, s.workspace)
    const next = await call(sc.client, 'plur_learn', { statement: 'zebra-stale root learning', scope: 'global' })
    expectOffAnswer(next, s.workspace)
    expect(snapshot(s.home)).toEqual(before)
  })

  it('list_changed is honoured: a later call uses the new roots', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const sc = await connectScripted(s.plur, async (i) => (i === 0 ? [s.other] : [s.workspace]))
    const first = await call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(first.text).toContain('zebra-local-fact')
    await sc.client.sendRootsListChanged()
    await sleep(20)
    expectOffAnswer(await call(sc.client, 'plur_recall', { query: 'zebra-local-fact' }), s.workspace)
  })
})

describe('a folder map that cannot be read fails safe', () => {
  function expectMapProblem(r: { raw: any; json: any; text: string }, home: string, needle: RegExp): void {
    expect(r.raw.isError, r.text).not.toBe(true)
    expect(r.json?.plur, r.text).toBe('off')
    expect(r.json?.reason).toBe('folder-map-unreadable')
    expect(r.json?.file).toBe(join(home, 'folders.yaml'))
    expect(r.json?.message).toContain(join(home, 'folders.yaml'))
    expect(r.json?.message).toMatch(needle)
    expect(r.text).not.toContain('zebra-')
  }

  it('invalid YAML: memory tools read and write nothing and name the file and line', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${s.workspace}"\n    plur: off\n  - path: [unclosed\n`)
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const client = await connect(s.plur)
    const before = snapshot(s.home)
    hits = []
    expectMapProblem(await call(client, 'plur_recall', { query: 'zebra-local-fact' }), s.home, /line \d+/)
    expectMapProblem(await call(client, 'plur_learn', { statement: 'zebra-malformed learning', scope: SCOPE }), s.home, /line \d+/)
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
    // admin tools still answer
    expect((await call(client, 'plur_status')).json?.engram_count).toBeGreaterThanOrEqual(1)
  })

  it('an invalid entry: names the entry and the problem', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${s.workspace}"\n    plur: of\n`)
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const client = await connect(s.plur)
    expectMapProblem(await call(client, 'plur_recall', { query: 'zebra-local-fact' }), s.home, /entry 1|folders\.0/)
  })

  it('no folders.yaml at all is not a problem: the folder is undecided and gets the question (#1525)', async () => {
    const s = await setup()
    rmSync(join(s.home, 'folders.yaml'))
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(r.json?.reason).toBeUndefined()
    expect(r.json?.plur).toBe('ask')
    expect(r.text).not.toContain('zebra-local-fact')
  })
})

describe('re-audit edge cases', () => {
  async function expectUnreadable(s: Setup, needle: RegExp): Promise<void> {
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const client = await connect(s.plur)
    const before = snapshot(s.home)
    hits = []
    for (const [tool, args] of [['plur_recall', { query: 'zebra-local-fact deploy target' }], ['plur_learn', { statement: 'zebra-edge learning', scope: 'global' }]] as const) {
      const r = await call(client, tool, args)
      expect(r.raw.isError, r.text).not.toBe(true)
      expect(r.json?.plur, r.text).toBe('off')
      expect(r.json?.reason, r.text).toBe('folder-map-unreadable')
      expect(r.json?.file).toBe(join(s.home, 'folders.yaml'))
      expect(r.json?.message).toMatch(needle)
      expect(r.text).not.toContain('zebra-')
    }
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
  }

  it('folders.yaml as a dangling symlink is unreadable, not absent', async () => {
    const s = await setup()
    rmSync(join(s.home, 'folders.yaml'))
    symlinkSync(join(s.home, 'no-such-target.yaml'), join(s.home, 'folders.yaml'))
    await expectUnreadable(s, /cannot be read|ENOENT|symlink/)
  })

  it('folders.yaml as a symlink loop is unreadable', async () => {
    const s = await setup()
    rmSync(join(s.home, 'folders.yaml'))
    symlinkSync(join(s.home, 'folders.yaml'), join(s.home, 'folders.yaml'))
    await expectUnreadable(s, /cannot be read|ELOOP/)
  })

  it('an empty folders.yaml is unreadable', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'folders.yaml'), '')
    await expectUnreadable(s, /empty/)
  })

  it('a comments-only folders.yaml is unreadable', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'folders.yaml'), '# nothing here yet\n')
    await expectUnreadable(s, /empty/)
  })

  it('a misspelled top-level key (`folder:`) is unreadable', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'folders.yaml'), `version: 1\nfolder:\n  - path: "${s.workspace}"\n    plur: off\n`)
    await expectUnreadable(s, /folder\b.*unknown|unknown.*folder\b/)
  })

  it('a root the server cannot convert fails the call closed, and is not cached', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other) // cwd is `on`
    const sc = await connectScripted(s.plur, async () => ['file://otherhost/work/secret'])
    const before = snapshot(s.home)
    hits = []
    const a = await call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(a.json?.reason, a.text).toBe('workspace-unknown')
    expect(a.text).not.toContain('zebra-')
    const b = await call(sc.client, 'plur_learn', { statement: 'zebra-unconvertible learning', scope: 'global' })
    expect(b.json?.reason, b.text).toBe('workspace-unknown')
    expect(sc.requests()).toBe(2)
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
  })

  it('an encoded-slash file root also fails closed', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const sc = await connectScripted(s.plur, async () => [pathToFileURL(s.other).href, `${pathToFileURL(s.workspace).href}%2Fchild`])
    const a = await call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(a.json?.reason, a.text).toBe('workspace-unknown')
    expect(a.text).not.toContain('zebra-')
  })

  it('a client with roots but no listChanged is asked again on every call', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const sc = await connectScripted(s.plur, async (i) => (i === 0 ? [s.other] : [s.workspace]), { listChanged: false })
    const first = await call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    expect(first.text).toContain('zebra-local-fact')
    expectOffAnswer(await call(sc.client, 'plur_recall', { query: 'zebra-local-fact' }), s.workspace)
    expect(sc.requests()).toBe(2)
  })

  it('plur_status on an unparsable engrams.yaml quotes no lines of it', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'engrams.yaml'), 'engrams:\n  - id: ENG-X\n    statement: zebra-secret statement text\n   bad: [indent\n')
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    const client = await connect(new Plur({ path: s.home }))
    const r = await call(client, 'plur_status')
    expect(r.raw.isError, r.text).not.toBe(true)
    expect(r.text).not.toContain('zebra-secret')
    expect(r.json?.store_errors?.engrams).toMatch(/YAMLException|bad indentation|line \d+/)
  })

  it('plur_stores_list on an unparsable engrams.yaml, from an off folder, quotes no lines of it', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'engrams.yaml'), 'engrams:\n  - id: ENG-X\n    statement: zebra-secret statement text\n   bad: [indent\n')
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace) // an `off` folder; stores_list is an ungated admin tool
    const client = await connect(new Plur({ path: s.home }))
    const r = await call(client, 'plur_stores_list')
    expect(r.text).not.toContain('zebra-secret')
    expect(r.text).not.toMatch(/\n\s*\d+ \|/)
  })

  it('a client without listChanged gets its own roots request per call, so a workspace switch is never shared', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.other)
    // request 0 answers slowly with the old workspace (on); the client then switches to the off one
    const sc = await connectScripted(s.plur, async (i) => { if (i === 0) { await sleep(300); return [s.other] } return [s.workspace] }, { listChanged: false })
    const a = call(sc.client, 'plur_recall', { query: 'zebra-local-fact deploy target' })
    await sleep(50)
    const b = await call(sc.client, 'plur_learn', { statement: 'zebra-switch learning', scope: 'global' })
    expectOffAnswer(b, s.workspace)
    await a // the first call is legitimately in the old (on) workspace
    expect(sc.requests()).toBe(2)
    expect(readFileSync(join(s.home, 'engrams.yaml'), 'utf8')).not.toContain('zebra-switch')
  })
})
