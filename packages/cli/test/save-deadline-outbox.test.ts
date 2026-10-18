/**
 * Save deadline, outbox fallback and remote probes (0.21.1 release blocker).
 *
 * Investigation 2026-10-02 (write routing and an expired team token), items
 * 1, 2, 2a, 3 and the CLI half of 6. Every case runs the BUILT CLI as a real
 * child process against an isolated HOME and PLUR_PATH, and against stub
 * servers on 127.0.0.1 that live in this process:
 *
 *   - `hang`  accepts the connection and never answers;
 *   - `401`   answers 401 to everything;
 *   - StubServer (200) for the id-collision cases.
 *
 * The invariants:
 *
 *   2a. A team-scope save while the server hangs ends in the local outbox,
 *       reported as `delivery: "outbox"` with the reason, exit 0, within a
 *       bounded time. Before: the CLI raced the whole save against 5 s and
 *       `process.exit(1)`ed while core was still waiting on its 30 s request,
 *       so the engram was written nowhere.
 *   2.  A local save that takes longer than 5 s returns its id, exit 0, and
 *       leaves no store lock behind.
 *   1.  An unregistered `project:` scope makes zero requests to any server.
 *   3.  `plur forget <local id>` is not blocked by a 401 from a remote (warns
 *       instead), and a hanging remote is refused quickly, without holding the
 *       store lock, naming `--scope primary`.
 *   6.  The CLI learn reports the namespaced id for a team save; `plur
 *       feedback` takes `--scope` and refuses unknown flags and stray args.
 *
 * Spawns are ASYNC: the stubs live in this process, and a spawnSync would
 * block the event loop so no stub could answer (see forget-namespaced.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import type { Socket } from 'net'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { storePrefix } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const SLOW_LOCK = join(__dirname, 'helpers', 'slow-store-lock.mjs')
const TOKEN = 'save-deadline-token'
const TEAM = 'group:test'
const PREFIX = storePrefix(TEAM)
const SPAWN_KILL_MS = 90_000
const TEST_TIMEOUT_MS = 180_000

interface Run { status: number; stdout: string; stderr: string; ms: number }

/** A server that counts requests and either answers 401 or never answers. */
interface CountingServer { url: string; requests: string[]; close: () => Promise<void> }

async function startCountingServer(mode: '401' | 'hang'): Promise<CountingServer> {
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`)
    if (mode === '401') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid or expired token' }))
    }
    // hang: never answer
  })
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  }
}

describe('save deadline, outbox fallback and remote probes (0.21.1)', () => {
  let root: string
  let plurDir: string
  let home: string
  let hang: CountingServer
  let unauth: CountingServer
  let stub: StubServer
  let stubUrl: string

  beforeAll(async () => {
    hang = await startCountingServer('hang')
    unauth = await startCountingServer('401')
    stub = new StubServer(TOKEN)
    stubUrl = (await stub.start()).url
  })
  afterAll(async () => {
    await hang.close()
    await unauth.close()
    await stub.stop()
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-save-deadline-'))
    plurDir = join(root, 'plur')
    home = join(root, 'home')
    mkdirSync(plurDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    hang.requests.length = 0
    unauth.requests.length = 0
    stub.reset()
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function writeConfig(stores: Array<{ url: string; scope: string }>): void {
    const body = stores.length === 0 ? '' : 'stores:\n' + stores.map(s =>
      `  - url: "${s.url}"\n    token: "${TOKEN}"\n    scope: "${s.scope}"\n`).join('')
    writeFileSync(join(plurDir, 'config.yaml'), `embeddings:\n  enabled: false\n${body}`)
  }

  function cli(args: string[], opts: { preload?: string; env?: Record<string, string> } = {}): Promise<Run> {
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const nodeArgs = [...(opts.preload ? ['--import', opts.preload] : []), CLI, ...args, '--path', plurDir]
      const child = spawn('node', nodeArgs, {
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: plurDir, ...(opts.env ?? {}) },
        cwd: root,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`plur ${args.join(' ')} timed out after ${SPAWN_KILL_MS}ms; stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`))
      }, SPAWN_KILL_MS)
      child.stdout.on('data', d => { stdout += String(d) })
      child.stderr.on('data', d => { stderr += String(d) })
      child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - started })
      })
    })
  }

  const yamlText = (): string => {
    const p = join(plurDir, 'engrams.yaml')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }
  const lockLeft = (): boolean => existsSync(join(plurDir, 'engrams.yaml.lock'))

  async function learnLocal(statement: string): Promise<string> {
    const r = await cli(['learn', statement, '--scope', 'global', '--json'])
    expect(r.status, `learn failed: ${r.stdout} ${r.stderr}`).toBe(0)
    return JSON.parse(r.stdout).id as string
  }

  // -------------------------------------------------------------------------
  // 2a. A hanging team server: the save lands in the outbox, never nowhere.
  // -------------------------------------------------------------------------

  it('2a: a team save against a hanging server is queued in the outbox, exit 0, bounded', async () => {
    writeConfig([{ url: hang.url, scope: TEAM }])
    const statement = 'Team note written while the server hangs'
    const r = await cli(['learn', statement, '--scope', TEAM, '--json'])
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.delivery).toBe('outbox')
    expect(out.delivery_reason_code).toBe('unreachable')
    expect(String(out.delivery_reason)).toMatch(/unreachable/i)
    expect(typeof out.id).toBe('string')
    // Written locally, with the outbox marker, under the id reported.
    const yaml = yamlText()
    expect(yaml).toContain(statement)
    expect(yaml).toContain('_outbox')
    expect(yaml).toContain(out.id)
    expect(hang.requests.some(q => q.startsWith('POST'))).toBe(true)
    expect(lockLeft()).toBe(false)
    // Bounded: well under core's old 30 s request budget.
    expect(r.ms).toBeLessThan(25_000)
  }, TEST_TIMEOUT_MS)

  it('2a: a team save against a 401 server is queued with the token reason, in --json and text', async () => {
    writeConfig([{ url: unauth.url, scope: TEAM }])
    const r = await cli(['learn', 'Team note with an expired token', '--scope', TEAM, '--json'])
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.delivery).toBe('outbox')
    expect(out.delivery_reason_code).toBe('auth_rejected')
    expect(String(out.delivery_reason)).toMatch(/token/i)
    expect(String(out.delivery_reason)).toContain('plur login')
    expect(lockLeft()).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('2a: text output says where the save landed and why it was queued, even with --quiet', async () => {
    writeConfig([{ url: unauth.url, scope: TEAM }])
    const out: string[] = []
    const { vi } = await import('vitest')
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true }) as never)
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const { run: learn } = await import('../src/commands/learn.js')
      await learn(['Team note in text mode', '--scope', TEAM], { path: plurDir, json: false, quiet: true })
    } finally {
      spy.mockRestore()
      process.env.HOME = prevHome
    }
    const text = out.join('')
    expect(text).toMatch(/Queued/)
    expect(text).toMatch(/outbox/)
    expect(text).toMatch(/token/i)
    expect(text).toContain('plur login')
  }, TEST_TIMEOUT_MS)

  it('a confirmed team save reports delivery "remote" and the namespaced id (item 6)', async () => {
    writeConfig([{ url: stubUrl, scope: TEAM }])
    const r = await cli(['learn', 'Team note the server accepts', '--scope', TEAM, '--json'])
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.delivery).toBe('remote')
    expect(out.id).toMatch(new RegExp(`^ENG-${PREFIX}-`))
    expect(out.delivery_reason).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  // -------------------------------------------------------------------------
  // 2. A slow LOCAL save is a success, not a timeout, and leaves no lock.
  // -------------------------------------------------------------------------

  it('2: a local save that takes longer than 5 s returns its id, exit 0, and leaves no lock', async () => {
    writeConfig([])
    const statement = 'Local note in a slow store'
    // The preload holds the store lock 6 s after acquiring it: the save is
    // correct and slow, exactly like a 13k-engram store on a loaded host.
    const r = await cli(['learn', statement, '--scope', 'global', '--json'], {
      preload: SLOW_LOCK, env: { PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS: '6000' },
    })
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.id).toMatch(/^ENG-/)
    expect(out.delivery).toBe('local')
    expect(yamlText()).toContain(statement)
    expect(lockLeft()).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('2: a save into a synthetic 13,000-engram store returns its id, exit 0, no lock left', async () => {
    writeConfig([])
    const lines = ['engrams:']
    const words = ['deploy', 'billing', 'cache', 'queue', 'schema', 'review', 'release', 'index', 'token', 'budget']
    for (let i = 1; i <= 13_000; i++) {
      lines.push(
        `  - id: ENG-2026-0901-${String(i).padStart(5, '0')}`, '    version: 2', '    status: active',
        '    consolidated: false', '    type: behavioral', '    scope: global', '    visibility: private',
        `    statement: "Rule ${i}: prefer ${words[i % 10]} ${words[(i * 7) % 10]} handling in module ${i % 97}"`,
        '    commitment: leaning',
        "    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-09-01' }",
        '    feedback_signals: { positive: 0, negative: 0, neutral: 0 }', '    associations: []',
        '    derivation_count: 1', '    tags: []', '    pack: null', '    abstract: null', '    derived_from: null',
        '    reference_count: 1', '    sources: []')
    }
    writeFileSync(join(plurDir, 'engrams.yaml'), lines.join('\n') + '\n')
    const statement = 'Local note in a very large store'
    const r = await cli(['learn', statement, '--scope', 'global', '--json'])
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.id).toMatch(/^ENG-/)
    expect(yamlText()).toContain(statement)
    expect(lockLeft()).toBe(false)
  }, TEST_TIMEOUT_MS)

  // -------------------------------------------------------------------------
  // 1. An unregistered project scope never dials a server.
  // -------------------------------------------------------------------------

  it('1: an unregistered project: scope makes zero remote requests and saves locally', async () => {
    writeConfig([
      { url: hang.url, scope: TEAM },
      { url: unauth.url, scope: 'group:test/product' },
      { url: unauth.url, scope: 'project:test/registered' },
    ])
    const r = await cli(['learn', 'Lesson for an unregistered project', '--scope', 'project:example/unregistered', '--json'])
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.delivery).toBe('local')
    expect(out.scope).toBe('project:example/unregistered')
    expect(yamlText()).toContain('Lesson for an unregistered project')
    expect(hang.requests).toEqual([])
    expect(unauth.requests).toEqual([])
  }, TEST_TIMEOUT_MS)

  // -------------------------------------------------------------------------
  // 3. forget: a 401 does not block; a hang refuses quickly and lock-free.
  // -------------------------------------------------------------------------

  it('3: forget <local id> with a 401 remote retires locally and warns about the rejected token', async () => {
    writeConfig([])
    const id = await learnLocal('Local engram to retire past a 401')
    writeConfig([{ url: unauth.url, scope: TEAM }])
    const r = await cli(['forget', id, '--json'])
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.success).toBe(true)
    expect(out.retired.id).toBe(id)
    expect(JSON.stringify(out.warnings ?? [])).toMatch(/token/i)
    expect(JSON.stringify(out.warnings ?? [])).toContain(TEAM)
    expect(yamlText()).toMatch(/status: retired/)
  }, TEST_TIMEOUT_MS)

  it('3: forget <local id> with a hanging remote refuses quickly, names --scope primary, and does not hold the lock', async () => {
    writeConfig([])
    const id = await learnLocal('Local engram probed against a hanging remote')
    writeConfig([{ url: hang.url, scope: TEAM }])
    const forgetRun = cli(['forget', id, '--json'])
    // While the probe waits on the hanging server, another writer must get the
    // store lock: the probe runs outside it.
    await new Promise(r => setTimeout(r, 1500))
    const learnStarted = Date.now()
    const other = await cli(['learn', 'A concurrent local save', '--scope', 'global', '--json'])
    const learnDone = Date.now()
    const f = await forgetRun
    expect(other.status, `${other.stdout} ${other.stderr}`).toBe(0)
    expect(f.status).toBe(1)
    const err = JSON.parse(f.stdout).error as string
    expect(err).toContain('--scope primary')
    expect(err).not.toMatch(/HTTP 401/)
    expect(f.ms).toBeLessThan(20_000)
    // The concurrent save did not queue behind the forget.
    expect(learnDone - learnStarted).toBeLessThan(f.ms)
    expect(yamlText()).not.toMatch(/status: retired/)
    // And the escape hatch works.
    const ok = await cli(['forget', id, '--scope', 'primary', '--json'])
    expect(ok.status, `${ok.stdout} ${ok.stderr}`).toBe(0)
  }, TEST_TIMEOUT_MS)

  // -------------------------------------------------------------------------
  // 6. feedback --scope; refusing what it does not understand.
  // -------------------------------------------------------------------------

  it('6: feedback --scope primary rates a local engram whose id also exists remotely', async () => {
    writeConfig([])
    const id = await learnLocal('Local engram whose id collides with a team one')
    stub.seedEngram({ id, scope: TEAM, status: 'active', data: { statement: 'unrelated team engram', type: 'behavioral' } })
    writeConfig([{ url: stubUrl, scope: TEAM }])
    // Bare id, no scope: ambiguous, refused.
    const amb = await cli(['feedback', id, 'positive', '--json'])
    expect(amb.status).toBe(1)
    // With --scope primary: rated locally.
    const r = await cli(['feedback', id, 'positive', '--scope', 'primary', '--json'])
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ id, signal: 'positive', status: 'recorded', scope: 'primary' })
    expect(stub.feedbackBodies.length).toBe(0)
  }, TEST_TIMEOUT_MS)

  it('F4: feedback --batch honours --scope and a per-item scope', async () => {
    writeConfig([])
    const id = await learnLocal('Local engram rated in a batch')
    stub.seedEngram({ id, scope: TEAM, status: 'active', data: { statement: 'unrelated team engram', type: 'behavioral' } })
    writeConfig([{ url: stubUrl, scope: TEAM }])
    const batch = JSON.stringify([{ id, signal: 'positive' }])
    const r = await cli(['feedback', '--batch', batch, '--scope', 'primary', '--json'])
    expect(r.status, `${r.stdout} ${r.stderr}`).toBe(0)
    expect(JSON.parse(r.stdout).results[0]).toMatchObject({ id, success: true })
    // Per item: the item's own scope wins.
    const perItem = JSON.stringify([{ id, signal: 'negative', scope: 'primary' }])
    const r2 = await cli(['feedback', '--batch', perItem, '--json'])
    expect(r2.status, `${r2.stdout} ${r2.stderr}`).toBe(0)
    expect(stub.feedbackBodies.length).toBe(0)
  }, TEST_TIMEOUT_MS)

  it('R2: plur recall shows a team engram whose bare id X is also local; after a 401, plur forget X refuses and names --scope primary', async () => {
    writeConfig([])
    const id = await learnLocal('Local engram sharing its id with a team engram')
    stub.recallRows = [{ id, scope: TEAM, status: 'active', statement: 'Unrelated team engram about canaries', score: 1 }]
    writeConfig([{ url: stubUrl, scope: TEAM }])
    const rec = await cli(['recall', 'canaries', '--scope', TEAM, '--json'])
    expect(rec.status, `${rec.stdout} ${rec.stderr}`).toBe(0)
    // Recall names the team row by its namespaced id, the id a save returns
    // (#1568); the bare id below is the one the local engram also has.
    expect(JSON.parse(rec.stdout).results.some((r: { id: string; scope: string }) => r.id === `ENG-${storePrefix(TEAM)}-${id.slice(4)}` && r.scope === TEAM)).toBe(true)
    writeConfig([{ url: unauth.url, scope: TEAM }])
    const f = await cli(['forget', id, '--json'])
    expect(f.status).toBe(1)
    expect(JSON.parse(f.stdout).error).toContain('--scope primary')
    expect(yamlText()).not.toMatch(/status: retired/)
  }, TEST_TIMEOUT_MS)

  it('6: feedback refuses an unknown flag and a stray extra argument', async () => {
    writeConfig([])
    const id = await learnLocal('Local engram for argument checks')
    const flag = await cli(['feedback', id, 'positive', '--scop', 'primary'])
    expect(flag.status).toBe(1)
    expect(flag.stderr + flag.stdout).toMatch(/--scop/)
    const extra = await cli(['feedback', id, 'positive', 'oops'])
    expect(extra.status).toBe(1)
    expect(extra.stderr + extra.stdout).toMatch(/oops/)
  }, TEST_TIMEOUT_MS)
})
