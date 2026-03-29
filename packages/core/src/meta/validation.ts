// packages/core/src/meta/validation.ts
import type { Engram } from '../schemas/engram.js'
import type { MetaField } from '../schemas/meta-engram.js'
import type { LlmFunction } from '../types.js'
import { computeMetaConfidence } from '../confidence.js'
import { sanitizeForPrompt } from './sanitize.js'

export interface ValidationResult {
  meta_engram_id: string
  test_domain: string
  prediction_held: boolean
  matching_engram_id: string | null
  alignment_score: number
  rationale: string
}

export async function validateMetaEngram(
  meta: Engram,
  testEngrams: Engram[],
  testDomain: string,
  llm: LlmFunction,
): Promise<ValidationResult> {
  const metaField = meta.structured_data?.meta as MetaField | undefined

  if (!metaField) {
    return {
      meta_engram_id: meta.id,
      test_domain: testDomain,
      prediction_held: false,
      matching_engram_id: null,
      alignment_score: 0,
      rationale: 'Meta-engram has no meta field',
    }
  }

  const template = metaField.structure.template
  const testEngramSummary = testEngrams
    .filter(e => e.status === 'active')
    .slice(0, 10)
    .map(e => `  - [${e.id}] ${sanitizeForPrompt(e.statement)}`)
    .join('\n')

  if (!testEngramSummary) {
    return {
      meta_engram_id: meta.id,
      test_domain: testDomain,
      prediction_held: false,
      matching_engram_id: null,
      alignment_score: 0,
      rationale: 'No test engrams available for validation',
    }
  }

  const prompt = `Meta-engram structural principle: ${sanitizeForPrompt(template)}
Meta-engram statement: ${sanitizeForPrompt(meta.statement)}

Test domain: ${testDomain}
Test engrams from this domain:
${testEngramSummary}

Task: Does any of the test engrams instantiate or validate this structural principle?

If YES (a test engram matches):
- prediction_held: true
- matching_engram_id: the ID of the matching engram
- alignment_score: 0.5-1.0 (how well the structural template maps)
- rationale: one sentence explaining how the test engram maps to the template

If NO (no test engram matches):
- prediction_held: false
- matching_engram_id: null
- alignment_score: 0
- rationale: one sentence explaining WHY none of the test engrams match (e.g., "Test engrams cover X domain but none exhibit the structural pattern of [assumed independence] → [understated risk]")

Return JSON:
{
  "prediction_held": true|false,
  "matching_engram_id": "ENG-..." | null,
  "alignment_score": 0.0-1.0,
  "rationale": "one sentence explanation — REQUIRED even when prediction_held is false"
}

Return ONLY valid JSON, no markdown fencing.`

  try {
    const response = await llm(prompt)
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned)

    const result: ValidationResult = {
      meta_engram_id: meta.id,
      test_domain: testDomain,
      prediction_held: Boolean(parsed.prediction_held),
      matching_engram_id: parsed.matching_engram_id ?? null,
      alignment_score: typeof parsed.alignment_score === 'number' ? parsed.alignment_score : 0,
      rationale: parsed.rationale ?? '',
    }

    // Update domain_coverage on meta-engram in place
    if (result.prediction_held) {
      if (!metaField.domain_coverage.validated.includes(testDomain)) {
        metaField.domain_coverage.validated.push(testDomain)
      }
    } else {
      if (!metaField.domain_coverage.failed.includes(testDomain)) {
        metaField.domain_coverage.failed.push(testDomain)
      }
    }

    // Recompute confidence
    const passes = metaField.domain_coverage.validated.length
    const total = passes + metaField.domain_coverage.failed.length
    const validationRatio = total > 0 ? passes / total : 0

    const updatedComposite = computeMetaConfidence(
      metaField.confidence.evidence_count,
      metaField.confidence.domain_count,
      metaField.confidence.structural_depth,
      validationRatio,
    )

    metaField.confidence.validation_ratio = validationRatio
    metaField.confidence.composite = updatedComposite
    metaField.last_validated = new Date().toISOString().slice(0, 10)

    // Demote if failing too many validations
    const failedCount = metaField.domain_coverage.failed.length
    if (failedCount >= 3) {
      if (metaField.hierarchy.level === 'top') {
        metaField.hierarchy.level = 'mop'
      } else {
        meta.status = 'retired'
      }
    }

    return result
  } catch {
    return {
      meta_engram_id: meta.id,
      test_domain: testDomain,
      prediction_held: false,
      matching_engram_id: null,
      alignment_score: 0,
      rationale: 'LLM parsing failed during validation',
    }
  }
}
