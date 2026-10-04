/**
 * #1318 review — the end-of-turn auto-rate hook against a remote store.
 *
 * 4. A remote engram injected this session is rated from a FRESH hook process
 *    (the remote cache is empty there), but only when the server advertises
 *    `feedback.source`; a server without it is never even asked for the engram.
 * 5. Each rated id is recorded as soon as it is rated, so a watchdog that
 *    kills the hook mid-way does not lose the verdicts already sent.
 *
 * The StubServer lives in THIS process, so the hook is spawned ASYNC (a
 * spawnSync would block the event loop and the stub could never answer).
 * HOME, PLUR_PATH and TMPDIR are temp dirs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn, spawnSync } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { RemoteStore } from '../../core/src/store/remote-store.js'
import { namespaceEngramId, loadEngrams } from '../../core/src/engrams.js'
import { builtCliPath } from './helpers/built-cli.js'
import { trustDirectory } from '@plur-ai/core'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'auto-rate-remote-token'
const SCOPE = 'group:test'
const REMOTE_STATEMENT = 'Team rule: tag every release candidate with the sprint number'
const LOCAL_STATEMENT = 'Local rule: keep the changelog entries in plain language'

let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

describe('hook-auto-rate × remote store (#1318 review)', { timeout: 120_000 }, () => {
  let root: string
  let project: string
  let env: NodeJS.ProcessEnv
  let remoteId: string

  beforeEach(async () => {
    server.reset()
    server.setMe({ capabilities: [] })
    root = mkdtempSync(join(tmpdir(), 'plur-auto-rate-remote-'))
    project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    mkdirSync(join(root, 'home'), { recursive: true })
    mkdirSync(join(root, 'tmp'), { recursive: true })
    mkdirSync(join(root, '.plur'), { recursive: true })
    writeFileSync(join(project, '.plur.yaml'), '# test project\n')
    writeFileSync(join(root, '.plur', 'engrams.yaml'), 'engrams: []\n')
    // JSON is valid YAML, so config.yaml needs no YAML serializer here.
    writeFileSync(join(root, '.plur', 'config.yaml'), JSON.stringify({
      embeddings: { enabled: false },
      stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, readonly: false }],
      index: false,
    }))
    env = {
      ...process.env,
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      PLUR_PATH: join(root, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
    delete env.PLUR_AUTO_RATE
    delete env.PLUR_AUTO_CAPTURE
    await new RemoteStore(baseUrl, TOKEN, SCOPE, { ttlMs: 0 })
      .append({ id: 'tmp', scope: SCOPE, status: 'active', statement: REMOTE_STATEMENT } as any)
    remoteId = namespaceEngramId('ENG-SRV-001', SCOPE)
    server.meCalls = 0
    server.getByIdCalls = 0
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    server.setMe({ capabilities: [] })
  })

  const rateDir = () => join(root, 'tmp', 'plur-auto-rate')
  function injected(sessionId: string, ids: string[]): void {
    mkdirSync(rateDir(), { recursive: true, mode: 0o700 })
    writeFileSync(join(rateDir(), `claude-${sessionId}.injected`), ids.join('\n') + '\n', { mode: 0o600 })
  }
  function rated(sessionId: string): string[] {
    const p = join(rateDir(), `claude-${sessionId}.rated`)
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
  }

  /**
   * Wait until the auto-rate work for this test has finished: no queued turn
   * and no worker running. The hook may hand its work to a background
   * worker; assertions about the store must wait for it.
   */
  async function idle(timeoutMs = 45_000): Promise<void> {
    const t0 = Date.now()
    for (;;) {
      const busy = existsSync(rateDir()) && readdirSync(rateDir()).some(f => /\.(queue|worker)/.test(f))
      if (!busy) return
      if (Date.now() - t0 > timeoutMs) throw new Error(`auto-rate still busy: ${readdirSync(rateDir()).join(', ')}`)
      await new Promise(r => setTimeout(r, 100))
    }
  }

  function spawnAsync(args: string[], input: unknown, extraEnv: Record<string, string> = {}, cwd = project): Promise<{ code: number; stdout: string; ms: number }> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv }, cwd })
      let stdout = ''
      child.stdout.on('data', d => { stdout += String(d) })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${args[0]} did not exit`)) }, 30_000)
      child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, ms: Date.now() - t0 }) })
      child.on('error', err => { clearTimeout(timer); reject(err) })
      child.stdin.end(JSON.stringify(input))
    })
  }

  async function stop(sessionId: string, reply: string, extraEnv: Record<string, string> = {}): Promise<number> {
    const r = await spawnAsync(['hook-auto-rate', 'claude'], { hook_event_name: 'Stop', session_id: sessionId, cwd: project, last_assistant_message: reply }, extraEnv)
    await idle()
    return r.code
  }

  it('rates a remote engram from a fresh process when the server has feedback.source', async () => {
    server.setMe({ capabilities: ['feedback.source'] })
    injected('r-1', [remoteId])
    expect(await stop('r-1', `Following the team note: ${REMOTE_STATEMENT}.`)).toBe(0)
    expect(server.feedbackBodies).toEqual([{ signal: 'positive', source: 'auto' }])
    expect(rated('r-1')).toContain(remoteId)
  })

  it('never fetches or rates a remote engram when the server lacks the capability', async () => {
    injected('r-2', [remoteId])
    expect(await stop('r-2', `Following the team note: ${REMOTE_STATEMENT}.`)).toBe(0)
    expect(server.feedbackBodies).toEqual([])
    expect(server.getByIdCalls).toBe(0)
  })

  it('a slow store never holds up the hook, and each verdict is applied at most once (audit M1/F5)', async () => {
    server.setMe({ capabilities: ['feedback.source'] })
    server.feedbackDelayMs = 6_000 // the remote rating is slow
    const learn = spawnSync(process.execPath, [CLI, 'learn', LOCAL_STATEMENT, '--scope', 'global'], { env, cwd: project, encoding: 'utf8' })
    expect(learn.status, learn.stderr).toBe(0)
    const localId = loadEngrams(join(root, '.plur', 'engrams.yaml'))
      .find(e => e.statement === LOCAL_STATEMENT)!.id
    injected('r-3', [localId, remoteId])
    const reply = `Done. ${LOCAL_STATEMENT}. Also: ${REMOTE_STATEMENT}.`
    const payload = { hook_event_name: 'Stop', session_id: 'r-3', cwd: project, last_assistant_message: reply }
    const hook = await spawnAsync(['hook-auto-rate', 'claude'], payload)
    expect(hook.code).toBe(0)
    // The hook returned before the slow remote call finished.
    expect(server.feedbackBodies).toEqual([])
    expect(hook.ms).toBeLessThan(6_000)
    await idle()
    expect(server.feedbackBodies).toEqual([{ signal: 'positive', source: 'auto' }])
    const localAfter = () => loadEngrams(join(root, '.plur', 'engrams.yaml')).find(e => e.id === localId) as any
    expect(localAfter().feedback_signals.positive).toBe(1)
    // The same reply again: nothing is applied twice.
    server.feedbackDelayMs = 0
    await spawnAsync(['hook-auto-rate', 'claude'], payload)
    await idle()
    expect(localAfter().feedback_signals.positive).toBe(1)
    expect(server.feedbackBodies).toHaveLength(1)
    expect(existsSync(join(root, '.plur', 'engrams.yaml.lock'))).toBe(false)
  }, 90_000)

  it('a worker killed while a verdict is in flight never applies it twice (write-ahead)', async () => {
    server.setMe({ capabilities: ['feedback.source'] })
    server.feedbackDelayMs = 12_000
    injected('wa-1', [remoteId])
    const payload = { hook_event_name: 'Stop', session_id: 'wa-1', cwd: project, last_assistant_message: `Per the team rule: ${REMOTE_STATEMENT}.` }
    // The worker's guard fires while the (slow) remote feedback call is in flight.
    await spawnAsync(['hook-auto-rate', 'claude'], payload, { PLUR_AUTO_RATE_WORKER_CEILING_MS: '6000' })
    // Wait for the stub to finish the request the killed worker sent.
    const t0 = Date.now()
    while (server.feedbackBodies.length === 0 && Date.now() - t0 < 30_000) await new Promise(r => setTimeout(r, 200))
    expect(server.feedbackBodies).toHaveLength(1)
    // The next turn finds the killed worker's lock and batch and takes them over.
    server.feedbackDelayMs = 0
    await spawnAsync(['hook-auto-rate', 'claude'], payload)
    await idle()
    expect(server.feedbackBodies).toHaveLength(1)
  })

  describe('auto-capture scope (audit adversarial M3)', () => {
    const CAPTURE_REPLY = 'Done.\n\n---\n🧠 I learned:\n- My private notes about the contract dispute live in the home folder\n---\n'

    it('an untrusted .plur.yaml cannot send captured reply text to a team store', async () => {
      writeFileSync(join(project, '.plur.yaml'), `scope: ${SCOPE}\n`)
      server.lastAppendBody = null
      await stop('cap-1', CAPTURE_REPLY, { PLUR_AUTO_CAPTURE: '1' })
      expect(server.lastAppendBody).toBeNull()
      expect(server.engramCount).toBe(1) // only the seeded engram
      // Under the folder map (#1347) an untrusted .plur.yaml makes the folder
      // "ask": every hook but the one question is silent, so nothing is
      // captured at all, locally or remotely, until the user decides.
      const local = loadEngrams(join(root, '.plur', 'engrams.yaml')) as any[]
      const captured = local.find((x: any) => /contract dispute/.test(x.statement))
      expect(captured).toBeUndefined()
    }, 60_000)

    it('a trusted folder mapped to the team scope may capture there', async () => {
      writeFileSync(join(project, '.plur.yaml'), `scope: ${SCOPE}\n`)
      trustDirectory(project, join(root, '.plur'))
      server.lastAppendBody = null
      await stop('cap-2', CAPTURE_REPLY, { PLUR_AUTO_CAPTURE: '1' })
      expect(String((server.lastAppendBody as Record<string, unknown> | null)?.statement ?? '')).toMatch(/contract dispute/)
    }, 60_000)
  })

  it('end to end: a team engram injected by hook-inject (remote recall) is rated by the Stop hook (audit H1)', async () => {
    server.setMe({ capabilities: ['feedback.source'] })
    // Remote recall serves the seeded team engram; the project opts into the
    // remote and is trusted, as `plur init-remote` + `plur trust` would do.
    server.recallRows = [{ id: 'ENG-SRV-001', scope: SCOPE, status: 'active', statement: REMOTE_STATEMENT, score: 1 }]
    writeFileSync(join(project, '.plur.yaml'), `scope: project:test/app\nremote_url: ${baseUrl}\nremote_token: ${TOKEN}\n`)
    trustDirectory(project, join(root, '.plur'))
    const inj = await spawnAsync(['hook-inject'], { hook_event_name: 'UserPromptSubmit', session_id: 'e2e-1', prompt: 'how do we tag a release candidate for the sprint' })
    expect(inj.code).toBe(0)
    expect(inj.stdout).toContain('sprint number')
    expect(readFileSync(join(rateDir(), 'claude-e2e-1.injected'), 'utf8')).toContain(remoteId)
    expect(await stop('e2e-1', `Per the team rule: ${REMOTE_STATEMENT}. Tagged.`)).toBe(0)
    expect(server.feedbackBodies).toEqual([{ signal: 'positive', source: 'auto' }])
  }, 90_000)
})
