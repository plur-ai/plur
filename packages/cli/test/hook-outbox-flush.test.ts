/**
 * #1269: editor hooks and `plur sync` flush the outbox.
 *
 * An enterprise deployment reported engrams that stayed on laptops: queued
 * team writes were only retried by MCP session start / sync / outbox and by
 * `plur outbox --flush`. No editor hook flushed, and `plur sync` did not
 * either, although `plur outbox` said it did.
 *
 * Driven end to end: a real spawned CLI process against a real-HTTP stub, so
 * "the hook exits promptly" is measured on the wall clock the harness sees.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { isolateGitConfig } from '../../core/test/helpers/git-isolation.js'
import { builtCliPath } from './helpers/built-cli.js'
import { outboxMayHaveEntries } from '../src/lib/hook-outbox-flush.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'hook-outbox-token'
const SCOPE = 'group:test'

let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

interface Ran { code: number | null; stdout: string; stderr: string; ms: number }

/** Async spawn: the stub server lives in THIS process and must keep answering. */
function runCli(args: string[], opts: { cwd: string; env: Record<string, string>; input?: string }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const child = spawn('node', [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(killer)
      resolve({ code, stdout, stderr, ms: Date.now() - t0 })
    })
    child.stdin.end(opts.input ?? '')
  })
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('outbox flush from hooks and plur sync (#1269)', () => {
  // `plur sync` commits, and the spawned CLI inherits process.env: give its
  // git an identity (and no developer config), or `git commit` fails on CI
  // runners that have no account name to fall back on.
  isolateGitConfig()

  let root: string
  let project: string
  let store: string
  let env: Record<string, string>

  beforeEach(() => {
    server.reset()
    root = mkdtempSync(join(tmpdir(), 'plur-hook-outbox-'))
    project = join(root, 'project')
    store = join(root, 'store')
    mkdirSync(project, { recursive: true })
    mkdirSync(store, { recursive: true })
    // Marks the project plur-enabled for every harness's configured-guard.
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    writeFileSync(
      join(store, 'config.yaml'),
      `index: false\nembeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n    shared: true\n    readonly: false\n`,
    )
    env = {
      PLUR_PATH: store,
      HOME: join(root, 'home'),
      CODEX_HOME: join(root, 'codex'),
    }
    mkdirSync(env.HOME, { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** Queue `n` team writes by making the remote refuse them at learn time. */
  async function queue(n: number): Promise<void> {
    const plur = new Plur({ path: store })
    server.appendErrorResponse = { status: 503, body: 'down for the test' }
    for (let i = 0; i < n; i++) {
      await plur.learnRouted(`hook outbox engram ${i}`, { scope: SCOPE, type: 'behavioral' })
    }
    await waitFor(async () => (await plur.listOutbox()).length === n
      && (await plur.listOutbox()).every(e => e.attempt_count >= 1))
    server.appendErrorResponse = null
  }

  async function pending(): Promise<number> {
    return new Plur({ path: store }).outboxCount()
  }

  const HOOKS: Array<{ name: string; args: string[]; input: string }> = [
    { name: 'Claude Code session-end', args: ['hook-session-end'], input: JSON.stringify({ session_id: 'cc-outbox-1', cwd: '' }) },
    { name: 'Codex session-end', args: ['hook-codex-session-end'], input: JSON.stringify({ session_id: 'codex-outbox-1' }) },
    { name: 'Cursor stop', args: ['hook-cursor-stop'], input: JSON.stringify({ conversation_id: 'cursor-outbox-1', status: 'completed' }) },
  ]

  for (const hook of HOOKS) {
    describe(hook.name, () => {
      it('drains the outbox when the remote is healthy', async () => {
        await queue(2)
        const r = await runCli(hook.args, { cwd: project, env, input: hook.input })
        expect(r.code, r.stderr).toBe(0)
        expect(await pending()).toBe(0)
        expect(server.engramCount).toBe(2)
      })

      it('leaves entries queued and still exits 0 when the remote fails', async () => {
        await queue(1)
        server.appendErrorResponse = { status: 500, body: 'still broken' }
        const r = await runCli(hook.args, { cwd: project, env, input: hook.input })
        expect(r.code, r.stderr).toBe(0)
        expect(await pending()).toBe(1)
      })

      it('cuts a slow remote at the budget and exits 0 promptly, entries still queued', async () => {
        await queue(2)
        server.appendDelayMs = 30_000
        const r = await runCli(hook.args, {
          cwd: project,
          env: { ...env, PLUR_HOOK_OUTBOX_FLUSH_MS: '500' },
          input: hook.input,
        })
        expect(r.code, r.stderr).toBe(0)
        // Well inside every harness budget (3s for Codex and Cursor) and far
        // short of the 30s the remote would have held the request.
        expect(r.ms).toBeLessThan(6_000)
        expect(await pending()).toBe(2)
      })
    })
  }

  it('Cursor stop fires every turn, so it retries at most once per interval', async () => {
    await queue(1)
    server.appendErrorResponse = { status: 500, body: 'still broken' }
    const first = await runCli(HOOKS[2].args, { cwd: project, env, input: HOOKS[2].input })
    expect(first.code, first.stderr).toBe(0)
    expect(await pending()).toBe(1)

    // The remote recovers, but the next turn is inside the interval: no retry,
    // so a dead store costs one flush per interval rather than one per turn.
    server.appendErrorResponse = null
    const second = await runCli(HOOKS[2].args, { cwd: project, env, input: HOOKS[2].input })
    expect(second.code, second.stderr).toBe(0)
    expect(await pending()).toBe(1)

    // Session-end hooks are not throttled.
    const end = await runCli(HOOKS[0].args, { cwd: project, env, input: HOOKS[0].input })
    expect(end.code, end.stderr).toBe(0)
    expect(await pending()).toBe(0)
  })

  it('the kill-switch turns the hook flush off', async () => {
    await queue(1)
    const r = await runCli(['hook-session-end'], {
      cwd: project,
      env: { ...env, PLUR_HOOK_OUTBOX_FLUSH: '0' },
      input: HOOKS[0].input,
    })
    expect(r.code, r.stderr).toBe(0)
    expect(await pending()).toBe(1)
  })

  it('plur sync flushes the outbox and reports it', async () => {
    await queue(2)
    const r = await runCli(['sync', '--json'], { cwd: project, env })
    expect(r.code, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!)
    expect(out.outbox).toMatchObject({ flushed: 2, pending: 0 })
    expect(await pending()).toBe(0)
  })

  it('plur sync leaves entries queued when the remote fails, and says so', async () => {
    await queue(1)
    server.appendErrorResponse = { status: 500, body: 'still broken' }
    const r = await runCli(['sync', '--json'], { cwd: project, env })
    expect(r.code, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!)
    expect(out.outbox).toMatchObject({ flushed: 0, pending: 1 })
    expect(await pending()).toBe(1)
  })

  describe('outboxMayHaveEntries (the no-load fast path)', () => {
    it('is false for a missing store and a store with no queued writes', async () => {
      expect(outboxMayHaveEntries(join(root, 'nope'))).toBe(false)
      const plur = new Plur({ path: store })
      await plur.learn('purely local', { type: 'behavioral' })
      expect(outboxMayHaveEntries(store)).toBe(false)
    })

    it('is true once a write is queued', async () => {
      await queue(1)
      expect(outboxMayHaveEntries(store)).toBe(true)
    })
  })
})
