import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import type { Engram } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('MCP meta-engram tool integration', () => {
  let tempDir: string
  let plur: Plur
  let tools: ReturnType<typeof getToolDefinitions>

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plur-mcp-meta-'))
    plur = new Plur({ path: tempDir })
    tools = getToolDefinitions()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('saveMetaEngrams persists to store and list() retrieves them', () => {
    const meta: Engram = {
      id: 'META-test-principle',
      version: 2,
      status: 'active',
      consolidated: false,
      type: 'behavioral',
      scope: 'global',
      visibility: 'private',
      statement: 'Test meta-engram principle',
      domain: 'meta',
      tags: ['meta-engram'],
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-03-29' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [],
      associations: [],
      derivation_count: 2,
      pack: null,
      abstract: null,
      derived_from: null,
      polarity: null,
      structured_data: {
        meta: {
          structure: { goal_type: 'test', constraint_type: 'test', outcome_type: 'test', template: '[test] + [test] -> [test]' },
          evidence: [
            { engram_id: 'ENG-1', domain: 'a', mapping_rationale: 'test', alignment_score: 0.9 },
            { engram_id: 'ENG-2', domain: 'b', mapping_rationale: 'test', alignment_score: 0.8 },
          ],
          domain_coverage: { validated: ['a', 'b'], failed: [], predicted: [] },
          falsification: { expected_conditions: 'test', expected_exceptions: 'test' },
          confidence: { evidence_count: 2, domain_count: 2, structural_depth: 2, validation_ratio: 0, composite: 0.5 },
          hierarchy: { level: 'mop', parent: null, children: [] },
          pipeline_version: '1.0.0',
        },
      },
    } as Engram

    // Save via Plur class (same path the MCP handler uses)
    const { saved, skipped } = plur.saveMetaEngrams([meta])
    expect(saved).toBe(1)
    expect(skipped).toBe(0)

    // Retrieve via list — same as plur_meta_engrams tool does
    const all = plur.list()
    const metas = all.filter(e => e.id.startsWith('META-'))
    expect(metas).toHaveLength(1)
    expect(metas[0].id).toBe('META-test-principle')
    expect(metas[0].structured_data?.meta).toBeTruthy()

    // Save again — should skip duplicate
    const { saved: saved2, skipped: skipped2 } = plur.saveMetaEngrams([meta])
    expect(saved2).toBe(0)
    expect(skipped2).toBe(1)
  })

  it('plur_meta_engrams tool lists saved meta-engrams', async () => {
    const meta = {
      id: 'META-tool-list-test',
      version: 2, status: 'active', consolidated: false, type: 'behavioral',
      scope: 'global', visibility: 'private', statement: 'Tool list test meta-engram',
      domain: 'meta', tags: ['meta-engram'],
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-03-29' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [], associations: [], derivation_count: 1,
      pack: null, abstract: null, derived_from: null, polarity: null,
      structured_data: {
        meta: {
          structure: { goal_type: 'test', constraint_type: 'test', outcome_type: 'test', template: '[x] + [y] -> [z]' },
          evidence: [{ engram_id: 'ENG-1', domain: 'a', mapping_rationale: 'test', alignment_score: 0.9 }],
          domain_coverage: { validated: ['a'], failed: [], predicted: [] },
          falsification: { expected_conditions: 'test', expected_exceptions: 'test' },
          confidence: { evidence_count: 1, domain_count: 1, structural_depth: 1, validation_ratio: 0, composite: 0.4 },
          hierarchy: { level: 'mop', parent: null, children: [] },
          pipeline_version: '1.0.0',
        },
      },
    } as Engram

    plur.saveMetaEngrams([meta])

    const result = await callTool('plur_meta_engrams', {}) as any
    expect(result.count).toBe(1)
    expect(result.total_meta_engrams).toBe(1)
    expect(result.results[0].id).toBe('META-tool-list-test')
    expect(result.results[0].template).toBe('[x] + [y] -> [z]')
  })

  it('list() returns both regular and meta engrams', () => {
    plur.learn('Regular engram test')

    const meta = {
      id: 'META-mixed-test',
      version: 2, status: 'active', consolidated: false, type: 'behavioral',
      scope: 'global', visibility: 'private', statement: 'Meta mixed test',
      domain: 'meta', tags: ['meta-engram'],
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-03-29' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [], associations: [], derivation_count: 1,
      pack: null, abstract: null, derived_from: null, polarity: null,
    } as Engram
    plur.saveMetaEngrams([meta])

    const all = plur.list()
    expect(all.length).toBe(2)
    expect(all.some(e => e.id.startsWith('ENG-'))).toBe(true)
    expect(all.some(e => e.id.startsWith('META-'))).toBe(true)
  })
})
