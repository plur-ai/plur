/**
 * Formal-verification run (Adapters cluster, spec/formal/PlurSpec/Adapters.lean,
 * candidate 2): MCP session lifecycle — an expired session's keyed scope
 * registration is released even when the sweep that expired it had no Plur in
 * hand, and an id-less plur_session_end with one session open ends it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('MCP session lifecycle (formal Adapters #2)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-adapters-sess-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
  })
  afterEach(() => {
    vi.useRealTimers()
    _resetSessionTelemetry()
    rmSync(dir, { recursive: true, force: true })
  })

  it('an id-only TTL sweep does not leak the expired session\'s scope registration', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const old = (await call('plur_session_start', { task: 'old', default_scope: 'project:old' })).session_id
    expect(plur.trackedSessionScopes()).toContain(old)

    vi.setSystemTime(new Date('2026-01-01T09:00:00Z')) // past the 8h TTL
    // plur_learn resolves its session through the id-only sweep (no Plur).
    await call('plur_learn', { statement: 'written after the old session expired', scope: 'global' })
    // The next plur-bearing sweep must release it.
    const fresh = (await call('plur_session_start', { task: 'fresh' })).session_id
    expect(plur.trackedSessionScopes()).not.toContain(old)
    expect(plur.trackedSessionScopes()).toContain(fresh)
  })

  it('id-less plur_session_end with one open session ends it', async () => {
    const a = (await call('plur_session_start', { task: 'a', default_scope: 'project:a' })).session_id
    await call('plur_session_end', { summary: 'done', engram_suggestions: [] })
    expect(plur.trackedSessionScopes()).not.toContain(a)
    // A later session is then the lone open one, so implicit resolution works.
    await call('plur_session_start', { task: 'b', default_scope: 'project:b' })
    const r = await call('plur_learn', { statement: 'lands in b' })
    expect(r.scope).toBe('project:b')
    const show = await call('plur_session_scope', { op: 'show' })
    expect(show.warning).toBeUndefined()
  })
})
