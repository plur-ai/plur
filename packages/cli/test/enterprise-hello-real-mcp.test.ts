/**
 * The hello proof against the REAL MCP server (packages/mcp/dist), with the
 * in-process contract stub standing in for the team server.
 *
 * The proof runs the server in a fresh temporary folder. With no decision for
 * that folder the server's folder gate answers plur_learn with the folder
 * question instead of saving, so the proof must authorise exactly that
 * temporary folder — and nothing in the user's folder map — for the run.
 *
 * Needs the built server: `pnpm -r build` (or `pnpm --filter @plur-ai/mcp
 * build` after core is built). A missing or stale dist fails loudly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'
import { runHello, type ToolId, type McpLaunch } from '../src/enterprise/hello.js'

const MCP_ENTRY = builtCliPath(join(__dirname, '..', '..', 'mcp'))
const TOKEN = 'hello-real-mcp-token'
const PERSONAL = 'user:acme:alice'
const STATEMENT = 'PLUR connected: alice on ws-0142 (macOS), Claude Code, Codex, PLUR 0.22.0, 2026-10-16'

interface Row { id: string; scope: string; status: string; data: Record<string, unknown> }

describe('hello proof through the real MCP server', { timeout: 120_000 }, () => {
  let stub: StubServer
  let url: string
  let root: string
  let plurHome: string
  let home: string

  beforeAll(async () => {
    stub = new StubServer(TOKEN)
    url = (await stub.start()).url
  })
  afterAll(async () => { await stub.stop() })

  beforeEach(() => {
    stub.reset()
    stub.setMe({ username: 'alice', org_id: 'acme', scopes: [PERSONAL] })
    // The contract server answers a recall with what it holds in the scope.
    const held = (stub as unknown as { engrams: Map<string, Row> }).engrams
    Object.defineProperty(stub, 'recallRows', {
      configurable: true,
      get: () => [...held.values()]
        .filter(e => e.scope === PERSONAL && e.status === 'active')
        .map(e => ({ ...e.data, id: e.id, scope: e.scope, status: e.status, score: 1 })),
      set: () => { /* reset() assigns []: the getter stays in charge */ },
    })
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-hello-real-')))
    plurHome = join(root, 'plur')
    home = join(root, 'home')
    mkdirSync(plurHome, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(plurHome, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${PERSONAL}"\n`)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function launch(tool: ToolId, env: Record<string, string> = { PLUR_DISABLE_EMBEDDINGS: '1' }): { tool: ToolId; launch: McpLaunch } {
    return {
      tool,
      launch: {
        command: process.execPath,
        args: [MCP_ENTRY],
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          HOME: home,
          USERPROFILE: home,
          PLUR_PATH: plurHome,
          ...env,
        },
      },
    }
  }

  /** Runs `fn` with os.tmpdir() pointing at a folder of its own, so the proof's temporary folder can be watched. */
  async function inOwnTmp<T>(fn: () => Promise<T>): Promise<{ value: T; left: string[] }> {
    const own = join(root, 'tmp')
    mkdirSync(own)
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
    process.env.TMPDIR = process.env.TMP = process.env.TEMP = own
    try {
      expect(tmpdir()).toBe(own)
      const value = await fn()
      return { value, left: readdirSync(own) }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  it('a fresh temporary folder: saved on the server, recalled by every launch', async () => {
    const { value: result, left } = await inOwnTmp(() => runHello({
      launches: [launch('claude-code'), launch('codex')],
      personalScope: PERSONAL,
      serverUrl: url,
      statement: STATEMENT,
      timeoutMs: 60_000,
    }))
    expect(result.saved).toMatchObject({ ok: true })
    const id = (result.saved as { ok: true; id: string }).id
    expect(stub.appendStatements).toEqual([STATEMENT])
    expect(result.perTool).toEqual([
      { tool: 'claude-code', recalled: true },
      { tool: 'codex', recalled: true },
    ])
    expect(id).toMatch(/^ENG-/)
    // The user's folder map is never written, and the proof folder is gone.
    expect(existsSync(join(plurHome, 'folders.yaml'))).toBe(false)
    expect(left).toEqual([])
  })

  it('a folder map that turns memory off everywhere is honoured: not saved', async () => {
    writeFileSync(join(plurHome, 'folders.yaml'), `version: 1\nfolders:\n  - path: "/**"\n    plur: off\n`)
    const result = await runHello({
      launches: [launch('codex')],
      personalScope: PERSONAL,
      serverUrl: url,
      statement: STATEMENT,
      timeoutMs: 60_000,
    })
    expect(result.saved.ok).toBe(false)
    expect(stub.appendStatements).toEqual([])
  })

  // Codex round 4: one launch saves (the row lands in that process's
  // optimistic cache) and recalls. The id coming back is not proof: the server
  // must have answered THIS recall, completely.
  for (const [label, arrange] of [
    ['answers 401', (s: StubServer) => { s.recallStatus = 401 }],
    ['answers 500', (s: StubServer) => { s.recallStatus = 500 }],
    ['answers with no rows', (s: StubServer) => {
      Object.defineProperty(s, 'recallRows', { configurable: true, get: () => [], set: () => {} })
    }],
  ] as const) {
    it(`single launch, the server's recall ${label}: saved, but not proven`, async () => {
      arrange(stub)
      const result = await runHello({
        launches: [launch('codex')],
        personalScope: PERSONAL,
        serverUrl: url,
        statement: STATEMENT,
        timeoutMs: 60_000,
      })
      expect(result.saved).toMatchObject({ ok: true })
      expect(stub.appendStatements).toEqual([STATEMENT])
      expect(stub.recallCalls).toBeGreaterThan(0)
      expect(result.perTool).toHaveLength(1)
      expect(result.perTool[0]).toMatchObject({ tool: 'codex', recalled: false })
    })
  }

  // Codex round 5, finding 1: the proof must not depend on local semantic
  // search. Default embeddings, an empty model cache and downloads off: the
  // model is missing (embedding_model_missing), and the server returned the id.
  it('embeddings on but the model is not downloaded: proven when the server returns the id', async () => {
    writeFileSync(join(plurHome, 'config.yaml'),
      `stores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${PERSONAL}"\n`)
    const emptyCache = join(root, 'model-cache')
    mkdirSync(emptyCache)
    const env = { PLUR_MODEL_CACHE_DIR: emptyCache, PLUR_MODEL_DOWNLOAD: 'off' }
    const result = await runHello({
      launches: [launch('claude-code', env), launch('codex', env)],
      personalScope: PERSONAL,
      serverUrl: url,
      statement: STATEMENT,
      timeoutMs: 60_000,
    })
    expect(result.saved).toMatchObject({ ok: true })
    expect(result.perTool).toEqual([
      { tool: 'claude-code', recalled: true },
      { tool: 'codex', recalled: true },
    ])
    expect(readdirSync(emptyCache)).toEqual([])
  })

  // Codex round 5, finding 2: two servers serve the personal scope. The proof
  // is about ONE of them, and only that server's own save and answer count.
  describe('two servers serve the personal scope', () => {
    let other: StubServer
    let otherUrl: string
    beforeAll(async () => {
      other = new StubServer(TOKEN)
      otherUrl = (await other.start()).url
    })
    afterAll(async () => { await other.stop() })

    const rowsOf = (s: StubServer) => [...(s as unknown as { engrams: Map<string, Row> }).engrams.values()]
      .filter(e => e.scope === PERSONAL && e.status === 'active')
      .map(e => ({ ...e.data, id: e.id, scope: e.scope, status: e.status, score: 1 }))
    /** A row unrelated to the hello, in the personal scope. */
    const unrelated = () => [{
      id: 'ENG-UNRELATED-1', scope: PERSONAL, status: 'active', score: 1,
      statement: 'PLUR connected: an older, unrelated note', type: 'behavioral', domain: 'plur.connect',
      tags: [], activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-10-01' },
    }]
    const setRows = (s: StubServer, get: () => unknown[]) =>
      Object.defineProperty(s, 'recallRows', { configurable: true, get, set: () => {} })

    beforeEach(() => {
      other.reset()
      other.setMe({ username: 'alice', org_id: 'acme', scopes: [PERSONAL] })
      // `url` (the first store) takes the personal scope's writes; the other
      // server is dialed on every recall too.
      writeFileSync(join(plurHome, 'config.yaml'),
        `embeddings:\n  enabled: false\nstores:\n` +
        `  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${PERSONAL}"\n` +
        `  - url: "${otherUrl}"\n    token: "${TOKEN}"\n    scope: "${PERSONAL}"\n    dial: always\n`)
    })

    it('the save reached the other server: not proven for the intended one', async () => {
      // The other server answers with an unrelated row; the first one with the hello.
      setRows(other, unrelated)
      const result = await runHello({
        launches: [launch('codex')],
        personalScope: PERSONAL,
        serverUrl: otherUrl,
        statement: STATEMENT,
        timeoutMs: 60_000,
      })
      expect(stub.appendStatements).toEqual([STATEMENT])
      expect(other.appendStatements).toEqual([])
      expect(result.saved.ok).toBe(false)
      expect(result.perTool.every(t => !t.recalled)).toBe(true)
    })

    it('only the other server returned the hello id: not proven', async () => {
      // The intended server (first store) took the save but answers with an
      // unrelated row; the other server hands back the hello row.
      setRows(stub, unrelated)
      setRows(other, () => rowsOf(stub))
      const result = await runHello({
        launches: [launch('codex')],
        personalScope: PERSONAL,
        serverUrl: url,
        statement: STATEMENT,
        timeoutMs: 60_000,
      })
      expect(result.saved).toMatchObject({ ok: true })
      expect(other.recallCalls).toBeGreaterThan(0)
      expect(result.perTool).toHaveLength(1)
      expect(result.perTool[0]).toMatchObject({ tool: 'codex', recalled: false })
    })

    it('control: the intended server holds and returns the id: proven', async () => {
      setRows(other, unrelated)
      const result = await runHello({
        launches: [launch('codex')],
        personalScope: PERSONAL,
        serverUrl: url,
        statement: STATEMENT,
        timeoutMs: 60_000,
      })
      expect(result.saved).toMatchObject({ ok: true })
      expect(other.recallCalls).toBeGreaterThan(0)
      expect(result.perTool).toEqual([{ tool: 'codex', recalled: true }])
    })
  })
})
