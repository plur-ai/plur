/**
 * Decision D1, revised (owner, 2026-11-14: "load memories but ignore untrusted
 * settings"). In a repository whose `.plur.yaml` requests settings and is not
 * trusted, every editor hook loads memories as if the file requested nothing —
 * no scope, domain or remote from it — and offers the one-time trust question
 * once per session, worded so it no longer says "no memories were loaded".
 *
 * A map `off`, an `ask` set by the user and a folder map that cannot be read
 * still win (no memories). The repository's remote is never dialled.
 *
 * Real spawned CLI, with HOME, USERPROFILE, TMPDIR and PLUR_PATH inside a temp
 * directory in every spawn, so the real ~/.plur is never touched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const CLI = builtCliPath(join(__dirname, '..'))
const CODEWORD = 'Codeword ZEPHYRQUILL: fixture deploys go through the blue staging lane'
const PROMPT = 'how do fixture deploys reach the blue staging lane'
const YAML = 'scope: project:fixture\ndomain: fixture.repo\nremote_url: http://127.0.0.1:9\nremote_token: secret-fixture-token\n'

let dir: string
let repo: string
let env: NodeJS.ProcessEnv

function setupDirs(): void {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-untrusted-hooks-')))
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

function mapFolder(fields: string): void {
  writeFileSync(join(dir, '.plur', 'folders.yaml'), `version: 1\nfolders:\n  - path: ${repo}\n${fields}`)
}

function nonceOf(text: string, flags: string): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`plur folders set \\S+ ${esc(flags)} --nonce ([0-9a-f]{32})`).exec(text)
  expect(m, `no nonce for ${flags} in: ${text}`).not.toBeNull()
  return m![1]
}

function context(stdout: string): string {
  if (!stdout) return ''
  const j = JSON.parse(stdout)
  return j.hookSpecificOutput?.additionalContext ?? j.additional_context ?? j.injectSteps?.[0]?.ephemeralMessage ?? ''
}

const QUESTION = 'the repo .plur.yaml is not trusted'
const count = (text: string, needle: string) => text.split(needle).length - 1

/** What every hook's first output must hold for an untrusted .plur.yaml. */
function expectMemoryAndQuestion(text: string): void {
  expect(text).toContain('ZEPHYRQUILL')
  expect(count(text, QUESTION)).toBe(1)
  expect(text).toContain('memories were loaded')
  expect(text).not.toContain('no memories were loaded')
  expect(text).toContain(`plur folders set ${repo} --trusted --nonce ${nonceOf(text, '--trusted')}`)
  // None of its settings apply.
  expect(text).not.toContain('Project scope: project:fixture')
  expect(text).not.toContain('Project domain: fixture.repo')
  expect(text).not.toContain('secret-fixture-token')
}

describe('Claude Code: an untrusted .plur.yaml loads memories and asks once', () => {
  beforeEach(() => { setupDirs(); seed(); writeFileSync(join(repo, '.plur.yaml'), YAML) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const payload = (sid: string, prompt = PROMPT) => ({ session_id: sid, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt })

  it('the first prompt carries the memory and the trust question; later prompts never repeat the question', () => {
    const first = context(cli(['hook-inject'], payload('cc-u1')).stdout)
    expect(first).toContain('session started')
    expectMemoryAndQuestion(first)
    for (let i = 0; i < 2; i++) expect(context(cli(['hook-inject'], payload('cc-u1')).stdout)).not.toContain(QUESTION)
  })

  it('answering "trust" applies its scope from the next session', () => {
    const first = context(cli(['hook-inject'], payload('cc-u2')).stdout)
    const set = cli(['folders', 'set', repo, '--trusted', '--nonce', nonceOf(first, '--trusted')])
    expect(set.status, set.stderr).toBe(0)
    const next = context(cli(['hook-inject'], payload('cc-u2b')).stdout)
    expect(next).toContain('Project scope: project:fixture')
    expect(next).toContain('Project domain: fixture.repo')
    expect(next).not.toContain(QUESTION)
  })

  it('a map off still silences the hook', () => {
    mapFolder('    plur: off\n')
    expect(cli(['hook-inject'], payload('cc-off')).stdout).toBe('')
  })

  it('an ask the user set still loads no memories', () => {
    mapFolder('    plur: ask\n')
    const out = context(cli(['hook-inject'], payload('cc-ask')).stdout)
    expect(out).toContain('no decision for this folder yet')
    expect(out).not.toContain('ZEPHYRQUILL')
  })

  it('a folder map that cannot be read still loads no memories', () => {
    writeFileSync(join(dir, '.plur', 'folders.yaml'), 'version: 1\nfolders:\n  - path: [unclosed\n')
    const out = context(cli(['hook-inject'], payload('cc-bad')).stdout)
    expect(out).toContain('the folder map cannot be read, so no memories were loaded')
    expect(out).not.toContain('ZEPHYRQUILL')
  })
})

describe('the untrusted repository remote is never dialled', () => {
  let server: StubServer
  let baseUrl: string
  const TOKEN = 'repo-token'

  beforeAll(async () => { server = new StubServer(TOKEN); baseUrl = (await server.start()).url })
  afterAll(async () => { await server.stop() })
  beforeEach(() => {
    setupDirs()
    seed()
    server.reset()
    delete env.PLUR_HOOK_HYBRID // the remote leg rides the hybrid search
    writeFileSync(join(dir, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\n')
    writeFileSync(join(repo, '.plur.yaml'),
      `scope: project:fixture\nremote_url: "${baseUrl}"\nremote_token: "${TOKEN}"\nremote_scopes:\n  - project:fixture\n`)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function runHookAsync(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, 'hook-inject'], { env, cwd: repo })
      let out = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timeout: ${out}`)) }, 30_000)
      child.stdout.on('data', d => { out += String(d) })
      child.on('close', () => { clearTimeout(timer); resolve(out) })
      child.stdin.end(JSON.stringify({ session_id: 'remote-u', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: PROMPT }))
    })
  }

  it('memory loads locally, the trust question is shown, and nothing reaches the repository server', async () => {
    const out = context(await runHookAsync())
    expect(out).toContain('ZEPHYRQUILL')
    expect(out).toContain(QUESTION)
    expect(server.recallCalls).toBe(0)
    expect(out).not.toContain(TOKEN)
  }, 60_000)
})

describe('Codex: an untrusted .plur.yaml loads memories and asks once', () => {
  beforeEach(() => { setupDirs(); seed(); writeFileSync(join(repo, '.plur.yaml'), YAML) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const prompt = (sid: string) => ({ session_id: sid, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: PROMPT })

  it('the first prompt carries the memory and the question; the next carries memory only', () => {
    expectMemoryAndQuestion(context(cli(['hook-codex-inject'], prompt('cx-u1')).stdout))
    const second = context(cli(['hook-codex-inject'], prompt('cx-u1')).stdout)
    expect(second).toContain('ZEPHYRQUILL')
    expect(second).not.toContain(QUESTION)
  })
})

describe('Cursor: an untrusted .plur.yaml loads memories and asks once', () => {
  beforeEach(() => { setupDirs(); seed(); writeFileSync(join(repo, '.plur.yaml'), YAML) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the session start writes the memory and the question, in both channels', () => {
    const out = context(cli(['hook-cursor-session-start'], { conversation_id: 'cu-u1', workspace_roots: [repo] }).stdout)
    // The session start recalls for a generic task: the codeword fact may not
    // match it, so only the header and the question are asserted here.
    expect(out).toContain('session started')
    expect(count(out, QUESTION)).toBe(1)
    expect(out).toContain('memories were loaded')
    expect(out).not.toContain('Project scope: project:fixture')
    expect(out).not.toContain('secret-fixture-token')
    expect(readFileSync(join(repo, '.cursor', 'rules', 'plur-context.mdc'), 'utf8')).toContain(QUESTION)
    // The same conversation again: memory, no second question.
    const again = context(cli(['hook-cursor-session-start'], { conversation_id: 'cu-u1', workspace_roots: [repo] }).stdout)
    expect(again).toContain('session started')
    expect(again).not.toContain(QUESTION)
  })
})

describe('Antigravity: an untrusted .plur.yaml loads memories and asks once', () => {
  beforeEach(() => { setupDirs(); seed(); writeFileSync(join(repo, '.plur.yaml'), YAML) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function transcript(text: string, step = 0): string {
    const p = join(dir, `agy-${step}.jsonl`)
    writeFileSync(p, JSON.stringify({ step_index: step, type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }) + '\n')
    return p
  }
  const pre = (sid: string, invocationNum: number, step = 0) => ({
    conversationId: sid, invocationNum, workspacePaths: [repo], transcriptPath: transcript(`${PROMPT} ${step}`, step),
  })

  it('the first turn carries the memory and the question; the next turn memory only', () => {
    expectMemoryAndQuestion(context(cli(['hook-agy-pre-invocation'], pre('ag-u1', 0)).stdout))
    const next = context(cli(['hook-agy-pre-invocation'], pre('ag-u1', 2, 1)).stdout)
    expect(next).toContain('ZEPHYRQUILL')
    expect(next).not.toContain(QUESTION)
  })
})
