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
    expect(names).toContain('plur.learn')
    expect(names).toContain('plur.recall')
    expect(names).toContain('plur.inject')
    expect(names).toContain('plur.feedback')
    expect(names).toContain('plur.forget')
    expect(names).toContain('plur.capture')
    expect(names).toContain('plur.timeline')
    expect(names).toContain('plur.ingest')
    expect(names).toContain('plur.packs.install')
    expect(names).toContain('plur.packs.list')
    expect(names).toContain('plur.status')
  })

  it('plur.learn creates an engram', async () => {
    const result = await callTool('plur.learn', { statement: 'Test learning', scope: 'global' }) as any
    expect(result.id).toMatch(/^ENG-/)
    expect(result.statement).toBe('Test learning')
  })

  it('plur.recall finds learned engrams', async () => {
    await callTool('plur.learn', { statement: 'API uses snake_case', scope: 'global' })
    const result = await callTool('plur.recall', { query: 'API snake' }) as any
    expect(result.results.length).toBeGreaterThan(0)
  })

  it('plur.inject returns formatted injection', async () => {
    await callTool('plur.learn', { statement: 'Always deploy carefully', scope: 'global' })
    const result = await callTool('plur.inject', { task: 'deploy the application' }) as any
    expect(result.count).toBeGreaterThan(0)
  })

  it('plur.feedback updates engram', async () => {
    const learned = await callTool('plur.learn', { statement: 'Test feedback engram', scope: 'global' }) as any
    const result = await callTool('plur.feedback', { id: learned.id, signal: 'positive' }) as any
    expect(result.success).toBe(true)
  })

  it('plur.capture and plur.timeline work', async () => {
    await callTool('plur.capture', { summary: 'Test episode', agent: 'test' })
    const result = await callTool('plur.timeline', {}) as any
    expect(result.episodes.length).toBe(1)
  })

  it('plur.status returns counts', async () => {
    const result = await callTool('plur.status', {}) as any
    expect(result.engram_count).toBe(0)
    await callTool('plur.learn', { statement: 'Status test', scope: 'global' })
    const result2 = await callTool('plur.status', {}) as any
    expect(result2.engram_count).toBe(1)
  })
})
