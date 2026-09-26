/**
 * Formal-verification apply phase, decision E7 (MCP side, "ignore"), 2026-09-26.
 *
 * When a write or an inject names no session_id and the number of open
 * sessions is not exactly one, the MCP server passes core's `NO_SESSION`, so NO
 * session's default scope is used — neither another session's registration
 * nor the process slot the last-started session owns (which may be a team
 * scope). The write takes the unscoped path. With exactly one open session its
 * default still applies. Replayed before (findings/adapters.md §2c): with
 * A(project:a) and B(project:b) open, an id-less plur_learn stored at project:b.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, NO_SESSION } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('ambiguous session → no session default (E7, MCP)', () => {
  let plur: Plur
  let dir: string

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = getToolDefinitions('full').find(t => t.name === name)!
    return await tool.handler(args, plur) as any
  }
  const start = async (default_scope: string) =>
    (await call('plur_session_start', { task: 'work', default_scope })).session_id as string
  const scopeOf = async (statement: string) =>
    (await plur.list()).find(e => e.statement === statement)?.scope

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-e7-mcp-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir })
    _resetSessionTelemetry()
  })
  afterEach(() => {
    _resetSessionTelemetry()
    rmSync(dir, { recursive: true, force: true })
  })

  it('two sessions open, id-less plur_learn: neither session\'s default is used', async () => {
    await start('project:a')
    await start('project:b')
    await call('plur_learn', { statement: 'id-less note with two sessions open' })
    const scope = await scopeOf('id-less note with two sessions open')
    expect(scope).not.toBe('project:b')
    expect(scope).not.toBe('project:a')
  })

  it('two sessions open, id-less plur_learn_batch: neither session\'s default is used', async () => {
    await start('project:a')
    await start('project:b')
    await call('plur_learn_batch', { engrams: [{ statement: 'id-less batch item with two sessions open' }] })
    const scope = await scopeOf('id-less batch item with two sessions open')
    expect(scope).not.toBe('project:b')
    expect(scope).not.toBe('project:a')
  })

  it('no session open: the process slot is not used either', async () => {
    plur.setSessionScope('project:stale')
    await call('plur_learn', { statement: 'id-less note with no session open' })
    expect(await scopeOf('id-less note with no session open')).not.toBe('project:stale')
  })

  it('two sessions open, id-less plur_session_end: suggestions take no session default', async () => {
    await start('project:a')
    await start('project:b')
    await call('plur_session_end', { summary: 's', engram_suggestions: ['id-less end suggestion'] })
    const scope = await scopeOf('id-less end suggestion')
    expect(scope).not.toBe('project:b')
    expect(scope).not.toBe('project:a')
  })

  it('two sessions open, id-less inject: core receives NO_SESSION', async () => {
    await start('project:a')
    await start('project:b')
    const spy = vi.spyOn(plur, 'injectHybrid')
    const spyBm25 = vi.spyOn(plur, 'inject')
    await call('plur_inject_hybrid', { task: 'anything' })
    await call('plur_inject', { task: 'anything' })
    expect(spy.mock.calls.at(-1)?.[1]?.session_id).toBe(NO_SESSION)
    expect(spyBm25.mock.calls.at(-1)?.[1]?.session_id).toBe(NO_SESSION)
  })

  it('plur_session_scope set with no session open says it does not govern writes', async () => {
    const r = await call('plur_session_scope', { op: 'set', scope: 'project:x' })
    expect(String(r.warning)).toMatch(/No session is open/)
    const shown = await call('plur_session_scope', { op: 'show' })
    expect(String(shown.warning)).toMatch(/No session is open/)
  })

  it('good case: exactly one open session still supplies its default', async () => {
    await start('project:a')
    await call('plur_learn', { statement: 'id-less note with one session open' })
    expect(await scopeOf('id-less note with one session open')).toBe('project:a')
  })

  it('good case: an explicit session_id still wins with several open', async () => {
    const a = await start('project:a')
    await start('project:b')
    await call('plur_learn', { statement: 'note for session a', session_id: a })
    expect(await scopeOf('note for session a')).toBe('project:a')
  })
})
