// packages/core/src/meta/alignment.ts
import type { EngramCluster } from './clustering.js'
import type { StructuralTemplate } from '../schemas/meta-engram.js'
import type { LlmFunction } from '../types.js'
import { isPlatitude } from './platitudes.js'

export interface MemberAlignment {
  engram_id: string
  alignment_score: number
  mapping_rationale: string
}

export interface AlignmentResult {
  cluster_id: string
  common_structure: StructuralTemplate
  member_alignments: MemberAlignment[]
  structural_depth: number
  systematicity: number
  candidate_inferences: string[]
}

export async function alignCluster(
  cluster: EngramCluster,
  llm: LlmFunction,
): Promise<AlignmentResult | null> {
  const tripleDescriptions = cluster.members.map(m => {
    const domain = m.domain
    const triples = m.triples.map(t => {
      const parts = [`${t.subject.role} ${t.predicate} ${t.object.role}`]
      if (t.outcome) parts.push(`→ ${t.outcome}`)
      return parts.join(' ')
    }).join('; ')
    return `Domain ${domain} (${m.engram_id}): ${triples}`
  }).join('\n')

  const prompt = `These lessons come from different domains but may share a common structural principle:

${tripleDescriptions}

Tasks:
1. Is there a genuine common relational structure? (Not surface similarity, not a platitude)
2. If yes, express it as JSON: { "goal_type": "...", "constraint_type": "...", "outcome_type": "...", "template": "[goal] + [constraint] → [outcome]" }
3. Rate structural depth (1-5): 1=surface, 3=causal chain, 5=deep systematic
4. For each member, rate alignment (0-1) and explain the mapping in one sentence
5. What does this structure PREDICT in a domain not listed above?

Return JSON:
{
  "common_structure": { "goal_type": "...", "constraint_type": "...", "outcome_type": "...", "template": "..." } | null,
  "structural_depth": N,
  "member_alignments": [{ "engram_id": "...", "alignment_score": N, "mapping_rationale": "..." }],
  "candidate_inferences": ["..."]
}

If the commonality is shallow or trivially obvious (e.g., "mistakes happen", "always be careful"), return null for common_structure. We prefer no extraction over a false abstraction.
Return ONLY valid JSON, no markdown fencing.`

  try {
    const response = await llm(prompt)
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()

    if (cleaned === 'null' || cleaned === '{"common_structure": null}') return null

    const parsed = JSON.parse(cleaned)

    if (!parsed.common_structure) return null

    // Quality gates
    if (parsed.structural_depth < 2) return null
    if (isPlatitude(parsed.common_structure.template)) return null
    if (parsed.common_structure.template.length < 30) return null

    // Check alignment scores — reject if >50% below 0.5
    const alignments = parsed.member_alignments ?? []
    const lowAlignments = alignments.filter((a: any) => a.alignment_score < 0.5)
    if (lowAlignments.length > alignments.length / 2) return null

    return {
      cluster_id: cluster.cluster_id,
      common_structure: parsed.common_structure,
      member_alignments: alignments,
      structural_depth: parsed.structural_depth,
      systematicity: parsed.structural_depth, // Use depth as systematicity proxy
      candidate_inferences: parsed.candidate_inferences ?? [],
    }
  } catch {
    return null // LLM parse failure = null case
  }
}
