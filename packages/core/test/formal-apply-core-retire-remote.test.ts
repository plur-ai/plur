/**
 * Decision D1 "queue-retire" (owner, 2026-09-26).
 *
 * When a forget / local rescope lands while a push is in flight and the remote
 * ACCEPTS the engram, the local record is kept (formal WritePath candidate 1)
 * and a durable "retire on remote" entry — server id + target scope — is queued
 * on it. flushOutbox() retries it like any other push: a DELETE of that server
 * id. Idempotent (a 404 counts as done, a done entry is gone), never resurrects
 * (no POST is ever issued for it), and survives a restart (it lives in
 * engrams.yaml). learn() keeps the server id its push returned.
 *
 * Deterministic interleaving through `globalThis.fetch`; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const SCOPE = 'group:acme/team'

async function waitFor(pred: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 5))
  }
}

function gatedRemote() {
  const posts: string[] = []
  const deletes: string[] = []
  let mode: 'ok' | 'fail' | 'gate' = 'ok'
  let deleteStatus = 200
  let waiters: Array<() => void> = []
  let n = 0
  const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    if (method === 'DELETE') {
      deletes.push(decodeURIComponent(String(url).split('/engrams/')[1] ?? ''))
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({}), text: async () => (deleteStatus < 300 ? '' : 'nope') } as unknown as Response
    }
    if (method !== 'POST') {
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }
    posts.push(String(init?.body ?? ''))
    if (mode === 'fail') throw new Error('fetch failed')
    if (mode === 'gate') await new Promise<void>(r => waiters.push(r))
    return { ok: true, status: 201, json: async () => ({ id: `SRV-${++n}` }), text: async () => '' } as unknown as Response
  })
  return {
    fetchImpl, posts, deletes,
    setMode(m: 'ok' | 'fail' | 'gate') { mode = m },
    setDeleteStatus(s: number) { deleteStatus = s },
    release() { const w = waiters; waiters = []; w.forEach(f => f()) },
    pendingCount: () => waiters.length,
  }
}

describe('Decision D1 — a remote copy accepted after a local cancel is queued for retirement', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let remote: ReturnType<typeof gatedRemote>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-apply-retire-'))
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
  const retireOf = (id: string) => rowOf(id)?.structured_data?._retireRemote

  async function queued(plur: Plur, statement: string) {
    remote.setMode('fail')
    const e = await plur.learn(statement, { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => !!rowOf(e.id)?.structured_data?._outbox?.last_error, 'the failed push to be recorded')
    await new Promise(r => setTimeout(r, 30))
    remote.posts.length = 0
    return e
  }

  it('flush path: forget during the flush POST queues a retire; the next flush DELETEs it once and never re-POSTs', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact forgotten mid-flush')
    remote.setMode('gate')
    const flushing = plur.flushOutbox()
    await waitFor(() => remote.pendingCount() === 1, 'the flush POST to be in flight')
    await plur.forget(e.id, 'no longer true')
    remote.release()
    await flushing

    expect(rowOf(e.id)?.status).toBe('retired')
    expect(retireOf(e.id), 'no retire-on-remote entry was queued').toMatchObject({ server_id: 'SRV-1', target_scope: SCOPE, target_url: REMOTE })

    remote.setMode('ok')
    const res = await plur.flushOutbox()
    expect(remote.deletes).toEqual(['SRV-1'])
    expect(remote.posts, 'the retired engram was pushed again').toHaveLength(1)
    expect(retireOf(e.id), 'the done entry was not cleared').toBeUndefined()
    expect(rowOf(e.id)?.status).toBe('retired')
    expect(res.flushed).toBeGreaterThanOrEqual(1)

    await plur.flushOutbox()
    expect(remote.deletes, 'a done retirement was issued again').toEqual(['SRV-1'])
  })

  it('learn() path: learn keeps the server id, and a forget during its push queues the retire', async () => {
    const plur = new Plur({ path: dir })
    remote.setMode('gate')
    const e = await plur.learn('a team fact forgotten while its first push is on the wire', { scope: SCOPE, type: 'behavioral' })
    await waitFor(() => remote.pendingCount() === 1, 'learn()\'s push to be in flight')
    await plur.forget(e.id, 'no longer true')
    remote.release()
    await waitFor(() => !!retireOf(e.id), 'the retire entry to be queued')
    expect(retireOf(e.id)).toMatchObject({ server_id: 'SRV-1', target_scope: SCOPE })
    remote.setMode('ok')
    // The background task releases its in-flight claim just after that write;
    // a flush that runs before the release skips the row (it is claimed) and
    // the next one takes it — exactly the retry the outbox gives any entry.
    const deadline = Date.now() + 5000
    while (remote.deletes.length === 0) {
      if (Date.now() > deadline) throw new Error('no flush ever retired the remote copy')
      await plur.flushOutbox()
      if (remote.deletes.length === 0) await new Promise(r => setTimeout(r, 10))
    }
    expect(remote.deletes).toEqual(['SRV-1'])
    expect(retireOf(e.id)).toBeUndefined()
  })

  it('a failed DELETE stays queued and survives a restart; a 404 counts as done', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact whose remote retire fails at first')
    remote.setMode('gate')
    const flushing = plur.flushOutbox()
    await waitFor(() => remote.pendingCount() === 1, 'the flush POST to be in flight')
    await plur.forget(e.id, 'x')
    remote.release()
    await flushing

    remote.setMode('ok')
    remote.setDeleteStatus(500)
    await plur.flushOutbox()
    expect(remote.deletes).toEqual(['SRV-1'])
    expect(retireOf(e.id)?.attempt_count).toBe(1)
    expect(retireOf(e.id)?.last_error).toContain('500')

    // Restart: a new instance reads the entry from disk. The server already
    // lost the row (404) — idempotent: done.
    remote.setDeleteStatus(404)
    const again = new Plur({ path: dir })
    await again.flushOutbox()
    expect(remote.deletes).toEqual(['SRV-1', 'SRV-1'])
    expect(retireOf(e.id)).toBeUndefined()
    expect(remote.posts).toHaveLength(1)
  })

  it('local rescope during the flush POST also queues the retire', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact moved back to local mid-flush')
    remote.setMode('gate')
    const flushing = plur.flushOutbox()
    await waitFor(() => remote.pendingCount() === 1, 'the flush POST to be in flight')
    await plur.rescope(e.id, 'local')
    remote.release()
    await flushing
    expect(rowOf(e.id)?.scope).toBe('local')
    expect(rowOf(e.id)?.status).toBe('active')
    expect(retireOf(e.id)).toMatchObject({ server_id: 'SRV-1', target_scope: SCOPE })
  })
})
