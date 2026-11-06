/**
 * Security audit 2026-11-06: an outbox flush loads the store once, then
 * pushes queued rows one by one. A same-scope content edit of a still-queued
 * team engram that landed while an earlier row's POST was in flight kept the
 * same `_outbox.idempotency_key`, so the flush POSTed the PRE-edit snapshot
 * under that key and the merge-back then dropped the edited local row as
 * "delivered". The withdrawn text reached the team store and the edit was
 * lost everywhere.
 *
 * The fix binds the queued write to its content: a same-scope content edit
 * of a queued row is a new logical write with a new key.
 *
 * In-process `globalThis.fetch` stub only — no sockets, dummy data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://team.example.invalid/sse'
const SCOPE = 'group:acme/eng'

async function waitFor(pred: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 5))
  }
}

function gatedRemote() {
  const posts: string[] = []
  let mode: 'ok' | 'fail' | 'gate' = 'ok'
  let waiters: Array<() => void> = []
  let n = 0
  const fetchImpl = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    if (method !== 'POST') {
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }
    if (mode === 'fail') throw new Error('fetch failed')
    posts.push(String(init?.body ?? ''))
    if (mode === 'gate') await new Promise<void>(r => waiters.push(r))
    return { ok: true, status: 201, json: async () => ({ id: `SRV-${++n}` }), text: async () => '' } as unknown as Response
  })
  return {
    fetchImpl,
    posts,
    setMode(m: 'ok' | 'fail' | 'gate') { mode = m },
    release() { const w = waiters; waiters = []; w.forEach(f => f()) },
    pendingCount: () => waiters.length,
  }
}

describe('outbox flush vs a same-scope edit of a queued row (security audit 2026-11-06)', () => {
  let root: string
  let dir: string
  let prevHome: string | undefined
  let prevPlurPath: string | undefined
  let originalFetch: typeof globalThis.fetch
  let remote: ReturnType<typeof gatedRemote>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-outbox-edit-'))
    prevHome = process.env.HOME
    prevPlurPath = process.env.PLUR_PATH
    process.env.HOME = join(root, 'home')
    mkdirSync(process.env.HOME, { recursive: true })
    dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    process.env.PLUR_PATH = dir
    originalFetch = globalThis.fetch
    remote = gatedRemote()
    globalThis.fetch = remote.fetchImpl as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'dummy-tok', scope: SCOPE, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.HOME = prevHome
    if (prevPlurPath === undefined) delete process.env.PLUR_PATH
    else process.env.PLUR_PATH = prevPlurPath
    rmSync(root, { recursive: true, force: true })
  })

  const rowOf = (id: string): any => {
    const p = join(dir, 'engrams.yaml')
    if (!existsSync(p)) return undefined
    const doc = yaml.load(readFileSync(p, 'utf8')) as { engrams?: any[] } | null
    return (doc?.engrams ?? []).find(e => e.id === id)
  }

  async function queued(plur: Plur, statement: string) {
    remote.setMode('fail')
    const e = await plur.learn(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => !!rowOf(e.id)?.structured_data?._outbox?.last_error, 'the background push to record its failure')
    await new Promise(r => setTimeout(r, 30))
    return e
  }

  it('never pushes the pre-edit text and keeps the edited row queued for delivery', async () => {
    const plur = new Plur({ path: dir })
    const a = await queued(plur, 'Dummy alpha fact about builds')
    const b = await queued(plur, 'Dummy beta fact naming DummyCustomerX')
    remote.posts.length = 0

    remote.setMode('gate')
    const flushing = plur.flushOutbox({ force: true })
    await waitFor(() => remote.pendingCount() === 1, 'the first flush POST to be in flight')
    // Edit whichever row is NOT the one parked on the wire.
    const parked = remote.posts[0]
    const target = parked.includes('DummyCustomerX') ? a : b
    const original = target.id === a.id ? 'Dummy alpha fact about builds' : 'Dummy beta fact naming DummyCustomerX'
    const edited = target.id === a.id ? 'Dummy alpha fact (redacted)' : 'Dummy beta fact (redacted)'
    const current = await plur.getById(target.id)
    expect(await plur.updateEngram({ ...current!, statement: edited })).toBe(true)
    expect(rowOf(target.id).statement).toBe(edited)

    remote.setMode('ok')
    remote.release()
    await flushing

    const pushedText = remote.posts.join('\n')
    expect(pushedText, 'the pre-edit text reached the team store').not.toContain(original)
    const after = rowOf(target.id)
    expect(after, 'the edited local row was dropped').toBeDefined()
    expect(after.statement).toBe(edited)
    expect(after.structured_data?._outbox, 'the edited row is no longer queued').toBeDefined()

    // The next flush delivers the edited text.
    await plur.flushOutbox({ force: true })
    expect(remote.posts.join('\n')).toContain(edited)
    expect(remote.posts.join('\n')).not.toContain(original)
  })

  it('a same-scope content edit of a queued row mints a new idempotency key; a no-op update does not', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'Dummy gamma fact')
    const key0 = rowOf(e.id).structured_data._outbox.idempotency_key
    expect(key0).toBeTruthy()

    await plur.updateEngram({ ...(await plur.getById(e.id))! })
    expect(rowOf(e.id).structured_data._outbox.idempotency_key).toBe(key0)

    await plur.updateEngram({ ...(await plur.getById(e.id))!, statement: 'Dummy gamma fact, revised' })
    const key1 = rowOf(e.id).structured_data._outbox.idempotency_key
    expect(key1).toBeTruthy()
    expect(key1).not.toBe(key0)
  })
})
