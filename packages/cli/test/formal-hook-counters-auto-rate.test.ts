import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * spec/formal/PlurSpec/HookCounters.lean §3, findings/hook-counters.md.
 * The hook's branches with its collaborators stubbed: which turn reaches the
 * worker, and whether the inline fallback may wait on a lock.
 */

const h = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>,
  spawnOk: true,
  cursorFolder: { policy: { mode: 'on', scope: undefined as string | undefined }, dir: '/ws/alpha' as string | null },
  enqueue: vi.fn((_o: unknown) => true),
  spawn: vi.fn((..._a: unknown[]) => true),
  worker: vi.fn(async (..._a: unknown[]) => ({ rated: [], captured: 0 })),
}))

vi.mock('../src/lib/codex-hook-io.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  readStdinJson: () => h.payload,
  runCodexHook: async (_n: string, body: () => Promise<void>) => { await body() },
}))
vi.mock('../src/lib/folder-gate.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  hookFolderOn: () => true,
  cursorHookFolder: () => h.cursorFolder,
}))
vi.mock('../src/lib/auto-rate.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  enqueueTurn: (o: unknown) => h.enqueue(o),
  hasLeftoverBatches: () => false,
  spawnWorker: (...a: unknown[]) => { h.spawn(...a); return h.spawnOk },
  runWorker: (...a: unknown[]) => h.worker(...a),
}))

import { run } from '../src/commands/hook-auto-rate.js'

beforeEach(() => {
  h.enqueue.mockClear(); h.spawn.mockClear(); h.worker.mockClear()
  h.spawnOk = true
  h.cursorFolder = { policy: { mode: 'on', scope: undefined }, dir: '/ws/alpha' }
})

describe('hook-auto-rate run', () => {
  it('when the worker cannot start, the turn is rated inline without waiting on a lock', async () => {
    h.payload = { session_id: 's1', last_assistant_message: 'Done.', cwd: '/ws/alpha' }
    h.spawnOk = false
    await run(['claude'], {} as never)
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.worker).toHaveBeenCalledTimes(1)
    expect(h.worker.mock.calls[0].slice(0, 2)).toEqual(['claude', 's1'])
    expect(h.worker.mock.calls[0][3]).toEqual({ waitForLockMs: 0 })
  })

  it('when the worker starts, nothing runs inline', async () => {
    h.payload = { session_id: 's2', last_assistant_message: 'Done.', cwd: '/ws/alpha' }
    await run(['claude'], {} as never)
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.worker).not.toHaveBeenCalled()
  })

  it('Cursor: the queued turn carries the scope decided for the whole workspace, or an explicit none', async () => {
    h.payload = { conversation_id: 'c1', text: 'Done.', workspace_roots: ['/ws/alpha', '/ws/beta'] }
    h.cursorFolder = { policy: { mode: 'on', scope: 'project:alpha' }, dir: '/ws/alpha' }
    await run(['cursor'], {} as never)
    expect(h.enqueue.mock.calls[0][0]).toMatchObject({ editor: 'cursor', sessionId: 'c1', cwd: '/ws/alpha', workspaceScope: 'project:alpha' })

    h.cursorFolder = { policy: { mode: 'on', scope: undefined }, dir: '/ws/alpha' }
    await run(['cursor'], {} as never)
    expect(h.enqueue.mock.calls[1][0]).toMatchObject({ workspaceScope: null })
  })

  it('Cursor: a workspace that is not on queues nothing', async () => {
    h.payload = { conversation_id: 'c2', text: 'Done.' }
    h.cursorFolder = { policy: { mode: 'off', scope: undefined }, dir: '/ws/alpha' }
    await run(['cursor'], {} as never)
    h.cursorFolder = { policy: { mode: 'on', scope: undefined }, dir: null }
    await run(['cursor'], {} as never)
    expect(h.enqueue).not.toHaveBeenCalled()
  })
})

describe('runWorker inline (waitForLockMs 0)', () => {
  let tmp: string
  let savedTmp: string | undefined
  let real: typeof import('../src/lib/auto-rate.js')
  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'plur-hc-inline-')))
    savedTmp = process.env.TMPDIR
    process.env.TMPDIR = tmp
    real = await vi.importActual<typeof import('../src/lib/auto-rate.js')>('../src/lib/auto-rate.js')
  })
  afterAll(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp
    rmSync(tmp, { recursive: true, force: true })
  })

  it('leaves at once even while a live older worker holds the lock and a .queue-ws turn is pending', async () => {
    const dir = real.autoRateDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const queueWs = join(dir, 'cursor-inl.queue-ws')
    writeFileSync(queueWs, JSON.stringify({ reply: 'Done.', workspaceScope: null }) + '\n', { mode: 0o600 })
    const lock = join(dir, 'cursor-inl.worker')
    writeFileSync(lock, `${process.pid}:older-worker`)
    const release = setTimeout(() => { try { unlinkSync(lock) } catch { /* gone */ } }, 3000)
    const t0 = Date.now()
    try {
      await real.runWorker('cursor', 'inl', { path: join(tmp, 'store') } as never, { waitForLockMs: 0 })
    } finally {
      clearTimeout(release)
      try { unlinkSync(lock) } catch { /* gone */ }
    }
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(existsSync(queueWs)).toBe(true)
  }, 20_000)
})
