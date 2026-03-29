// packages/core/src/meta/pipeline.ts
import type { Engram } from '../schemas/engram.js'
import type { LlmFunction } from '../types.js'
import type { MetaField } from '../schemas/meta-engram.js'
import { analyzeStructure } from './structural-analysis.js'
import { clusterByStructure } from './clustering.js'
import { alignCluster } from './alignment.js'
import { formulateMetaEngram } from './formulation.js'
import { validateMetaEngram, type ValidationResult } from './validation.js'
import { organizeHierarchy } from './hierarchy.js'

export interface ExtractOptions {
  /** Whether to run Stage 5 validation (default: false — can be deferred) */
  run_validation?: boolean
  /** Engrams to use for validation (held-out domains) */
  validation_engrams?: Engram[]
  /** Existing meta-engrams to check for deduplication */
  existing_metas?: Engram[]
  /** Minimum cluster size to attempt alignment (default: 2) */
  min_cluster_size?: number
}

export interface ExtractionResult {
  engrams_analyzed: number
  clusters_found: number
  alignments_passed: number
  meta_engrams_extracted: number
  rejected_as_platitudes: number
  validation_results: ValidationResult[]
  results: Engram[]
  duration_ms: number
}

/**
 * Full meta-engram extraction pipeline: Stages 1 → 2 → 3 → 4 → 5(optional) → 6
 */
export async function extractMetaEngrams(
  engrams: Engram[],
  llm: LlmFunction,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const start = Date.now()
  const {
    run_validation = false,
    validation_engrams = [],
    existing_metas = [],
    min_cluster_size = 2,
  } = options

  let rejected_as_platitudes = 0

  // Stage 1: Structural Analysis
  const analyses = await analyzeStructure(engrams, llm)

  // Stage 2: Clustering (MAC layer)
  const clusters = await clusterByStructure(analyses)
  const viableClusters = clusters.filter(c => c.members.length >= min_cluster_size)

  // Stage 3: Alignment (FAC layer)
  const alignmentResults = await Promise.all(
    viableClusters.map(cluster => alignCluster(cluster, llm))
  )
  const validAlignments = alignmentResults.filter(r => r !== null) as NonNullable<typeof alignmentResults[0]>[]

  // Stage 4: Formulation
  const formulated: Engram[] = []
  for (const alignment of validAlignments) {
    const meta = await formulateMetaEngram(alignment, llm, [...existing_metas, ...formulated])
    if (meta === null) {
      rejected_as_platitudes++
    } else {
      // Enrich evidence entries with domain info from cluster members
      const cluster = viableClusters.find(c => c.cluster_id === alignment.cluster_id)
      if (cluster) {
        const metaField = meta.structured_data?.meta as MetaField | undefined
        if (metaField) {
          // Map engram_id → domain from cluster members
          const domainMap = new Map(cluster.members.map(m => [m.engram_id, m.domain]))
          for (const ev of metaField.evidence) {
            if (domainMap.has(ev.engram_id)) {
              ev.domain = domainMap.get(ev.engram_id)!
            }
          }
          // Update domain_count with actual distinct domains
          const distinctDomains = new Set(cluster.members.map(m => m.domain))
          metaField.confidence.domain_count = distinctDomains.size
          meta.domain = distinctDomains.size >= 3 ? 'meta' : `meta.${[...distinctDomains][0] ?? 'unknown'}`
        }
      }
      formulated.push(meta)
    }
  }

  // Stage 5: Cross-Domain Validation (optional)
  const validationResults: ValidationResult[] = []
  if (run_validation && validation_engrams.length > 0) {
    for (const meta of formulated) {
      const metaField = meta.structured_data?.meta as MetaField | undefined
      if (!metaField) continue

      // Find domains not already in evidence
      const evidenceDomains = new Set(metaField.evidence.map(e => e.domain))
      const testEngrams = validation_engrams.filter(e => !evidenceDomains.has(e.domain ?? ''))

      if (testEngrams.length > 0) {
        // Group by domain
        const byDomain = new Map<string, Engram[]>()
        for (const te of testEngrams) {
          const d = te.domain ?? 'unknown'
          if (!byDomain.has(d)) byDomain.set(d, [])
          byDomain.get(d)!.push(te)
        }
        for (const [domain, domainEngrams] of byDomain) {
          const vr = await validateMetaEngram(meta, domainEngrams, domain, llm)
          validationResults.push(vr)
        }
      }
    }
  }

  // Stage 6: Hierarchical Organization
  const organized = organizeHierarchy(formulated)

  const duration_ms = Date.now() - start

  return {
    engrams_analyzed: analyses.length,
    clusters_found: clusters.length,
    alignments_passed: validAlignments.length,
    meta_engrams_extracted: organized.length,
    rejected_as_platitudes,
    validation_results: validationResults,
    results: organized,
    duration_ms,
  }
}
