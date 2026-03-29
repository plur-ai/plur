// packages/core/src/meta/structural-analysis.ts
import type { Engram } from '../schemas/engram.js'
import type { LlmFunction } from '../types.js'
import { classifyPolarity } from '../polarity.js'

export interface TypedRole {
  role: string
  domain_instance: string
}

export interface RelationalTriple {
  subject: TypedRole
  predicate: string
  object: TypedRole
  outcome?: string
}

export interface RelationalAnalysis {
  engram_id: string
  triples: RelationalTriple[]
  goal_context: string
  is_failure_driven: boolean
  domain: string
  polarity: 'do' | 'dont'
}

const FAILURE_TAGS = new Set(['correction', 'mistake', 'bug', 'fix', 'error', 'wrong', 'broken'])
const BATCH_SIZE = 5

function isFailureDriven(engram: Engram): boolean {
  if (engram.tags.some(t => FAILURE_TAGS.has(t.toLowerCase()))) return true
  const fb = engram.feedback_signals
  if (fb && fb.negative > fb.positive) return true
  return false
}

function prioritize(engrams: Engram[]): Engram[] {
  return [...engrams].sort((a, b) => {
    const aFail = isFailureDriven(a) ? 0 : 1
    const bFail = isFailureDriven(b) ? 0 : 1
    if (aFail !== bFail) return aFail - bFail
    const aFb = (a.feedback_signals?.negative ?? 0)
    const bFb = (b.feedback_signals?.negative ?? 0)
    return bFb - aFb
  })
}

function buildPrompt(engrams: Engram[]): string {
  const items = engrams.map((e, i) => {
    const parts = [`  Statement: "${e.statement}"`]
    if (e.rationale) parts.push(`  Rationale: "${e.rationale}"`)
    if (e.domain) parts.push(`  Domain: "${e.domain}"`)
    return `Engram ${i + 1} (${e.id}):\n${parts.join('\n')}`
  }).join('\n\n')

  return `Given these learned lessons, extract relational structure for cross-domain transfer.

${items}

For EACH engram, extract:
1. The GOAL the agent had (abstract type, not domain-specific)
2. Relational triples: subject (role + domain instance), predicate, object (role + domain instance), outcome
3. Use domain-GENERAL role types (e.g., "safety-metric" not "liquidation-price")

Return a JSON array with one object per engram:
[{
  "engram_id": "ENG-...",
  "goal_context": "what the agent was trying to achieve (abstract)",
  "triples": [{ "subject": { "role": "...", "domain_instance": "..." }, "predicate": "...", "object": { "role": "...", "domain_instance": "..." }, "outcome": "..." }]
}]

Rules:
- Roles MUST be domain-general (e.g., "safety-metric" not "liquidation-price")
- If a lesson is purely domain-specific with no transferable structure, return empty triples: []
- Prefer causal chains over isolated attributes
- Return ONLY valid JSON, no markdown fencing`
}

export async function analyzeStructure(
  engrams: Engram[],
  llm: LlmFunction,
): Promise<RelationalAnalysis[]> {
  const prioritized = prioritize(engrams.filter(e => e.status === 'active'))
  const results: RelationalAnalysis[] = []

  // Process in batches
  for (let i = 0; i < prioritized.length; i += BATCH_SIZE) {
    const batch = prioritized.slice(i, i + BATCH_SIZE)
    const prompt = buildPrompt(batch)

    let parsed: any[]
    try {
      const response = await llm(prompt)
      // Strip markdown fencing if present
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      // Retry with simplified prompt
      try {
        const retryResponse = await llm(prompt + '\n\nIMPORTANT: Return ONLY raw JSON array, no text.')
        const cleaned = retryResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
        parsed = JSON.parse(cleaned)
      } catch {
        continue // Skip batch on persistent failure
      }
    }

    for (const item of parsed) {
      if (!item.triples || item.triples.length === 0) continue

      const engram = batch.find(e => e.id === item.engram_id) ?? batch[parsed.indexOf(item)]
      if (!engram) continue

      results.push({
        engram_id: engram.id,
        triples: item.triples,
        goal_context: item.goal_context ?? '',
        is_failure_driven: isFailureDriven(engram),
        domain: engram.domain ?? 'unknown',
        polarity: classifyPolarity(engram.statement) === 'dont' ? 'dont' : 'do',
      })
    }
  }

  return results
}
