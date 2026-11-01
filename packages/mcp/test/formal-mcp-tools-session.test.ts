/**
 * Formal model spec/formal/PlurSpec/McpTools.lean §1–§3: session resolution in
 * tools.ts. Which session default an unscoped write takes with zero, one or
 * several sessions open, with and without a session id, through the server
 * (a FolderScopeContext attached) and without it; plur_episode_to_engram
 * follows the same rule as plur_learn; an expired session is never chosen;
 * a scope clear for a session this server did not start restores nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry, FOLDER_SCOPE, type FolderScopeContext } from '../src/tools.js'

describe('MCP session resolution (formal McpTools)', () => {
  let plur: Plur
  let dir: string
  const tools = getToolDefinitions('full')

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)!
    return await tool.handler(args, plur) as any
  }
  const start = async (default_scope?: string) =>
    (await call('plur_session_start', { task: 'work', ...(default_scope ? { default_scope } : {}) })).session_id as string
  const promote = async (summary: string, extra: Record<string | symbol, unknown> = {}) => {
    const ep = plur.capture(summary)
    return await call('plur_episode_to_engram', { episode_id: ep.id, ...extra } as Record<string, unknown>)
  }
  /** What the server attaches: a workspace whose resolver gives no scope. */
  const serverCtx = (ws: Awaited<ReturnType<FolderScopeContext['resolve']>> = { scope: null, key: 'ws' }): FolderScopeContext =>
    ({ resolve: async () => ws })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-mcp-tools-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir })
    _resetSessionTelemetry()
  })
  afterEach(() => {
    vi.useRealTimers()
    _resetSessionTelemetry()
    rmSync(dir, { recursive: true, force: true })
  })

  it('episode to engram, one session open, no id: takes that session\'s default', async () => {
    await start('project:a')
    expect((await promote('episode with one session open')).id).toMatch(/^ENG-/)
    expect((await plur.list()).find(e => e.statement === 'episode with one session open')?.scope).toBe('project:a')
  })

  it('episode to engram, two sessions open, no id: neither session\'s default', async () => {
    await start('project:a')
    await start('project:b')
    await promote('episode with two sessions open')
    const scope = (await plur.list()).find(e => e.statement === 'episode with two sessions open')?.scope
    expect(scope).not.toBe('project:a')
    expect(scope).not.toBe('project:b')
  })

  it('episode to engram, no session open: the process slot is not used', async () => {
    plur.setSessionScope('project:stale')
    await promote('episode with no session open')
    expect((await plur.list()).find(e => e.statement === 'episode with no session open')?.scope).not.toBe('project:stale')
  })

  it('episode to engram, two sessions open, named session: takes the named session\'s default', async () => {
    const a = await start('project:a')
    await start('project:b')
    await promote('episode for session a', { session_id: a })
    expect((await plur.list()).find(e => e.statement === 'episode for session a')?.scope).toBe('project:a')
  })

  it('episode to engram advertises session_id like plur_learn', () => {
    const props = (name: string) => Object.keys((tools.find(t => t.name === name)!.inputSchema as any).properties)
    expect(props('plur_learn')).toContain('session_id')
    expect(props('plur_episode_to_engram')).toContain('session_id')
  })

  it('through the server, a session id this process never started supplies no default (learn and episode)', async () => {
    plur.setSessionScope('project:ghost', { session: 'ghost' })
    await call('plur_learn', { statement: 'learn under a ghost id', session_id: 'ghost', [FOLDER_SCOPE]: serverCtx() } as Record<string, unknown>)
    await promote('episode under a ghost id', { session_id: 'ghost', [FOLDER_SCOPE]: serverCtx() })
    const list = await plur.list()
    expect(list.find(e => e.statement === 'learn under a ghost id')?.scope).not.toBe('project:ghost')
    expect(list.find(e => e.statement === 'episode under a ghost id')?.scope).not.toBe('project:ghost')
  })

  it('without the server, a session id never started or registered supplies no default (not the last-started session\'s)', async () => {
    await start('project:a')
    await start('project:b')
    await call('plur_learn', { statement: 'learn under a never-started id', session_id: 'never-started' })
    await promote('episode under a never-started id', { session_id: 'never-started' })
    const list = await plur.list()
    expect(list.find(e => e.statement === 'learn under a never-started id')?.scope).not.toBe('project:b')
    expect(list.find(e => e.statement === 'episode under a never-started id')?.scope).not.toBe('project:b')
  })

  it('without the server, a session registered in core still supplies its default', async () => {
    plur.setSessionScope('project:embedded', { session: 'embedded' })
    await call('plur_learn', { statement: 'learn under a core-registered id', session_id: 'embedded' })
    expect((await plur.list()).find(e => e.statement === 'learn under a core-registered id')?.scope).toBe('project:embedded')
  })

  it('episode to engram with disagreeing roots returns the same refusal as plur_learn, nothing saved', async () => {
    const roots = [{ root: '/w/a', scope: 'project:a' }, { root: '/w/b', scope: 'project:b' }]
    const ctx = serverCtx({ scope: null, key: 'ws', roots })
    const learn = await call('plur_learn', { statement: 'learn in a split window', [FOLDER_SCOPE]: ctx } as Record<string, unknown>)
    const ep = await promote('episode in a split window', { [FOLDER_SCOPE]: ctx })
    expect(learn).toMatchObject({ saved: false, refused: 'roots-disagree' })
    expect(ep).toMatchObject({ saved: false, refused: 'roots-disagree', choices: learn.choices })
    expect((await plur.list()).some(e => e.statement === 'episode in a split window')).toBe(false)
  })

  it('an expired session is never the implicit session, and a later start is the lone open one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await start('project:old')
    vi.setSystemTime(new Date('2026-01-01T08:00:01Z')) // just past the 8h TTL
    await call('plur_learn', { statement: 'after the old session expired' })
    expect((await plur.list()).find(e => e.statement === 'after the old session expired')?.scope).not.toBe('project:old')
    expect((await call('plur_session_scope', { op: 'show' })).session_id).toBeUndefined()
    const fresh = await start('project:fresh')
    expect((await call('plur_session_scope', { op: 'show' })).session_id).toBe(fresh)
  })

  it('a session still inside its TTL keeps its default', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await start('project:live')
    vi.setSystemTime(new Date('2026-01-01T07:59:59Z'))
    await call('plur_learn', { statement: 'inside the TTL' })
    expect((await plur.list()).find(e => e.statement === 'inside the TTL')?.scope).toBe('project:live')
  })

  it('through the server, clearing the scope of a session this server did not start restores nothing', async () => {
    plur.setSessionScope('project:slot')
    plur.setSessionScope('project:ghost', { session: 'ghost' })
    const r = await call('plur_session_scope', { op: 'clear', session_id: 'ghost', [FOLDER_SCOPE]: serverCtx() } as Record<string, unknown>)
    expect(r.new_scope).toBeNull()
    expect(r.restored_source).toBe('none')
    expect(plur.getSessionScope({ session: 'ghost' })).not.toBe('project:slot')
    expect(plur.getSessionScope()).toBe('project:slot')
  })

  it('a session-scope set or clear with two sessions open and no id is refused, and changes nothing', async () => {
    await start('project:a')
    await start('project:b')
    const before = plur.getSessionScope()
    await expect(call('plur_session_scope', { op: 'set', scope: 'project:x' })).rejects.toThrow(/2 sessions are open/)
    await expect(call('plur_session_scope', { op: 'clear' })).rejects.toThrow(/2 sessions are open/)
    expect(plur.getSessionScope()).toBe(before)
  })

  it('a session-scope set with no session open is refused', async () => {
    await expect(call('plur_session_scope', { op: 'set', scope: 'project:x' })).rejects.toThrow(/no session is open/)
  })
})
