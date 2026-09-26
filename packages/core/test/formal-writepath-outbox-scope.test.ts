/**
 * Formal-verification replay (spec/formal/PlurSpec/WritePath.lean, candidate 2):
 * the invariant `_outbox ⇒ scope = _outbox.target_scope`.
 *
 * Only rescope() maintained it (#848). Two other writers change `scope` on a
 * queued row and leave `_outbox` naming the old target:
 *   - updateEngram() (public API) writes the caller's row as-is;
 *   - cross-scope recurrence (#176) broadens a shared scope to 'global'.
 * flushOutbox() then POSTed the row — carrying its NEW scope — to the OLD
 * target store. The fake remote records every POST body; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const SCOPE = 'group:acme/team'

describe('formal WritePath — a queued row is only delivered under its target scope (candidate 2)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let posts: Array<Record<string, unknown>>
  let fail: boolean

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-obscope-'))
    originalFetch = globalThis.fetch
    posts = []
    fail = true
    globalThis.fetch = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        if (fail) throw new Error('fetch failed')
        posts.push(JSON.parse(String(init?.body ?? '{}')))
        return { ok: true, status: 201, json: async () => ({ id: `SRV-${posts.length}` }), text: async () => '' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }) as never
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

  it('updateEngram moving a queued row to another scope: the flush does not POST it to the old store', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact the user re-scopes by editing the row')
    const row = (await plur.getById(e.id))!
    row.scope = 'local'
    expect(await plur.updateEngram(row)).toBe(true)
    // Decision D4 (like-rescope, 2026-09-26): moving a queued row to a
    // local-family scope cancels the delivery at update time. (Before the
    // decision the entry stayed queued and the flush held it back with a
    // warning; either way nothing reaches the team store.)
    expect(rowOf(e.id).structured_data?._outbox, 'the delivery to the team store is still queued').toBeUndefined()

    fail = false
    await plur.flushOutbox()

    expect(posts.map(p => p.scope), 'a row scoped "local" was delivered to the team store').toEqual([])
    expect(rowOf(e.id)?.scope, 'the local record was handed off').toBe('local')
  })

  it('cross-scope recurrence broadening a queued row: the flush does not POST scope "global" to the team store', async () => {
    const plur = new Plur({ path: dir })
    const statement = 'retry idempotent POSTs at most three times'
    const e = await queued(plur, statement)
    await plur.learn(statement, { scope: 'project:alpha', type: 'behavioral' })
    await plur.learn(statement, { scope: 'project:beta', type: 'behavioral' })
    const row = rowOf(e.id)
    // Record what the recurrence path did — this is the input to the flush.
    const broadened = row.scope
    expect(row.structured_data?._outbox?.target_scope).toBe(SCOPE)

    fail = false
    await plur.flushOutbox()

    for (const p of posts) {
      expect(p.scope, `delivered to ${SCOPE}'s store under scope "${p.scope}" (row scope was ${broadened})`).toBe(SCOPE)
    }
  })

  it('good case: an untouched queued row is delivered under its target scope', async () => {
    const plur = new Plur({ path: dir })
    const e = await queued(plur, 'a team fact nobody touches')
    fail = false
    const res = await plur.flushOutbox()
    expect(res.flushed).toBe(1)
    expect(posts.map(p => p.scope)).toEqual([SCOPE])
    expect(rowOf(e.id)).toBeUndefined()
  })
})
