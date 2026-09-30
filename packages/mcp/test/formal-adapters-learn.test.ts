/**
 * Formal-verification run (Adapters cluster, spec/formal/PlurSpec/Adapters.lean):
 * the three MCP write entry points — plur_learn, plur_learn_batch and
 * plur_session_end — must build the same LearnContext for the same logical
 * input: same session resolution, same project-domain default, same pinned
 * quota gate, and the reported decision must say what happened.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('MCP learn entry points agree (formal Adapters #1)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }
  const start = async (default_scope: string) =>
    (await call('plur_session_start', { task: 'work', default_scope })).session_id as string
  const scopeOf = async (statement: string) =>
    (await plur.list()).find(e => e.statement === statement)?.scope

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-adapters-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
  })
  afterEach(() => {
    _resetSessionTelemetry()
    rmSync(dir, { recursive: true, force: true })
  })

  it('plur_session_end learns its suggestions under the ENDING session\'s scope', async () => {
    const a = await start('project:a')
    await start('project:b') // started later: owns the process slot
    await call('plur_session_end', { summary: 'a done', session_id: a, engram_suggestions: ['suggestion from session a'] })
    expect(await scopeOf('suggestion from session a')).toBe('project:a')
  })

  it('plur_learn_batch honours session_id like plur_learn does', async () => {
    const a = await start('project:a')
    await start('project:b')
    const single = await call('plur_learn', { statement: 'single write in a', session_id: a })
    const batch = await call('plur_learn_batch', { engrams: [{ statement: 'batch write in a' }], session_id: a })
    expect(single.scope).toBe('project:a')
    expect(batch.results[0].scope).toBe('project:a')
  })

  it('plur_learn_batch refuses a pinned item when the pinned quota has no room, like plur_learn', async () => {
    ;(plur as any).pinnedQuota = async () => ({ quota: 5, used: 41, free: 0, count: 1, over: true, entries: [] })
    const single = await call('plur_learn', { statement: 'pinned single', pinned: true, scope: 'global' })
    expect(single.error).toBe('pinned_quota_exceeded')
    const batch = await call('plur_learn_batch', {
      engrams: [
        { statement: 'unpinned batch item', scope: 'global' },
        { statement: 'pinned batch item', pinned: true, scope: 'global' },
      ],
    })
    expect(batch.ids[0]).toEqual(expect.any(String))
    expect(batch.ids[1]).toBeNull()
    expect(batch.failures).toEqual([expect.objectContaining({ index: 1, error: expect.stringMatching(/pinned_quota_exceeded/) })])
    expect(await scopeOf('pinned batch item')).toBeUndefined()
    expect(await scopeOf('unpinned batch item')).toBe('global')
  })

  it('plur_learn reports an absorbed duplicate as NOOP with existing_id, not ADD', async () => {
    const first = await call('plur_learn', { statement: 'dup statement', scope: 'global' })
    expect(first.decision).toBe('ADD')
    const second = await call('plur_learn', { statement: 'dup statement', scope: 'global' })
    expect(second.id).toBe(first.id)
    expect(second.decision).toBe('NOOP')
    expect(second.existing_id).toBe(first.id)
  })

  it('the learnRouted fallback does not claim a remote failure for a local write', async () => {
    ;(plur as any).learnRouted = async () => { throw new Error('lock contention') }
    const r = await call('plur_learn', { statement: 'local fallback write', scope: 'global' })
    expect(r.scope).toBe('global')
    expect(r.outbox).toBeUndefined()
    expect(r.warning).not.toMatch(/Remote write failed/)
    expect(r.warning).not.toMatch(/queued/)
    expect(r.warning).toMatch(/lock contention/)
  })

  it('good case stays reachable: one open session, no id, all three entry points use its scope', async () => {
    await start('project:solo')
    const single = await call('plur_learn', { statement: 'solo single' })
    const batch = await call('plur_learn_batch', { engrams: [{ statement: 'solo batch' }] })
    expect(single.scope).toBe('project:solo')
    expect(batch.results[0].scope).toBe('project:solo')
    await call('plur_session_end', { summary: 'done', engram_suggestions: ['solo suggestion'] })
    expect(await scopeOf('solo suggestion')).toBe('project:solo')
  })
})
