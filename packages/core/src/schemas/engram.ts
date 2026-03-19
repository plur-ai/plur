import { z } from 'zod'

export const ActivationSchema = z.object({
  retrieval_strength: z.number().min(0).max(1),
  storage_strength: z.number().min(0).max(1),
  frequency: z.number().int().min(0),
  last_accessed: z.string(),
})

export const KnowledgeTypeSchema = z.object({
  memory_class: z.enum(['semantic', 'episodic', 'procedural', 'metacognitive']),
  cognitive_level: z.enum(['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']),
})

export const KnowledgeAnchorSchema = z.object({
  path: z.string(),
  relevance: z.enum(['primary', 'supporting', 'example']).default('supporting'),
  snippet: z.string().max(200).optional(),
  snippet_extracted_at: z.string().optional(),
})

export const AssociationSchema = z.object({
  target_type: z.enum(['engram', 'document']),
  target: z.string(),
  strength: z.number().min(0).max(0.95),
  type: z.enum(['semantic', 'temporal', 'causal', 'co_accessed']),
  updated_at: z.string().optional(),
})

export const DualCodingSchema = z.object({
  example: z.string().optional(),
  analogy: z.string().optional(),
}).refine(
  d => d.example || d.analogy,
  'At least one of example or analogy must be provided'
)

export const RelationsSchema = z.object({
  broader: z.array(z.string()).default([]),
  narrower: z.array(z.string()).default([]),
  related: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
})

export const ProvenanceSchema = z.object({
  origin: z.string(),
  chain: z.array(z.string()).default([]),
  signature: z.string().nullable().default(null),
  license: z.string().default('cc-by-sa-4.0'),
})

export const FeedbackSignalsSchema = z.object({
  positive: z.number().int().default(0),
  negative: z.number().int().default(0),
  neutral: z.number().int().default(0),
})

export const EngramSchema = z.object({
  id: z.string().regex(/^(ENG|ABS)-[A-Za-z0-9-]+$/),
  version: z.number().int().min(1).default(2),
  status: z.enum(['active', 'dormant', 'retired', 'candidate']),
  consolidated: z.boolean().default(false),
  type: z.enum(['behavioral', 'terminological', 'procedural', 'architectural']),
  scope: z.string(),
  visibility: z.enum(['private', 'public', 'template']).default('private'),
  statement: z.string().min(1),
  rationale: z.string().optional(),
  contraindications: z.array(z.string()).optional(),
  source_patterns: z.array(z.string()).optional(),
  derivation_count: z.number().int().min(0).default(1),
  knowledge_type: KnowledgeTypeSchema.optional(),
  domain: z.string().optional(),
  relations: RelationsSchema.optional(),
  activation: ActivationSchema.default({ retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: new Date().toISOString().slice(0, 10) }),
  provenance: ProvenanceSchema.optional(),
  feedback_signals: FeedbackSignalsSchema.default({ positive: 0, negative: 0, neutral: 0 }),
  knowledge_anchors: z.array(KnowledgeAnchorSchema).default([]),
  associations: z.array(AssociationSchema).default([]),
  dual_coding: DualCodingSchema.optional(),
  tags: z.array(z.string()).default([]),
  pack: z.string().nullable().default(null),
  abstract: z.string().nullable().default(null),
  derived_from: z.string().nullable().default(null),
})

export type Engram = z.infer<typeof EngramSchema>
export type KnowledgeAnchor = z.infer<typeof KnowledgeAnchorSchema>
export type Association = z.infer<typeof AssociationSchema>
