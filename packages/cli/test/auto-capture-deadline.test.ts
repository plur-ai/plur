/**
 * #1532 review F3: the hook auto-capture team save is bounded below the
 * inline watchdog.
 *
 * When the detached worker cannot be spawned, `hook-auto-rate` runs the turn
 * inline under a 9 s watchdog that exits once the store is idle. The team POST
 * runs OUTSIDE the store lock, so to that watchdog the store looks idle while
 * the request hangs — and an exit there loses the captured statement (not on
 * the server, not local, not in the outbox). The save must reach the outbox
 * well inside the watchdog instead.
 *
 * In-process: the hanging server lives in this process and the code under
 * test only awaits (no spawnSync), so it can be dialled.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'
import type { Socket } from 'net'
import { Plur, trustDirectory } from '@plur-ai/core'
import { autoRateTurn, enqueueTurn, runWorker, AUTO_CAPTURE_REMOTE_TIMEOUT_MS } from '../src/lib/auto-rate.js'

const TEAM = 'group:test'
/** The inline watchdog in hook-auto-rate (WATCHDOG_CEILING). */
const INLINE_WATCHDOG_MS = 9_000
const REPLY = 'Done.\n\n---\n🧠 I learned:\n- Release candidates are tagged with the sprint number before the demo\n---\n'

describe('auto-capture team save is bounded below the inline watchdog (#1532 F3)', () => {
  let server: Server
  let url: string
  const sockets = new Set<Socket>()
  let root: string
  const saved: Record<string, string | undefined> = {}

  beforeAll(async () => {
    server = createServer(() => { /* never answer */ })
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const a = server.address()
    if (!a || typeof a === 'string') throw new Error('no address')
    url = `http://127.0.0.1:${a.port}`
  })
  afterAll(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())) })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-capture-deadline-'))
    for (const k of ['HOME', 'USERPROFILE', 'TMPDIR', 'PLUR_PATH', 'PLUR_AUTO_CAPTURE', 'PLUR_AUTO_RATE']) saved[k] = process.env[k]
    mkdirSync(join(root, 'home'), { recursive: true })
    mkdirSync(join(root, 'tmp'), { recursive: true })
    mkdirSync(join(root, '.plur'), { recursive: true })
    mkdirSync(join(root, 'project'), { recursive: true })
    process.env.HOME = join(root, 'home')
    process.env.USERPROFILE = join(root, 'home')
    process.env.TMPDIR = join(root, 'tmp')
    process.env.PLUR_PATH = join(root, '.plur')
    process.env.PLUR_AUTO_CAPTURE = '1'
    delete process.env.PLUR_AUTO_RATE
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(root, { recursive: true, force: true })
  })

  it('several captured statements share ONE server budget that fits inside the watchdog (re-audit R4)', async () => {
    const plurPath = join(root, '.plur')
    writeFileSync(join(plurPath, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(plurPath, 'config.yaml'), JSON.stringify({
      embeddings: { enabled: false }, index: false,
      stores: [{ url, token: 't', scope: TEAM, readonly: false }],
    }))
    const project = join(root, 'project')
    writeFileSync(join(project, '.plur.yaml'), `scope: ${TEAM}\n`)
    trustDirectory(project, plurPath)
    const plur = new Plur({ path: plurPath })
    await plur.ready()
    const reply = 'Done.\n\n---\n🧠 I learned:\n'
      + '- Release candidates are tagged with the sprint number before the demo\n'
      + '- Database migrations run in a separate deploy step from the code change\n'
      + '- Feature flags are removed within two sprints of full rollout\n'
      + '- The staging cluster is rebuilt from scratch every Monday morning\n---\n'
    const t0 = Date.now()
    const outcome = await autoRateTurn({ editor: 'claude', sessionId: 'cap-multi', reply, flags: { path: plurPath }, cwd: project, plur })
    const ms = Date.now() - t0
    expect(outcome.captured).toBe(4)
    expect(ms).toBeLessThan(INLINE_WATCHDOG_MS - 2_000)
    const yaml = readFileSync(join(plurPath, 'engrams.yaml'), 'utf8')
    expect((yaml.match(/_outbox:/g) ?? []).length).toBe(4)
  }, 60_000)

  it('S5: several queued turns drained in one hook run share ONE server budget', async () => {
    const plurPath = join(root, '.plur')
    writeFileSync(join(plurPath, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(plurPath, 'config.yaml'), JSON.stringify({
      embeddings: { enabled: false }, index: false,
      stores: [{ url, token: 't', scope: TEAM, readonly: false }],
    }))
    const project = join(root, 'project')
    writeFileSync(join(project, '.plur.yaml'), `scope: ${TEAM}\n`)
    trustDirectory(project, plurPath)
    const session = `cap-run-${process.pid}-${Date.now()}`
    const turn = (a: string, b: string) => `Done.\n\n---\n🧠 I learned:\n- ${a}\n- ${b}\n---\n`
    expect(enqueueTurn({ editor: 'claude', sessionId: session, cwd: project,
      reply: turn('Release candidates are tagged with the sprint number', 'Database migrations run in their own deploy step') })).toBe(true)
    expect(enqueueTurn({ editor: 'claude', sessionId: session, cwd: project,
      reply: turn('Feature flags are removed within two sprints of rollout', 'The staging cluster is rebuilt every Monday morning') })).toBe(true)
    const t0 = Date.now()
    const total = await runWorker('claude', session, { path: plurPath })
    const ms = Date.now() - t0
    expect(total.captured).toBe(4)
    expect(ms).toBeLessThan(INLINE_WATCHDOG_MS - 2_000)
    const yaml = readFileSync(join(plurPath, 'engrams.yaml'), 'utf8')
    expect((yaml.match(/_outbox:/g) ?? []).length).toBe(4)
  }, 60_000)

  it('the deadline is shorter than the watchdog', () => {
    expect(AUTO_CAPTURE_REMOTE_TIMEOUT_MS).toBeLessThan(INLINE_WATCHDOG_MS - 3_000)
  })

  it('a hanging team server: the captured statement is in the outbox before the watchdog would fire', async () => {
    const plurPath = join(root, '.plur')
    writeFileSync(join(plurPath, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(plurPath, 'config.yaml'), JSON.stringify({
      embeddings: { enabled: false }, index: false,
      stores: [{ url, token: 't', scope: TEAM, readonly: false }],
    }))
    const project = join(root, 'project')
    writeFileSync(join(project, '.plur.yaml'), `scope: ${TEAM}\n`)
    trustDirectory(project, plurPath)
    const plur = new Plur({ path: plurPath })
    await plur.ready()
    const t0 = Date.now()
    const outcome = await autoRateTurn({ editor: 'claude', sessionId: 'cap-deadline', reply: REPLY, flags: { path: plurPath }, cwd: project, plur })
    const ms = Date.now() - t0
    expect(outcome.captured).toBe(1)
    expect(ms).toBeLessThan(INLINE_WATCHDOG_MS - 2_000)
    const yaml = readFileSync(join(plurPath, 'engrams.yaml'), 'utf8')
    expect(yaml).toContain('sprint number')
    expect(yaml).toContain('_outbox')
  }, 60_000)
})
