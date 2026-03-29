// packages/core/src/meta/clustering.ts
import type { RelationalAnalysis, RelationalTriple } from './structural-analysis.js'
import { tokenSimilarity } from './similarity.js'

export interface EngramCluster {
  cluster_id: string
  members: RelationalAnalysis[]
  domains: string[]
  is_cross_domain: boolean
  cohesion: number
}

/** Convert relational triples to a template string for embedding/comparison */
function tripleToTemplate(triple: RelationalTriple): string {
  const parts = [triple.subject.role, triple.predicate, triple.object.role]
  if (triple.outcome) parts.push('→', triple.outcome)
  return parts.join(' ')
}

function analysisTemplate(analysis: RelationalAnalysis): string {
  return analysis.triples.map(tripleToTemplate).join('; ')
}


/** Try to compute embedding-based pairwise similarities; fall back to token overlap */
async function computeSimilarityMatrix(
  templates: string[],
): Promise<{ matrix: number[][]; method: 'embedding' | 'token' }> {
  const n = templates.length
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0))

  // Try embeddings first
  try {
    const { embed, cosineSimilarity } = await import('../embeddings.js')
    const embeddings: (Float32Array | null)[] = []
    for (const t of templates) {
      embeddings.push(await embed(t))
    }
    // Check if embeddings are available (first one non-null)
    if (embeddings[0] !== null) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (embeddings[i] && embeddings[j]) {
            const sim = cosineSimilarity(embeddings[i]!, embeddings[j]!)
            matrix[i][j] = sim
            matrix[j][i] = sim
          }
        }
      }
      return { matrix, method: 'embedding' }
    }
  } catch {
    // Embeddings unavailable — fall through to token similarity
  }

  // Fallback: token overlap
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = tokenSimilarity(templates[i], templates[j])
      matrix[i][j] = sim
      matrix[j][i] = sim
    }
  }
  return { matrix, method: 'token' }
}

// Thresholds differ by method — embeddings are semantically richer so threshold is higher
const EMBEDDING_THRESHOLD = 0.65
const TOKEN_THRESHOLD = 0.35

/**
 * Cluster relational analyses by structural similarity.
 * Prefers embedding-based cosine similarity (384-dim BGE vectors) for semantic depth.
 * Falls back to token overlap when @huggingface/transformers is unavailable.
 */
export async function clusterByStructure(
  analyses: RelationalAnalysis[],
  threshold?: number,
): Promise<EngramCluster[]> {
  if (analyses.length < 2) return []

  const templates = analyses.map(a => analysisTemplate(a))
  const { matrix, method } = await computeSimilarityMatrix(templates)
  const effectiveThreshold = threshold ?? (method === 'embedding' ? EMBEDDING_THRESHOLD : TOKEN_THRESHOLD)

  // Multi-membership clustering: each engram can appear in multiple clusters
  const seenClusters = new Set<string>()
  const clusters: EngramCluster[] = []
  let clusterId = 0

  for (let i = 0; i < analyses.length; i++) {
    const members = [analyses[i]]
    const memberIndices = [i]

    for (let j = 0; j < analyses.length; j++) {
      if (j === i) continue
      if (matrix[i][j] >= effectiveThreshold) {
        members.push(analyses[j])
        memberIndices.push(j)
      }
    }

    if (members.length < 2) continue // Discard singletons

    // Deduplicate: skip if this exact member set (by sorted IDs) already exists
    const memberKey = members.map(m => m.engram_id).sort().join(',')
    if (seenClusters.has(memberKey)) continue
    seenClusters.add(memberKey)

    const domains = [...new Set(members.map(m => m.domain))]

    // Compute cohesion (mean pairwise similarity within cluster)
    let totalSim = 0
    let pairs = 0
    for (let a = 0; a < memberIndices.length; a++) {
      for (let b = a + 1; b < memberIndices.length; b++) {
        totalSim += matrix[memberIndices[a]][memberIndices[b]]
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
