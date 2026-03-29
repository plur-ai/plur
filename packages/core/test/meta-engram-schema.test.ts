import { describe, it, expect } from 'vitest'
import {
  StructuralTemplateSchema,
  MetaConfidenceSchema,
  MetaFieldSchema,
} from '../src/schemas/meta-engram.js'
import { EngramSchema } from '../src/schemas/engram.js'

describe('StructuralTemplateSchema', () => {
  it('validates a well-formed template', () => {
    const result = StructuralTemplateSchema.safeParse({
      goal_type: 'optimization',
      constraint_type: 'resource_limited',
      outcome_type: 'efficiency_gain',
      template: 'When optimizing under resource constraints, prioritize {outcome}',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty goal_type', () => {
    const result = StructuralTemplateSchema.safeParse({
      goal_type: '',
      constraint_type: 'resource_limited',
      outcome_type: 'efficiency_gain',
      template: 'some template',
    })
    expect(result.success).toBe(false)
  })
})

describe('MetaConfidenceSchema', () => {
  it('validates a complete confidence object', () => {
    const result = MetaConfidenceSchema.safeParse({
      evidence_count: 5,
      domain_count: 3,
      structural_depth: 2,
      validation_ratio: 0.8,
      composite: 0.75,
    })
    expect(result.success).toBe(true)
  })

  it('defaults validation_ratio to 0 when omitted', () => {
    const result = MetaConfidenceSchema.safeParse({
      evidence_count: 2,
      domain_count: 1,
      structural_depth: 1,
      composite: 0.5,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.validation_ratio).toBe(0)
    }
  })
})

const validMetaField = {
  structure: {
    goal_type: 'performance',
    constraint_type: 'time_bounded',
    outcome_type: 'speed_improvement',
    template: 'Optimize {goal} within {constraint} to achieve {outcome}',
  },
  evidence: [
    {
      engram_id: 'ENG-2026-0101-001',
      domain: 'software',
      mapping_rationale: 'Direct performance optimization case',
      alignment_score: 0.9,
    },
    {
      engram_id: 'ENG-2026-0102-002',
      domain: 'hardware',
      mapping_rationale: 'Analogous resource constraint pattern',
      alignment_score: 0.75,
    },
  ],
  domain_coverage: {
    validated: ['software', 'hardware'],
  },
  falsification: {
    expected_conditions: 'Resource constraints exist and goal is measurable',
    expected_exceptions: 'When resources are unlimited, pattern does not apply',
  },
  confidence: {
    evidence_count: 2,
    domain_count: 2,
    structural_depth: 1,
    composite: 0.82,
  },
  hierarchy: {
    level: 'mop',
  },
  pipeline_version: '1.0.0',
}

describe('MetaFieldSchema', () => {
  it('validates a complete meta field', () => {
    const result = MetaFieldSchema.safeParse(validMetaField)
    expect(result.success).toBe(true)
  })

  it('requires at least 2 evidence entries', () => {
    const result = MetaFieldSchema.safeParse({
      ...validMetaField,
      evidence: [validMetaField.evidence[0]],
    })
    expect(result.success).toBe(false)
  })

  it('defaults children to [] when omitted from hierarchy', () => {
    const result = MetaFieldSchema.safeParse(validMetaField)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.hierarchy.children).toEqual([])
    }
  })
})

describe('EngramSchema META- prefix', () => {
  const baseEngram = {
    statement: 'Meta-pattern for optimization under constraints',
    type: 'behavioral',
    scope: 'global',
    status: 'active',
  }

  it('accepts META- prefix', () => {
    const result = EngramSchema.safeParse({ ...baseEngram, id: 'META-2026-0101-001' })
    expect(result.success).toBe(true)
  })

  it('still accepts ENG- prefix', () => {
    const result = EngramSchema.safeParse({ ...baseEngram, id: 'ENG-2026-0101-001' })
    expect(result.success).toBe(true)
  })

  it('still accepts ABS- prefix', () => {
    const result = EngramSchema.safeParse({ ...baseEngram, id: 'ABS-2026-0101-001' })
    expect(result.success).toBe(true)
  })
})
