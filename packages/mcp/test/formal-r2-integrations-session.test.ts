/**
 * Formal verification round 2 (R2-Integrations follow-ups, MCP side).
 *
 * 1. Recall uses the same session rule as writes (decision E7): an explicit
 *    session_id, else the lone open session, else core's NO_SESSION. Recall
 *    dials remote hosts with the session's scope, so an ambiguous recall must
 *    not borrow the last-started session's scope from the process slot.
 * 2. plur_session_scope op:"set" with NO session open refuses: the slot it
 *    would set is read by no id-less call any more.
 * 3. plur_suggest_scope / plur_learn: a refused REMOTE PERSONAL scope (decision
 *    E1 "me-only") is not called "shared".
 * 4. plur_outbox reports whatever core lists, and `pending` after a flush is
 *    counted from the same list.
 *
 * Model: spec/formal/PlurSpec/R2Integrations.lean §3.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, NO_SESSION } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('R2 follow-ups: session rule for recall, zero-session scope set', () => {
  let plur: Plur
  let dir: string
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = getToolDefinitions('full').find(t => t.name === name)!
    return await tool.handler(args, plur) as any
  }
  const start = async (default_scope: string) =>
    (await call('plur_session_start', { task: 'work', default_scope })).session_id as string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2-int-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir })
    _resetSessionTelemetry()
  })
  afterEach(() => {
    _resetSessionTelemetry()
    rmSync(dir, { recursive: true, force: true })
  })

  it('two sessions open, id-less recall (keyword and hybrid): core receives NO_SESSION', async () => {
    await start('project:a')
    await start('group:acme/eng')
    const kw = vi.spyOn(plur, 'recallWithMeta')
    const hy = vi.spyOn(plur, 'recallHybridWithMeta')
    await call('plur_recall', { query: 'anything', mode: 'keyword' })
    await call('plur_recall', { query: 'anything' })
    expect(kw.mock.calls.at(-1)?.[1]?.session).toBe(NO_SESSION)
    expect(hy.mock.calls.at(-1)?.[1]?.session).toBe(NO_SESSION)
  })

  it('zero sessions open, id-less recall: core receives NO_SESSION', async () => {
    const kw = vi.spyOn(plur, 'recallWithMeta')
    await call('plur_recall', { query: 'anything', mode: 'keyword' })
    expect(kw.mock.calls.at(-1)?.[1]?.session).toBe(NO_SESSION)
  })

  it('good case: one session open, or an explicit id, still supplies the session', async () => {
    const a = await start('project:a')
    const kw = vi.spyOn(plur, 'recallWithMeta')
    await call('plur_recall', { query: 'anything', mode: 'keyword' })
    expect(kw.mock.calls.at(-1)?.[1]?.session).toBe(a)
    const b = await start('project:b')
    await call('plur_recall', { query: 'anything', mode: 'keyword', session_id: b })
    expect(kw.mock.calls.at(-1)?.[1]?.session).toBe(b)
  })

  it('plur_session_scope set with no session open refuses with a clear message', async () => {
    await expect(call('plur_session_scope', { op: 'set', scope: 'project:x' }))
      .rejects.toThrow(/no session is open/i)
    // Nothing was set.
    expect(plur.getSessionScope({})).toBeNull()
    // show stays answerable.
    const shown = await call('plur_session_scope', { op: 'show' })
    expect(shown.op).toBe('show')
  })
})

describe('R2 follow-up: refused remote personal scope is not called shared', () => {
  let plur: Plur
  let dir: string
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = getToolDefinitions('full').find(t => t.name === name)!
    return await tool.handler(args, plur) as any
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2-suggest-'))
    // A personal scope backed by a URL store whose /me identity is unknown
    // (nothing is ever fetched: port 9, and suggest/preview is offline).
    writeFileSync(join(dir, 'config.yaml'), [
      'embeddings:', '  enabled: false',
      'stores:',
      '  - url: http://127.0.0.1:9', '    token: t', '    scope: user:bob',
      '    covers: [deploy.pipeline]', '    description: Bob notes',
    ].join('\n') + '\n')
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('plur_suggest_scope names it a remote personal scope, not a shared one', async () => {
    const r = await call('plur_suggest_scope', { statement: 'Run the canary before promoting', domain: 'deploy.pipeline.canary' })
    expect(r.would_route.refused_shared ?? r.would_route.refused_scope).toBe('user:bob')
    expect(r.would_route.note).not.toMatch(/SHARED scope/)
    expect(r.would_route.note).toMatch(/personal/i)
  })
})

describe('R2 follow-up: plur_outbox pending after a flush is counted from listOutbox', () => {
  let plur: Plur
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2-outbox-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('an entry core lists (e.g. a queued remote retirement) is reported, and counted after a flush', async () => {
    const entry = { id: 'ENG-1', target_scope: 'group:acme/eng', queued_at: '2026-09-26T00:00:00Z', attempt_count: 1, age_days: 0, kind: 'retire' }
    vi.spyOn(plur, 'listOutbox').mockResolvedValue([entry] as any)
    vi.spyOn(plur, 'outboxCount').mockResolvedValue(0)
    vi.spyOn(plur, 'flushOutbox').mockResolvedValue({ flushed: 0, failed: 1, deferred: 0, held: 0, skipped: 0, expired_warnings: [] })
    const tool = getToolDefinitions('full').find(t => t.name === 'plur_outbox')!
    const shown = await tool.handler({}, plur) as any
    expect(shown.entries).toEqual([entry])
    const flushed = await tool.handler({ flush: true }, plur) as any
    expect(flushed.pending).toBe(1)
  })
})
