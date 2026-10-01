/**
 * `remote-only` folders through the CLI (owner decisions 2026-10-01):
 *
 *   - `plur folders set <dir> --remote-only --scope <s>` records the entry,
 *     under the usual nonce rules, and only for a scope a url store serves;
 *   - the first write creates folders.yaml with a commented example of every
 *     setting;
 *   - the editor hooks treat the folder as on, read only the team scope and
 *     packs (never the personal store), and when the server cannot be reached
 *     the session starts without memory and says so once.
 *
 * Real spawned CLI against a real-HTTP stub; HOME, USERPROFILE, TMPDIR and
 * PLUR_PATH inside a temp directory in every spawn.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { issueFolderNonce } from '@plur-ai/core'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'cli-remote-only-token'
const TEAM = 'group:acme/client'
const PERSONAL = 'Codeword PERSONALZEBRA: fixture deploys go through the blue lane'
const PROMPT = 'how do fixture deploys reach the blue lane'

let server: StubServer
let baseUrl: string
let dir: string
let plurHome: string
let repo: string
let env: NodeJS.ProcessEnv

beforeAll(async () => { server = new StubServer(TOKEN); baseUrl = (await server.start()).url })
afterAll(async () => { await server.stop() })

function writeConfig(url = baseUrl): void {
  writeFileSync(join(plurHome, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${TEAM}"\n`)
}

beforeEach(() => {
  server.reset()
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-remote-only-cli-')))
  mkdirSync(join(dir, 'tmp'))
  plurHome = join(dir, '.plur')
  mkdirSync(plurHome)
  repo = join(dir, 'client')
  mkdirSync(join(repo, '.git'), { recursive: true })
  env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome }
  delete env.CLAUDE_SESSION_ID
  delete env.PLUR_HOOK_HYBRID
  writeConfig()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function cli(args: string[], input?: unknown, cwd: string = repo): { stdout: string; stderr: string; status: number } {
  const r = runCli('node', [CLI, ...args], {
    encoding: 'utf-8', env, cwd,
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 }
}

/** Spawned asynchronously, so the in-process stub server can answer. */
function hook(args: string[], input: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { env, cwd: repo })
    let out = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout: ${out}`)) }, 45_000)
    child.stdout.on('data', d => { out += String(d) })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
    child.stdin.end(JSON.stringify(input))
  })
}

function context(stdout: string): string {
  if (!stdout) return ''
  const j = JSON.parse(stdout)
  return j.hookSpecificOutput?.additionalContext ?? j.additional_context ?? j.injectSteps?.[0]?.ephemeralMessage ?? ''
}

function seedPersonal(): void {
  // Seeded from a folder with no decision, into the personal local store.
  const r = cli(['learn', PERSONAL, '--json'], undefined, dir)
  expect(r.status, r.stderr).toBe(0)
}

function mapRemoteOnly(): void {
  writeFileSync(join(plurHome, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${repo}\n    plur: remote-only\n    scope: ${TEAM}\n`)
}

const json = (r: { stdout: string }) => { try { return JSON.parse(r.stdout.trim()) } catch { return null } }

describe('plur folders set --remote-only', () => {
  it('records the entry with a nonce, and the new folders.yaml carries the commented examples', () => {
    const nonce = issueFolderNonce(plurHome, 's-ro', repo, { mode: 'remote-only', scope: TEAM })
    const r = cli(['folders', 'set', repo, '--remote-only', '--scope', TEAM, '--nonce', nonce, '--json'])
    expect(r.status, r.stderr).toBe(0)
    expect(json(r).entry).toEqual({ path: repo, plur: 'remote-only', scope: TEAM })
    const list = json(cli(['folders', 'list', '--json']))
    expect(list.folders).toEqual([{ path: repo, plur: 'remote-only', scope: TEAM }])
    const text = readFileSync(join(plurHome, 'folders.yaml'), 'utf8')
    for (const m of ['on', 'off', 'ask', 'remote-only']) expect(text).toMatch(new RegExp(`#\\s+plur:\\s+${m}\\s+#`))
    expect(text).toMatch(/#\s+scope:\s+\S+\s+#/)
    expect(text).toMatch(/#\s+trusted:\s+true\s+#/)
    expect(cli(['folders', 'list'], undefined, dir).stdout).toContain('remote-only')
  }, 60_000)

  it('outside a terminal it needs a nonce; the scope must be served by a url store; --scope is required', () => {
    const noNonce = cli(['folders', 'set', repo, '--remote-only', '--scope', TEAM, '--json'])
    expect(noNonce.status).toBe(1)
    expect(json(noNonce).code).toBe('nonce-required')
    const other = 'group:acme/nostore'
    const unserved = cli(['folders', 'set', repo, '--remote-only', '--scope', other, '--json',
      '--nonce', issueFolderNonce(plurHome, 's-ro', repo, { mode: 'remote-only', scope: other })])
    expect(unserved.status).toBe(1)
    expect(json(unserved).code).toBe('scope-unconfigured')
    const noScope = cli(['folders', 'set', repo, '--remote-only', '--json'])
    expect(noScope.status).toBe(1)
    expect(existsSync(join(plurHome, 'folders.yaml'))).toBe(false)
  }, 60_000)
})

describe('Claude Code hook in a remote-only folder', () => {
  const payload = (sid: string) => ({ session_id: sid, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: PROMPT })

  it('reads the team scope only: the team row is injected, the personal store is not', async () => {
    seedPersonal()
    mapRemoteOnly()
    server.recallRows = [{ id: 'ENG-2026-1001-020', scope: TEAM, status: 'active', statement: 'fixture deploys reach the blue lane via TEAMHERON gates', score: 1 }]
    const ctx = context(await hook(['hook-inject'], payload('ro-up')))
    expect(server.recallCalls).toBeGreaterThan(0)
    expect(ctx).toContain('TEAMHERON')
    expect(ctx).not.toContain('PERSONALZEBRA')
    expect(ctx).toMatch(/remote-only/)
    expect(ctx).toContain(TEAM)
  }, 90_000)

  it('server down: the session starts without memory and says so once', async () => {
    seedPersonal()
    mapRemoteOnly()
    server.recallStatus = 503
    const first = context(await hook(['hook-inject'], payload('ro-down')))
    expect(first).not.toContain('PERSONALZEBRA')
    expect(first).toMatch(/could not be reached/i)
    expect(first).toMatch(/without memory/i)
    const second = context(await hook(['hook-inject'], payload('ro-down')))
    expect(second).not.toMatch(/could not be reached/i)
    expect(second).not.toContain('PERSONALZEBRA')
  }, 90_000)
})

describe('Codex and Cursor hooks in a remote-only folder', () => {
  it('Codex: no personal memory; an unreachable server is said on the first prompt only', async () => {
    seedPersonal()
    mapRemoteOnly()
    server.recallStatus = 503
    const p = { session_id: 'cx-ro', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: PROMPT }
    const first = context(await hook(['hook-codex-inject'], p))
    expect(first).toMatch(/could not be reached/i)
    expect(first).not.toContain('PERSONALZEBRA')
    const second = context(await hook(['hook-codex-inject'], p))
    expect(second).not.toMatch(/could not be reached/i)
    expect(second).not.toContain('PERSONALZEBRA')
  }, 90_000)

  it('Cursor: the session start reads the team scope, not the personal store', async () => {
    seedPersonal()
    mapRemoteOnly()
    server.recallRows = [{ id: 'ENG-2026-1001-021', scope: TEAM, status: 'active', statement: 'general session start rule TEAMHERON applies to client work', score: 1 }]
    const ctx = context(await hook(['hook-cursor-session-start'], { conversation_id: 'cu-ro' }))
    expect(ctx).toMatch(/remote-only/)
    expect(ctx).not.toContain('PERSONALZEBRA')
    expect(ctx).toContain('TEAMHERON')
  }, 90_000)
})
