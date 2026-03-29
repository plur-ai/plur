import { z } from 'zod'

// === Existing schemas (unchanged for backward compat) ===

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

// === NEW: Structured entity extraction ===

export const EntityRefSchema = z.object({
  name: z.string(),
  type: z.enum([
    'person', 'organization', 'technology',
    'concept', 'project', 'tool', 'place',
    'event', 'standard', 'other',
  ]),
  uri: z.string().url().optional(),
})

// === NEW: Temporal anchoring (Zep-inspired bi-temporal) ===

export const TemporalSchema = z.object({
  learned_at: z.string(),
  valid_from: z.string().optional(),
  valid_until: z.string().optional(),
  ingested_at: z.string().optional(),
})

// === NEW: Usage tracking (Softmax Engram-inspired hit/miss) ===

export const UsageStatsSchema = z.object({
  injections: z.number().int().default(0),
  hits: z.number().int().default(0),
  misses: z.number().int().default(0),
  last_hit_at: z.string().optional(),
})

// === NEW: Episodic memory fields (from DIP-0019) ===

export const EpisodicFieldsSchema = z.object({
  emotional_weight: z.number().int().min(1).max(10).default(5),
  confidence: z.number().int().min(1).max(10).default(5),
  trigger_context: z.string().optional(),
  journal_ref: z.string().optional(),
})

// === NEW: Exchange metadata (marketplace fitness) ===

export const ExchangeMetadataSchema = z.object({
  fitness_score: z.number().min(0).max(1).optional(),
  environmental_diversity: z.number().int().default(0),
  adoption_count: z.number().int().default(0),
  contradiction_rate: z.number().min(0).max(1).default(0),
})

// === Main Engram Schema ===

export const EngramSchema = z.object({
  // Identity
  id: z.string().regex(/^(ENG|ABS|META)-[A-Za-z0-9-]+$/),
  version: z.number().int().min(1).default(2),
  status: z.enum(['active', 'dormant', 'retired', 'candidate']),
  consolidated: z.boolean().default(false),
  type: z.enum(['behavioral', 'terminological', 'procedural', 'architectural']),
  scope: z.string(),
  visibility: z.enum(['private', 'public', 'template']).default('private'),

  // Content
  statement: z.string().min(1),
  rationale: z.string().optional(),
  contraindications: z.array(z.string()).optional(),

  // Lineage
  source: z.string().optional(),
  source_patterns: z.array(z.string()).optional(),
  derivation_count: z.number().int().min(0).default(1),
  pack: z.string().nullable().default(null),
  abstract: z.string().nullable().default(null),
  derived_from: z.string().nullable().default(null),

  // Classification
  knowledge_type: KnowledgeTypeSchema.optional(),
  domain: z.string().optional(),
  tags: z.array(z.string()).default([]),

  // Activation (ACT-R model)
  activation: ActivationSchema.default({
    retrieval_strength: 0.7,
    storage_strength: 1.0,
    frequency: 0,
    last_accessed: new Date().toISOString().slice(0, 10),
  }),

  // Relations & grounding
  relations: RelationsSchema.optional(),
  associations: z.array(AssociationSchema).default([]),
  knowledge_anchors: z.array(KnowledgeAnchorSchema).default([]),
  dual_coding: DualCodingSchema.optional(),

  // Provenance
  provenance: ProvenanceSchema.optional(),

  // Feedback
  feedback_signals: FeedbackSignalsSchema.default({ positive: 0, negative: 0, neutral: 0 }),

  // === NEW OPTIONAL FIELDS (v2.1) ===

  /** Typed entity references extracted from statement. Enables graph queries. */
  entities: z.array(EntityRefSchema).optional(),

  /** Temporal validity window. When is this knowledge true? */
  temporal: TemporalSchema.optional(),

  /** Automatic usage tracking. Injections, hits, misses. */
  usage: UsageStatsSchema.optional(),

  /** Episodic context: emotional weight, confidence, trigger. */
  episodic: EpisodicFieldsSchema.optional(),

  /** Exchange marketplace metadata: fitness, adoption, diversity. */
  exchange: ExchangeMetadataSchema.optional(),

  /** Extensible key-value data for domain-specific fields. */
  structured_data: z.record(z.string(), z.unknown()).optional(),
})

export type Engram = z.infer<typeof EngramSchema>
export type KnowledgeAnchor = z.infer<typeof KnowledgeAnchorSchema>
export type Association = z.infer<typeof AssociationSchema>
export type EntityRef = z.infer<typeof EntityRefSchema>
export type Temporal = z.infer<typeof TemporalSchema>
export type UsageStats = z.infer<typeof UsageStatsSchema>
export type EpisodicFields = z.infer<typeof EpisodicFieldsSchema>
export type ExchangeMetadata = z.infer<typeof ExchangeMetadataSchema>
