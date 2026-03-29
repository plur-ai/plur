// packages/core/src/meta/hierarchy.ts
import type { Engram } from '../schemas/engram.js'
import type { MetaField } from '../schemas/meta-engram.js'

const SUBSUMPTION_THRESHOLD = 0.75

/** Token-based similarity on template strings */
function tokenSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/[\s\[\]→+\-]+/).filter(w => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/[\s\[\]→+\-]+/).filter(w => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let overlap = 0
  for (const w of wordsA) { if (wordsB.has(w)) overlap++ }
  return overlap / Math.sqrt(wordsA.size * wordsB.size)
}

function getMetaField(engram: Engram): MetaField | null {
  return (engram.structured_data?.meta as MetaField) ?? null
}

function getDomainCount(metaField: MetaField): number {
  const validated = metaField.domain_coverage.validated.length
  const evidenceDomains = new Set(metaField.evidence.map(e => e.domain)).size
  return Math.max(validated, evidenceDomains, metaField.confidence.domain_count)
}

/**
 * Organize meta-engrams into MOP/TOP hierarchy.
 * Purely deterministic: pairwise template similarity, parent-child by domain subsumption.
 * Returns engrams with updated hierarchy fields.
 */
export function organizeHierarchy(metaEngrams: Engram[]): Engram[] {
  const metas = metaEngrams.filter(e => getMetaField(e) !== null && e.id.startsWith('META-'))

  if (metas.length === 0) return metaEngrams

  // Reset hierarchy for all meta-engrams
  for (const meta of metas) {
    const mf = getMetaField(meta)!
    mf.hierarchy.parent = null
    mf.hierarchy.children = []
  }

  // Compute pairwise similarities and establish parent-child relationships
  for (let i = 0; i < metas.length; i++) {
    for (let j = 0; j < metas.length; j++) {
      if (i === j) continue

      const mfI = getMetaField(metas[i])!
      const mfJ = getMetaField(metas[j])!

      const sim = tokenSimilarity(mfI.structure.template, mfJ.structure.template)
      if (sim < SUBSUMPTION_THRESHOLD) continue

      const domainsI = getDomainCount(mfI)
      const domainsJ = getDomainCount(mfJ)

      // If I has strictly more domains than J, I is the parent of J
      if (domainsI > domainsJ) {
        if (!mfI.hierarchy.children.includes(metas[j].id)) {
          mfI.hierarchy.children.push(metas[j].id)
        }
        // Only assign parent if J doesn't have one or the current parent has fewer domains
        if (!mfJ.hierarchy.parent) {
          mfJ.hierarchy.parent = metas[i].id
        } else {
          // Check if new parent is better (more domains)
          const currentParent = metas.find(m => m.id === mfJ.hierarchy.parent)
          const currentParentMf = currentParent ? getMetaField(currentParent) : null
          if (currentParentMf && getDomainCount(currentParentMf) < domainsI) {
            mfJ.hierarchy.parent = metas[i].id
          }
        }
      }
    }
  }

  // Assign levels: TOP = domains >= 3 AND no parent, MOP otherwise
  for (const meta of metas) {
    const mf = getMetaField(meta)!
    const domains = getDomainCount(mf)
    if (domains >= 3 && !mf.hierarchy.parent) {
      mf.hierarchy.level = 'top'
    } else {
      mf.hierarchy.level = 'mop'
    }
  }

  return metaEngrams
}
