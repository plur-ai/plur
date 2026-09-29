/**
 * Formal-verification replays, field-report cluster 5: one first-prompt run of
 * hook-inject under its watchdog (#1343/#1353/#1278).
 * Model: spec/formal/PlurSpec/R2CLI.lean §FR5.Life.
 * Findings: spec/formal/findings/r2-cli.md, "Field report cluster 5".
 *
 * In-process, with the store replaced by a stub, so the watchdog can be made to
 * fire at a chosen point: PLUR_HOOK_CEILING_MS=150, and "a store write is in
 * flight" is core's pendingStoreLockOps() > 0 (the condition under which the
 * watchdog's exit waits, up to 3s, instead of exiting at once). process.exit
 * and stdout are spied. TMPDIR / HOME / PLUR_PATH are temp dirs.
 *
 * `it.fails` marks a CONFIRMED defect (the body asserts the intended behaviour).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  busy: 0,
  stdin: '',
  fed: false,
  inject: (async () => ({})) as (task: string, opts: unknown) => Promise<unknown>,
}))

vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const readSync = ((fd: number, buf: Buffer, ...rest: unknown[]) => {
    if (fd !== 0) return (real.readSync as any)(fd, buf, ...rest)
    if (h.fed) return 0
    h.fed = true
    return buf.write(h.stdin)
  }) as typeof real.readSync
  return { ...real, default: { ...real, readSync }, readSync }
})
vi.mock('@plur-ai/core', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pendingStoreLockOps: () => h.busy,
  claimHookDegradationLines: () => [],
}))
vi.mock('../src/lib/plur-configured.js', () => ({ isPlurConfigured: () => true }))
vi.mock('../src/lib/project-remote.js', () => ({
  resolveProjectRemote: () => ({ config: {}, configDir: null, refusedFrom: null, remoteProject: null }),
  projectRemoteRefusalNotice: () => '',
}))
vi.mock('../src/plur.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createPlur: () => ({
    storageRoot: process.env.PLUR_PATH,
    inject: (t: string, o: unknown) => h.inject(t, o),
    injectHybrid: (t: string, o: unknown) => h.inject(t, o),
    remoteStoreStatus: () => [],
    remoteHealthStatePath: () => join(process.env.PLUR_PATH!, 'remote-health.json'),
    capture: () => {},
  }),
  trustedProjectScope: () => ({}),
  storeTrustCheck: () => ({}),
  getLastPlurInstance: () => null,
}))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const RESULT = { count: 1, directives: 'DIRECTIVE-c5', constraints: '', consider: '', injected_ids: [] }
const ENV = ['TMPDIR', 'HOME', 'PLUR_PATH', 'PLUR_HOOK_CEILING_MS', 'PLUR_HOOK_HYBRID', 'PLUR_AUTO_RATE', 'CLAUDE_SESSION_ID']

describe('formal field-report cluster 5 — hook-inject lifecycle under the watchdog', () => {
  let root: string
  let saved: Record<string, string | undefined>
  let out: string[]
  let exits: number
  let writeDelayMs: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-fr-c5-life-'))
    saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
    for (const d of ['tmp', 'home', 'store']) mkdirSync(join(root, d))
    Object.assign(process.env, {
      TMPDIR: join(root, 'tmp'), HOME: join(root, 'home'), PLUR_PATH: join(root, 'store'),
      PLUR_HOOK_CEILING_MS: '150', PLUR_HOOK_HYBRID: '0', PLUR_AUTO_RATE: '0',
    })
    delete process.env.CLAUDE_SESSION_ID
    h.busy = 0
    out = []
    exits = 0
    writeDelayMs = 0
    vi.spyOn(process, 'exit').mockImplementation((() => { exits++ }) as any)
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, cb?: unknown) => {
      out.push(String(chunk))
      if (typeof cb === 'function') setTimeout(() => (cb as (e?: Error) => void)(), writeDelayMs)
      return true
    }) as any)
  })

  afterEach(async () => {
    h.busy = 0
    await sleep(60) // let the watchdog's exit wait see the idle store
    vi.restoreAllMocks()
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    rmSync(root, { recursive: true, force: true })
  })

  async function start(session: string) {
    h.fed = false
    h.stdin = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'first prompt' })
    vi.resetModules()
    const mod = await import('../src/commands/hook-inject.js')
    return mod.run([], {})
  }
  const sessions = () => join(root, 'tmp', 'plur-sessions')

  it('the watchdog fires before the emit: nothing printed, no marker, no lock (Life.watchdog_before_emit_no_marker, watchdog_no_lock)', async () => {
    h.inject = async () => { h.busy = 1; await sleep(400); return RESULT }
    await start('c5-life-b')
    expect(out.join('')).toBe('')
    expect(existsSync(join(sessions(), 'c5-life-b.marker'))).toBe(false)
    expect(existsSync(join(sessions(), 'c5-life-b.injecting'))).toBe(false)
    // Counted before the work: the cap sees this attempt (Life.prompt_inv).
    expect(readFileSync(join(sessions(), 'c5-life-b.attempts'), 'utf8')).toBe('1')
  })

  // DOWNGRADED (Life.watchdog_after_handoff_marks): the write was handed to
  // stdout before the watchdog fired and its callback came after. The session
  // is marked although the run was stopped — but the context was delivered
  // (Life.marker_needs_delivery), so the marker is true.
  it('a context handed to stdout before the stop is delivered and marked', async () => {
    writeDelayMs = 400
    h.inject = async () => { h.busy = 1; return RESULT }
    await start('c5-life-c')
    expect(out.join('')).toContain('DIRECTIVE-c5')
    expect(existsSync(join(sessions(), 'c5-life-c.marker'))).toBe(true)
    expect(existsSync(join(sessions(), 'c5-life-c.injecting'))).toBe(false)
  })

  // CONFIRMED (Life.stopped_throw_prints): the watchdog fires while a store
  // write is in flight, so its exit waits; the injection then throws. run()
  // rejects before the exit, and the CLI dispatcher (src/index.ts) prints
  // `{"error": …}` on stdout and exits 1 — a stopped run that prints, and a hook
  // error in the editor. Intended: a stopped run settles without output.
  it.fails('a stopped run whose injection then throws hands the dispatcher nothing to print', async () => {
    h.inject = async () => { h.busy = 1; await sleep(400); throw new Error('store write failed') }
    const outcome = await start('c5-life-a').then(() => 'settled', () => 'rejected')
    expect({ outcome, exitsBefore: exits, printed: out.join('') }).toEqual({ outcome: 'settled', exitsBefore: 0, printed: '' })
  })
})
