/**
 * Formal-verification replay (spec/formal/PlurSpec/WritePath.lean, candidate 1):
 * outbox delivery races.
 *
 * Every test here drives a deterministic interleaving through the code's own
 * seam — `globalThis.fetch` — by holding a remote POST open until the test
 * releases it. Nothing talks to a real service.
 *
 *   A. learn()'s fire-and-forget push is in flight when flushOutbox() runs:
 *      the flush picked the same row (attempt_count 0) and POSTed it again, so
 *      the remote received the engram twice.
 *   B. flushOutbox() pushes a queued engram, and forget() retires it while the
 *      POST is in flight: the merge-back dropped the row unconditionally, so the
 *      local retirement was erased and nothing recorded that the remote now holds
 *      a live copy of a forgotten engram (#766).
 *   C. flushOutbox()'s push FAILS while a rescope (or forget) cancels the queue
 *      entry: the merge-back copied the stale `_outbox` snapshot over the
 *      cancellation, re-queueing delivery to the store the engram was moved away
 *      from (#848).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const SCOPE = 'group:acme/team'

async function waitFor(pred: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 5))
  }
}

/** A fake remote whose POSTs block until released, succeeding or failing on command. */
function gatedRemote() {
  const posts: string[] = []
  let mode: 'ok' | 'fail' | 'gate' = 'ok'
  let waiters: Array<() => void> = []
  let gateOutcome: 'ok' | 'fail' = 'ok'
  let n = 0
  const ok = () => ({ ok: true, status: 201, json: async () => ({ id: `SRV-${++n}` }), text: async () => '' }) as unknown as Response
  const fetchImpl = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    if (method !== 'POST') {
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }
    posts.push(String(init?.body ?? ''))
    if (mode === 'fail') throw new Error('fetch failed')
    if (mode === 'gate') {
      await new Promise<void>(r => waiters.push(r))
      if (gateOutcome === 'fail') throw new Error('fetch failed')
    }
    return ok()
  })
  return {
    fetchImpl,
    posts,
    setMode(m: 'ok' | 'fail' | 'gate') { mode = m },
    release(outcome: 'ok' | 'fail') { gateOutcome = outcome; const w = waiters; waiters = []; w.forEach(f => f()) },
    pendingCount: () => waiters.length,
  }
}

describe('formal WritePath — outbox delivery races (candidate 1)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let remote: ReturnType<typeof gatedRemote>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-outbox-'))
    originalFetch = globalThis.fetch
    remote = gatedRemote()
    globalThis.fetch = remote.fetchImpl as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: SCOPE, shared: true, readonly: false }],
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

  /** Learn while the store is down, so the engram sits queued with attempt_count 1. */
  async function queued(plur: Plur, statement: string) {
    remote.setMode('fail')
    const e = await plur.learn(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => !!rowOf(e.id)?.structured_data?._outbox?.last_error, 'the background push to record its failure')
    // The background task releases its in-flight claim just after that write.
    await new Promise(r => setTimeout(r, 30))
    remote.posts.length = 0
    return e
  }

  it('A: a flush during learn()\'s in-flight push does not POST the same engram twice', async () => {
    const plur = new Plur({ path: dir })
    remote.setMode('gate')
    const e = await plur.learn('a team fact whose first push is slow', { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => remote.posts.length === 1, 'learn()\'s background push to reach the remote')

    const flushing = plur.flushOutbox()
    // Give the flush every chance to issue its own POST before releasing.
    await new Promise(r => setTimeout(r, 50))
    remote.release('ok')
    await flushing
    await waitFor(() => rowOf(e.id) === undefined, 'the local copy to be handed off')

    expect(remote.posts.length, 'the remote received the same engram twice').toBe(1)
  })

  it('B: a forget() landing while the flush POST is in flight is not erased (#766)', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact the user forgets mid-flush')

    remote.setMode('gate')
    const flushing = plur.flushOutbox()
    await waitFor(() => remote.pendingCount() === 1, 'the flush POST to be in flight')
    await plur.forget(e.id, 'no longer true')
    expect(rowOf(e.id)?.status, 'precondition: forget retired the row').toBe('retired')
    remote.release('ok')
    const res = await flushing

    const after = rowOf(e.id)
    expect(after, 'the flush deleted the local retirement record').toBeDefined()
    expect(after.status).toBe('retired')
    expect(after.structured_data?._outbox, 'a retired engram was re-queued').toBeUndefined()
    expect(res.expired_warnings.join('\n'), 'the live remote copy of a forgotten engram went unreported')
      .toContain(e.id)
  })

  it('B2: a forget() landing while learn()\'s own push is in flight is not erased (#766)', async () => {
    const plur = new Plur({ path: dir })
    remote.setMode('gate')
    const e = await plur.learn('a team fact forgotten before its first push lands', { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => remote.pendingCount() === 1, 'learn()\'s push to be in flight')
    await plur.forget(e.id)
    remote.release('ok')
    await new Promise(r => setTimeout(r, 100))

    const after = rowOf(e.id)
    expect(after, 'learn()\'s hand-off deleted the local retirement record').toBeDefined()
    expect(after.status).toBe('retired')
  })

  it('C: a rescope landing while a flush push FAILS keeps its cancellation (#848)', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact moved to a local scope mid-flush')

    remote.setMode('gate')
    const flushing = plur.flushOutbox()
    await waitFor(() => remote.pendingCount() === 1, 'the flush POST to be in flight')
    const { results } = await plur.rescope(e.id, 'global')
    expect(results[0].status).toBe('rescoped')
    expect(rowOf(e.id)?.structured_data?._outbox, 'precondition: rescope cancelled the queue entry').toBeUndefined()
    remote.release('fail')
    await flushing

    const after = rowOf(e.id)
    expect(after.scope).toBe('global')
    expect(after.structured_data?._outbox, 'the flush re-queued delivery to the store the engram left').toBeUndefined()
  })

  it('C2: a forget landing while a flush push FAILS is not re-queued', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact forgotten while its retry fails')

    remote.setMode('gate')
    const flushing = plur.flushOutbox()
    await waitFor(() => remote.pendingCount() === 1, 'the flush POST to be in flight')
    await plur.forget(e.id)
    remote.release('fail')
    await flushing

    const after = rowOf(e.id)
    expect(after.status).toBe('retired')
    expect(after.structured_data?._outbox, 'a retired engram regained its queue entry').toBeUndefined()
  })

  it('good case stays reachable: a queued engram with no interference is handed off once', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact that eventually lands')
    remote.setMode('ok')
    const res = await plur.flushOutbox()
    expect(res.flushed).toBe(1)
    expect(remote.posts.length).toBe(1)
    expect(rowOf(e.id)).toBeUndefined()
  })
})
