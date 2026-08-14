/**
 * plur_session_scope — dynamic mid-session scope adjustment (#243).
 *
 * The session default write scope was fixed at plur_session_start; real
 * sessions pivot (narrow, expand, switch org). This suite covers the MCP
 * surface end to end:
 *
 *   - set / show / clear roundtrip, with derivation reporting
 *   - clear reverts to the SESSION-START default, not to null
 *   - a set scope governs subsequent unscoped plur_learn calls
 *   - remote routing: learn after set posts to the enterprise store
 *   - recall dialing follows the session scope's org (#778 interaction)
 *   - per-session isolation: two sessions adjusting scopes do not bleed
 *     (ADR-0004), and an ambiguous write refuses instead of guessing
 *   - invalid input is rejected
 *   - the session_scope_changed history event is appended
 *   - session_end drops the session's keyed registration
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, readHistory, storePrefix } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('plur_session_scope (#243)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }

  const startSession = async (args: Record<string, unknown> = {}) =>
    (await callTool('plur_session_start', { task: 'work on the thing', ...args })).session_id as string

  const scopeEvents = () => readHistory(dir, new Date().toISOString().slice(0, 7))
    .filter(e => e.event === 'session_scope_changed')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-scope-tool-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is registered in the full profile with op/scope/reason/session_id inputs', () => {
    const tool = tools.find(t => t.name === 'plur_session_scope')
    expect(tool).toBeDefined()
    const props = (tool!.inputSchema as any).properties
    expect(props.op.enum).toEqual(['set', 'show', 'clear'])
    expect(props.scope).toBeDefined()
    expect(props.reason).toBeDefined()
    expect(props.session_id).toBeDefined()
    expect((tool!.inputSchema as any).required).toEqual(['op'])
    // Anti-oscillation guidance is part of the acceptance criteria.
    expect(tool!.description).toContain('oscillate')
  })

  it('set → show → clear roundtrip against a live session', async () => {
    const session = await startSession()

    const before = await callTool('plur_session_scope', { op: 'show' })
    expect(before.scope).toBeNull()
    expect(before.source).toBe('none')
    expect(before.session_id).toBe(session)

    const set = await callTool('plur_session_scope', {
      op: 'set', scope: 'group:plur/eng', reason: 'pivot to team-wide insight',
    })
    expect(set.previous_scope).toBeNull()
    expect(set.new_scope).toBe('group:plur/eng')
    expect(set.reason).toBe('pivot to team-wide insight')
    expect(set.session_id).toBe(session)
    // Shared/team scope as session default → warn about write implications;
    // the per-write guard still applies.
    expect(set.warning).toMatch(/guard/)

    const after = await callTool('plur_session_scope', { op: 'show' })
    expect(after.scope).toBe('group:plur/eng')
    expect(after.source).toBe('session-adjusted')

    const cleared = await callTool('plur_session_scope', { op: 'clear' })
    expect(cleared.previous_scope).toBe('group:plur/eng')
    expect(cleared.new_scope).toBeNull()
    expect(cleared.restored_source).toBe('none')

    const final = await callTool('plur_session_scope', { op: 'show' })
    expect(final.scope).toBeNull()
    expect(final.source).toBe('none')
  })

  it('clear reverts to the session-start default, not to null', async () => {
    await startSession({ default_scope: 'project:base' })

    await callTool('plur_session_scope', { op: 'set', scope: 'group:elsewhere' })
    const cleared = await callTool('plur_session_scope', { op: 'clear' })
    expect(cleared.previous_scope).toBe('group:elsewhere')
    expect(cleared.new_scope).toBe('project:base')
    expect(cleared.restored_source).toBe('session-start')

    const engram = await callTool('plur_learn', { statement: 'after clear, writes carry the start default again' })
    expect(engram.scope).toBe('project:base')
  })

  it('a mid-session set governs subsequent unscoped plur_learn calls; explicit scope still wins', async () => {
    await startSession()
    await callTool('plur_session_scope', { op: 'set', scope: 'project:pivoted' })

    const unscoped = await callTool('plur_learn', { statement: 'routes to the adjusted session scope' })
    expect(unscoped.scope).toBe('project:pivoted')

    const explicit = await callTool('plur_learn', { statement: 'explicit beats session default', scope: 'project:explicit' })
    expect(explicit.scope).toBe('project:explicit')
  })

  it('two sessions adjusting scopes stay isolated (ADR-0004); ambiguous writes refuse', async () => {
    const a = await startSession({ task: 'org A work' })
    const b = await startSession({ task: 'org B work' })

    await callTool('plur_session_scope', { op: 'set', scope: 'project:org-a', session_id: a })
    await callTool('plur_session_scope', { op: 'set', scope: 'project:org-b', session_id: b })

    const showA = await callTool('plur_session_scope', { op: 'show', session_id: a })
    const showB = await callTool('plur_session_scope', { op: 'show', session_id: b })
    expect(showA.scope).toBe('project:org-a')
    expect(showB.scope).toBe('project:org-b')

    const learnA = await callTool('plur_learn', { statement: 'a-side write lands in the a scope', session_id: a })
    const learnB = await callTool('plur_learn', { statement: 'b-side write lands in the b scope', session_id: b })
    expect(learnA.scope).toBe('project:org-a')
    expect(learnB.scope).toBe('project:org-b')

    // With two sessions open and no session_id there is no right target —
    // landing in the process slot would decide another session's writes.
    await expect(callTool('plur_session_scope', { op: 'set', scope: 'project:whoever' }))
      .rejects.toThrow(/session_id/)
    // show stays answerable but flags the ambiguity.
    const ambiguousShow = await callTool('plur_session_scope', { op: 'show' })
    expect(ambiguousShow.warning).toMatch(/sessions are open/)
  })

  it('rejects invalid input', async () => {
    await startSession()
    await expect(callTool('plur_session_scope', { op: 'flip' })).rejects.toThrow(/op must be/)
    await expect(callTool('plur_session_scope', { op: 'set' })).rejects.toThrow(/non-empty string/)
    await expect(callTool('plur_session_scope', { op: 'set', scope: '' })).rejects.toThrow(/non-empty string/)
    await expect(callTool('plur_session_scope', { op: 'set', scope: 'has whitespace' })).rejects.toThrow(/invalid scope/)
  })

  it('appends a session_scope_changed history event per change', async () => {
    const session = await startSession()
    await callTool('plur_session_scope', { op: 'set', scope: 'project:observed', reason: 'observability check' })
    await callTool('plur_session_scope', { op: 'clear' })

    const evs = scopeEvents()
    expect(evs).toHaveLength(2)
    expect(evs[0].data).toMatchObject({
      previous: null, next: 'project:observed', trigger: 'set',
      reason: 'observability check', session_id: session,
    })
    expect(evs[1].data).toMatchObject({ previous: 'project:observed', next: null, trigger: 'clear', session_id: session })
  })

  it('plur_session_end drops the session\'s keyed scope registration', async () => {
    const session = await startSession()
    await callTool('plur_session_scope', { op: 'set', scope: 'project:short-lived' })
    expect(plur.trackedSessionScopes()).toContain(session)

    await callTool('plur_session_end', { summary: 'done', session_id: session, engram_suggestions: [] })
    expect(plur.trackedSessionScopes()).not.toContain(session)
  })
})

describe('plur_session_scope — remote routing and dialing (#243 × #778)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-scope-remote-'))
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
    originalFetch = globalThis.fetch
    fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && String(url).includes('/api/v1/recall')) {
        return {
          ok: true, status: 200,
          json: async () => ({ results: [] }),
          text: async () => JSON.stringify({ results: [] }),
        } as Response
      }
      if (method === 'POST') {
        return {
          ok: true, status: 201,
          json: async () => ({ id: 'ENG-REMOTE-001' }),
          text: async () => '',
        } as Response
      }
      return {
        ok: true, status: 200,
        json: async () => ({ rows: [], total_count: 0 }),
        text: async () => '',
      } as Response
    })
    globalThis.fetch = fetchMock as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  function configureStores(stores: Array<Record<string, unknown>>) {
    // JSON is valid YAML — avoids a js-yaml devDependency in this package.
    writeFileSync(join(dir, 'config.yaml'), JSON.stringify({ stores, index: false }))
    plur = new Plur({ path: dir })
  }

  it('learn after a mid-session set routes to the enterprise store for that scope', async () => {
    configureStores([
      { url: 'https://enterprise.example.com/sse', token: 'test_token', scope: 'group:plur/eng', shared: true, readonly: false },
    ])

    const set = await callTool('plur_session_scope', { op: 'set', scope: 'group:plur/eng' })
    // Remote-backed shared scope → the warning names the store it routes to.
    expect(set.warning).toContain('enterprise.example.com')
    expect(set.remote_scopes).toEqual([{ scope: 'group:plur/eng', url: 'https://enterprise.example.com/sse' }])

    const engram = await callTool('plur_learn', { statement: 'routed to the enterprise store via the adjusted scope' })
    expect(engram.scope).toBe('group:plur/eng')
    // The server assigned ENG-REMOTE-001; plur_learn reports it in the same
    // namespaced form plur_recall uses for that store (#914).
    expect(engram.id).toBe(`ENG-${storePrefix('group:plur/eng')}-REMOTE-001`)
    const engramPosts = fetchMock.mock.calls.filter(([u, i]) =>
      (i as any)?.method === 'POST' && String(u).includes('/api/v1/engrams'))
    expect(engramPosts.length).toBe(1)
  })

  it('recall dialing follows the session scope org — and follows it again after a switch', async () => {
    configureStores([
      { url: 'https://plur.example.com', token: 't1', scope: 'group:plur/engineering', shared: true, readonly: false },
      { url: 'https://df.example.com', token: 't2', scope: 'group:datafund/igea', shared: true, readonly: false },
    ])

    const recallUrls = () => fetchMock.mock.calls
      .filter(([u, i]) => (i as any)?.method === 'POST' && String(u).includes('/api/v1/recall'))
      .map(([u]) => String(u))

    // No session scope: recall without an explicit scope implicates no org.
    await callTool('plur_recall', { query: 'anything at all', mode: 'keyword' })
    expect(recallUrls()).toEqual([])

    // Session scoped to the plur org → recall dials the plur host only.
    await callTool('plur_session_scope', { op: 'set', scope: 'project:plur/core' })
    await callTool('plur_recall', { query: 'anything at all', mode: 'keyword' })
    expect(recallUrls().some(u => u.startsWith('https://plur.example.com'))).toBe(true)
    expect(recallUrls().some(u => u.startsWith('https://df.example.com'))).toBe(false)

    // Mid-session switch to the other org → subsequent recalls dial THAT
    // org's host.
    fetchMock.mockClear()
    await callTool('plur_session_scope', { op: 'set', scope: 'group:datafund/igea', reason: 'switching to IGEA work' })
    await callTool('plur_recall', { query: 'anything at all', mode: 'keyword' })
    expect(recallUrls().some(u => u.startsWith('https://df.example.com'))).toBe(true)
    expect(recallUrls().some(u => u.startsWith('https://plur.example.com'))).toBe(false)
  })
})
