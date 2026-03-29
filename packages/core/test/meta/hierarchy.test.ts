// packages/core/test/meta/hierarchy.test.ts
import { describe, it, expect } from 'vitest'
import { organizeHierarchy } from '../../src/meta/hierarchy.js'
import type { Engram } from '../../src/schemas/engram.js'
import type { MetaField } from '../../src/schemas/meta-engram.js'

function makeMeta(id: string, template: string, domainCount: number, validatedDomains: string[] = []): Engram {
  const metaField: MetaField = {
    structure: {
      goal_type: 'risk-assessment',
      constraint_type: 'assumed-independence',
      outcome_type: 'understated-risk',
      template,
    },
    evidence: Array.from({ length: domainCount }, (_, i) => ({
      engram_id: `ENG-${i}`,
      domain: `domain-${i}`,
      mapping_rationale: 'test',
      alignment_score: 0.9,
    })),
    domain_coverage: { validated: validatedDomains, failed: [], predicted: [] },
    falsification: {
      expected_conditions: 'Variables are correlated',
      expected_exceptions: 'Variables are independent',
    },
    confidence: {
      evidence_count: domainCount,
      domain_count: domainCount,
      structural_depth: 3,
      validation_ratio: 0,
      composite: 0.5,
    },
    hierarchy: { level: 'mop', parent: null, children: [] },
    pipeline_version: '1.0.0',
  }
  return {
    id, version: 2, status: 'active', consolidated: false,
    type: 'behavioral', scope: 'global',
    statement: `Meta engram: ${template}`,
    tags: ['meta-engram'], domain: 'meta',
    activation: { retrieval_strength: 0.5, storage_strength: 1.0, frequency: 0, last_accessed: '2026-03-29' },
    pack: null, abstract: null, derived_from: null, polarity: null,
    knowledge_anchors: [], associations: [],
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    derivation_count: domainCount, visibility: 'private',
    structured_data: { meta: metaField },
  } as Engram
}

describe('organizeHierarchy', () => {
  it('assigns TOP level to meta-engrams with 3+ domains and no parent', () => {
    const meta = makeMeta('META-broad', '[risk-assessment] + [assumed-independence-of-correlated-variables] → [systematically-understated-risk]', 3, ['trading', 'infra', 'medicine'])
    const result = organizeHierarchy([meta])
    const mf = result[0].structured_data?.meta as MetaField
    expect(mf.hierarchy.level).toBe('top')
    expect(mf.hierarchy.parent).toBeNull()
  })

  it('assigns MOP level to meta-engrams with fewer than 3 domains', () => {
    const meta = makeMeta('META-narrow', '[risk-assessment] + [assumed-independence-of-correlated-variables] → [systematically-understated-risk]', 2, ['trading', 'infra'])
    const result = organizeHierarchy([meta])
    const mf = result[0].structured_data?.meta as MetaField
    expect(mf.hierarchy.level).toBe('mop')
  })

  it('establishes parent-child when one subsumes another by domain count', () => {
    const template = '[risk-assessment] + [assumed-independence-of-correlated-variables] → [systematically-understated-risk]'
    const broad = makeMeta('META-broad', template, 3, ['trading', 'infra', 'medicine'])
    const narrow = makeMeta('META-narrow', template, 2, ['trading', 'infra'])

    const result = organizeHierarchy([broad, narrow])
    const broadMf = result.find(e => e.id === 'META-broad')!.structured_data?.meta as MetaField
    const narrowMf = result.find(e => e.id === 'META-narrow')!.structured_data?.meta as MetaField

    expect(broadMf.hierarchy.children).toContain('META-narrow')
    expect(narrowMf.hierarchy.parent).toBe('META-broad')
    expect(narrowMf.hierarchy.level).toBe('mop') // Has parent, so mop
  })

  it('handles empty input gracefully', () => {
    expect(organizeHierarchy([])).toHaveLength(0)
  })

  it('handles single meta-engram', () => {
    const meta = makeMeta('META-single', '[goal] + [constraint] → [outcome-type-specific-value]', 1, ['trading'])
    const result = organizeHierarchy([meta])
    expect(result).toHaveLength(1)
    const mf = result[0].structured_data?.meta as MetaField
    expect(mf.hierarchy.parent).toBeNull()
    expect(mf.hierarchy.children).toHaveLength(0)
  })
})
