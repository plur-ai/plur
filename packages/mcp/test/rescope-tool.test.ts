/**
 * plur_rescope MCP tool (#676) — scope movement, distinct from plur_promote
 * (candidate activation). Covers: tool surface (full profile + plur_admin
 * dispatch in lean), local rescope through the tool, dry_run passthrough,
 * and argument validation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, validateToolArgs } from '../src/tools.js'

describe('plur_rescope tool', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rescope-tool-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  it('is exposed in the full profile and reachable via plur_admin in the lean profile (not destructive)', () => {
    const full = getToolDefinitions('full')
    const rescope = full.find(t => t.name === 'plur_rescope')
    expect(rescope).toBeDefined()
    // Soft-retire with a superseded_by link is a move, not a delete — it must
    // stay dispatchable through plur_admin (destructive tools are refused there).
    expect(rescope!.annotations?.destructiveHint).toBe(false)

    const lean = getToolDefinitions('lean')
    expect(lean.find(t => t.name === 'plur_rescope')).toBeUndefined()
    const admin = lean.find(t => t.name === 'plur_admin')
    expect(admin).toBeDefined()
    expect(admin!.description).toContain('plur_rescope')
  })

  it('moves an engram to a local-family scope, preserving its id', async () => {
    const e = await plur.learn('Rescope tool statement', { scope: 'project:alpha' })
    const result = await callTool('plur_rescope', { id: e.id, target_scope: 'global' }) as any
    expect(result.success).toBe(true)
    expect(result.results[0]).toMatchObject({
      id: e.id, status: 'rescoped', to_scope: 'global', new_id: e.id,
    })
    expect((await plur.getById(e.id))!.scope).toBe('global')
  })

  it('dry_run reports the plan and mutates nothing', async () => {
    const e = await plur.learn('Rescope tool dry run statement', { scope: 'project:alpha' })
    const result = await callTool('plur_rescope', { id: e.id, target_scope: 'global', dry_run: true }) as any
    expect(result.success).toBe(true)
    expect(result.dry_run).toBe(true)
    expect(result.note).toMatch(/nothing was changed/i)
    expect(result.results[0]).toMatchObject({ status: 'rescoped', dry_run: true })
    expect((await plur.getById(e.id))!.scope).toBe('project:alpha')
  })

  it('accepts batch ids and reports per-id outcomes', async () => {
    const a = await plur.learn('Batch tool statement one', { scope: 'project:alpha' })
    const b = await plur.learn('Batch tool statement two', { scope: 'project:alpha' })
    const result = await callTool('plur_rescope', { ids: [a.id, b.id], target_scope: 'global' }) as any
    expect(result.success).toBe(true)
    expect(result.results.map((r: any) => r.status)).toEqual(['rescoped', 'rescoped'])
  })

  it('requires target_scope (schema) and id/ids (handler)', async () => {
    const tool = tools.find(t => t.name === 'plur_rescope')!
    const validated = validateToolArgs(tool, { id: 'ENG-X' })
    expect(validated.ok).toBe(false)

    await expect(callTool('plur_rescope', { target_scope: 'global' })).rejects.toThrow(/Provide id or ids/)
  })

  it('an unconfigured shared target scope fails with the structured early error', async () => {
    const e = await plur.learn('Unknown scope tool statement', { scope: 'local' })
    await expect(
      callTool('plur_rescope', { id: e.id, target_scope: 'group:plur-ai/engineering' }),
    ).rejects.toThrow(/no configured store matches/)
  })

  it('plur_admin dispatches plur_rescope in the lean profile', async () => {
    const lean = getToolDefinitions('lean')
    const admin = lean.find(t => t.name === 'plur_admin')!
    const e = await plur.learn('Admin dispatch rescope statement', { scope: 'project:alpha' })
    const result = await admin.handler(
      { action: 'plur_rescope', args: { id: e.id, target_scope: 'global' } },
      plur,
    ) as any
    expect(result.success).toBe(true)
    expect((await plur.getById(e.id))!.scope).toBe('global')
  })

  it('plur_promote still activates candidates and its description points scope moves at plur_rescope', async () => {
    const promote = tools.find(t => t.name === 'plur_promote')!
    expect(promote.description).toContain('plur_rescope')
    expect(promote.description).toMatch(/does NOT move/i)
  })
})
