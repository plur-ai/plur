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

describe('owner decisions on #1521', () => {
  it('decision 2: folders set --scope on a remote-only folder keeps it remote-only', () => {
    mapRemoteOnly()
    const r = cli(['folders', 'set', repo, '--scope', TEAM, '--json',
      '--nonce', issueFolderNonce(plurHome, 's-scope', repo, { scope: TEAM })])
    expect(r.status, r.stderr).toBe(0)
    expect(json(r).entry).toEqual({ path: repo, plur: 'remote-only', scope: TEAM })
  }, 60_000)

  it('decision 4: plur capture in a remote-only folder is refused and writes no episode', () => {
    mapRemoteOnly()
    const r = cli(['capture', 'client session summary CAPTUREOTTER', '--json'])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('remote-only')
    const ep = join(plurHome, 'episodes.yaml')
    expect(existsSync(ep) ? readFileSync(ep, 'utf8') : '').not.toContain('CAPTUREOTTER')
  }, 60_000)

  it('decision 4: the session-end hook captures no episode in a remote-only folder, and drops the checkpoint', () => {
    mapRemoteOnly()
    const sessions = join(plurHome, 'sessions')
    mkdirSync(sessions, { recursive: true })
    const cp = join(sessions, 'ro-end.checkpoint.json')
    writeFileSync(cp, JSON.stringify({
      session_id: 'ro-end', started_at: new Date(Date.now() - 3600_000).toISOString(),
      last_checkpoint: new Date().toISOString(), stop_count: 7, cwd: repo,
    }))
    const r = cli(['hook-session-end'], { session_id: 'ro-end', cwd: repo, reason: 'other' })
    expect(r.status, r.stderr).toBe(0)
    const ep = join(plurHome, 'episodes.yaml')
    expect(existsSync(ep) ? readFileSync(ep, 'utf8') : '').not.toContain('auto-closed')
    expect(existsSync(cp)).toBe(false)
  }, 60_000)
})

describe('audit of #1521: CLI commands and hooks fail closed', () => {
  it('S1: plur learn / recall run in a remote-only folder are bound to it', async () => {
    seedPersonal()
    mapRemoteOnly()
    const personal = cli(['learn', 'typed in the client folder CLIOTTER', '--scope', 'global', '--json'])
    expect(personal.status).not.toBe(0)
    expect(personal.stdout + personal.stderr).toContain('remote-only')
    expect(readFileSync(join(plurHome, 'engrams.yaml'), 'utf8')).not.toContain('CLIOTTER')
    const recall = cli(['recall', 'fixture deploys blue lane', '--json'])
    expect(recall.stdout).not.toContain('PERSONALZEBRA')
  }, 90_000)

  it('S3: a malformed folders.yaml makes the hook say so, naming the file, with no memories', async () => {
    seedPersonal()
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    writeFileSync(join(plurHome, 'folders.yaml'), 'version: 1\nfolders: [[[\n')
    const ctx = context(await hook(['hook-inject'], { session_id: 'mal-1', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: PROMPT }))
    expect(ctx).toContain(join(plurHome, 'folders.yaml'))
    expect(ctx).not.toContain('PERSONALZEBRA')
  }, 90_000)

  it('S7: binding a hook instance that cannot be bound fails loudly', async () => {
    const { bindHookFolder } = await import('../src/lib/folder-gate.js')
    expect(() => bindHookFolder({} as never, repo, { mode: 'remote-only', scope: TEAM, remoteAllowed: false, source: 'map' })).toThrow()
  })
})

describe('re-audit of #1521: no capture when in doubt, fail closed', () => {
  it('C-1: a SessionEnd payload without cwd, from an ordinary folder, does not capture a remote-only checkpoint', () => {
    mapRemoteOnly()
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    writeFileSync(join(plurHome, 'folders.yaml'),
      `version: 1\nfolders:\n  - path: ${repo}\n    plur: remote-only\n    scope: ${TEAM}\n  - path: ${plain}\n    plur: on\n`)
    const sessions = join(plurHome, 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'ro-nocwd.checkpoint.json'), JSON.stringify({
      session_id: 'ro-nocwd', started_at: new Date(Date.now() - 3600_000).toISOString(),
      last_checkpoint: new Date().toISOString(), stop_count: 3, cwd: repo,
    }))
    const r = cli(['hook-session-end'], { session_id: 'ro-nocwd', reason: 'other' }, plain)
    expect(r.status, r.stderr).toBe(0)
    const ep = join(plurHome, 'episodes.yaml')
    expect(existsSync(ep) ? readFileSync(ep, 'utf8') : '').not.toContain('auto-closed')
  }, 60_000)

  it('C-1: the deferred wrap-up captures nothing when the checkpoint folder cannot be resolved', async () => {
    const { processDeferredWrapups } = await import('../src/commands/hook-inject.js')
    const sessions = join(plurHome, 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'old.checkpoint.json'), JSON.stringify({
      session_id: 'old', started_at: new Date(Date.now() - 7200_000).toISOString(),
      last_checkpoint: new Date(Date.now() - 3600_000).toISOString(), stop_count: 3, cwd: repo,
    }))
    const captured: string[] = []
    const fake = {
      capture: (s: string) => { captured.push(s); return { id: 'EP-1' } },
      remoteOnlyFolder: () => null,
      resolveFolderPolicy: () => { throw new Error('cannot resolve') },
    }
    processDeferredWrapups(fake as never, plurHome)
    expect(captured).toEqual([])
  })
})
