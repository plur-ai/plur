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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { getToolDefinitions } from '../src/tools.js'
import { FOLDER_GATED_TOOLS } from '../src/folder-gate.js'
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

  it('every gated tool exists, and the admin/diagnostic tools are not gated', () => {
    const names = new Set(getToolDefinitions('full').map(t => t.name))
    for (const n of FOLDER_GATED_TOOLS) expect(names.has(n), n).toBe(true)
    for (const n of ['plur_status', 'plur_doctor', 'plur_stores_list', 'plur_stores_add', 'plur_sync_status', 'plur_receipt']) {
      expect(FOLDER_GATED_TOOLS.has(n), n).toBe(false)
    }
    for (const n of ['plur_learn', 'plur_learn_batch', 'plur_recall', 'plur_recall_hybrid', 'plur_inject', 'plur_inject_hybrid',
      'plur_capture', 'plur_feedback', 'plur_session_start', 'plur_session_end', 'plur_forget']) {
      expect(FOLDER_GATED_TOOLS.has(n), n).toBe(true)
    }
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
