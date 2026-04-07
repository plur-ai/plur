// packages/core/src/meta/formulation.ts
import type { AlignmentResult } from './alignment.js'
import type { LlmFunction } from '../types.js'
import type { Engram } from '../schemas/engram.js'
import type { MetaField, EvidenceEntry } from '../schemas/meta-engram.js'
import { computeMetaConfidence } from '../confidence.js'
import { isPlatitude } from './platitudes.js'
import { tokenSimilarity } from './similarity.js'
import { sanitizeForPrompt } from './sanitize.js'

const PIPELINE_VERSION = '1.0.0'

/** Slugify a template string into a valid ID suffix (max 60 chars) */
function slugifyTemplate(template: string): string {
  return template
    .toLowerCase()
    .replace(/[\[\]→+]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}


function isDuplicate(template: string, existingMetas: Engram[]): Engram | null {
  for (const meta of existingMetas) {
    const metaField = meta.structured_data?.meta as MetaField | undefined
    if (!metaField?.structure?.template) continue
    const sim = tokenSimilarity(template, metaField.structure.template)
    if (sim > 0.90) return meta
  }
  return null
}

export async function formulateMetaEngram(
  alignment: AlignmentResult,
  llm: LlmFunction,
  existingMetas: Engram[] = [],
  /** Distinct domains from the cluster (provided by pipeline orchestrator) */
  domains: string[] = [],
): Promise<Engram | null> {
  const { common_structure, member_alignments, structural_depth, candidate_inferences } = alignment

  // Final quality gate: platitude check
  if (isPlatitude(common_structure.template)) return null

  // Build prompt for LLM to generate statement + falsification criteria
  const memberSummary = member_alignments
    .map(m => `  - ${m.engram_id}: ${sanitizeForPrompt(m.mapping_rationale)} (alignment: ${m.alignment_score})`)
    .join('\n')

  const prompt = `Structural principle: ${sanitizeForPrompt(common_structure.template)}
Goal type: ${common_structure.goal_type}
Constraint type: ${common_structure.constraint_type}
Outcome type: ${common_structure.outcome_type}
Structural depth: ${structural_depth}
Evidence from members:
${memberSummary}
Candidate inferences: ${candidate_inferences.map(sanitizeForPrompt).join(', ')}

Generate:
1. A natural-language statement of this principle (1-2 sentences, precise, not generic)
2. Conditions under which it holds (expected_conditions)
3. Conditions under which it does NOT hold (expected_exceptions)
4. A concrete test: pick a domain NOT in the evidence list, describe a scenario where this principle predicts a specific outcome (test_prediction)

The statement must be specific enough to be FALSIFIABLE. If you cannot write falsification criteria, return null.

Return JSON:
{
  "statement": "...",
  "falsification": {
    "expected_conditions": "...",
    "expected_exceptions": "...",
    "test_prediction": "..."
  }
}

Or return null if the principle is too vague to falsify.
Return ONLY valid JSON, no markdown fencing.`

  let parsed: any
  try {
    const response = await llm(prompt)
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    if (cleaned === 'null') return null
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }

  if (!parsed || !parsed.statement || !parsed.falsification) return null
  if (!parsed.falsification.expected_conditions || !parsed.falsification.expected_exceptions) return null

  // Deduplicate against existing meta-engrams
  const duplicate = isDuplicate(common_structure.template, existingMetas)
  if (duplicate) {
    // Merge evidence: update existing rather than create new
    // Return null to signal "no new engram needed"
    return null
  }

  // Compute meta-confidence
  const evidenceCount = member_alignments.length
  const domainCount = domains.length > 0 ? domains.length : 1 // Use actual domains when provided
  const validationRatio = 0 // No validation yet at formulation stage
  const composite = computeMetaConfidence(evidenceCount, domainCount, structural_depth, validationRatio)

  // Generate ID
  const slug = slugifyTemplate(common_structure.template)
  const id = `META-${slug}`

  // Build evidence entries
  const evidence: EvidenceEntry[] = member_alignments.map(ma => ({
    engram_id: ma.engram_id,
    domain: 'unknown', // Will be enriched by pipeline orchestrator
    mapping_rationale: ma.mapping_rationale,
    alignment_score: ma.alignment_score,
  }))

  const metaField: MetaField = {
    structure: common_structure,
    evidence,
    domain_coverage: {
      validated: [],
      failed: [],
      predicted: candidate_inferences,
    },
    falsification: parsed.falsification,
    confidence: {
      evidence_count: evidenceCount,
      domain_count: domainCount,
      structural_depth,
      validation_ratio: validationRatio,
      composite,
    },
    hierarchy: {
      level: domainCount >= 3 ? 'top' : 'mop',
      parent: null,
      children: [],
    },
    pipeline_version: PIPELINE_VERSION,
  }

  const now = new Date().toISOString()
  const engram: Engram = {
    id,
    version: 2,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement: parsed.statement,
    domain: 'meta',
    tags: ['meta-engram', common_structure.goal_type, common_structure.constraint_type],
    activation: {
      retrieval_strength: composite,
      storage_strength: 1.0,
      frequency: 0,
      last_accessed: now.slice(0, 10),
    },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_anchors: [],
    associations: [],
    derivation_count: evidenceCount,
    pack: null,
    abstract: null,
    derived_from: null,
    polarity: null,
    engram_version: 1,
    episode_ids: [],
    knowledge_type: {
      memory_class: 'metacognitive',
      cognitive_level: 'evaluate',
    },
    structured_data: { meta: metaField },
  }

  return engram
}
