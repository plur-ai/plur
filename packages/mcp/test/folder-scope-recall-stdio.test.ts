/**
 * A folder's team scope reaches unscoped READS over MCP without
 * plur_session_start (#1566, finding F4 of the second 0.21.1 pre-release
 * check) — the read-side twin of #1562.
 *
 * Since #1563 an unscoped save in a folder mapped to a team scope goes to
 * that team without plur_session_start. An unscoped recall did not: without
 * a session it searched only this machine, so an agent could not find what it
 * had just saved to the team. Reads now use the same workspace resolver
 * (workspaceWriteScope) as writes: when every workspace input agrees on one
 * team scope, an unscoped read dials that store, exactly as a session started
 * there would. Any disagreement: no team default, as before.
 *
 * Drives the built server (`node dist/index.js`) as a child process over
 * stdio, with a stub team store.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js')

const TOKEN = 'folder-scope-recall-token'
const SCOPE = 'group:test/eng'
const SCOPE2 = 'group:test/ops'
const PERSONAL = 'user:test:tester'

let stub: StubServer
let baseUrl: string
const dirs: string[] = []
const live: Client[] = []

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

interface Env { home: string; fakeHome: string; workspace: string; a: string; b: string }

function env(scopes: string[], folders: (ws: string, a: string, b: string) => string): Env {
  const home = tmp('plur-frecall-store-')
  const fakeHome = tmp('plur-frecall-home-')
  const workspace = tmp('plur-frecall-ws-')
  const a = tmp('plur-frecall-a-')
  const b = tmp('plur-frecall-b-')
  const stores = scopes.map(s => `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${s}"\n`).join('')
  writeFileSync(join(home, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n${stores}`)
  writeFileSync(join(home, 'folders.yaml'), folders(workspace, a, b))
  return { home, fakeHome, workspace, a, b }
}

const mapped = (scope: string) => (ws: string) => `version: 1\nfolders:\n  - path: "${ws}"\n    plur: on\n    scope: "${scope}"\n`

const childEnv = (e: Env): Record<string, string> => ({
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  HOME: e.fakeHome,
  PLUR_PATH: e.home,
  PLUR_TOOL_PROFILE: 'full',
})

async function start(e: Env, roots?: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    cwd: e.workspace,
    stderr: 'ignore',
    env: childEnv(e),
  })
  const client = roots
    ? new Client({ name: 'folder-scope-recall-roots', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } })
    : new Client({ name: 'folder-scope-recall', version: '1.0.0' })
  if (roots) client.setRequestHandler('roots/list' as any, async () => ({ roots: roots.map(r => ({ uri: pathToFileURL(r).href, name: 'ws' })) }))
  await client.connect(transport)
  live.push(client)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const raw = await client.callTool({ name, arguments: args }, { timeout: 30_000 })
  const text = (raw.content as any)[0].text as string
  try { return JSON.parse(text) } catch { return { text } }
}

/** The stub's recall endpoint serves the row the team store holds. */
function serve(statement: string, scope: string): void {
  stub.recallRows = [{ id: 'ENG-2026-1003-001', scope, status: 'active', statement, score: 1 }]
}

const statements = (r: any): string[] => (r.results ?? []).map((x: any) => String(x.statement))
const injected = (r: any): string => JSON.stringify([r.directives, r.consider])

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
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [SCOPE, SCOPE2, PERSONAL] })
})

afterEach(async () => {
  for (const c of live.splice(0)) await c.close().catch(() => {})
})

const ready = existsSync(DIST_ENTRY)

describe.skipIf(!ready)('a folder\'s team scope is the default for unscoped reads over MCP (#1566)', () => {
  it('save, then recall, both unscoped and with no plur_session_start: the team row is found', async () => {
    const e = env([SCOPE], mapped(SCOPE))
    const client = await start(e)
    const fact = 'quokka-roundtrip the deploy target is the blue cluster'
    const saved = await call(client, 'plur_learn', { statement: fact })
    expect(saved.scope, JSON.stringify(saved)).toBe(SCOPE)
    expect(saved.delivery).toBe('remote')
    serve(fact, SCOPE)
    const r = await call(client, 'plur_recall', { query: 'quokka-roundtrip deploy target' })
    expect(stub.recallCalls, JSON.stringify(r)).toBeGreaterThan(0)
    expect(statements(r)).toContain(fact)
  }, 60_000)

  it('plur_recall in keyword mode and plur_recall_hybrid dial the team store too', async () => {
    const e = env([SCOPE], mapped(SCOPE))
    const client = await start(e)
    const fact = 'quokka-modes the release train leaves on tuesday'
    serve(fact, SCOPE)
    const kw = await call(client, 'plur_recall', { query: 'quokka-modes release train', mode: 'keyword' })
    expect(statements(kw), JSON.stringify(kw)).toContain(fact)
    const hy = await call(client, 'plur_recall_hybrid', { query: 'quokka-modes release train' })
    expect(statements(hy), JSON.stringify(hy)).toContain(fact)
  }, 60_000)

  it('plur_inject_hybrid dials the team store, and records no internal session key', async () => {
    const e = env([SCOPE], mapped(SCOPE))
    const client = await start(e)
    const fact = 'quokka-inject always run the canary before every deploy'
    serve(fact, SCOPE)
    const r = await call(client, 'plur_inject_hybrid', { task: 'quokka-inject canary before deploy' })
    expect(stub.recallCalls, JSON.stringify(r)).toBeGreaterThan(0)
    expect(injected(r)).toContain('quokka-inject')
    const historyDir = join(e.home, 'history')
    const history = existsSync(historyDir)
      ? readdirSync(historyDir).map(f => readFileSync(join(historyDir, f), 'utf8')).join('\n')
      : ''
    expect(history).not.toContain('plur:folder-scope:')
  }, 60_000)

  it('a personal user: team scope: an unscoped recall dials its store', async () => {
    const e = env([PERSONAL], mapped(PERSONAL))
    const client = await start(e)
    const fact = 'quokka-personal my editor uses tabs'
    serve(fact, PERSONAL)
    const r = await call(client, 'plur_recall', { query: 'quokka-personal editor' })
    expect(statements(r), JSON.stringify(r)).toContain(fact)
  }, 60_000)

  it('guard: the plur_session_start path finds the team row (as before)', async () => {
    const e = env([SCOPE], mapped(SCOPE))
    const client = await start(e)
    const s = await call(client, 'plur_session_start', { task: 'quokka session' })
    expect(s.default_scope).toBe(SCOPE)
    const fact = 'quokka-session the staging cluster is green'
    serve(fact, SCOPE)
    const r = await call(client, 'plur_recall', { query: 'quokka-session staging cluster' })
    expect(statements(r), JSON.stringify(r)).toContain(fact)
  }, 60_000)

  it('guard: an explicit scope wins — scope "global" dials no team store', async () => {
    const e = env([SCOPE], mapped(SCOPE))
    const client = await start(e)
    serve('quokka-explicit a team fact', SCOPE)
    const r = await call(client, 'plur_recall', { query: 'quokka-explicit team fact', scope: 'global' })
    expect(stub.recallCalls, JSON.stringify(r)).toBe(0)
    expect(statements(r)).not.toContain('quokka-explicit a team fact')
  }, 60_000)

  it('guard: two roots with different team scopes, either order: an unscoped recall dials no team store', async () => {
    const e = env([SCOPE, SCOPE2], (_ws, a, b) =>
      `version: 1\nfolders:\n  - path: "${a}"\n    scope: ${SCOPE2}\n  - path: "${b}"\n    scope: ${SCOPE}\n`)
    serve('quokka-two-teams a team fact', SCOPE)
    for (const roots of [[e.a, e.b], [e.b, e.a]]) {
      const client = await start(e, roots)
      const r = await call(client, 'plur_recall', { query: 'quokka-two-teams team fact' })
      expect(r.plur, JSON.stringify(r)).toBeUndefined()
      expect(statements(r)).not.toContain('quokka-two-teams a team fact')
      const i = await call(client, 'plur_inject_hybrid', { task: 'quokka-two-teams team fact' })
      expect(injected(i)).not.toContain('quokka-two-teams')
    }
    expect(stub.recallCalls).toBe(0)
  }, 90_000)

  it('[team A, team A]: an unscoped recall dials team A', async () => {
    const e = env([SCOPE], (_ws, a, b) =>
      `version: 1\nfolders:\n  - path: "${a}"\n    scope: ${SCOPE}\n  - path: "${b}"\n    scope: ${SCOPE}\n`)
    const client = await start(e, [e.a, e.b])
    const fact = 'quokka-same-team both repos share the eng store'
    serve(fact, SCOPE)
    const r = await call(client, 'plur_recall', { query: 'quokka-same-team eng store' })
    expect(statements(r), JSON.stringify(r)).toContain(fact)
  }, 60_000)
})
