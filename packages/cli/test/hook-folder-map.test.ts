/**
 * #1347 (hook integration): every editor's hooks read the folder map.
 *
 *   - off  → silent, and nothing is written;
 *   - on   → memory as before; a map scope becomes the session scope, so the
 *            team store it belongs to is dialled;
 *   - ask  → on the first prompt of a session, one question with the exact
 *            commands and a single-use nonce, and no memories; later prompts
 *            of that session stay silent; after a yes, the next prompt injects.
 *
 * Real spawned CLI, with HOME, USERPROFILE, TMPDIR and PLUR_PATH inside a temp
 * directory in every spawn, so the real ~/.plur is never touched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const CLI = builtCliPath(join(__dirname, '..'))
const CODEWORD = 'Codeword ZEPHYRQUILL: fixture deploys go through the blue staging lane'
const PROMPT = 'how do fixture deploys reach the blue staging lane'

let dir: string
let repo: string
let env: NodeJS.ProcessEnv

function setupDirs(): void {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-folder-hooks-')))
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  mkdirSync(join(dir, '.plur'), { recursive: true })
  repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    TMPDIR: join(dir, 'tmp'),
    PLUR_PATH: join(dir, '.plur'),
    PLUR_HOOK_HYBRID: 'off',
  }
  delete env.CLAUDE_SESSION_ID
}

function cli(args: string[], input?: unknown, cwd: string = repo): { stdout: string; stderr: string; status: number } {
  const r = runCli('node', [CLI, ...args], {
    encoding: 'utf-8', env, cwd,
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 }
}

function seed(): void {
  const r = cli(['learn', CODEWORD, '--json'])
  expect(r.status, r.stderr).toBe(0)
}

function mapFolder(path: string, fields: string): void {
  writeFileSync(join(dir, '.plur', 'folders.yaml'), `version: 1\nfolders:\n  - path: ${path}\n${fields}`)
}

function nonceOf(text: string): string {
  const m = /--nonce ([0-9a-f]{32})/.exec(text)
  expect(m, `no nonce in: ${text}`).not.toBeNull()
  return m![1]
}

function context(stdout: string): string {
  if (!stdout) return ''
  const j = JSON.parse(stdout)
  return j.hookSpecificOutput?.additionalContext ?? j.additional_context ?? j.injectSteps?.[0]?.ephemeralMessage ?? ''
}

describe('Claude Code hooks read the folder map (#1347)', () => {
  beforeEach(() => { setupDirs(); seed() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const payload = (prompt: string, sid = 'cc-ask') => ({ session_id: sid, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt })

  it('an unmapped folder asks once per session, with no memories, then stays silent', () => {
    const first = context(cli(['hook-inject'], payload(PROMPT)).stdout)
    expect(first).toContain('no decision for this folder yet')
    expect(first).toContain(repo)
    expect(first).toContain(`plur folders set ${repo} --on --nonce ${nonceOf(first)}`)
    expect(first).toContain(`plur folders set ${repo} --off --nonce ${nonceOf(first)}`)
    expect(first).not.toContain('ZEPHYRQUILL')
    expect(cli(['hook-inject'], payload(PROMPT)).stdout).toBe('')
    // A new session asks again ("not now" records nothing).
    expect(context(cli(['hook-inject'], payload(PROMPT, 'cc-ask-2')).stdout)).toContain('no decision for this folder yet')
  })

  it('after a yes with the nonce, the next prompt of the same session injects', () => {
    const ask = context(cli(['hook-inject'], payload(PROMPT)).stdout)
    const set = cli(['folders', 'set', repo, '--on', '--nonce', nonceOf(ask)])
    expect(set.status, set.stderr).toBe(0)
    const next = context(cli(['hook-inject'], payload(PROMPT)).stdout)
    expect(next).toContain('session started')
    expect(next).toContain('ZEPHYRQUILL')
    // The nonce works once.
    expect(cli(['folders', 'set', repo, '--off', '--nonce', nonceOf(ask)]).status).not.toBe(0)
  })

  it('never here: --off with the nonce silences every hook from then on', () => {
    const ask = context(cli(['hook-inject'], payload(PROMPT)).stdout)
    expect(cli(['folders', 'set', repo, '--off', '--nonce', nonceOf(ask)]).status).toBe(0)
    expect(cli(['hook-inject'], payload(PROMPT, 'cc-after-off')).stdout).toBe('')
  })

  it('$HOME itself asks like any other folder', () => {
    const out = context(cli(['hook-inject'], { session_id: 'cc-home', cwd: dir, prompt: PROMPT }, dir).stdout)
    expect(out).toContain('no decision for this folder yet')
    expect(out).toContain(dir)
  })

  it('off: inject, remind, guard, observe and learn-check are silent and write nothing', () => {
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur' } } }))
    mapFolder(repo, '    plur: off\n')
    const cc = { session_id: 'cc-off', cwd: repo }
    expect(cli(['hook-inject'], payload(PROMPT, 'cc-off')).stdout).toBe('')
    expect(cli(['hook-session-remind'], cc).stdout).toBe('')
    expect(cli(['hook-session-guard'], { ...cc, tool_name: 'Bash' }).stdout).toBe('')
    const obs = { ...cc, tool_name: 'Bash', tool_input: { command: 'ls' } }
    expect(cli(['hook-observe'], obs).stdout).toBe(JSON.stringify(obs)) // passthrough is the hook contract
    expect(existsSync(join(dir, '.plur', 'observations'))).toBe(false)
    for (let i = 0; i < 3; i++) expect(cli(['hook-learn-check'], cc).stdout).toBe('')
    expect(existsSync(join(dir, 'tmp', 'plur-sessions', 'cc-off.stop-count'))).toBe(false)
  })

  it('on via the map: injects, and a map scope is the session scope', () => {
    mapFolder(repo, '    plur: on\n')
    const on = context(cli(['hook-inject'], payload(PROMPT, 'cc-on')).stdout)
    expect(on).toContain('ZEPHYRQUILL')
    mapFolder(repo, '    scope: project:mapped\n')
    const scoped = context(cli(['hook-inject'], payload(PROMPT, 'cc-scoped')).stdout)
    expect(scoped).toContain('Project scope: project:mapped — use this scope for plur_learn calls')
  })

  it('an untrusted .plur.yaml remote asks once, offers --trusted, and never shows the token', () => {
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:fixture\nremote_url: http://127.0.0.1:9\nremote_token: secret-fixture-token\n')
    const ask = context(cli(['hook-inject'], payload(PROMPT, 'cc-untrusted')).stdout)
    expect(ask).toContain('.plur.yaml is not trusted')
    expect(ask).toContain('127.0.0.1:9')
    expect(ask).toContain(`plur folders set ${repo} --trusted --nonce ${nonceOf(ask)}`)
    expect(ask).not.toContain('secret-fixture-token')
    expect(ask).not.toContain('ZEPHYRQUILL')
    expect(cli(['hook-inject'], payload(PROMPT, 'cc-untrusted')).stdout).toBe('')
    // Yes, trust it → the next prompt injects under the repo's scope.
    expect(cli(['folders', 'set', repo, '--trusted', '--nonce', nonceOf(ask)]).status).toBe(0)
    expect(context(cli(['hook-inject'], payload(PROMPT, 'cc-untrusted')).stdout)).toContain('Project scope: project:fixture')
  })
})

describe('a folder mapped to a team scope gets remote recall (#1347, found in #1415)', () => {
  let server: StubServer
  let baseUrl: string
  const TOKEN = 'folder-map-token'
  const SCOPE = 'group:test/eng'

  beforeAll(async () => { server = new StubServer(TOKEN); baseUrl = (await server.start()).url })
  afterAll(async () => { await server.stop() })
  beforeEach(() => {
    setupDirs()
    server.reset()
    delete env.PLUR_HOOK_HYBRID // the remote leg rides the hybrid search
    // What `plur remote --url --token --scope` writes: a url store in
    // config.yaml and a folder entry with the scope. No .plur.yaml.
    writeFileSync(join(dir, '.plur', 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function runHookAsync(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, 'hook-inject'], { env, cwd: repo })
      let out = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout: ${out}`)) }, 30_000)
      child.stdout.on('data', d => { out += String(d) })
      child.on('close', () => { clearTimeout(timer); resolve(out) })
      child.stdin.end(JSON.stringify({ session_id: 'remote-1', cwd: repo, prompt: 'what are the deployment conventions' }))
    })
  }

  it('dials the store the map scope names and injects its rows', async () => {
    mapFolder(repo, `    scope: ${SCOPE}\n`)
    server.recallRows = [{ id: 'ENG-2026-0929-001', scope: SCOPE, status: 'active', statement: 'deployment conventions require canary verification', score: 1 }]
    const out = await runHookAsync()
    expect(server.recallCalls).toBe(1)
    expect(context(out)).toContain('canary verification')
    expect(context(out)).toContain(`Project scope: ${SCOPE}`)
  }, 60_000)

  it('an unmapped folder with the same store configured dials nothing and asks', async () => {
    const out = await runHookAsync()
    expect(server.recallCalls).toBe(0)
    expect(context(out)).toContain('no decision for this folder yet')
    expect(context(out)).toContain(`--scope ${SCOPE}`)
  }, 60_000)
})

describe('Codex hooks read the folder map (#1347)', () => {
  beforeEach(() => { setupDirs(); seed() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const start = (sid: string) => ({ session_id: sid, cwd: repo, hook_event_name: 'SessionStart', source: 'startup' })
  const prompt = (sid: string) => ({ session_id: sid, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: PROMPT })

  it('unmapped: session start is silent, the first prompt asks, later prompts are silent', () => {
    expect(cli(['hook-codex-session-start'], start('cx-ask')).stdout).toBe('')
    const ask = context(cli(['hook-codex-inject'], prompt('cx-ask')).stdout)
    expect(ask).toContain('no decision for this folder yet')
    expect(ask).toContain(`--nonce ${nonceOf(ask)}`)
    expect(ask).not.toContain('ZEPHYRQUILL')
    expect(cli(['hook-codex-inject'], prompt('cx-ask')).stdout).toBe('')
    expect(cli(['hook-codex-guard'], { session_id: 'cx-ask', cwd: repo, tool_name: 'shell' }).stdout).toBe('')
    expect(cli(['folders', 'set', repo, '--on', '--nonce', nonceOf(ask)]).status).toBe(0)
    expect(context(cli(['hook-codex-inject'], prompt('cx-ask')).stdout)).toContain('ZEPHYRQUILL')
  })

  it('off: every Codex hook is silent', () => {
    mapFolder(repo, '    plur: off\n')
    expect(cli(['hook-codex-session-start'], start('cx-off')).stdout).toBe('')
    expect(cli(['hook-codex-inject'], prompt('cx-off')).stdout).toBe('')
    expect(cli(['hook-codex-guard'], { session_id: 'cx-off', cwd: repo, tool_name: 'shell' }).stdout).toBe('')
    expect(cli(['hook-codex-post-tool'], { session_id: 'cx-off', cwd: repo, tool_name: 'plur_session_start' }).stdout).toBe('')
  })

  it('on via the map: injects with the map scope', () => {
    mapFolder(repo, '    scope: project:mapped\n')
    expect(context(cli(['hook-codex-session-start'], start('cx-on')).stdout)).toContain('Project scope: project:mapped')
    expect(context(cli(['hook-codex-inject'], prompt('cx-on')).stdout)).toContain('ZEPHYRQUILL')
  })

  it('an untrusted .plur.yaml remote asks once', () => {
    writeFileSync(join(repo, '.plur.yaml'), 'remote_url: http://127.0.0.1:9\nremote_token: secret-fixture-token\n')
    const ask = context(cli(['hook-codex-inject'], prompt('cx-untrusted')).stdout)
    expect(ask).toContain('--trusted')
    expect(ask).not.toContain('secret-fixture-token')
    expect(cli(['hook-codex-inject'], prompt('cx-untrusted')).stdout).toBe('')
  })
})

describe('Cursor hooks read the folder map (#1347)', () => {
  beforeEach(() => { setupDirs(); seed() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const rule = () => join(repo, '.cursor', 'rules', 'plur-context.mdc')

  it('unmapped: the session start asks (both channels), the guard is silent', () => {
    const out = cli(['hook-cursor-session-start'], { conversation_id: 'cu-ask' })
    const ask = context(out.stdout)
    expect(ask).toContain('no decision for this folder yet')
    expect(ask).not.toContain('ZEPHYRQUILL')
    expect(readFileSync(rule(), 'utf8')).toContain(`--nonce ${nonceOf(ask)}`)
    expect(cli(['hook-cursor-guard'], { conversation_id: 'cu-ask', tool_name: 'Shell' }).stdout).toBe('')
    // Same conversation again: silent.
    expect(cli(['hook-cursor-session-start'], { conversation_id: 'cu-ask' }).stdout).toBe('')
  })

  it('off: silent, and a question left in the rule file by an earlier session is removed', () => {
    cli(['hook-cursor-session-start'], { conversation_id: 'cu-first' })
    expect(existsSync(rule())).toBe(true)
    mapFolder(repo, '    plur: off\n')
    expect(cli(['hook-cursor-session-start'], { conversation_id: 'cu-off' }).stdout).toBe('')
    expect(existsSync(rule())).toBe(false)
    expect(cli(['hook-cursor-guard'], { conversation_id: 'cu-off', tool_name: 'Shell' }).stdout).toBe('')
    expect(cli(['hook-cursor-stop'], { conversation_id: 'cu-off', status: 'completed' }).stdout).toBe('')
  })

  it('on via the map: injects with the map scope', () => {
    mapFolder(repo, '    scope: project:mapped\n')
    expect(context(cli(['hook-cursor-session-start'], { conversation_id: 'cu-on' }).stdout)).toContain('Project scope: project:mapped')
  })

  it('an untrusted .plur.yaml remote asks once', () => {
    writeFileSync(join(repo, '.plur.yaml'), 'remote_url: http://127.0.0.1:9\nremote_token: secret-fixture-token\n')
    const ask = context(cli(['hook-cursor-session-start'], { conversation_id: 'cu-untrusted' }).stdout)
    expect(ask).toContain('--trusted')
    expect(ask).not.toContain('secret-fixture-token')
  })
})

describe('Antigravity hooks read the folder map (#1347)', () => {
  beforeEach(() => { setupDirs(); seed() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function transcript(text: string, step = 0): string {
    const p = join(dir, `agy-${step}.jsonl`)
    writeFileSync(p, JSON.stringify({ step_index: step, type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }) + '\n')
    return p
  }
  const pre = (sid: string, invocationNum: number, step = 0, workspace: string[] = [repo]) => ({
    conversationId: sid, invocationNum, workspacePaths: workspace, transcriptPath: transcript(`${PROMPT} ${step}`, step),
  })

  it('unmapped workspace: the first turn asks and replays the question within the turn, later turns are silent', () => {
    const ask = context(cli(['hook-agy-pre-invocation'], pre('ag-ask', 0)).stdout)
    expect(ask).toContain('no decision for this folder yet')
    expect(ask).not.toContain('ZEPHYRQUILL')
    expect(context(cli(['hook-agy-pre-invocation'], pre('ag-ask', 1)).stdout)).toBe(ask)
    expect(cli(['hook-agy-pre-invocation'], pre('ag-ask', 2, 1)).stdout).toBe('')
    expect(cli(['hook-agy-guard'], { conversationId: 'ag-ask', workspacePaths: [repo], toolCall: { name: 'run_command' } }).stdout).toBe('')
    expect(cli(['folders', 'set', repo, '--on', '--nonce', nonceOf(ask)]).status).toBe(0)
    expect(context(cli(['hook-agy-pre-invocation'], pre('ag-ask', 3, 2)).stdout)).toContain('ZEPHYRQUILL')
  })

  it('off: silent', () => {
    mapFolder(repo, '    plur: off\n')
    expect(cli(['hook-agy-pre-invocation'], pre('ag-off', 0)).stdout).toBe('')
    expect(cli(['hook-agy-guard'], { conversationId: 'ag-off', workspacePaths: [repo], toolCall: { name: 'run_command' } }).stdout).toBe('')
  })

  it('on via the map: injects with the map scope', () => {
    mapFolder(repo, '    scope: project:mapped\n')
    expect(context(cli(['hook-agy-pre-invocation'], pre('ag-on', 0)).stdout)).toContain('Project scope: project:mapped')
  })

  it('no workspace in the payload: unchanged, the install is the opt-in', () => {
    expect(context(cli(['hook-agy-pre-invocation'], pre('ag-nows', 0, 0, [])).stdout)).toContain('ZEPHYRQUILL')
  })

  it('an untrusted .plur.yaml remote asks once', () => {
    writeFileSync(join(repo, '.plur.yaml'), 'remote_url: http://127.0.0.1:9\nremote_token: secret-fixture-token\n')
    const ask = context(cli(['hook-agy-pre-invocation'], pre('ag-untrusted', 0)).stdout)
    expect(ask).toContain('--trusted')
    expect(ask).not.toContain('secret-fixture-token')
    expect(cli(['hook-agy-pre-invocation'], pre('ag-untrusted', 2, 1)).stdout).toBe('')
  })
})
