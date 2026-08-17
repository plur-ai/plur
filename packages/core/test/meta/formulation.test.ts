// packages/core/test/meta/formulation.test.ts
import { describe, it, expect } from 'vitest'
import { formulateMetaEngram } from '../../src/meta/formulation.js'
import type { AlignmentResult } from '../../src/meta/alignment.js'
import type { LlmFunction } from '../../src/types.js'
import type { Engram } from '../../src/schemas/engram.js'
import type { MetaField } from '../../src/schemas/meta-engram.js'

const baseAlignment: AlignmentResult = {
  cluster_id: 'cluster-0',
  common_structure: {
    goal_type: 'risk-assessment',
    constraint_type: 'assumed-independence-of-correlated-variables',
    outcome_type: 'systematically-understated-risk',
    template: '[risk-assessment] + [assumed-independence-of-correlated-variables] → [systematically-understated-risk]',
  },
  structural_depth: 3,
  systematicity: 3,
  member_alignments: [
    { engram_id: 'ENG-1', alignment_score: 0.92, mapping_rationale: 'Liquidation price assumes collateral independence' },
    { engram_id: 'ENG-2', alignment_score: 0.87, mapping_rationale: 'Health check assumes app independence from host' },
  ],
  candidate_inferences: ['Medical dosage calculations with shared metabolic pathways'],
}

const mockLlm: LlmFunction = async (prompt: string) => {
  if (prompt.includes('assumed-independence-of-correlated-variables')) {
    return JSON.stringify({
      statement: 'When a safety margin calculation assumes independence between variables that are actually correlated, the real margin is significantly worse than the reported value — leading to systematic underestimation of risk.',
      falsification: {
        expected_conditions: 'The variables are genuinely correlated under adverse conditions; the safety calculation does not account for this correlation',
        expected_exceptions: 'Variables are truly independent; correlation only emerges under rare edge cases; the safety system explicitly models joint distributions',
        test_prediction: 'In medical dosing with drugs sharing metabolic pathways, fixed maximum doses will underestimate toxicity risk when given together',
      },
    })
  }
  if (prompt.includes('unfalsifiable-principle')) {
    return 'null'
  }
  return 'null'
}

describe('formulateMetaEngram', () => {
  it('creates a full Engram with META- prefix ID', async () => {
    const result = await formulateMetaEngram(baseAlignment, mockLlm)
    expect(result).not.toBeNull()
    expect(result!.id).toMatch(/^META-/)
    expect(result!.type).toBe('behavioral')
    expect(result!.scope).toBe('global')
    expect(result!.domain).toBe('meta')
  })

  it('populates structured_data.meta with full MetaField', async () => {
    const result = await formulateMetaEngram(baseAlignment, mockLlm)
    expect(result).not.toBeNull()
    const metaField = result!.structured_data?.meta as MetaField
    expect(metaField).toBeDefined()
    expect(metaField.structure.goal_type).toBe('risk-assessment')
    expect(metaField.evidence).toHaveLength(2)
    expect(metaField.falsification.expected_conditions).toBeTruthy()
    expect(metaField.falsification.expected_exceptions).toBeTruthy()
    expect(metaField.confidence.composite).toBeGreaterThan(0)
    expect(metaField.pipeline_version).toBe('1.0.0')
  })

  it('computes composite confidence from multiple signals', async () => {
    const result = await formulateMetaEngram(baseAlignment, mockLlm)
    expect(result).not.toBeNull()
    const metaField = result!.structured_data?.meta as MetaField
    // evidenceCount=2 → 0.1, domainCount=2 → ~0.233, structuralDepth=3 → 0.2, validationRatio=0 → 0
    // composite should be around 0.53
    expect(metaField.confidence.composite).toBeGreaterThan(0.3)
    expect(metaField.confidence.composite).toBeLessThanOrEqual(1.0)
  })

  it('returns null when LLM cannot produce falsification criteria', async () => {
    const unFalsifiableAlignment: AlignmentResult = {
      ...baseAlignment,
      common_structure: {
        ...baseAlignment.common_structure,
        constraint_type: 'unfalsifiable-principle',
        template: '[unfalsifiable-principle] + [vague-constraint] → [vague-outcome-that-is-very-generic]',
      },
    }
    const result = await formulateMetaEngram(unFalsifiableAlignment, mockLlm)
    expect(result).toBeNull()
  })

  it('returns null for platitude templates', async () => {
    const platitudeAlignment: AlignmentResult = {
      ...baseAlignment,
      common_structure: {
        goal_type: 'anything',
        constraint_type: 'any',
        outcome_type: 'any',
        template: 'always be careful and verify before acting',
      },
    }
    const result = await formulateMetaEngram(platitudeAlignment, mockLlm)
    expect(result).toBeNull()
  })

  it('deduplicates against existing meta-engrams with similar templates', async () => {
    const existingMeta: Engram = {
      id: 'META-risk-assessment-assumed-independence',
      version: 2, status: 'active', consolidated: false,
      type: 'behavioral', scope: 'global', statement: 'Existing meta',
      tags: ['meta-engram'], activation: { retrieval_strength: 0.5, storage_strength: 1.0, frequency: 0, last_accessed: '2026-03-29' },
      pack: null, abstract: null, derived_from: null, polarity: null,
      knowledge_anchors: [], associations: [],
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      derivation_count: 2,
      visibility: 'private',
      structured_data: {
        meta: {
          structure: {
            goal_type: 'risk-assessment',
            constraint_type: 'assumed-independence-of-correlated-variables',
            outcome_type: 'systematically-understated-risk',
            template: '[risk-assessment] + [assumed-independence-of-correlated-variables] → [systematically-understated-risk]',
          },
          evidence: [
            { engram_id: 'ENG-OLD', domain: 'trading', mapping_rationale: 'old', alignment_score: 0.9 },
            { engram_id: 'ENG-OLD2', domain: 'infra', mapping_rationale: 'old2', alignment_score: 0.8 },
          ],
          domain_coverage: { validated: [], failed: [], predicted: [] },
          falsification: { expected_conditions: 'cond', expected_exceptions: 'except' },
          confidence: { evidence_count: 2, domain_count: 2, structural_depth: 3, validation_ratio: 0, composite: 0.5 },
          hierarchy: { level: 'mop', parent: null, children: [] },
          pipeline_version: '1.0.0',
        },
      },
    }
    const result = await formulateMetaEngram(baseAlignment, mockLlm, [existingMeta])
    // Should return null because it's a duplicate
    expect(result).toBeNull()
  })
})
