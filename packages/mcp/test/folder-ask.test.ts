/**
 * The MCP server asks the folder question in an undecided folder (#1525).
 *
 * #1519 made the MCP server honour the folder map's `off`; an undecided folder
 * (`ask`) still ran memory. Now, in a workspace whose folder resolves to
 * `ask`, every memory tool touches no memory and answers — without an error —
 * with the folder question: one command per answer, each carrying its own
 * nonce issued by core, bound to this MCP session. The same question (same
 * nonces) comes back on every gated call until the user answers; the next
 * call after an answer follows it. "Not now" turns memory off for the rest of
 * this MCP session without writing the folder map. A broken folder map fails
 * safe with no commands; admin tools are unchanged; off > ask > on.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur, FOLDER_NONCE_TTL_MS, sweepFolderNonces } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'folder-ask-token'
const SCOPE = 'group:test'
const LOCAL_FACT = 'zebra-local-fact the deploy target is the blue cluster'

let stub: StubServer
let baseUrl: string
let hits: string[] = []
const dirs: string[] = []
let clients: Client[] = []
let servers: Array<{ close(): Promise<void> }> = []

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

/** sha256 of every file under `root` except the folder-question nonces (not memory). */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const rel = relative(root, p)
      if (rel === 'folder-nonces' || rel.startsWith('.folders') || rel.endsWith('.lock')) continue
      if (statSync(p).isDirectory()) walk(p)
      else out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(root)
  return out
}

interface Setup { home: string; plur: Plur; workspace: string; onDir: string; offDir: string }

/** A throwaway PLUR home with one local engram and the stub as a team store; `workspace` is undecided. */
async function setup(): Promise<Setup> {
  const home = tmp('plur-mcp-ask-home-')
  writeFileSync(
    join(home, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`,
  )
  const plur = new Plur({ path: home })
  await plur.learn(LOCAL_FACT, { scope: 'global' })
  const workspace = tmp('plur-mcp-ask-ws-')
  const onDir = tmp('plur-mcp-ask-on-')
  const offDir = tmp('plur-mcp-ask-off-')
  writeFileSync(
    join(home, 'folders.yaml'),
    `version: 1\nfolders:\n  - path: "${onDir}"\n    plur: on\n  - path: "${offDir}"\n    plur: off\n`,
  )
  return { home, plur, workspace, onDir, offDir }
}

async function connect(plur: Plur, opts: { roots?: string[]; profile?: 'full' | 'lean' } = {}): Promise<Client> {
  const server = await createServer(plur, { profile: opts.profile ?? 'full' })
  servers.push(server as any)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: 'folder-ask-test', version: '1.0.0' },
    opts.roots ? { capabilities: { roots: { listChanged: true } } } : undefined,
  )
  if (opts.roots) {
    const roots = opts.roots
    client.setRequestHandler('roots/list', async () => ({ roots: roots.map(r => ({ uri: pathToFileURL(r).href, name: 'ws' })) }))
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

/** The pieces of an offered `plur folders set` command. */
function parse(command: string): { folder: string; flags: string[]; nonce: string; session: string } {
  const m = /folders set (\S+) (.+?) --nonce ([0-9a-f]+) --session (\S+)$/.exec(command)
  if (!m) throw new Error(`not a folder answer command: ${command}`)
  return { folder: m[1], flags: m[2].split(' '), nonce: m[3], session: m[4] }
}

function answer(json: any, kind: RegExp): string {
  const a = (json.answers as Array<{ label: string; command: string }>).find(x => kind.test(x.label))
  if (!a) throw new Error(`no answer matching ${kind}: ${JSON.stringify(json.answers)}`)
  return a.command
}

/** What `plur folders set` does with an offered command, run through core (the CLI calls the same). */
function run(plur: Plur, command: string, session?: string): void {
  const c = parse(command)
  const s = session === undefined ? c.session : session
  const opts = { nonce: c.nonce, ...(s ? { session: s } : {}) }
  if (c.flags[0] === '--not-now') return (plur as any).notNowFolder(c.folder, opts)
  const change = c.flags[0] === '--scope' ? { scope: c.flags[1] } : c.flags[0] === '--trusted' ? { trusted: true } : { mode: c.flags[0].slice(2) as 'on' | 'off' }
  plur.setFolder(c.folder, change, opts)
}

function expectAsk(r: { raw: any; json: any; text: string }, folder: string): void {
  expect(r.raw.isError, r.text).not.toBe(true)
  expect(r.json?.plur, r.text).toBe('ask')
  expect(r.json?.success).toBe(true)
  expect(r.json?.folder).toBe(folder)
  expect(typeof r.json?.question).toBe('string')
  expect(Array.isArray(r.json?.answers)).toBe(true)
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
  stub.recallRows = []
  hits = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(clients.map(c => c.close().catch(() => {})))
  clients = []
  servers = []
})

describe('MCP memory tools in an undecided (`ask`) folder', () => {
  it('plur_learn asks the folder question and touches no memory', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const before = snapshot(s.home)
    hits = []
    const r = await call(client, 'plur_learn', { statement: 'zebra-new learning', scope: 'global' })
    expectAsk(r, s.workspace)
    expect(snapshot(s.home)).toEqual(before)
    expect(hits).toEqual([])
    expect(await s.plur.outboxCount()).toBe(0)
  })

  it('recall returns no engram text and does not dial the remote', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    hits = []
    for (const tool of ['plur_recall', 'plur_recall_hybrid', 'plur_inject', 'plur_session_start']) {
      const args = tool === 'plur_inject' || tool === 'plur_session_start' ? { task: 'zebra deploy target' } : { query: 'zebra deploy target', scope: SCOPE }
      const r = await call(client, tool, args)
      expectAsk(r, s.workspace)
    }
    expect(stub.recallCalls).toBe(0)
    expect(hits).toEqual([])
  })

  it('offers yes (with the suggested scope), not now and never here, each with its own nonce bound to this session', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_learn', { statement: 'zebra-x' })
    expectAsk(r, s.workspace)
    const answers = r.json.answers as Array<{ label: string; command: string }>
    const labels = answers.map(a => a.label).join(' | ')
    expect(labels).toMatch(/Yes/)
    expect(labels).toMatch(/Not now/)
    expect(labels).toMatch(/Never here/)
    const yes = parse(answer(r.json, /^Yes/))
    expect(yes.flags).toEqual(['--scope', SCOPE])
    expect(parse(answer(r.json, /^Not now/)).flags).toEqual(['--not-now'])
    expect(parse(answer(r.json, /^Never here/)).flags).toEqual(['--off'])
    const parsed = answers.map(a => parse(a.command))
    expect(new Set(parsed.map(p => p.nonce)).size).toBe(answers.length)
    expect(new Set(parsed.map(p => p.session)).size).toBe(1)
    expect(parsed[0].session).toMatch(/^mcp-[0-9a-f]+$/)
    expect(r.json.question).toContain(parsed[0].nonce)
  })

  it('the same question, with the same nonces, on every gated call until answered (also through plur_admin)', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const a = await call(client, 'plur_learn', { statement: 'zebra-a' })
    const b = await call(client, 'plur_recall', { query: 'zebra' })
    expectAsk(a, s.workspace)
    expectAsk(b, s.workspace)
    expect(b.json.answers).toEqual(a.json.answers)
    expect(b.json.question).toBe(a.json.question)
    // Through plur_admin (lean profile): the same question as that session's direct calls.
    const lean = await connect(s.plur, { profile: 'lean' })
    const d = await call(lean, 'plur_recall', { query: 'zebra' })
    const e = await call(lean, 'plur_admin', { action: 'plur_timeline', args: {} })
    expectAsk(d, s.workspace)
    expectAsk(e, s.workspace)
    expect(e.json.answers).toEqual(d.json.answers)
    // One nonce per answer in each session's nonce file, not one per call.
    const nonceFiles = readdirSync(join(s.home, 'folder-nonces'))
    expect(nonceFiles).toHaveLength(2)
    for (const f of nonceFiles) {
      const nonces = readFileSync(join(s.home, 'folder-nonces', f), 'utf8').match(/nonce: \S+/g) ?? []
      expect(nonces).toHaveLength(a.json.answers.length)
    }
  })

  it('yes: the next call runs memory, with the answer\'s scope as this session\'s default write scope', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_recall', { query: 'zebra' })
    run(s.plur, answer(q.json, /^Yes/))
    const r = await call(client, 'plur_recall', { query: 'zebra deploy target', scope: 'global' })
    expect(r.json?.plur, r.text).toBeUndefined()
    expect(r.text).toContain('zebra-local-fact')
    expect(s.plur.getSessionScope()).toBe(SCOPE)
  })

  it('yes with a scope: a plur_session_start after the answer keeps that scope as the session default', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_session_start', { task: 'zebra deploy' })
    expectAsk(q, s.workspace)
    run(s.plur, answer(q.json, /^Yes/))
    const r = await call(client, 'plur_session_start', { task: 'zebra deploy' })
    expect(r.json?.plur, r.text).toBeUndefined()
    expect(r.json?.default_scope).toBe(SCOPE)
    expect(r.json?.scope_source).toBe('folder-map')
    expect(s.plur.getSessionScope({ session: r.json.session_id })).toBe(SCOPE)
    // An explicit default_scope still wins.
    const explicit = await call(client, 'plur_session_start', { task: 'x', default_scope: 'global' })
    expect(explicit.json?.default_scope).toBe('global')
    // A folder decided before the session (not asked here) gets its map scope too.
    const later = await connect(s.plur)
    const fresh = await call(later, 'plur_session_start', { task: 'zebra deploy' })
    expect(fresh.json?.default_scope).toBe(SCOPE)
  })

  it('yes without a team scope (--on): memory on', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_recall', { query: 'zebra' })
    const on = (q.json.answers as Array<{ command: string }>).map(a => a.command).find(c => / --on /.test(c))!
    run(s.plur, on)
    const r = await call(client, 'plur_recall', { query: 'zebra deploy target', scope: 'global' })
    expect(r.json?.plur, r.text).toBeUndefined()
    expect(r.text).toContain('zebra-local-fact')
  })

  it('never here: the next call gets the off answer', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    run(s.plur, answer(q.json, /^Never here/))
    const r = await call(client, 'plur_learn', { statement: 'zebra-b' })
    expect(r.json?.plur, r.text).toBe('off')
    expect(r.json?.folder).toBe(s.workspace)
  })

  it('a folder answered and then undecided again gets a fresh question, not one whose nonce was used', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    run(s.plur, answer(q.json, /^Never here/))
    expect((await call(client, 'plur_learn', { statement: 'zebra-b' })).json?.plur).toBe('off')
    s.plur.removeFolder(s.workspace)
    const again = await call(client, 'plur_learn', { statement: 'zebra-c' })
    expectAsk(again, s.workspace)
    expect(again.json.answers).not.toEqual(q.json.answers)
    run(s.plur, answer(again.json, /^Never here/))
    expect((await call(client, 'plur_learn', { statement: 'zebra-d' })).json?.plur).toBe('off')
  })

  it('a nonce redeemed from another session, or naming none, is refused and writes nothing', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    const yes = answer(q.json, /^Yes/)
    const map = readFileSync(join(s.home, 'folders.yaml'), 'utf8')
    expect(() => run(s.plur, yes, 'mcp-another-session')).toThrow(/another session/)
    expect(() => run(s.plur, yes, '')).toThrow(/another session/)
    expect(readFileSync(join(s.home, 'folders.yaml'), 'utf8')).toBe(map)
    // Still asking, and the right session's command still works.
    expectAsk(await call(client, 'plur_learn', { statement: 'zebra-b' }), s.workspace)
    run(s.plur, yes)
    expect((await call(client, 'plur_recall', { query: 'zebra', scope: 'global' })).json?.plur).toBeUndefined()
  })

  it('a nonce of another MCP session is refused for this one', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const one = await connect(s.plur)
    const two = await connect(s.plur)
    const q1 = await call(one, 'plur_learn', { statement: 'zebra-a' })
    const q2 = await call(two, 'plur_learn', { statement: 'zebra-a' })
    const s1 = parse(answer(q1.json, /^Yes/)).session
    const s2 = parse(answer(q2.json, /^Yes/)).session
    expect(s1).not.toBe(s2)
    expect(() => run(s.plur, answer(q1.json, /^Yes/), s2)).toThrow(/another session/)
  })

  it('not now: off for the rest of this session, no question again, the folder map untouched', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    const map = readFileSync(join(s.home, 'folders.yaml'), 'utf8')
    const before = snapshot(s.home)
    run(s.plur, answer(q.json, /^Not now/))
    expect(readFileSync(join(s.home, 'folders.yaml'), 'utf8')).toBe(map)
    for (const [tool, args] of [['plur_learn', { statement: 'zebra-b' }], ['plur_recall', { query: 'zebra' }], ['plur_session_start', { task: 'x' }]] as const) {
      const r = await call(client, tool, args as any)
      expect(r.raw.isError, r.text).not.toBe(true)
      expect(r.json?.plur, r.text).toBe('off')
      expect(r.json?.reason).toBe('not-now')
      expect(r.json?.answers).toBeUndefined()
      expect(r.text).not.toContain('--nonce')
    }
    expect(snapshot(s.home)).toEqual(before)
    // The folder stays undecided: another session asks again.
    const other = await connect(s.plur)
    expectAsk(await call(other, 'plur_learn', { statement: 'zebra-c' }), s.workspace)
  })

  it('a repo .plur.yaml asking for settings not yet trusted: the question offers trust, and trust turns memory on', async () => {
    const s = await setup()
    writeFileSync(join(s.workspace, '.plur.yaml'), `scope: ${SCOPE}\n`)
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    expectAsk(q, s.workspace)
    expect(q.json.question).toContain('.plur.yaml is not trusted')
    const trust = answer(q.json, /^Yes, and trust/)
    expect(parse(trust).flags).toEqual(['--trusted'])
    run(s.plur, trust)
    const r = await call(client, 'plur_recall', { query: 'zebra deploy target', scope: 'global' })
    expect(r.json?.plur, r.text).toBeUndefined()
  })

  it('a broken folders.yaml fails safe: off, names the problem, offers no command, issues no nonce', async () => {
    const s = await setup()
    writeFileSync(join(s.home, 'folders.yaml'), 'version: 1\nfolders: [unclosed\n')
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_learn', { statement: 'zebra-a' })
    expect(r.json?.plur, r.text).toBe('off')
    expect(r.json?.reason).toBe('folder-map-unreadable')
    expect(r.json?.answers).toBeUndefined()
    expect(r.text).not.toContain('--nonce')
    expect(existsSync(join(s.home, 'folder-nonces'))).toBe(false)
  })

  it('admin tools are unchanged in an ask folder', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    for (const tool of ['plur_status', 'plur_stores_list', 'plur_packs_list']) {
      const r = await call(client, tool)
      expect(r.json?.plur, `${tool}: ${r.text}`).toBeUndefined()
    }
  })

  it('precedence: off > ask > on across the workspace folders', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.onDir)
    const offAndAsk = await connect(s.plur, { roots: [s.workspace, s.offDir] })
    expect((await call(offAndAsk, 'plur_learn', { statement: 'zebra-a' })).json?.plur).toBe('off')
    const askAndOn = await connect(s.plur, { roots: [s.onDir, s.workspace] })
    expectAsk(await call(askAndOn, 'plur_learn', { statement: 'zebra-a' }), s.workspace)
    const onOnly = await connect(s.plur, { roots: [s.onDir] })
    expect((await call(onOnly, 'plur_recall', { query: 'zebra', scope: 'global' })).json?.plur).toBeUndefined()
  })

  it('a filesystem root (where some clients start MCP servers) is never asked about', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue('/')
    const client = await connect(s.plur)
    const r = await call(client, 'plur_recall', { query: 'zebra', scope: 'global' })
    expect(r.json?.plur, r.text).toBeUndefined()
  })

  it('a workspace that cannot be fetched stays fail-closed', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.onDir)
    const server = await createServer(s.plur, { profile: 'full' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 't', version: '1' }, { capabilities: { roots: { listChanged: true } } })
    client.setRequestHandler('roots/list', async () => { throw new Error('no roots today') })
    await client.connect(ct)
    clients.push(client)
    const r = await call(client, 'plur_learn', { statement: 'zebra-a' })
    expect(r.json?.plur).toBe('off')
    expect(r.json?.reason).toBe('workspace-unknown')
  })

  it('the session\'s unanswered nonces are deleted when the connection closes', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    expectAsk(q, s.workspace)
    expect(readdirSync(join(s.home, 'folder-nonces'))).toHaveLength(1)
    await client.close()
    await new Promise(r => setTimeout(r, 20))
    const left = existsSync(join(s.home, 'folder-nonces')) ? readdirSync(join(s.home, 'folder-nonces')) : []
    expect(left).toHaveLength(0)
    expect(() => run(s.plur, answer(q.json, /^Yes/))).toThrow(/Unknown or already-used/)
  })
})

describe('the server\'s own folder (audit F2 of #1529)', () => {
  it('with roots, the server\'s cwd is not asked about: started in the home folder, root an `on` project → memory runs', async () => {
    const s = await setup()
    const fakeHome = tmp('plur-mcp-ask-fakehome-')
    vi.stubEnv('HOME', fakeHome)
    vi.spyOn(process, 'cwd').mockReturnValue(fakeHome)
    const client = await connect(s.plur, { roots: [s.onDir] })
    const r = await call(client, 'plur_recall', { query: 'zebra deploy target', scope: 'global' })
    expect(r.json?.plur, r.text).toBeUndefined()
    expect(r.text).toContain('zebra-local-fact')
    expect(r.text).not.toContain(fakeHome)
  })

  it('with roots, an undecided cwd is not asked about either (roots only)', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur, { roots: [s.onDir] })
    const r = await call(client, 'plur_recall', { query: 'zebra', scope: 'global' })
    expect(r.json?.plur, r.text).toBeUndefined()
  })

  it('with roots, an `off` cwd still turns memory off (#1519 unchanged)', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.offDir)
    const client = await connect(s.plur, { roots: [s.onDir] })
    expect((await call(client, 'plur_learn', { statement: 'zebra-a' })).json?.plur).toBe('off')
  })

  it('without roots, a client started in the home folder is not asked: memory as today', async () => {
    const s = await setup()
    const fakeHome = tmp('plur-mcp-ask-fakehome-')
    vi.stubEnv('HOME', fakeHome)
    vi.spyOn(process, 'cwd').mockReturnValue(fakeHome)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_recall', { query: 'zebra', scope: 'global' })
    expect(r.json?.plur, r.text).toBeUndefined()
    expect(existsSync(join(s.home, 'folder-nonces'))).toBe(false)
  })

  it('without roots, a folder above the home folder is not asked either', async () => {
    const s = await setup()
    const above = tmp('plur-mcp-ask-above-')
    const fakeHome = join(above, 'me')
    mkdirSync(fakeHome)
    vi.stubEnv('HOME', fakeHome)
    vi.spyOn(process, 'cwd').mockReturnValue(above)
    const client = await connect(s.plur)
    expect((await call(client, 'plur_recall', { query: 'zebra', scope: 'global' })).json?.plur).toBeUndefined()
  })

  it('without roots, an `off` home folder still turns memory off', async () => {
    const s = await setup()
    const fakeHome = tmp('plur-mcp-ask-fakehome-')
    writeFileSync(join(s.home, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${fakeHome}"\n    plur: off\n`)
    vi.stubEnv('HOME', fakeHome)
    vi.spyOn(process, 'cwd').mockReturnValue(fakeHome)
    const client = await connect(s.plur)
    expect((await call(client, 'plur_learn', { statement: 'zebra-a' })).json?.plur).toBe('off')
  })
})

describe('not now holds for the rest of the session (audit N5 of #1529)', () => {
  it('past the nonce re-issue time', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    run(s.plur, answer(q.json, /^Not now/))
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + FOLDER_NONCE_TTL_MS + 120_000)
    const r = await call(client, 'plur_learn', { statement: 'zebra-b' })
    expect(r.json?.plur, r.text).toBe('off')
    expect(r.json?.reason).toBe('not-now')
  })

  it('after the reason the folder is undecided changes', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    run(s.plur, answer(q.json, /^Not now/))
    writeFileSync(join(s.workspace, '.plur.yaml'), `scope: ${SCOPE}\n`)
    const r = await call(client, 'plur_learn', { statement: 'zebra-b' })
    expect(r.json?.plur, r.text).toBe('off')
    expect(r.json?.reason).toBe('not-now')
  })
})

describe('a folder already `on` with a map scope (audit N3 of #1529)', () => {
  it('plur_session_start defaults to the map scope, ahead of a trusted .plur.yaml, and an unscoped learn lands there', async () => {
    const s = await setup()
    const proj = tmp('plur-mcp-ask-mapscope-')
    writeFileSync(join(proj, '.plur.yaml'), 'scope: project:fromyaml\n')
    writeFileSync(join(s.home, 'folders.yaml'),
      `version: 1\nfolders:\n  - path: "${proj}"\n    plur: on\n    scope: project:frommap\n    trusted: true\n`)
    vi.spyOn(process, 'cwd').mockReturnValue(proj)
    const client = await connect(s.plur)
    const r = await call(client, 'plur_session_start', { task: 'zebra map scope' })
    expect(r.json?.default_scope, r.text).toBe('project:frommap')
    expect(r.json?.scope_source).toBe('folder-map')
    await call(client, 'plur_learn', { statement: 'zebra-mapscope unscoped learning', session_id: r.json.session_id })
    expect(readFileSync(join(s.home, 'engrams.yaml'), 'utf8')).toMatch(/zebra-mapscope[\s\S]*?scope: project:frommap|scope: project:frommap[\s\S]*?zebra-mapscope/)
  })
})

describe('a swept question is asked afresh, not read as not now (audit R2 of #1529)', () => {
  it('an unanswered question whose nonce file was swept after the lifetime is asked again', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur)
    const q = await call(client, 'plur_learn', { statement: 'zebra-a' })
    expectAsk(q, s.workspace)
    const dir = join(s.home, 'folder-nonces')
    const [f] = readdirSync(dir)
    const old = Date.now() - FOLDER_NONCE_TTL_MS - 60_000
    writeFileSync(join(dir, f), readFileSync(join(dir, f), 'utf8').replace(/issued_at: \d+/g, `issued_at: ${old}`))
    sweepFolderNonces(s.home)
    expect(existsSync(join(dir, f))).toBe(false)
    const r = await call(client, 'plur_learn', { statement: 'zebra-b' })
    expectAsk(r, s.workspace)
    expect(r.json.answers).not.toEqual(q.json.answers)
  })
})

describe('roots that are not a project folder (audit N6/N7 of #1529)', () => {
  it('roots of only `/` count as no roots: an undecided start folder is asked about', async () => {
    const s = await setup()
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur, { roots: ['/'] })
    expectAsk(await call(client, 'plur_learn', { statement: 'zebra-a' }), s.workspace)
  })

  it('a root that is the home folder is not asked about; with an undecided start folder, that is asked', async () => {
    const s = await setup()
    const fakeHome = tmp('plur-mcp-ask-fakehome-')
    vi.stubEnv('HOME', fakeHome)
    vi.spyOn(process, 'cwd').mockReturnValue(s.workspace)
    const client = await connect(s.plur, { roots: [fakeHome] })
    const r = await call(client, 'plur_learn', { statement: 'zebra-a' })
    expectAsk(r, s.workspace)
    expect(r.text).not.toContain(`folders set ${fakeHome} `)
  })

  it('a root that is the home folder, started in the home folder: memory as today, no question', async () => {
    const s = await setup()
    const fakeHome = tmp('plur-mcp-ask-fakehome-')
    vi.stubEnv('HOME', fakeHome)
    vi.spyOn(process, 'cwd').mockReturnValue(fakeHome)
    const client = await connect(s.plur, { roots: [fakeHome] })
    const r = await call(client, 'plur_recall', { query: 'zebra', scope: 'global' })
    expect(r.json?.plur, r.text).toBeUndefined()
    expect(existsSync(join(s.home, 'folder-nonces'))).toBe(false)
  })

  it('a root above home is not asked about either', async () => {
    const s = await setup()
    const above = tmp('plur-mcp-ask-above-')
    const fakeHome = join(above, 'me')
    mkdirSync(fakeHome)
    vi.stubEnv('HOME', fakeHome)
    vi.spyOn(process, 'cwd').mockReturnValue(fakeHome)
    const client = await connect(s.plur, { roots: [above] })
    expect((await call(client, 'plur_recall', { query: 'zebra', scope: 'global' })).json?.plur).toBeUndefined()
  })

  it('home among real roots: only the project root is asked about', async () => {
    const s = await setup()
    const fakeHome = tmp('plur-mcp-ask-fakehome-')
    vi.stubEnv('HOME', fakeHome)
    vi.spyOn(process, 'cwd').mockReturnValue(fakeHome)
    const client = await connect(s.plur, { roots: [fakeHome, s.workspace] })
    expectAsk(await call(client, 'plur_learn', { statement: 'zebra-a' }), s.workspace)
  })
})
