import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('MCP tools', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions()
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  it('defines all PLUR tools', () => {
    const names = tools.map(t => t.name)
    expect(names).toContain('plur_learn')
    expect(names).toContain('plur_recall')
    expect(names).toContain('plur_inject')
    expect(names).toContain('plur_feedback')
    expect(names).toContain('plur_forget')
    expect(names).toContain('plur_capture')
    expect(names).toContain('plur_timeline')
    expect(names).toContain('plur_ingest')
    expect(names).toContain('plur_packs_install')
    expect(names).toContain('plur_packs_list')
    expect(names).toContain('plur_status')
  })

  it('plur_learn creates an engram', async () => {
    const result = await callTool('plur_learn', { statement: 'Test learning', scope: 'global' }) as any
    expect(result.id).toMatch(/^ENG-/)
    expect(result.statement).toBe('Test learning')
  })

  // #296 — team knowledge silently defaulting to 'global'. When a team store is
  // configured and no scope is passed, surface a hint at the moment of the write.
  describe('scope hint when a team store is configured (#296)', () => {
    beforeEach(() => {
      plur.addStore('', 'group:acme/engineering', { url: 'https://plur.example.com', token: 'tok' })
    })

    it('hints to use the team scope when scope is omitted and engram lands at global', async () => {
      const result = await callTool('plur_learn', { statement: 'We use trunk-based development' }) as any
      expect(result.scope).toBe('global')
      expect(result.scope_hint).toBeDefined()
      expect(result.scope_hint).toContain('group:acme/engineering')
    })

    it('no hint when an explicit scope is passed', async () => {
      const result = await callTool('plur_learn', {
        statement: 'We use trunk-based development', scope: 'group:acme/engineering',
      }) as any
      expect(result.scope_hint).toBeUndefined()
    })

    it('no hint when the explicit scope is global on purpose', async () => {
      const result = await callTool('plur_learn', { statement: 'TS enums are slow', scope: 'global' }) as any
      expect(result.scope_hint).toBeUndefined()
    })
  })

  it('plur_learn does NOT hint on a personal install (no team store configured)', async () => {
    const result = await callTool('plur_learn', { statement: 'Personal note' }) as any
    expect(result.scope).toBe('global')
    expect(result.scope_hint).toBeUndefined()
  })

  it('plur_learn strips XML envelope artifacts from statement (#145)', async () => {
    // Reproduce the corruption: LLM generates old XML tool-call format where the
    // statement value contains the closing tag + duplicated parameter body.
    const corrupted = 'Use snake_case for all identifiers.</statement>\n\n<parameter name="statement">Use snake_case for all identifiers.</parameter>\n<parameter name="type">behavioral</parameter>'
    const result = await callTool('plur_learn', { statement: corrupted }) as any
    expect(result.statement).toBe('Use snake_case for all identifiers.')
    expect(result.statement).not.toContain('</statement>')
    expect(result.statement).not.toContain('<parameter name=')
  })

  it('plur_learn does not truncate clean statements', async () => {
    const clean = 'Always verify timestamps with python before committing.'
    const result = await callTool('plur_learn', { statement: clean }) as any
    expect(result.statement).toBe(clean)
  })

  it('plur_recall finds learned engrams', async () => {
    await callTool('plur_learn', { statement: 'API uses snake_case', scope: 'global' })
    const result = await callTool('plur_recall', { query: 'API snake' }) as any
    expect(result.results.length).toBeGreaterThan(0)
  })

  it('plur_inject returns formatted injection', async () => {
    await callTool('plur_learn', { statement: 'Always deploy carefully', scope: 'global' })
    const result = await callTool('plur_inject', { task: 'deploy the application' }) as any
    expect(result.count).toBeGreaterThan(0)
  })

  it('plur_feedback updates engram', async () => {
    const learned = await callTool('plur_learn', { statement: 'Test feedback engram', scope: 'global' }) as any
    const result = await callTool('plur_feedback', { id: learned.id, signal: 'positive' }) as any
    expect(result.success).toBe(true)
  })

  it('plur_capture and plur.timeline work', async () => {
    await callTool('plur_capture', { summary: 'Test episode', agent: 'test' })
    const result = await callTool('plur_timeline', {}) as any
    expect(result.episodes.length).toBe(1)
  })

  it('plur_status returns counts', async () => {
    const result = await callTool('plur_status', {}) as any
    expect(result.engram_count).toBe(0)
    await callTool('plur_learn', { statement: 'Status test', scope: 'global' })
    const result2 = await callTool('plur_status', {}) as any
    expect(result2.engram_count).toBe(1)
  })

  it('plur_status includes running version', async () => {
    const result = await callTool('plur_status', {}) as any
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  // plur_stores_add must report an honest status, never an unconditional
  // success:true that masks a dropped scope (#291).
  describe('plur_stores_add status reporting (#291)', () => {
    const url = 'https://plur.datafund.io/sse'

    it('reports status:added for a second scope on the same remote URL', async () => {
      const first = await callTool('plur_stores_add', { url, token: 'tok', scope: 'group:plur/plur-ai/engineering' }) as any
      expect(first).toMatchObject({ success: true, status: 'added', kind: 'remote' })

      // The bug: this used to return success:true while persisting nothing.
      const second = await callTool('plur_stores_add', { url, token: 'tok', scope: 'group:plur/plur-ai/comms' }) as any
      expect(second).toMatchObject({ success: true, status: 'added', scope: 'group:plur/plur-ai/comms' })

      // Both scopes are now visible in the listing (alongside the default local
      // store, so we assert on scopes present rather than total count).
      const list = await callTool('plur_stores_list', {}) as any
      const scopes = list.stores.map((s: any) => s.scope)
      expect(scopes).toContain('group:plur/plur-ai/engineering')
      expect(scopes).toContain('group:plur/plur-ai/comms')
    })

    it('reports status:already_registered on an exact url+scope repeat', async () => {
      await callTool('plur_stores_add', { url, token: 'tok', scope: 'group:plur/plur-ai/engineering' })
      const repeat = await callTool('plur_stores_add', { url, token: 'tok', scope: 'group:plur/plur-ai/engineering' }) as any
      expect(repeat).toMatchObject({ success: true, status: 'already_registered' })

      // The repeat must not have created a duplicate entry for that scope.
      const list = await callTool('plur_stores_list', {}) as any
      const engineering = list.stores.filter((s: any) => s.scope === 'group:plur/plur-ai/engineering')
      expect(engineering).toHaveLength(1)
    })
  })
})
