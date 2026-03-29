// packages/core/src/meta/similarity.ts

/** Token-based similarity between two template strings. Used for clustering, dedup, and hierarchy. */
export function tokenSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/[\s\[\]→+\-]+/).filter(w => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/[\s\[\]→+\-]+/).filter(w => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let overlap = 0
  for (const w of wordsA) { if (wordsB.has(w)) overlap++ }
  return overlap / Math.sqrt(wordsA.size * wordsB.size)
}
