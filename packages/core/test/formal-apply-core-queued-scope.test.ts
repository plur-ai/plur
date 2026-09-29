/**
 * Decisions D3 "no-widen" and D4 "like-rescope" (owner, 2026-09-26): nothing
 * changes the scope of a row still carrying `_outbox` behind the queue's back.
 *
 *  - D3: cross-scope recurrence never widens a queued row; the recurrence is
 *    recorded without changing its scope (same rule as a remote-resident hit),
 *    so the team store still receives it under its own scope.
 *  - D4: updateEngram changing the scope of a queued row behaves like rescope
 *    (#848): to a local-family scope → the pending delivery is cancelled; to a
 *    scope with a writable url store → `_outbox` is retargeted after the leak
 *    guard ran against the new scope; otherwise → cancelled with a warning.
 *
 * Fake remote via mocked fetch; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const REMOTE2 = 'https://other.example.com/sse'
const SCOPE = 'group:acme/team'
const SCOPE2 = 'group:acme/ops'

describe('Decisions D3 / D4 — a queued row keeps a scope its queue entry agrees with', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let posts: Array<{ url: string; body: Record<string, unknown> }>
  let fail: boolean

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-apply-queued-'))
    originalFetch = globalThis.fetch
    posts = []
    fail = true
    globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        if (fail) throw new Error('fetch failed')
        posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
        return { ok: true, status: 201, json: async () => ({ id: `SRV-${posts.length}` }), text: async () => '' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }) as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [
        { url: REMOTE, token: 'tok', scope: SCOPE, shared: true, readonly: false },
        { url: REMOTE2, token: 'tok2', scope: SCOPE2, shared: true, readonly: false },
        { url: REMOTE2, token: 'tok2', scope: 'group:acme/readonly', shared: true, readonly: true },
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

  async function queued(plur: Plur, statement: string) {
    const e = await plur.learn(statement, { scope: SCOPE, type: 'behavioral' })
    const deadline = Date.now() + 5000
    while (!rowOf(e.id)?.structured_data?._outbox?.last_error) {
      if (Date.now() > deadline) throw new Error('never queued')
      await new Promise(r => setTimeout(r, 5))
    }
    await new Promise(r => setTimeout(r, 30))
    return e
  }

  it('D3: a second cross-scope hit records the recurrence but does not widen the queued row', async () => {
    const plur = new Plur({ path: dir })
    const statement = 'retry idempotent POSTs at most three times'
    const e = await queued(plur, statement)
    await plur.learn(statement, { scope: 'project:alpha', type: 'behavioral' })
    await plur.learn(statement, { scope: 'project:beta', type: 'behavioral' })
    const row = rowOf(e.id)
    expect(row.recurrence_count, 'the recurrence was not recorded').toBe(2)
    expect(row.scope, 'a queued row was widened').toBe(SCOPE)
    expect(row.structured_data?._outbox?.target_scope).toBe(SCOPE)

    fail = false
    const res = await plur.flushOutbox()
    expect(res.flushed).toBe(1)
    expect(posts.map(p => p.body.scope)).toEqual([SCOPE])
    expect(res.expired_warnings.join('\n')).not.toContain('NOT pushed')
  })

  it('D3 control: an unqueued shared row still widens to global on the second hit', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false }))
    const plur = new Plur({ path: dir })
    const statement = 'a project fact that recurs everywhere'
    const e = await plur.learn(statement, { scope: 'project:one', type: 'behavioral' })
    await plur.learn(statement, { scope: 'project:alpha', type: 'behavioral' })
    await plur.learn(statement, { scope: 'project:beta', type: 'behavioral' })
    expect(rowOf(e.id).scope).toBe('global')
  })

  it('D4: updateEngram to a local-family scope cancels the pending delivery', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact the user moves to local by editing it')
    const row = (await plur.getById(e.id))!
    row.scope = 'local'
    expect(await plur.updateEngram(row)).toBe(true)
    expect(rowOf(e.id).scope).toBe('local')
    expect(rowOf(e.id).structured_data?._outbox, 'the delivery to the team store is still queued').toBeUndefined()

    fail = false
    const res = await plur.flushOutbox()
    expect(posts).toEqual([])
    expect(res.expired_warnings.join('\n')).not.toContain(e.id)
  })

  it('D4: updateEngram to a scope with a writable url store retargets the queue entry', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact that belongs to ops')
    const row = (await plur.getById(e.id))!
    row.scope = SCOPE2
    expect(await plur.updateEngram(row)).toBe(true)
    expect(rowOf(e.id).structured_data?._outbox).toMatchObject({ target_scope: SCOPE2, target_url: REMOTE2 })

    fail = false
    const res = await plur.flushOutbox()
    expect(res.flushed).toBe(1)
    expect(posts.map(p => [p.url.startsWith('https://other.example.com'), p.body.scope])).toEqual([[true, SCOPE2]])
  })

  it('D4: the leak guard runs against the new scope before retargeting', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'the staging box is reachable over the vpn')
    const row = (await plur.getById(e.id))!
    row.scope = SCOPE2
    row.statement = 'my prod box is 139.59.155.82'
    expect(await plur.updateEngram(row)).toBe(true)
    const after = rowOf(e.id)
    expect(after.scope, 'the guard did not demote').toBe('local')
    expect(after.structured_data?._outbox, 'a demoted row stayed queued').toBeUndefined()
    fail = false
    await plur.flushOutbox()
    expect(posts).toEqual([])
  })

  it('D4: updateEngram to a scope with no writable url store cancels with a warning', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact moved to a readonly scope')
    const row = (await plur.getById(e.id))!
    row.scope = 'group:acme/readonly'
    expect(await plur.updateEngram(row)).toBe(true)
    expect(rowOf(e.id).scope).toBe('group:acme/readonly')
    expect(rowOf(e.id).structured_data?._outbox).toBeUndefined()
    fail = false
    await plur.flushOutbox()
    expect(posts).toEqual([])
  })

  it('D4: an update that keeps the scope leaves the queue entry alone', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact whose wording is corrected')
    const row = (await plur.getById(e.id))!
    row.statement = 'a team fact whose wording was corrected'
    expect(await plur.updateEngram(row)).toBe(true)
    expect(rowOf(e.id).structured_data?._outbox?.target_scope).toBe(SCOPE)
  })
})
