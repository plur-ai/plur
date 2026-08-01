/**
 * Hook path × server-authoritative recall (#776, plan A2′/A4′).
 *
 * The former remote-first `tryRemoteInject` POST /api/v1/inject path is
 * REPLACED by the recall leg inside `injectHybrid`. Pinned here, against a
 * real-HTTP stub server from a real spawned hook process:
 *
 *   - the hook makes AT MOST ONE remote call per host per prompt (a degraded
 *     host must not cost two sequential remote budgets)
 *   - it dials POST /api/v1/recall (not /inject) with the 1500ms hook budget
 *     threaded through as `timeout_ms`
 *   - `.plur.yaml` remote_url/remote_token is the org context for dialing
 *   - PLUR_REMOTE_RECALL=off → zero remote calls from the hook
 *   - a degraded host prints ONE [PLUR] header line on state change, and the
 *     suppression state persists ACROSS hook processes (second spawned run
 *     stays silent)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const CLI = join(__dirname, '..', 'dist', 'index.js')
const TOKEN = 'hook-recall-token'
const SCOPE = 'group:test'

let server: StubServer
let baseUrl: string

describe('hook-inject × remote recall (#776)', () => {
  let dir: string
  let runIdx = 0

  beforeAll(async () => {
    server = new StubServer(TOKEN)
    const info = await server.start()
    baseUrl = info.url
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-hook-rr-'))
    server.reset()
    mkdirSync(join(dir, '.plur'), { recursive: true })
    writeFileSync(
      join(dir, '.plur', 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`,
    )
    // .plur.yaml: project scope (org 'test' → implicates the store above) AND
    // the remote_url/remote_token project opt-in. Its presence also satisfies
    // isPlurConfigured for the spawned hook.
    writeFileSync(
      join(dir, '.plur.yaml'),
      `scope: project:test/app\nremote_url: ${baseUrl}\nremote_token: ${TOKEN}\n`,
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // ASYNC spawn, deliberately: the StubServer lives in THIS process, and a
  // spawnSync would block the event loop for the child's whole lifetime — the
  // stub could never accept the child's connection and every hook dial would
  // read as a timeout (the deadlock is the harness's, not the hook's).
  function runHook(extraEnv: Record<string, string> = {}): Promise<{ stdout: string; status: number }> {
    // Fresh TMPDIR per invocation: the session marker is keyed on ppid, and a
    // reused marker turns the second run into a reminder no-op.
    const tmp = join(dir, `tmp-${runIdx++}`)
    mkdirSync(tmp, { recursive: true })
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, 'hook-inject'], {
        env: {
          ...process.env,
          HOME: dir,
          USERPROFILE: dir,
          TMPDIR: tmp,
          PLUR_PATH: join(dir, '.plur'),
          ...extraEnv,
        },
        cwd: dir,
      })
      let stdout = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`hook-inject timed out; partial stdout: ${stdout.slice(0, 400)}`))
      }, 20000)
      child.stdout.on('data', (d) => { stdout += String(d) })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ stdout, status: code ?? 1 })
      })
      child.stdin.write(JSON.stringify({ prompt: 'what are the deployment conventions' }))
      child.stdin.end()
    })
  }

  it('makes exactly ONE remote call per host per prompt, to /recall, with the 1500ms budget', async () => {
    server.recallRows = [{
      id: 'ENG-2026-0731-070', scope: SCOPE, status: 'active',
      statement: 'deployment conventions require canary verification', score: 1,
    }]
    const { stdout, status } = await runHook()
    expect(status).toBe(0)
    // ≤1 remote call per host per prompt — the replaced tryRemoteInject path
    // must NOT fire a second budget.
    expect(server.recallCalls).toBe(1)
    // Opts threading: hook budget 1500ms reaches the wire as timeout_ms.
    expect(server.lastRecallBody?.timeout_ms).toBe(1500)
    // The server row made it into the injected context.
    expect(stdout).toContain('PLUR Memory')
    expect(stdout).toContain('canary verification')
  })

  it('PLUR_REMOTE_RECALL=off → zero remote calls from the hook', async () => {
    server.recallRows = [{
      id: 'ENG-2026-0731-071', scope: SCOPE, status: 'active',
      statement: 'should never be fetched', score: 1,
    }]
    const { status } = await runHook({ PLUR_REMOTE_RECALL: 'off' })
    expect(status).toBe(0)
    expect(server.recallCalls).toBe(0)
  })

  it('degraded host prints ONE [PLUR] header line, suppressed across hook processes', async () => {
    server.recallStatus = 500
    const first = await runHook()
    expect(first.status).toBe(0)
    expect(first.stdout).toMatch(/\[PLUR\] .*unreachable — team memory skipped/)

    // Second one-shot process, same state: the suppression marker persisted
    // in remote-health.json keeps the header out of the next prompt.
    const second = await runHook()
    expect(second.status).toBe(0)
    expect(second.stdout).not.toMatch(/unreachable — team memory skipped/)
  })

  it('a healthy host prints no degradation header', async () => {
    server.recallRows = []
    const { stdout, status } = await runHook()
    expect(status).toBe(0)
    expect(stdout).not.toContain('[PLUR] ')
  })
})
