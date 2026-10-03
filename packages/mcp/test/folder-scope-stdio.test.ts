/**
 * A folder's team scope reaches unscoped saves over MCP without
 * plur_session_start (#1562, finding F1 of the 0.21.1 pre-release check).
 *
 * The changelog and the README promise: after a "yes" with a team scope, or in
 * a folder already mapped to a scope, an unscoped save goes to that scope.
 * Before the fix it did only after plur_session_start; without it, the save
 * landed in `global` on this machine.
 *
 * Drives the built server (`node dist/index.js`) as a child process over
 * stdio, with a stub team store, and runs the offered answer with the built
 * CLI (`node ../cli/dist/index.js`), as an agent would in its shell.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js')
const CLI_ENTRY = join(PKG_ROOT, '..', 'cli', 'dist', 'index.js')

const TOKEN = 'folder-scope-token'
const SCOPE = 'group:test/eng'

let stub: StubServer
let baseUrl: string
const dirs: string[] = []
const live: Client[] = []

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

interface Env { home: string; fakeHome: string; workspace: string }

function env(folders?: (ws: string) => string): Env {
  const home = tmp('plur-fscope-store-')
  const fakeHome = tmp('plur-fscope-home-')
  const workspace = tmp('plur-fscope-ws-')
  writeFileSync(join(home, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`)
  if (folders) writeFileSync(join(home, 'folders.yaml'), folders(workspace))
  return { home, fakeHome, workspace }
}

const childEnv = (e: Env): Record<string, string> => ({
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  HOME: e.fakeHome,
  PLUR_PATH: e.home,
  PLUR_TOOL_PROFILE: 'full',
})

async function start(e: Env): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    cwd: e.workspace,
    stderr: 'ignore',
    env: childEnv(e),
  })
  const client = new Client({ name: 'folder-scope-stdio', version: '1.0.0' })
  await client.connect(transport)
  live.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const raw = await client.callTool({ name, arguments: args }, { timeout: 30_000 })
  const text = (raw.content as any)[0].text as string
  try { return JSON.parse(text) } catch { return { text } }
}

/** Run an offered `plur …` command with the built CLI, in a POSIX shell, as the agent would. */
function runOffered(e: Env, command: string): string {
  expect(command.startsWith('plur ')).toBe(true)
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return execFileSync('sh', ['-c', `${q(process.execPath)} ${q(CLI_ENTRY)} ${command.slice('plur '.length)}`], {
    env: childEnv(e), cwd: e.workspace, encoding: 'utf8', timeout: 30_000,
  })
}

const engramsText = (e: Env) => (existsSync(join(e.home, 'engrams.yaml')) ? readFileSync(join(e.home, 'engrams.yaml'), 'utf8') : '')

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
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [SCOPE] })
})

afterEach(async () => {
  for (const c of live.splice(0)) await c.close().catch(() => {})
})

const ready = existsSync(DIST_ENTRY) && existsSync(CLI_ENTRY)
// The offered commands are run through `sh`.
describe.skipIf(!ready || process.platform === 'win32')('a folder\'s team scope is the default for unscoped saves over MCP (#1562)', () => {
  it('yes with the team scope, then plur_learn with no scope and no plur_session_start: saved in that scope, on the team server', async () => {
    const e = env()
    const client = await start(e)
    const q = await call(client, 'plur_learn', { statement: 'zebra-before-answer not saved' })
    expect(q.plur).toBe('ask')
    const yes = (q.answers as Array<{ label: string; command: string }>).find(a => a.label === `Yes, with the team scope ${SCOPE}`)
    expect(yes, JSON.stringify(q.answers)).toBeDefined()
    runOffered(e, yes!.command)
    const r = await call(client, 'plur_learn', { statement: 'zebra-after-yes the deploy target is the blue cluster' })
    expect(r.scope, JSON.stringify(r)).toBe(SCOPE)
    expect(r.delivery).toBe('remote')
    expect(stub.appendStatements).toContain('zebra-after-yes the deploy target is the blue cluster')
    expect(engramsText(e)).not.toContain('zebra-after-yes')
  }, 60_000)

  it('a folder already mapped to the team scope: the first call, an unscoped plur_learn, goes to the team server', async () => {
    const e = env(ws => `version: 1\nfolders:\n  - path: "${ws}"\n    plur: on\n    scope: ${SCOPE}\n`)
    const client = await start(e)
    const r = await call(client, 'plur_learn', { statement: 'zebra-mapped the release train leaves on tuesday' })
    expect(r.scope, JSON.stringify(r)).toBe(SCOPE)
    expect(r.delivery).toBe('remote')
    expect(stub.appendStatements).toContain('zebra-mapped the release train leaves on tuesday')
  }, 60_000)

  it('a folder already mapped to the team scope: plur_learn_batch items with no scope go to the team server', async () => {
    const e = env(ws => `version: 1\nfolders:\n  - path: "${ws}"\n    plur: on\n    scope: ${SCOPE}\n`)
    const client = await start(e)
    const r = await call(client, 'plur_learn_batch', { engrams: [{ statement: 'zebra-batch staging uses the green cluster' }] })
    expect(stub.appendStatements, JSON.stringify(r)).toContain('zebra-batch staging uses the green cluster')
    expect(engramsText(e)).not.toContain('zebra-batch')
  }, 60_000)

  it('an explicit scope still wins over the folder scope', async () => {
    const e = env(ws => `version: 1\nfolders:\n  - path: "${ws}"\n    plur: on\n    scope: ${SCOPE}\n`)
    const client = await start(e)
    const r = await call(client, 'plur_learn', { statement: 'zebra-explicit my own editor preference', scope: 'global' })
    expect(r.scope).toBe('global')
    expect(r.delivery).toBe('local')
    expect(stub.appendStatements).not.toContain('zebra-explicit my own editor preference')
    expect(engramsText(e)).toContain('zebra-explicit')
  }, 60_000)

  it('the plur_session_start path still gives the folder scope', async () => {
    const e = env(ws => `version: 1\nfolders:\n  - path: "${ws}"\n    plur: on\n    scope: ${SCOPE}\n`)
    const client = await start(e)
    const s = await call(client, 'plur_session_start', { task: 'zebra session' })
    expect(s.default_scope).toBe(SCOPE)
    expect(s.scope_source).toBe('folder-map')
    const r = await call(client, 'plur_learn', { statement: 'zebra-session the canary runs before every deploy' })
    expect(r.scope).toBe(SCOPE)
    expect(r.delivery).toBe('remote')
  }, 60_000)

  it('a session started with another default keeps it: the folder scope only fills a gap', async () => {
    const e = env(ws => `version: 1\nfolders:\n  - path: "${ws}"\n    plur: on\n    scope: ${SCOPE}\n`)
    const client = await start(e)
    const s = await call(client, 'plur_session_start', { task: 'zebra session', default_scope: 'global' })
    expect(s.default_scope).toBe('global')
    const r = await call(client, 'plur_learn', { statement: 'zebra-own-default a personal note' })
    expect(r.scope).toBe('global')
    expect(stub.appendStatements).not.toContain('zebra-own-default a personal note')
  }, 60_000)

  it('off and undecided folders still touch no memory', async () => {
    const off = env(ws => `version: 1\nfolders:\n  - path: "${ws}"\n    plur: off\n    scope: ${SCOPE}\n`)
    const c1 = await start(off)
    expect((await call(c1, 'plur_learn', { statement: 'zebra-off nothing' })).plur).toBe('off')
    const ask = env()
    const c2 = await start(ask)
    expect((await call(c2, 'plur_learn', { statement: 'zebra-ask nothing' })).plur).toBe('ask')
    expect(stub.appendStatements).toEqual([])
    expect(engramsText(off)).not.toContain('zebra-off')
    expect(engramsText(ask)).not.toContain('zebra-ask')
  }, 60_000)
})

// Review round 1 of #1563 (H1): in a multi-root workspace the folder scope
// was the first root's that had one, so a save went to a team the client
// happened to list first. A scope is attached only when every root agrees.
const SCOPE2 = 'group:test/ops'

describe.skipIf(!ready)('multi-root workspaces: a folder scope only when every root agrees (#1563 review, H1)', () => {
  function multi(map: (a: string, b: string) => string): Env & { a: string; b: string } {
    const home = tmp('plur-fscope-store-')
    const fakeHome = tmp('plur-fscope-home-')
    const workspace = tmp('plur-fscope-ws-')
    const a = tmp('plur-fscope-a-')
    const b = tmp('plur-fscope-b-')
    writeFileSync(join(home, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE2}"\n`)
    writeFileSync(join(home, 'folders.yaml'), map(a, b))
    return { home, fakeHome, workspace, a, b }
  }

  async function startRoots(e: Env, roots: string[]): Promise<Client> {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_ENTRY], cwd: e.workspace, stderr: 'ignore', env: childEnv(e) })
    const client = new Client({ name: 'folder-scope-roots', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } })
    client.setRequestHandler('roots/list' as any, async () => ({ roots: roots.map(r => ({ uri: pathToFileURL(r).href, name: 'ws' })) }))
    await client.connect(transport)
    live.push(client)
    return client
  }

  beforeEach(() => {
    stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [SCOPE, SCOPE2] })
  })

  it('[a root with no scope, a team root]: an unscoped save reaches no team, in either order', async () => {
    const e = multi((a, b) => `version: 1\nfolders:\n  - path: "${a}"\n    plur: on\n  - path: "${b}"\n    plur: on\n    scope: ${SCOPE}\n`)
    for (const [i, roots] of [[e.a, e.b], [e.b, e.a]].entries()) {
      const client = await startRoots(e, roots)
      const r = await call(client, 'plur_learn', { statement: `zebra-mixed-${i} a note about one of the two repos` })
      expect(r.scope, JSON.stringify(r)).not.toBe(SCOPE)
      expect(r.delivery).toBe('local')
      const s = await call(client, 'plur_session_start', { task: 'zebra mixed' })
      expect(s.default_scope ?? null).toBeNull()
    }
    expect(stub.appendStatements).toEqual([])
  }, 90_000)

  it('[team A, team B]: no team, whichever order the client lists them', async () => {
    const e = multi((a, b) => `version: 1\nfolders:\n  - path: "${a}"\n    scope: ${SCOPE2}\n  - path: "${b}"\n    scope: ${SCOPE}\n`)
    for (const [i, roots] of [[e.a, e.b], [e.b, e.a]].entries()) {
      const client = await startRoots(e, roots)
      const r = await call(client, 'plur_learn', { statement: `zebra-two-teams-${i} a note about one of the two repos` })
      expect([SCOPE, SCOPE2], JSON.stringify(r)).not.toContain(r.scope)
      expect(r.delivery).toBe('local')
      const s = await call(client, 'plur_session_start', { task: 'zebra two teams' })
      expect(s.default_scope ?? null).toBeNull()
    }
    expect(stub.appendStatements).toEqual([])
  }, 90_000)

  it('[team A, team A]: team A', async () => {
    const e = multi((a, b) => `version: 1\nfolders:\n  - path: "${a}"\n    scope: ${SCOPE}\n  - path: "${b}"\n    scope: ${SCOPE}\n`)
    const client = await startRoots(e, [e.a, e.b])
    const r = await call(client, 'plur_learn', { statement: 'zebra-same-team both repos share the eng store' })
    expect(r.scope, JSON.stringify(r)).toBe(SCOPE)
    expect(r.delivery).toBe('remote')
    expect(stub.appendStatements).toContain('zebra-same-team both repos share the eng store')
  }, 90_000)
})

// Review round 1 of #1563 (L1): with several sessions open and none named, no
// session default applies (E7), and the folder scope fills that gap. Pinned
// here so the order is a decision, not an accident.
describe.skipIf(!ready)('several sessions open, none named: the folder scope applies (#1563 review, L1)', () => {
  it('an id-less save goes to the folder scope, not to either session\'s default', async () => {
    const e = env(ws => `version: 1\nfolders:\n  - path: "${ws}"\n    plur: on\n    scope: ${SCOPE}\n`)
    const client = await start(e)
    await call(client, 'plur_session_start', { task: 'one', default_scope: 'global' })
    await call(client, 'plur_session_start', { task: 'two', default_scope: 'project:other' })
    const r = await call(client, 'plur_learn', { statement: 'zebra-ambiguous an id-less save' })
    expect(r.scope, JSON.stringify(r)).toBe(SCOPE)
  }, 60_000)
})
