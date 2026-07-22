import { describe, it, expect } from 'vitest'
import { getToolDefinitions, CURSOR_CORE_TOOL_NAMES } from '../src/tools.js'

describe('plur_receipt tool', () => {
  it('is registered in the full profile', () => {
    expect(getToolDefinitions().find(t => t.name === 'plur_receipt')).toBeDefined()
  })

  it('accepts an optional days parameter that is not required', () => {
    const tool = getToolDefinitions().find(t => t.name === 'plur_receipt')!
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(schema.properties?.days).toBeDefined()
    expect(schema.required ?? []).not.toContain('days')
  })

  it('is marked read-only', () => {
    const tool = getToolDefinitions().find(t => t.name === 'plur_receipt')!
    expect(tool.annotations?.readOnlyHint).toBe(true)
  })

  it('describes itself without promising savings or cost', () => {
    const tool = getToolDefinitions().find(t => t.name === 'plur_receipt')!
    const desc = tool.description.toLowerCase()
    for (const banned of ['saving', 'cost', 'dollar', '$']) {
      expect(desc).not.toContain(banned)
    }
  })

  it('is available directly on the Cursor profile (read-only, not admin-gated)', () => {
    expect(CURSOR_CORE_TOOL_NAMES.has('plur_receipt')).toBe(true)
    expect(getToolDefinitions('cursor').find(t => t.name === 'plur_receipt')).toBeDefined()
  })

  it('description warns that activation_rate is coverage, not a quality score', () => {
    const tool = getToolDefinitions().find(t => t.name === 'plur_receipt')!
    expect(tool.description.toLowerCase()).toMatch(/coverage|not a quality|not.*effectiveness/)
  })

  it('handler returns a natural-language summary alongside the counted fields', async () => {
    const fs = await import('fs'); const os = await import('os'); const path = await import('path')
    const { Plur } = await import('@plur-ai/core')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-receipt-mcp-'))
    try {
      const plur = new Plur({ path: dir })
      plur.learn('This monorepo uses pnpm for every install, never npm.', { type: 'procedural' })
      plur.inject('pnpm install', { session_id: 's1', source: 'hook' })
      const tool = getToolDefinitions().find(t => t.name === 'plur_receipt')!
      const res = await tool.handler({}, plur) as { summary?: string; retrieved?: unknown }
      expect(typeof res.summary).toBe('string')
      expect(res.summary!.toLowerCase()).toContain('coverage')
      expect(res.retrieved).toBeDefined() // counted fields still present
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
