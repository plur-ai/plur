import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('Session & store tools', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions()
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  it('plur_session_start returns session_id and engrams when engrams exist', async () => {
    // Seed an engram so injection finds something
    plur.learn('Always use semicolons in TypeScript', { scope: 'global' })

    const result = await callTool('plur_session_start', { task: 'write TypeScript code' }) as any
    expect(result.session_id).toBeDefined()
    expect(typeof result.session_id).toBe('string')
    expect(result.engrams.count).toBeGreaterThan(0)
    expect(result.engrams.injected_ids.length).toBeGreaterThan(0)
    expect(result.store_stats.engram_count).toBe(1)
    expect(result.guide).toContain('Session started with')
  })

  it('plur_session_start returns empty-store guide when no engrams exist', async () => {
    const result = await callTool('plur_session_start', { task: 'something obscure' }) as any
    expect(result.session_id).toBeDefined()
    expect(result.engrams).toEqual([])
    expect(result.store_stats.engram_count).toBe(0)
    expect(result.guide).toContain('0 engrams')
    expect(result.follow_up).toContain('fresh store')
  })

  it('plur_session_start returns guide when engrams exist but none match', async () => {
    plur.learn('Always use semicolons in TypeScript', { scope: 'global' })
    const result = await callTool('plur_session_start', { task: 'cooking recipes for dinner' }) as any
    expect(result.session_id).toBeDefined()
    expect(result.engrams).toEqual([])
    expect(result.store_stats.engram_count).toBe(1)
    expect(result.guide).toContain('1 engrams but none matched')
    expect(result.follow_up).toBeUndefined()
  })

  it('plur_session_end creates engrams from suggestions and captures episode', async () => {
    const result = await callTool('plur_session_end', {
      summary: 'Implemented session management',
      session_id: 'test-session-123',
      engram_suggestions: [
        { statement: 'Always validate session IDs', type: 'behavioral' },
        { statement: 'Sessions use UUID v4 format' },
      ],
    }) as any
    expect(result.engrams_created).toBe(2)
    expect(result.episode_id).toBeDefined()

    // Verify engrams were created
    const status = plur.status()
    expect(status.engram_count).toBe(2)

    // Verify episode was captured
    const episodes = plur.timeline()
    expect(episodes.length).toBe(1)
    expect(episodes[0].summary).toBe('Implemented session management')
  })

  it('plur_session_end works with no suggestions and returns hint', async () => {
    const result = await callTool('plur_session_end', {
      summary: 'Quick session, nothing learned',
    }) as any
    expect(result.engrams_created).toBe(0)
    expect(result.episode_id).toBeDefined()
    expect(result.hint).toContain('No engrams captured')
    expect(result.total_engrams).toBe(0)
  })

  it('plur_stores_add registers a store in config', async () => {
    const storePath = join(dir, 'extra-store', 'engrams.yaml')
    const storeDir = join(dir, 'extra-store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(storePath, '')

    const result = await callTool('plur_stores_add', {
      path: storePath,
      scope: 'space:test',
      shared: true,
    }) as any
    expect(result.success).toBe(true)
    expect(result.path).toBe(storePath)
    expect(result.scope).toBe('space:test')
  })

  it('plur_stores_list returns primary + added stores', async () => {
    // List before adding
    const before = await callTool('plur_stores_list') as any
    expect(before.count).toBe(1) // Primary only
    expect(before.stores[0].scope).toBe('global')

    // Add a store
    const storePath = join(dir, 'extra-engrams.yaml')
    writeFileSync(storePath, '')
    await callTool('plur_stores_add', { path: storePath, scope: 'project:test' })

    // Re-create plur to reload config
    plur = new Plur({ path: dir })

    const after = await callTool('plur_stores_list') as any
    expect(after.count).toBe(2)
    expect(after.stores[1].scope).toBe('project:test')
  })

  it('plur_promote promotes a candidate engram', async () => {
    // Create an engram and manually set it to candidate status
    const engram = plur.learn('Test candidate engram', { scope: 'global' })
    engram.status = 'candidate' as any
    engram.activation.retrieval_strength = 0.3
    plur.updateEngram(engram)

    const result = await callTool('plur_promote', { id: engram.id }) as any
    expect(result.success).toBe(true)
    expect(result.promoted).toHaveLength(1)
    expect(result.promoted[0].id).toBe(engram.id)

    // Verify it's now active
    const updated = plur.getById(engram.id)
    expect(updated!.status).toBe('active')
    expect(updated!.activation.retrieval_strength).toBe(0.7)
  })

  it('plur_promote returns already_active for active engrams', async () => {
    const engram = plur.learn('Already active engram', { scope: 'global' })
    const result = await callTool('plur_promote', { id: engram.id }) as any
    expect(result.success).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toBe('Already active')
  })

  it('plur_promote returns error for retired engrams', async () => {
    const engram = plur.learn('Soon retired', { scope: 'global' })
    plur.forget(engram.id)
    const result = await callTool('plur_promote', { id: engram.id }) as any
    expect(result.success).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toBe('Cannot promote retired')
  })
})
