// packages/core/test/meta/validation.test.ts
import { describe, it, expect } from 'vitest'
import { validateMetaEngram, type ValidationResult } from '../../src/meta/validation.js'
import type { Engram } from '../../src/schemas/engram.js'
import type { LlmFunction } from '../../src/types.js'
import type { MetaField } from '../../src/schemas/meta-engram.js'

function makeMeta(overrides?: Partial<Engram>): Engram {
  const metaField: MetaField = {
    structure: {
      goal_type: 'risk-assessment',
      constraint_type: 'assumed-independence-of-correlated-variables',
      outcome_type: 'systematically-understated-risk',
      template: '[risk-assessment] + [assumed-independence-of-correlated-variables] → [systematically-understated-risk]',
    },
    evidence: [
      { engram_id: 'ENG-1', domain: 'trading', mapping_rationale: 'liquidation', alignment_score: 0.9 },
      { engram_id: 'ENG-2', domain: 'infrastructure', mapping_rationale: 'health check', alignment_score: 0.85 },
    ],
    domain_coverage: { validated: [], failed: [], predicted: ['medicine'] },
    falsification: {
      expected_conditions: 'Variables are correlated under adverse conditions',
      expected_exceptions: 'Variables are truly independent',
    },
    confidence: {
      evidence_count: 2,
      domain_count: 2,
      structural_depth: 3,
      validation_ratio: 0,
      composite: 0.53,
    },
    hierarchy: { level: 'mop', parent: null, children: [] },
    pipeline_version: '1.0.0',
  }
  return {
    id: 'META-risk-assessment-correlated-vars',
    version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global',
    statement: 'When safety margins assume independence between correlated variables, real risk is underestimated.',
    tags: ['meta-engram'], domain: 'meta',
    activation: { retrieval_strength: 0.5, storage_strength: 1.0, frequency: 0, last_accessed: '2026-03-29' },
    pack: null, abstract: null, derived_from: null, polarity: null,
    knowledge_anchors: [], associations: [],
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    derivation_count: 2, visibility: 'private',
    structured_data: { meta: metaField },
    ...overrides,
  } as Engram
}

function makeTestEngram(id: string, statement: string): Engram {
  return {
    id, version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global', statement,
    tags: [], domain: 'medicine',
    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-03-29' },
    pack: null, abstract: null, derived_from: null, polarity: null,
    knowledge_anchors: [], associations: [],
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    derivation_count: 1, visibility: 'private',
  } as Engram
}

const mockLlm: LlmFunction = async (prompt: string) => {
  if (prompt.includes('metabolic') || prompt.includes('drug interaction')) {
    return JSON.stringify({
      prediction_held: true,
      matching_engram_id: 'ENG-MED-001',
      alignment_score: 0.88,
      rationale: 'Drug interaction dosing assumes metabolic independence but cytochrome P450 creates correlation',
    })
  }
  if (prompt.includes('cooking recipe')) {
    return JSON.stringify({
      prediction_held: false,
      matching_engram_id: null,
      alignment_score: 0.12,
      rationale: 'Cooking recipe tips do not exhibit the correlated-variable safety structure',
    })
  }
  return JSON.stringify({
    prediction_held: false,
    matching_engram_id: null,
    alignment_score: 0,
    rationale: 'No match found',
  })
}

describe('validateMetaEngram', () => {
  it('returns confirmed when test domain matches the template', async () => {
    const meta = makeMeta()
    const testEngrams = [
      makeTestEngram('ENG-MED-001', 'Fixed maximum drug doses assume metabolic independence — when drugs share cytochrome P450 pathways, combined toxicity is 2-4x the individual maximum'),
    ]
    const result = await validateMetaEngram(meta, testEngrams, 'medicine', mockLlm)
    expect(result.prediction_held).toBe(true)
    expect(result.matching_engram_id).toBe('ENG-MED-001')
    expect(result.alignment_score).toBeGreaterThan(0.5)
  })

  it('returns refuted when test domain does not match', async () => {
    const meta = makeMeta()
    const testEngrams = [
      makeTestEngram('ENG-COOK-001', 'cooking recipe for pasta needs salt in the water'),
    ]
    const result = await validateMetaEngram(meta, testEngrams, 'cooking', mockLlm)
    expect(result.prediction_held).toBe(false)
    expect(result.matching_engram_id).toBeNull()
  })

  it('updates domain_coverage on the meta-engram', async () => {
    const meta = makeMeta()
    const testEngrams = [
      makeTestEngram('ENG-MED-001', 'Fixed maximum drug doses assume metabolic independence — when drugs share cytochrome P450 pathways, combined toxicity is 2-4x the individual maximum'),
    ]
    await validateMetaEngram(meta, testEngrams, 'medicine', mockLlm)
    const metaField = meta.structured_data?.meta as MetaField
    expect(metaField.domain_coverage.validated).toContain('medicine')
  })

  it('returns inconclusive when no test engrams available', async () => {
    const meta = makeMeta()
    const result = await validateMetaEngram(meta, [], 'empty-domain', mockLlm)
    expect(result.prediction_held).toBe(false)
    expect(result.rationale).toContain('No test engrams')
  })

  it('demotes TOP to MOP after 3+ failed validations', async () => {
    const meta = makeMeta({ structured_data: { meta: {
      ...((makeMeta().structured_data?.meta) as MetaField),
      hierarchy: { level: 'top', parent: null, children: [] },
      domain_coverage: { validated: [], failed: ['d1', 'd2'], predicted: [] },
    }}})
    const testEngrams = [makeTestEngram('ENG-COOK-001', 'cooking recipe for pasta needs salt in the water')]
    await validateMetaEngram(meta, testEngrams, 'cooking', mockLlm)
    const metaField = meta.structured_data?.meta as MetaField
    // After 3rd failure, should demote from top to mop
    expect(metaField.hierarchy.level).toBe('mop')
  })
})
