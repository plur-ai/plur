/**
 * Property: an unscoped save reaches a team ONLY when every workspace input
 * agrees on that team (#1562, review round 2 of #1563).
 *
 * The inputs are all of the client's roots — none left out — or, with no
 * roots, the server's start folder. Each resolves (realpath first) to its
 * folder-map scope, else a trusted `.plur.yaml`'s for that folder. A root
 * with no scope, the home folder, a folder above it, `/`, or two different
 * scopes: no scope at all, and the save stays on this machine. No later
 * fallback (the start folder's `.plur.yaml`, a process slot) brings a team
 * back.
 *
 * Enumerates root combinations (none, personal, team A, team B, home, `/`,
 * nested, symlinked) × session paths (no session, plur_session_start, and a
 * session started in team A whose roots then change). In-process server,
 * stub team store with both team scopes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { pathToFileURL } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { _resetSessionTelemetry } from '../src/tools.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'scope-property-token'
const A = 'group:test/eng'
const B = 'group:test/ops'

let stub: StubServer
let baseUrl: string
const dirs: string[] = []
let clients: Client[] = []

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

type Kind = 'personal' | 'teamA' | 'teamB' | 'home' | 'root' | 'nestedB' | 'linkPersonal' | 'yamlA'
/** What each input means on its own: a team, or null (no scope, or never a scope). */
const MEANS: Record<Kind, string | null> = {
  personal: null, teamA: A, teamB: B, home: null, root: null, nestedB: B, linkPersonal: null, yamlA: A,
}
const KINDS = Object.keys(MEANS) as Kind[]

interface World { plur: Plur; home: string; path: Record<Kind, string> }

function world(): World {
  const home = tmp('plur-prop-home-')
  writeFileSync(join(home, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${A}"\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${B}"\n`)
  const personal = tmp('plur-prop-personal-')
  const teamA = tmp('plur-prop-a-')
  const teamB = tmp('plur-prop-b-')
  const nestedB = join(teamA, 'sub-b')
  mkdirSync(nestedB)
  // A link inside team A's folder that points at the personal folder: it
  // gets the personal folder's decision, not team A's .plur.yaml.
  const yamlA = tmp('plur-prop-yaml-a-')
  writeFileSync(join(yamlA, '.plur.yaml'), `scope: ${A}\n`)
  const linkPersonal = join(yamlA, 'link-personal')
  symlinkSync(personal, linkPersonal)
  writeFileSync(join(home, 'folders.yaml'), [
    'version: 1', 'folders:',
    `  - path: "${personal}"`, '    plur: on',
    `  - path: "${teamA}"`, `    scope: ${A}`,
    `  - path: "${teamB}"`, `    scope: ${B}`,
    `  - path: "${nestedB}"`, `    scope: ${B}`,
    `  - path: "${yamlA}"`, '    trusted: true',
    '',
  ].join('\n'))
  return {
    plur: new Plur({ path: home }),
    home,
    path: { personal, teamA, teamB, home: homedir(), root: '/', nestedB, linkPersonal, yamlA },
  }
}

interface Conn { client: Client; setRoots(r: string[] | null): Promise<void> }

async function connect(w: World, roots: string[] | null): Promise<Conn> {
  const server = await createServer(w.plur, { profile: 'full' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  let current = roots
  const client = new Client({ name: 'scope-property', version: '1.0.0' }, current ? { capabilities: { roots: { listChanged: true } } } : undefined)
  if (current) client.setRequestHandler('roots/list' as any, async () => ({ roots: (current ?? []).map(r => ({ uri: pathToFileURL(r).href, name: 'ws' })) }))
  await client.connect(ct)
  clients.push(client)
  return {
    client,
    async setRoots(r) {
      current = r
      await (client as any).notification({ method: 'notifications/roots/list_changed' })
      await new Promise(res => setTimeout(res, 20))
    },
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const raw = await client.callTool({ name, arguments: args }, { timeout: 120_000 })
  return JSON.parse((raw.content as any)[0].text)
}

/** The team every input agrees on, or null. */
function agreed(kinds: Kind[]): string | null {
  const m = kinds.map(k => MEANS[k])
  return m.length > 0 && m[0] !== null && m.every(x => x === m[0]) ? m[0] : null
}

let seq = 0
async function save(c: Conn): Promise<{ statement: string; r: any; team: string | null }> {
  const statement = `zebra-prop-${++seq} a note made in this workspace`
  const r = await call(c.client, 'plur_learn', { statement })
  const team = stub.appendStatements.includes(statement) ? (r.scope as string) : null
  return { statement, r, team }
}

/**
 * Every MCP tool that writes a NEW engram with no scope given (#1563 review
 * round 3, N1): each must reach a team only when the workspace agrees. Returns
 * the team each delivered to (null: none). plur_session_end goes last: it ends
 * the session.
 */
async function saveAll(c: Conn): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  const delivered = (needle: string) => stub.appendStatements.some(x => x.includes(needle))
  const n = ++seq
  const l = await call(c.client, 'plur_learn', { statement: `zebra-all-${n} learn note` })
  out.plur_learn = delivered(`zebra-all-${n} learn note`) ? l.scope : null
  await call(c.client, 'plur_learn_batch', { engrams: [{ statement: `zebra-all-${n} batch note` }] })
  out.plur_learn_batch = delivered(`zebra-all-${n} batch note`) ? 'team' : null
  const ep = await call(c.client, 'plur_capture', { summary: `zebra-all-${n} episode note about the deploy` })
  const e2e = await call(c.client, 'plur_episode_to_engram', { episode_id: ep.id })
  out.plur_episode_to_engram = delivered(`zebra-all-${n} episode note`) ? (e2e.scope ?? 'team') : null
  await call(c.client, 'plur_ingest', { content: `Always run zebra-all-${n} ingest checks before every deploy.` })
  out.plur_ingest = delivered(`zebra-all-${n} ingest`) ? 'team' : null
  await call(c.client, 'plur_session_end', { summary: 'zebra property end', engram_suggestions: [{ statement: `zebra-all-${n} end note` }] })
  out.plur_session_end = delivered(`zebra-all-${n} end note`) ? 'team' : null
  return out
}

/** The failures of saveAll's result against the team every input agrees on. ingest always saves to `global`. */
function judge(label: string, got: Record<string, string | null>, want: string | null): string[] {
  const f: string[] = []
  for (const [tool, team] of Object.entries(got)) {
    const w = tool === 'plur_ingest' ? null : want
    if ((team !== null) !== (w !== null) || (team !== null && team !== 'team' && team !== w)) f.push(`${label}: ${tool} reached ${team}, want ${w}`)
  }
  return f
}

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  baseUrl = (await stub.start()).url
})
afterAll(async () => {
  await stub.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
beforeEach(() => {
  stub.reset()
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [A, B] })
  _resetSessionTelemetry()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.map(c => c.close().catch(() => {})))
  clients = []
})

const singles: Kind[][] = KINDS.map(k => [k])
const pairs: Kind[][] = KINDS.flatMap((a, i) => KINDS.slice(i).map(b => [a, b] as Kind[]))
const combos: Kind[][] = [...singles, ...pairs]

describe('a team delivery happens only when every workspace input agrees on that team (#1563 review round 2)', () => {
  it('roots × no session, plur_session_start, and a session started in team A whose roots then change', async () => {
    const w = world()
    // The server's start folder is a team-A folder throughout: it must never
    // decide anything when the client gives roots.
    vi.spyOn(process, 'cwd').mockReturnValue(w.path.yamlA)
    const failures: string[] = []
    for (const kinds of combos) {
      const roots = kinds.map(k => w.path[k])
      const want = agreed(kinds)
      // A fresh team store per combination: the stub keeps what it was sent,
      // and its stored rows (no tags) are not what this test is about.
      stub.reset()
      stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [A, B] })
      // 1. No session.
      _resetSessionTelemetry()
      const c1 = await connect(w, roots)
      failures.push(...judge(`${kinds}: no session`, await saveAll(c1), want))
      // 2. plur_session_start, then save.
      _resetSessionTelemetry()
      const c2 = await connect(w, roots)
      const st = await call(c2.client, 'plur_session_start', { task: 'zebra property' })
      if ((st.default_scope ?? null) !== want) failures.push(`${kinds}: session_start default ${st.default_scope}, want ${want} (${JSON.stringify(st).slice(0, 200)})`)
      failures.push(...judge(`${kinds}: after session_start`, await saveAll(c2), want))
      // 3. A session started in team A; the roots then change to these.
      _resetSessionTelemetry()
      const c3 = await connect(w, [w.path.teamA])
      await call(c3.client, 'plur_session_start', { task: 'zebra property start in A' })
      await c3.setRoots(roots)
      failures.push(...judge(`${kinds}: started in A, roots changed`, await saveAll(c3), want))
      for (const c of clients.splice(0)) await c.close().catch(() => {})
    }
    expect(failures).toEqual([])
  }, 300_000)

  it('observes episode delivery after the background push completes (#1584)', async () => {
    const w = world()
    const fetch = globalThis.fetch
    // Delay the transport before the stub sees the request. Other save tools
    // await their remote write; episode promotion deliberately queues its push.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(baseUrl) && args[1]?.method === 'POST') {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return fetch(...args)
    })
    const c = await connect(w, [w.path.teamA])
    expect(judge('delayed remote', await saveAll(c), A)).toEqual([])
  }, 30_000)

  it('no roots: the start folder alone decides, by the same rule', async () => {
    const w = world()
    const failures: string[] = []
    for (const k of KINDS) {
      vi.spyOn(process, 'cwd').mockReturnValue(w.path[k])
      _resetSessionTelemetry()
      const c = await connect(w, null)
      const s = await save(c)
      // home and / are never asked about, and never give a scope.
      const want = MEANS[k]
      if (s.r.plur && s.r.plur !== 'on') {
        if (want !== null) failures.push(`${k}: gate said ${s.r.plur}`)
      } else if (s.team !== want) failures.push(`${k}: team ${s.team}, want ${want}`)
      for (const cl of clients.splice(0)) await cl.close().catch(() => {})
      vi.restoreAllMocks()
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('an explicit scope still wins, and so does plur_session_scope set, whatever the roots', async () => {
    const w = world()
    vi.spyOn(process, 'cwd').mockReturnValue(w.path.yamlA)
    const c = await connect(w, [w.path.teamA, w.path.teamB])
    const explicit = await call(c.client, 'plur_learn', { statement: 'zebra-prop-explicit', scope: A })
    expect(explicit.scope).toBe(A)
    expect(stub.appendStatements).toContain('zebra-prop-explicit')
    const st = await call(c.client, 'plur_session_start', { task: 'zebra set' })
    expect(st.default_scope ?? null).toBeNull()
    await call(c.client, 'plur_session_scope', { op: 'set', scope: B })
    await c.setRoots([w.path.personal])
    const r = await call(c.client, 'plur_learn', { statement: 'zebra-prop-set' })
    expect(r.scope).toBe(B)
    // Cleared: back to the start default, which the current roots replace.
    await call(c.client, 'plur_session_scope', { op: 'clear' })
    const after = await call(c.client, 'plur_learn', { statement: 'zebra-prop-cleared' })
    expect(after.scope).not.toBe(A)
    expect(after.scope).not.toBe(B)
  }, 60_000)

  it('an unregistered session id gives no default (Codex path 6)', async () => {
    const w = world()
    vi.spyOn(process, 'cwd').mockReturnValue(w.path.yamlA)
    // The process slot holds a team (as a "yes" in a team folder may set it).
    w.plur.setSessionScope(A)
    const c = await connect(w, [w.path.personal])
    const r = await call(c.client, 'plur_learn', { statement: 'zebra-prop-unregistered', session_id: 'never-started' })
    expect(r.scope).not.toBe(A)
    expect(stub.appendStatements).not.toContain('zebra-prop-unregistered')
  }, 60_000)

  // N1: the process-wide default scope (set by plur_session_start and the
  // folder question's "yes" on main) outlived the session and the roots.
  it('after a session in team A ends and the roots change, an episode promoted with no scope reaches no team', async () => {
    const w = world()
    vi.spyOn(process, 'cwd').mockReturnValue(w.path.yamlA)
    const c = await connect(w, [w.path.teamA])
    await call(c.client, 'plur_session_start', { task: 'zebra n1' })
    const ep = await call(c.client, 'plur_capture', { summary: 'zebra-n1 episode about the release' })
    await call(c.client, 'plur_session_end', { summary: 'done', engram_suggestions: [] })
    await c.setRoots([w.path.personal])
    await call(c.client, 'plur_episode_to_engram', { episode_id: ep.id })
    expect(stub.appendStatements.some(x => x.includes('zebra-n1'))).toBe(false)
    expect(w.plur.getSessionScope()).toBeNull()
  }, 60_000)

  // L8: a start default is re-checked against the workspace's current answer,
  // not only its roots: a map edit with the same roots drops it.
  it('a session started in team A whose map entry loses its scope (same roots) reaches no team', async () => {
    const w = world()
    vi.spyOn(process, 'cwd').mockReturnValue(w.path.yamlA)
    const c = await connect(w, [w.path.teamA])
    const st = await call(c.client, 'plur_session_start', { task: 'zebra l8' })
    expect(st.default_scope).toBe(A)
    writeFileSync(join(w.home, 'folders.yaml'), readFileSync(join(w.home, 'folders.yaml'), 'utf8').replace(`  - path: "${w.path.teamA}"\n    scope: ${A}`, `  - path: "${w.path.teamA}"\n    plur: on`))
    const s = await save(c)
    expect(s.team).toBeNull()
  }, 60_000)
})
