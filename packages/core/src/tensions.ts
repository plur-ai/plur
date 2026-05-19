import type { Engram } from './schemas/engram.js'
import type { LlmFunction } from './types.js'
import { ftsTokenize } from './fts.js'

export interface TensionPair {
  id_a: string
  id_b: string
  statement_a: string
  statement_b: string
  confidence: number
  reason: string
}

export interface TensionScanResult {
  pairs_checked: number
  new_tensions: number
  tensions: TensionPair[]
}

export function buildContradictionPrompt(
  a: { id: string; statement: string },
  b: { id: string; statement: string },
): string {
  return `You are a memory consistency checker. Determine whether these two statements CONTRADICT each other.

STATEMENT A [${a.id}]:
"${a.statement}"

STATEMENT B [${b.id}]:
"${b.statement}"

Two statements CONTRADICT when one asserts X is true and the other asserts X is false, different, or mutually exclusive.
Do NOT flag as contradictions: different topics in the same domain, complementary facts, or unrelated statements that happen to share keywords.

Respond in this EXACT format:
CONTRADICTS: yes|no
CONFIDENCE: 0.0-1.0
REASON: <one sentence>`
}

export function parseContradictionResponse(response: string): {
  is_contradiction: boolean
  confidence: number
  reason: string
} {
  const contradictsMatch = response.match(/CONTRADICTS:\s*(yes|no)/i)
  const confidenceMatch = response.match(/CONFIDENCE:\s*([\d.]+)/i)
  const reasonMatch = response.match(/REASON:\s*([^\n]+)/i)

  const is_contradiction = contradictsMatch?.[1]?.toLowerCase() === 'yes'
  const confidence = Math.min(1, Math.max(0, parseFloat(confidenceMatch?.[1] ?? '0') || 0))
  const reason = reasonMatch?.[1]?.trim() ?? ''

  return { is_contradiction, confidence, reason }
}

/**
 * Scope-based partitioning: skip pairs whose scopes share no overlap.
 *
 * Conservative rule: only compare engrams that are either global or in the
 * exact same scope. Cross-scope pairs (e.g. "project:plur" vs
 * "project:datacore") are skipped — they're different namespaces and
 * contradictions across them are rarely actionable.
 */
export function scopesOverlap(a: string, b: string): boolean {
  if (a === 'global' || b === 'global') return true
  return a === b
}

/**
 * Domain-segment overlap: skip pairs whose domain hierarchies share no
 * segment.
 *
 * Domain strings are dot-separated hierarchies like "datacore.mcp.packs".
 * Two engrams share domain overlap when any segment of one appears in the
 * other. Missing domain means "unknown" — don't filter those out.
 */
export function domainSegmentsOverlap(a?: string, b?: string): boolean {
  if (!a || !b) return true
  const segsA = a.split('.')
  const segsB = new Set(b.split('.'))
  return segsA.some(s => segsB.has(s))
}

/**
 * Subject-predicate pre-filter: skip pairs whose subject noun phrases don't
 * overlap.
 *
 * Extracts "subject tokens" from each statement — longer content words
 * (>3 chars) from the first clause (up to the first verb-like boundary or
 * 10 tokens). Two statements pass the filter when they share at least one
 * subject token, indicating they are making assertions about the same entity.
 *
 * This is a heuristic, not a true NLP parse. It captures the most common
 * pattern: "The plur CLI uses X" vs "The plur CLI uses Y" share "plur"
 * and "cli". Unrelated facts like "Protocol fee is 1%" vs "MemPalace
 * is a competitor" share no subject tokens and are skipped.
 */
export function subjectsOverlap(a: string, b: string): boolean {
  const extractSubjectTokens = (s: string): Set<string> => {
    // Take the first clause: split at first comma, semicolon, or after ~60 chars
    const clause = s.split(/[,;]|(?<=\w{3,})\s+(?:is|are|was|were|has|have|can|will|should|must|does|do)\s/)[0]
      .slice(0, 80)
    return new Set(ftsTokenize(clause).filter(t => t.length > 3).slice(0, 10))
  }

  const tokA = extractSubjectTokens(a)
  const tokB = extractSubjectTokens(b)

  for (const t of tokA) {
    if (tokB.has(t)) return true
  }
  return false
}

/**
 * Build candidate pairs for the LLM contradiction scan.
 *
 * Three-stage pipeline (cheapest first):
 *   1. Scope partition  — skip pairs with no scope overlap
 *   2. Domain filter    — skip pairs whose domain hierarchies don't touch
 *   3. Subject overlap  — skip pairs whose subject noun phrases don't overlap
 *
 * Already-known conflicts (relations.conflicts) are skipped to avoid
 * re-evaluating the same pair.
 */
export function getCandidatePairs(engrams: Engram[]): Array<[Engram, Engram]> {
  const active = engrams.filter(e => e.status === 'active')
  const pairs: Array<[Engram, Engram]> = []

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]

      // Stage 1: scope-based partition (cheapest gate)
      if (!scopesOverlap(a.scope, b.scope)) continue

      // Stage 2: domain segment filter
      if (!domainSegmentsOverlap(a.domain, b.domain)) continue

      // Skip already-known conflict pairs
      if (a.relations?.conflicts?.includes(b.id)) continue

      // Stage 3: subject-predicate pre-filter
      if (!subjectsOverlap(a.statement, b.statement)) continue

      pairs.push([a, b])
    }
  }

  return pairs
}

export async function scanForTensions(
  engrams: Engram[],
  llm: LlmFunction,
  options?: { min_confidence?: number; max_pairs?: number },
): Promise<TensionScanResult> {
  const minConfidence = options?.min_confidence ?? 0.7
  const maxPairs = options?.max_pairs ?? 50

  const candidates = getCandidatePairs(engrams).slice(0, maxPairs)
  const tensions: TensionPair[] = []

  for (const [a, b] of candidates) {
    const prompt = buildContradictionPrompt(
      { id: a.id, statement: a.statement },
      { id: b.id, statement: b.statement },
    )
    try {
      const response = await llm(prompt)
      const { is_contradiction, confidence, reason } = parseContradictionResponse(response)
      if (is_contradiction && confidence >= minConfidence) {
        tensions.push({
          id_a: a.id,
          id_b: b.id,
          statement_a: a.statement,
          statement_b: b.statement,
          confidence,
          reason,
        })
      }
    } catch {
      // Skip pair on LLM error — non-fatal
    }
  }

  return {
    pairs_checked: candidates.length,
    new_tensions: tensions.length,
    tensions,
  }
}
