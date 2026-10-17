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

  function launch(tool: ToolId): { tool: ToolId; launch: McpLaunch } {
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
          PLUR_DISABLE_EMBEDDINGS: '1',
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
      statement: STATEMENT,
      timeoutMs: 60_000,
    })
    expect(result.saved.ok).toBe(false)
    expect(stub.appendStatements).toEqual([])
  })
})
