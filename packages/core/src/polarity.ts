// src/polarity.ts

/**
 * Detect dont-patterns in engram statements.
 * Returns 'dont' if the statement contains prohibition language.
 * Returns null for everything else — null engrams are treated as directives
 * in the injection pipeline. This avoids false-positive "do" classification
 * from common verbs (use, run, apply) that appear in descriptive statements.
 */

const DONT_PATTERNS: RegExp[] = [
  /\bnever\b/i,
  /\bdo\s+not\b/i,
  /\bdon'?t\b/i,
  /\bavoid\b/i,
  /\bmust\s+not\b/i,
  /\bshould\s+not\b/i,
  /\bNOT\b.*?\b(?:include|use|run|start|create|add|send|describe|reference|assume)\b/,
  /\bstop\b.*?\b(?:generating|iterating|doing|running|creating)\b/i,
]

export function classifyPolarity(statement: string): 'dont' | null {
  if (!statement || statement.length < 5) return null

  // Check first sentence only (first period or 200 chars)
  const dotIndex = statement.indexOf('.')
  const firstSentence = statement.slice(0, dotIndex > 0 ? Math.min(dotIndex, 200) : 200)

  for (const pattern of DONT_PATTERNS) {
    if (pattern.test(firstSentence)) return 'dont'
  }

  return null
}
