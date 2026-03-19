import { ftsTokenize, ftsScore } from './fts.js'
import type { Engram } from './schemas/engram.js'

export function detectConflicts(
  newEngram: { statement: string; scope?: string },
  existing: Engram[],
  threshold = 0.4,
): Engram[] {
  const newScope = newEngram.scope || 'global'
  const newTokens = ftsTokenize(newEngram.statement)
  if (newTokens.length === 0) return []

  return existing.filter(e => {
    if (e.status !== 'active') return false
    if ((e.scope || 'global') !== newScope) return false
    const score = ftsScore(e, newTokens)
    return score >= threshold
  })
}
