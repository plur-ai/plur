// packages/core/src/meta/clustering.ts
import type { RelationalAnalysis, RelationalTriple } from './structural-analysis.js'

export interface EngramCluster {
  cluster_id: string
  members: RelationalAnalysis[]
  domains: string[]
  is_cross_domain: boolean
  cohesion: number
}

/** Convert relational triples to a template string for embedding */
function tripleToTemplate(triple: RelationalTriple): string {
  const parts = [triple.subject.role, triple.predicate, triple.object.role]
  if (triple.outcome) parts.push('→', triple.outcome)
  return parts.join(' ')
}

function analysisTemplate(analysis: RelationalAnalysis): string {
  return analysis.triples.map(tripleToTemplate).join('; ')
}

/** Simple cosine similarity for string-based clustering (token overlap) */
function tokenSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/[\s-]+/).filter(w => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/[\s-]+/).filter(w => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let overlap = 0
  for (const w of wordsA) { if (wordsB.has(w)) overlap++ }
  return overlap / Math.sqrt(wordsA.size * wordsB.size)
}

const SIMILARITY_THRESHOLD = 0.35 // Token overlap threshold (lower than embedding threshold)

/**
 * Cluster relational analyses by structural similarity.
 * Uses token-based similarity on template strings as a fast MAC layer.
 * When @huggingface/transformers embeddings are available, can be upgraded to embedding cosine.
 */
export async function clusterByStructure(
  analyses: RelationalAnalysis[],
  threshold: number = SIMILARITY_THRESHOLD,
): Promise<EngramCluster[]> {
  if (analyses.length < 2) return []

  // Compute templates
  const templates = analyses.map(a => analysisTemplate(a))

  // Agglomerative clustering via pairwise similarity
  const assigned = new Set<number>()
  const clusters: EngramCluster[] = []
  let clusterId = 0

  for (let i = 0; i < analyses.length; i++) {
    if (assigned.has(i)) continue

    const members = [analyses[i]]
    assigned.add(i)

    for (let j = i + 1; j < analyses.length; j++) {
      if (assigned.has(j)) continue
      const sim = tokenSimilarity(templates[i], templates[j])
      if (sim >= threshold) {
        members.push(analyses[j])
        assigned.add(j)
      }
    }

    if (members.length < 2) continue // Discard singletons

    const domains = [...new Set(members.map(m => m.domain))]

    // Compute cohesion (mean pairwise similarity within cluster)
    let totalSim = 0
    let pairs = 0
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        totalSim += tokenSimilarity(
          analysisTemplate(members[a]),
          analysisTemplate(members[b]),
        )
        pairs++
      }
    }

    clusters.push({
      cluster_id: `cluster-${clusterId++}`,
      members,
      domains,
      is_cross_domain: domains.length >= 2,
      cohesion: pairs > 0 ? totalSim / pairs : 0,
    })
  }

  return clusters
}
