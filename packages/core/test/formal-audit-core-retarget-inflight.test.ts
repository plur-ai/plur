/**
 * Audit of #1228, finding 1 (MEDIUM): an engram retargeted to another store
 * (decision D4 — updateEngram changes the scope of a queued row, so `_outbox`
 * now points at store B) while its push to the OLD store A is on the wire must
 * not be lost.
 *
 * Before the fix both hand-off paths (learn()'s immediate push and
 * flushOutbox()'s merge-back) only asked "does the fresh row still carry
 * `_outbox`?" — it did (for B), so the row was dropped as handed off: B never
 * received it, A holds it under the old scope, no retire was queued.
 *
 * The hand-off now requires the fresh `_outbox` to target the SAME store the
 * push went to. Otherwise the row is kept (still queued for B) and the copy A
 * accepted is queued for retirement (decision D1); the next flush retires it
 * and then delivers to B.
 *
 * Deterministic interleaving through `globalThis.fetch`; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE_A = 'https://a.example.com/sse'
const REMOTE_B = 'https://b.example.com/sse'
const SCOPE_A = 'group:acme/team'
const SCOPE_B = 'group:acme/ops'

async function waitFor(pred: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 5))
  }
}

function gatedRemote() {
  const posts: Array<{ host: string; scope: unknown }> = []
  const deletes: Array<{ host: string; id: string }> = []
  let mode: 'ok' | 'fail' | 'gate' = 'ok'
  let waiters: Array<() => void> = []
  let n = 0
  const hostOf = (url: string) => new URL(url).host
  const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    if (method === 'DELETE') {
      deletes.push({ host: hostOf(String(url)), id: decodeURIComponent(String(url).split('/engrams/')[1] ?? '') })
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as unknown as Response
    }
    if (method !== 'POST') {
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }
    if (mode === 'fail') throw new Error('fetch failed')
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(String(init?.body ?? '{}')) } catch { /* not json */ }
    posts.push({ host: hostOf(String(url)), scope: body.scope })
    if (mode === 'gate') {
      await new Promise<void>(r => waiters.push(r))
      // Switching to 'fail' before release() fails the gated POST itself.
      // `mode` is reassigned by setMode() while this POST is parked, so the
      // widening cast only undoes TypeScript's narrowing from the check above.
      if ((mode as 'ok' | 'fail' | 'gate') === 'fail') throw new Error('fetch failed')
    }
    return { ok: true, status: 201, json: async () => ({ id: `SRV-${++n}` }), text: async () => '' } as unknown as Response
  })
  return {
    fetchImpl, posts, deletes,
    setMode(m: 'ok' | 'fail' | 'gate') { mode = m },
    release() { const w = waiters; waiters = []; w.forEach(f => f()) },
    pendingCount: () => waiters.length,
  }
}

describe('audit #1228 finding 1 — a D4 retarget during an in-flight push is not lost', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let remote: ReturnType<typeof gatedRemote>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-audit-retarget-'))
    originalFetch = globalThis.fetch
    remote = gatedRemote()
    globalThis.fetch = remote.fetchImpl as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [
        { url: REMOTE_A, token: 'tokA', scope: SCOPE_A, shared: true, readonly: false },
        { url: REMOTE_B, token: 'tokB', scope: SCOPE_B, shared: true, readonly: false },
      ],
      index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const rowOf = (id: string): any => {
    const p = join(dir, 'engrams.yaml')
    if (!existsSync(p)) return undefined
    const doc = yaml.load(readFileSync(p, 'utf8')) as { engrams?: any[] } | null
    return (doc?.engrams ?? []).find(e => e.id === id)
  }

  async function retargetToB(plur: Plur, id: string) {
    const row = (await plur.getById(id))!
    row.scope = SCOPE_B
    expect(await plur.updateEngram(row)).toBe(true)
    expect(rowOf(id)?.structured_data?._outbox).toMatchObject({ target_scope: SCOPE_B, target_url: REMOTE_B })
  }

  /** Flush until B has the engram and A's stray copy is retired (the in-flight claim may defer one pass). */
  async function drain(plur: Plur) {
    remote.setMode('ok')
    const deadline = Date.now() + 5000
    while (!(remote.posts.some(p => p.host === 'b.example.com') && remote.deletes.length > 0)) {
      if (Date.now() > deadline) break
      await plur.flushOutbox()
      await new Promise(r => setTimeout(r, 10))
    }
  }

  function expectDelivered(id: string) {
    expect(remote.posts.filter(p => p.host === 'b.example.com'), 'store B never received the retargeted engram')
      .toEqual([{ host: 'b.example.com', scope: SCOPE_B }])
    expect(remote.deletes, 'the copy store A accepted was not retired').toEqual([{ host: 'a.example.com', id: 'SRV-1' }])
    expect(rowOf(id), 'the local row outlived its delivery to B').toBeUndefined()
  }

  it('(a) learn() immediate push: retarget to B during the POST to A keeps the row queued for B and retires A\'s copy', async () => {
    const plur = new Plur({ path: dir })
    remote.setMode('gate')
    const e = await plur.learn('a team fact that turns out to belong to ops', { scope: SCOPE_A, type: 'behavioral' })
    await waitFor(() => remote.pendingCount() === 1, 'learn()\'s push to A to be in flight')
    await retargetToB(plur, e.id)
    remote.release()
    await waitFor(() => !!rowOf(e.id)?.structured_data?._retireRemote || !rowOf(e.id), 'the push to A to settle')

    const row = rowOf(e.id)
    expect(row, 'the retargeted row was dropped as if B had it').toBeDefined()
    expect(row.scope).toBe(SCOPE_B)
    expect(row.structured_data?._outbox).toMatchObject({ target_scope: SCOPE_B, target_url: REMOTE_B })
    expect(row.structured_data?._retireRemote).toMatchObject({ server_id: 'SRV-1', target_scope: SCOPE_A, target_url: REMOTE_A })

    await drain(plur)
    expectDelivered(e.id)
  })

  it('(b) flushOutbox: retarget to B during the flush POST to A keeps the row queued for B and retires A\'s copy', async () => {
    const plur = new Plur({ path: dir })
    remote.setMode('fail')
    const e = await plur.learn('a queued team fact that turns out to belong to ops', { scope: SCOPE_A, type: 'behavioral' })
    await waitFor(() => !!rowOf(e.id)?.structured_data?._outbox?.last_error, 'the failed push to be recorded')
    await new Promise(r => setTimeout(r, 30))

    remote.setMode('gate')
    const flushing = plur.flushOutbox()
    await waitFor(() => remote.pendingCount() === 1, 'the flush POST to A to be in flight')
    await retargetToB(plur, e.id)
    remote.release()
    const res = await flushing

    const row = rowOf(e.id)
    expect(row, 'the retargeted row was dropped as if B had it').toBeDefined()
    expect(row.scope).toBe(SCOPE_B)
    expect(row.structured_data?._outbox).toMatchObject({ target_scope: SCOPE_B, target_url: REMOTE_B })
    expect(row.structured_data?._retireRemote).toMatchObject({ server_id: 'SRV-1', target_scope: SCOPE_A, target_url: REMOTE_A })
    expect(res.expired_warnings.join('\n')).toContain(e.id)

    await drain(plur)
    expectDelivered(e.id)
  })

  it('a failed push to A while the row was retargeted keeps the retarget (the snapshot does not re-point it at A)', async () => {
    const plur = new Plur({ path: dir })
    remote.setMode('fail')
    const e = await plur.learn('a queued team fact retargeted during a failing flush', { scope: SCOPE_A, type: 'behavioral' })
    await waitFor(() => !!rowOf(e.id)?.structured_data?._outbox?.last_error, 'the failed push to be recorded')
    await new Promise(r => setTimeout(r, 30))

    // Gate, retarget, then fail the gated POST.
    remote.setMode('gate')
    const flushing = plur.flushOutbox()
    await waitFor(() => remote.pendingCount() === 1, 'the flush POST to A to be in flight')
    await retargetToB(plur, e.id)
    remote.setMode('fail')
    remote.release()
    await flushing
    const row = rowOf(e.id)
    expect(row.scope).toBe(SCOPE_B)
    expect(row.structured_data?._outbox, 'the failed flush re-pointed the row at A')
      .toMatchObject({ target_scope: SCOPE_B, target_url: REMOTE_B, attempt_count: 0 })
    expect(row.structured_data?._retireRemote).toBeUndefined()

    remote.setMode('ok')
    remote.posts.length = 0
    await plur.flushOutbox()
    expect(remote.posts).toEqual([{ host: 'b.example.com', scope: SCOPE_B }])
    expect(rowOf(e.id)).toBeUndefined()
  })
})
