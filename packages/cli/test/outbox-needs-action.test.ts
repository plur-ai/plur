/**
 * #1299: a queued write that can never succeed is not silent in the CLI.
 *
 * Observed: writes refused with `403 Cannot write to scope ...` on every
 * attempt for twelve days, and `plur status` and `plur doctor` stayed quiet.
 * Now `plur status`, `plur doctor` (a failing check) and `plur outbox` say how
 * many, for which scope, why, and what to do. A write that failed on the
 * network is still just queued: it does not trip doctor.
 *
 * Spawned against a real-HTTP stub; every run sets PLUR_PATH and HOME to temp
 * directories. Text mode is exercised in-process with `json: false`, because
 * a piped stdout auto-selects JSON.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { isolateGitConfig } from '../../core/test/helpers/git-isolation.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'cli-needs-action-token'
const SCOPE = 'group:example/eng'

let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

interface Ran { code: number | null; stdout: string; stderr: string }

/** Async spawn: the stub server lives in THIS process and must keep answering. */
function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('error', reject)
    child.on('close', code => { clearTimeout(killer); resolve({ code, stdout, stderr }) })
  })
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('outbox needs_action in the CLI (#1299)', () => {
  // `plur sync` commits: give the spawned git an identity and no developer config.
  isolateGitConfig()

  let root: string
  let store: string
  let env: Record<string, string>

  beforeEach(() => {
    server.reset()
    root = mkdtempSync(join(tmpdir(), 'plur-cli-needs-action-'))
    store = join(root, 'store')
    mkdirSync(store, { recursive: true })
    mkdirSync(join(root, 'home'), { recursive: true })
    writeFileSync(
      join(store, 'config.yaml'),
      `index: false\nembeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n    shared: true\n    readonly: false\n`,
    )
    env = { PLUR_PATH: store, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), CODEX_HOME: join(root, 'codex') }
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  async function queue(status: number, body: string, statement: string): Promise<void> {
    const plur = new Plur({ path: store })
    server.appendErrorResponse = { status, body }
    const e = await plur.learnRouted(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(async () => (await plur.listOutbox()).some(x => x.id === e.id && x.attempt_count >= 1))
    server.appendCalls = 0
  }

  it('plur status --json reports the needs_action count and scope', async () => {
    await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
    const r = await runCli(['status', '--json'], env, root)
    expect(r.code, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.outbox_count).toBe(1)
    expect(out.outbox_needs_action).toBe(1)
    expect(out.outbox_attention[0]).toMatchObject({ scope: SCOPE, count: 1 })
    expect(out.outbox_attention[0].reason).toMatch(/403/)
  })

  it('plur doctor fails the outbox check on a 403-refused write and exits non-zero', async () => {
    await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
    const r = await runCli(['doctor', '--no-handshake', '--json'], env, root)
    expect(r.code).toBe(1)
    const report = JSON.parse(r.stdout)
    expect(report.outbox).toMatchObject({ ok: false, needs_action: 1, pending: 1 })
    expect(report.outbox.scopes[0]).toMatchObject({ scope: SCOPE, count: 1 })
    expect(report.overall).toBe('fail')
  })

  it('plur doctor does not trip on a write that failed on the network', async () => {
    await queue(503, 'down for the test', 'transient team fact')
    const r = await runCli(['doctor', '--no-handshake', '--json'], env, root)
    const report = JSON.parse(r.stdout)
    expect(report.outbox).toMatchObject({ ok: true, needs_action: 0, retrying: 1, pending: 1 })
  })

  it('plur outbox --json classifies each entry and counts by state', async () => {
    await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
    await queue(503, 'down for the test', 'transient team fact')
    const r = await runCli(['outbox', '--json'], env, root)
    expect(r.code, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ pending: 2, retrying: 1, needs_action: 1 })
    const states = out.entries.map((e: { state: string }) => e.state).sort()
    expect(states).toEqual(['needs_action', 'retrying'])
    expect(out.needs_action_scopes[0].next_step).toMatch(/plur rescope/)
  })

  it('plur outbox --flush retries a needs_action entry despite the back-off', async () => {
    await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
    server.appendErrorResponse = null
    const r = await runCli(['outbox', '--flush', '--json'], env, root)
    expect(r.code, r.stderr).toBe(0)
    expect(server.appendCalls).toBe(1)
    expect(JSON.parse(r.stdout)).toMatchObject({ flushed: 1, pending: 0 })
  })

  it('an automatic flush (plur sync) holds it back and leaves it queued', async () => {
    await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
    server.appendErrorResponse = null
    await runCli(['sync', '--json'], env, root)
    expect(server.appendCalls).toBe(0)
    expect(await new Plur({ path: store }).outboxCount()).toBe(1)
  })

  describe('text output', () => {
    let out: string[]
    let spy: ReturnType<typeof vi.spyOn>
    const saved = process.env.PLUR_PATH
    beforeEach(() => {
      out = []
      process.env.PLUR_PATH = store
      spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true }) as never)
    })
    afterEach(() => {
      spy.mockRestore()
      if (saved === undefined) delete process.env.PLUR_PATH
      else process.env.PLUR_PATH = saved
    })

    it('plur status names the scope, the reason and the next step', async () => {
      await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
      const { run } = await import('../src/commands/status.js')
      await run([], { json: false, path: store })
      const text = out.join('')
      expect(text).toMatch(/will not deliver/)
      expect(text).toContain(SCOPE)
      expect(text).toMatch(/plur rescope/)
    })

    it('plur outbox marks the entry needs action and says what to do', async () => {
      await queue(403, `Cannot write to scope ${SCOPE}`, 'refused team fact')
      const { run } = await import('../src/commands/outbox.js')
      await run([], { json: false, path: store })
      const text = out.join('')
      expect(text).toMatch(/needs action/i)
      expect(text).toMatch(/403/)
      expect(text).toMatch(/plur rescope/)
    })
  })
})
