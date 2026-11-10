import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

/**
 * Overhaul W10: `plur_learn` takes the structured form of a memory —
 * `structured_data: { body, kind, outcome }` — validates it in core, stores
 * it, and the body is found by recall.
 */
describe('plur_learn structured_data (W10)', () => {
  let dir: string
  const tools = getToolDefinitions('full')
  const learnTool = tools.find(t => t.name === 'plur_learn')!
  const learn = (plur: Plur, args: Record<string, unknown>) => learnTool.handler(args, plur) as Promise<Record<string, unknown>>

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-mcp-body-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('declares the field with only body, kind and outcome', () => {
    const sd = (learnTool.inputSchema as any).properties.structured_data
    expect(Object.keys(sd.properties).sort()).toEqual(['body', 'kind', 'outcome'])
    expect(sd.additionalProperties).toBe(false)
    expect(sd.properties.kind.enum).toEqual(['rule', 'tool', 'fact', 'preference', 'experience', 'failure_lesson'])
  })

  it('stores the body, kind and outcome; recall finds a body-only term', async () => {
    const plur = new Plur({ path: dir })
    const r = await learn(plur, {
      statement: 'Restart the worker after config edits',
      scope: 'global',
      structured_data: { body: 'When: you edit wombatgrid settings. Do: restart the worker. Why: config is read at boot.', kind: 'rule' },
    })
    const id = String(r.id)
    const stored = (await plur.getById(id))!
    expect((stored as any).structured_data).toMatchObject({ kind: 'rule' })
    expect((stored as any).structured_data.body).toContain('wombatgrid')
    expect(stored.knowledge_type?.memory_class).toBe('procedural')
    const hits = await plur.recall('wombatgrid', { limit: 5 })
    expect(hits.map(h => h.id)).toContain(id)
  })

  it('refuses an invalid kind or a forged bookkeeping key', async () => {
    const plur = new Plur({ path: dir })
    const bad = async (sd: unknown) => {
      try {
        const r = await learn(plur, { statement: 'Some statement here', scope: 'global', structured_data: sd })
        return JSON.stringify(r)
      } catch (err) { return (err as Error).message }
    }
    expect(await bad({ kind: 'opinion' })).toMatch(/structured_data/)
    expect(await bad({ _routed: { scope: 'group:x' } })).toMatch(/structured_data/)
    expect(await plur.list()).toHaveLength(0)
  })
})
