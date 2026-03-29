import { z } from 'zod'

export const StructuralTemplateSchema = z.object({
  goal_type: z.string().min(1),
  constraint_type: z.string().min(1),
  outcome_type: z.string().min(1),
  template: z.string().min(1),
})

export const EvidenceEntrySchema = z.object({
  engram_id: z.string(),
  domain: z.string(),
  mapping_rationale: z.string(),
  alignment_score: z.number().min(0).max(1),
})

export const FalsificationSchema = z.object({
  expected_conditions: z.string(),
  expected_exceptions: z.string(),
  test_prediction: z.string().optional(),
})

export const MetaConfidenceSchema = z.object({
  evidence_count: z.number().int().min(0),
  domain_count: z.number().int().min(0),
  structural_depth: z.number().int().min(1).max(5),
  validation_ratio: z.number().min(0).max(1).default(0),
  composite: z.number().min(0).max(1),
})

export const DomainCoverageSchema = z.object({
  validated: z.array(z.string()),
  failed: z.array(z.string()).default([]),
  predicted: z.array(z.string()).default([]),
})

export const HierarchyPositionSchema = z.object({
  level: z.enum(['mop', 'top']),
  parent: z.string().nullable().default(null),
  children: z.array(z.string()).default([]),
})

export const MetaFieldSchema = z.object({
  structure: StructuralTemplateSchema,
  evidence: z.array(EvidenceEntrySchema).min(2),
  domain_coverage: DomainCoverageSchema,
  falsification: FalsificationSchema,
  confidence: MetaConfidenceSchema,
  hierarchy: HierarchyPositionSchema,
  pipeline_version: z.string(),
  last_validated: z.string().optional(),
})

export type MetaField = z.infer<typeof MetaFieldSchema>
export type StructuralTemplate = z.infer<typeof StructuralTemplateSchema>
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>
export type MetaConfidence = z.infer<typeof MetaConfidenceSchema>
export type DomainCoverage = z.infer<typeof DomainCoverageSchema>
export type HierarchyPosition = z.infer<typeof HierarchyPositionSchema>
export type Falsification = z.infer<typeof FalsificationSchema>
