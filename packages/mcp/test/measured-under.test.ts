/**
 * MCP tool tests for `measured_under` (#869).
 *
 * Verifies that:
 *   - plur_learn accepts measured_under and stores it on the engram
 *   - plur_recall surfaces measured_under in results (annotation + field)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('measured_under MCP tools (#869)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  // Warm the embedder once so individual tests don't pay cold-start cost
  beforeAll(async () => {
    const warmDir = mkdtempSync(join(tmpdir(), 'plur-mu-warm-'))
    try {
      const warm = new Plur({ path: warmDir })
      await warm.learn('embedder warm-up', { scope: 'global' })
      await warm.recallHybrid('embedder warm-up')
    } finally {
      rmSync(warmDir, { recursive: true, force: true })
    }
  }, 120_000)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-mu-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  it('plur_learn accepts measured_under and stores it on the engram', async () => {
    const result = await callTool('plur_learn', {
      statement: 'max_tokens 16384 causes timeouts on 64k ops',
      scope: 'global',
      measured_under: {
        model: 'claude-opus-4',
        source_type: 'bench',
        hardware: 'M3-Pro-36GB',
        date: '2026-08-11',
      },
    }) as any

    expect(result.id).toMatch(/^ENG-/)
    // Verify it was actually stored by fetching from the store
    const stored = await plur.getById(result.id) as any
    expect(stored).toBeDefined()
    expect(stored.measured_under).toBeDefined()
    expect(stored.measured_under.model).toBe('claude-opus-4')
    expect(stored.measured_under.source_type).toBe('bench')
  })

  it('plur_recall surfaces measured_under in result statements (keyword mode)', async () => {
    await plur.learn('87% wall-clock from local-git — ratio inverts on gitlab', {
      scope: 'global',
      measured_under: { source_type: 'local-git', date: '2026-08-11' },
    })

    const result = await callTool('plur_recall', {
      query: 'wall-clock local-git',
      scope: 'global',
      mode: 'keyword',
    }) as any

    expect(result.results.length).toBeGreaterThan(0)
    const hit = result.results.find((r: any) => r.statement.includes('wall-clock'))
    expect(hit).toBeDefined()
    // Statement should have the measured_under annotation appended
    expect(hit.statement).toContain('[measured under:')
    expect(hit.statement).toContain('source_type=local-git')
    // Structured field should also be present
    expect(hit.measured_under).toBeDefined()
    expect(hit.measured_under.source_type).toBe('local-git')
  })

  it('plur_recall does not append annotation when measured_under is absent', async () => {
    await plur.learn('Use pnpm not npm', { scope: 'global' })

    const result = await callTool('plur_recall', {
      query: 'pnpm npm',
      scope: 'global',
      mode: 'keyword',
    }) as any

    expect(result.results.length).toBeGreaterThan(0)
    const hit = result.results.find((r: any) => r.statement.includes('pnpm'))
    expect(hit).toBeDefined()
    expect(hit.statement).not.toContain('[measured under:')
    expect(hit.measured_under).toBeUndefined()
  })

  it('plur_learn inputSchema declares measured_under field', () => {
    const tool = tools.find(t => t.name === 'plur_learn')!
    const props = (tool.inputSchema as any).properties
    expect(props.measured_under).toBeDefined()
    expect(props.measured_under.type).toBe('object')
    // Sub-fields present
    expect(props.measured_under.properties.model).toBeDefined()
    expect(props.measured_under.properties.source_type).toBeDefined()
    expect(props.measured_under.properties.hardware).toBeDefined()
    expect(props.measured_under.properties.dataset).toBeDefined()
    expect(props.measured_under.properties.date).toBeDefined()
  })
})
