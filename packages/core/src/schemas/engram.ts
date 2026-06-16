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

// === NEW: Version lineage (SP2 Idea 8) ===

export const PreviousVersionRefSchema = z.object({
  event_id: z.string(),
  changed_at: z.string(),
})

// === NEW: Exchange metadata (marketplace fitness) ===

export const ExchangeMetadataSchema = z.object({
  fitness_score: z.number().min(0).max(1).optional(),
  environmental_diversity: z.number().int().default(0),
  adoption_count: z.number().int().default(0),
  contradiction_rate: z.number().min(0).max(1).default(0),
})

// === NEW: Memory-stream insight engrams (metacognition Phase 1) ===
//
// An "insight engram" is a normal engram carrying an optional `insight` sub-object.
// Following the #110 failure-engram pattern, this is ORTHOGONAL to `type`: `type`
// stays the cognitive class (behavioral/terminological/procedural/architectural),
// while `insight` records that the engram was synthesized by the metacognition
// memory stream — its synthesis origin, source grounding, serendipity, and
// downstream fate. The "episodic insight buffer" is simply the set of engrams
// where `insight != null`. Source citations reuse `knowledge_anchors[]`; lifecycle
// reuses `status`/`activation` decay; gist consolidation reuses the meta-engram
// pipeline. Decisions: 5-plur/3-knowledge/pages/insight-engram-schema-2026-06-14.md

/** Serendipity objective for connect/emerge/dream insights = unexpectedness × relevance
 *  (Kotkov et al., JCST 2020). Scored on existing embeddings + buffer novelty —
 *  NOT a learned link predictor. */
export const SerendipitySchema = z.object({
  unexpectedness: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
  score: z.number().min(0).max(1),
})

/** Downstream fate of a surfaced insight — the substrate for the primary
 *  evaluation metric "insight acted-upon rate" (NOT engagement). */
export const InsightFateSchema = z.enum([
  'surfaced',   // shown in a briefing; no downstream action yet
  'promoted',   // became a durable engram / zettel
  'cited',      // referenced in later journal/work
  'tasked',     // converted to a GTD task
  'dismissed',  // user/LLM rejected it
  'expired',    // decayed out of the buffer unused
])

export const InsightFieldSchema = z.object({
  /** Which memory-stream operation produced this insight. Nightly arc:
   *  `distill` (episode→insight synthesis) → `consolidate` (convergent gist
   *  abstraction over the buffer) → `dream` (divergent REM-style recombination —
   *  speculative, never auto-promoted). `connect`/`emerge`/`drift` are on-demand lenses. */
  operation: z.enum(['distill', 'consolidate', 'dream', 'connect', 'emerge', 'drift']),
  synthesized_at: z.string(),

  /** Anti-hallucination grounding. Cited source notes live in the parent engram's
   *  `knowledge_anchors[]`; this flags whether the claim was verified against those
   *  snippets. `ungrounded` = couldn't cite sources → quarantined (`candidate`, never
   *  surfaced). `speculative` = a `dream`: its recombined INPUTS are cited but its
   *  CONCLUSION is an explicit hypothesis — surfaced only as inspiration, and (per the
   *  promote-requires-grounding refine below) it must be re-grounded to `verified`
   *  before it can be promoted to a durable engram. */
  grounding: z.enum(['verified', 'unverified', 'ungrounded', 'speculative']).default('unverified'),
  /** The episode-log slice this insight was distilled from (evidence trail). */
  source_episode_ids: z.array(z.string()).default([]),

  /** Distinct objective for connect/emerge/dream insights. */
  serendipity: SerendipitySchema.optional(),

  fate: InsightFateSchema.default('surfaced'),
  /** Engram id / zettel path / task id the insight became, if acted upon. */
  fate_ref: z.string().optional(),
  fate_at: z.string().optional(),
  /** How many briefings have surfaced this insight (acted-upon-rate denominator). */
  surfaced_count: z.number().int().min(0).default(0),
}).refine(
  // Promote-requires-grounding (user rule 2026-06-15): a dream is inspiration, not
  // fact. A speculative/ungrounded insight can only become a durable promotion once
  // it has been re-grounded in reality (grounding=verified).
  i => i.fate !== 'promoted' || i.grounding === 'verified',
  { message: 'A promoted insight must be grounded (grounding=verified); speculative dreams cannot be promoted until re-grounded.', path: ['grounding'] },
)

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

  /** Memory-stream insight provenance (metacognition Phase 1). Orthogonal to
   *  `type`. Present iff this engram was synthesized by the metacognition memory
   *  stream; the episodic insight buffer is the set of engrams where this is set. */
  insight: InsightFieldSchema.optional(),

  /** Polarity classification: 'do' for directives, 'dont' for prohibitions, null for unclassified. */
  polarity: z.enum(['do', 'dont']).nullable().default(null),

  // === SP1: Memory Intelligence fields ===
  content_hash: z.string().optional(),
  commitment: z.enum(['exploring', 'leaning', 'decided', 'locked']).optional(),
  locked_at: z.string().optional(),
  locked_reason: z.string().optional(),

  // === SP1: Reference counting (issue #107) ===
  /** Number of write attempts that resolved to this engram.
   * Incremented on every hash-dedup hit; decremented by forget().
   * Engram physically retires only when this reaches 0. */
  reference_count: z.number().int().min(0).default(1),
  /** Provenance of each write attempt. One entry per write (including the
   * first). Migrated old engrams without this field start with []. */
  sources: z.array(z.object({
    scope: z.string(),
    session_id: z.string().nullable().default(null),
    stored_at: z.string(),  // ISO timestamp of this write
  })).default([]),

  // === SP1: Cross-scope recurrence (issue #176) ===
  /** Number of times this engram's content was re-learned at a DIFFERENT
   * scope than the original. Triggers auto-broadening + commitment
   * escalation when threshold is crossed. Distinct from reference_count
   * (which counts re-learns in the SAME scope) — recurrence_count is
   * evidence of universal applicability, not just repetition. */
  recurrence_count: z.number().int().min(0).default(0),

  // === SP2: History & Evolution fields ===
  engram_version: z.number().int().min(1).default(1),
  previous_version_ref: PreviousVersionRefSchema.optional(),
  episode_ids: z.array(z.string()).default([]),

  // === SP3: Retrieval & Injection fields ===
  summary: z.string().max(80).optional(),

  /**
   * Always-load flag. Pinned engrams bypass the term-hits gate in scoreEngram
   * and are eligible for injection on every session start, regardless of
   * keyword overlap with the user's task. Use sparingly: meta-rules,
   * cross-cutting safety conventions, and core operating principles only.
   * Pinned engrams still respect the token budget — they bypass per-pack and
   * per-domain fairness caps in fillTokenBudget so always-load behavior is
   * honored even if a single pack contributes many.
   */
  pinned: z.boolean().optional(),
})

/**
 * Runtime schema with .passthrough() so unknown fields are preserved during parsing.
 * This prevents data loss when new fields are added by hand or by other SPs.
 * The Engram type is derived from the strict schema (without passthrough) to keep
 * TypeScript type safety — passthrough only affects runtime Zod validation.
 */
export const EngramSchemaPassthrough = EngramSchema.passthrough()

export type Engram = z.infer<typeof EngramSchema>
export type KnowledgeAnchor = z.infer<typeof KnowledgeAnchorSchema>
export type Association = z.infer<typeof AssociationSchema>
export type EntityRef = z.infer<typeof EntityRefSchema>
export type Temporal = z.infer<typeof TemporalSchema>
export type UsageStats = z.infer<typeof UsageStatsSchema>
export type EpisodicFields = z.infer<typeof EpisodicFieldsSchema>
export type ExchangeMetadata = z.infer<typeof ExchangeMetadataSchema>
export type PreviousVersionRef = z.infer<typeof PreviousVersionRefSchema>
export type Serendipity = z.infer<typeof SerendipitySchema>
export type InsightFate = z.infer<typeof InsightFateSchema>
export type InsightField = z.infer<typeof InsightFieldSchema>
