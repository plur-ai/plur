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

export interface ContradictionVerdict {
  is_contradiction: boolean
  confidence: number
  reason: string
}

export function parseContradictionResponse(response: string): ContradictionVerdict {
  const contradictsMatch = response.match(/CONTRADICTS:\s*(yes|no)/i)
  const confidenceMatch = response.match(/CONFIDENCE:\s*([\d.]+)/i)
  const reasonMatch = response.match(/REASON:\s*([^\n]+)/i)

  const is_contradiction = contradictsMatch?.[1]?.toLowerCase() === 'yes'
  const confidence = Math.min(1, Math.max(0, parseFloat(confidenceMatch?.[1] ?? '0') || 0))
  const reason = reasonMatch?.[1]?.trim() ?? ''

  return { is_contradiction, confidence, reason }
}

/**
 * Batched contradiction prompt (#180): judge several pairs in one LLM call.
 *
 * Keeps the same contradiction definition and guardrails as the single-pair
 * prompt; each pair is numbered and the model answers one line per pair.
 */
export function buildBatchContradictionPrompt(
  pairs: Array<[{ id: string; statement: string }, { id: string; statement: string }]>,
): string {
  const blocks = pairs
    .map(
      ([a, b], i) => `PAIR ${i + 1}:
A [${a.id}]: "${a.statement}"
B [${b.id}]: "${b.statement}"`,
    )
    .join('\n\n')

  const formatLines = pairs
    .map((_, i) => `PAIR_${i + 1}: CONTRADICTS: yes|no | CONFIDENCE: 0.0-1.0 | REASON: <one sentence>`)
    .join('\n')

  return `You are a memory consistency checker. For each numbered pair of statements below, determine whether the two statements CONTRADICT each other.

Two statements CONTRADICT when one asserts X is true and the other asserts X is false, different, or mutually exclusive.
Do NOT flag as contradictions: different topics in the same domain, complementary facts, or unrelated statements that happen to share keywords.
Judge each pair independently.

${blocks}

Respond with EXACTLY one line per pair, in this EXACT format:
${formatLines}`
}

/**
 * Parse a batched contradiction response into per-pair verdicts.
 *
 * Returns an array of length `pairCount`, positionally aligned with the pairs
 * sent in the prompt. A pair whose verdict is missing or unparseable maps to
 * `null` — never to a contradiction — so format failures cannot create false
 * positives. Callers should re-judge `null` pairs individually.
 */
export function parseBatchContradictionResponse(
  response: string,
  pairCount: number,
): Array<ContradictionVerdict | null> {
  const verdicts: Array<ContradictionVerdict | null> = new Array(pairCount).fill(null)

  // Locate PAIR_N / PAIR N markers, then parse each marker-to-marker section
  // with the single-pair parser.
  const markerRe = /PAIR[_\s]*(\d+)\s*:/gi
  const markers: Array<{ index: number; end: number; start: number }> = []
  let m: RegExpExecArray | null
  while ((m = markerRe.exec(response)) !== null) {
    markers.push({ index: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length })
  }

  for (let k = 0; k < markers.length; k++) {
    const { index, end } = markers[k]
    if (index < 1 || index > pairCount) continue
    const sectionEnd = k + 1 < markers.length ? markers[k + 1].start : response.length
    const section = response.slice(end, sectionEnd)
    // Require an explicit verdict — a bare marker is not a "no".
    if (!/CONTRADICTS:\s*(yes|no)/i.test(section)) continue
    verdicts[index - 1] = parseContradictionResponse(section)
  }

  return verdicts
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
  return setsIntersect(extractSubjectTokens(a), extractSubjectTokens(b))
}

function extractSubjectTokens(s: string): Set<string> {
  // Take the first clause: split at first comma, semicolon, or after ~60 chars
  const clause = s.split(/[,;]|(?<=\w{3,})\s+(?:is|are|was|were|has|have|can|will|should|must|does|do)\s/)[0]
    .slice(0, 80)
  return new Set(ftsTokenize(clause).filter(t => t.length > 3).slice(0, 10))
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) {
    if (b.has(t)) return true
  }
  return false
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let n = 0
  for (const t of small) {
    if (large.has(t)) n++
  }
  return n
}

/**
 * Overlap score between two statements: number of unique shared content
 * tokens (after FTS tokenization). Used to rank candidate pairs so the most
 * likely contradictions are LLM-judged first (#180).
 */
export function statementOverlap(a: string, b: string): number {
  return intersectionSize(new Set(ftsTokenize(a)), new Set(ftsTokenize(b)))
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
 *
 * Surviving pairs are ranked by descending shared-token overlap (#180) so
 * that the pairs most likely to be genuine contradictions are judged first
 * when the caller applies a max_pairs cap. Ties keep insertion order
 * (stable sort).
 */
export function getCandidatePairs(engrams: Engram[]): Array<[Engram, Engram]> {
  const active = engrams.filter(e => e.status === 'active')

  // Tokenize each engram once instead of once per pair (O(n) vs O(n²) passes).
  const subjectTokens = active.map(e => extractSubjectTokens(e.statement))
  const statementTokens = active.map(e => new Set(ftsTokenize(e.statement)))

  const scored: Array<{ pair: [Engram, Engram]; overlap: number }> = []

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
      if (!setsIntersect(subjectTokens[i], subjectTokens[j])) continue

      scored.push({
        pair: [a, b],
        overlap: intersectionSize(statementTokens[i], statementTokens[j]),
      })
    }
  }

  // Rank: highest shared-token count first (#180).
  scored.sort((x, y) => y.overlap - x.overlap)
  return scored.map(s => s.pair)
}

/**
 * Scan engrams for contradictions with an LLM judge.
 *
 * Candidates come pre-ranked by overlap score from getCandidatePairs, so the
 * max_pairs cap keeps the most likely contradictions (#180).
 *
 * Pairs are judged in batches of `batch_size` (default 5) — one LLM call per
 * batch instead of one per pair (#180). Any pair whose batch verdict is
 * missing or unparseable falls back to an individual single-pair call;
 * a pair is never counted as a contradiction without an explicit verdict.
 * Set batch_size to 1 for the original sequential single-pair behavior.
 */
export async function scanForTensions(
  engrams: Engram[],
  llm: LlmFunction,
  options?: { min_confidence?: number; max_pairs?: number; batch_size?: number },
): Promise<TensionScanResult> {
  const minConfidence = options?.min_confidence ?? 0.7
  const maxPairs = options?.max_pairs ?? 50
  const rawBatchSize = options?.batch_size ?? 5
  const batchSize = Number.isFinite(rawBatchSize) ? Math.max(1, Math.floor(rawBatchSize)) : 5

  const candidates = getCandidatePairs(engrams).slice(0, maxPairs)
  const tensions: TensionPair[] = []

  const judgeSingle = async (a: Engram, b: Engram): Promise<ContradictionVerdict | null> => {
    const prompt = buildContradictionPrompt(
      { id: a.id, statement: a.statement },
      { id: b.id, statement: b.statement },
    )
    try {
      return parseContradictionResponse(await llm(prompt))
    } catch {
      // Skip pair on LLM error — non-fatal
      return null
    }
  }

  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize)

    let verdicts: Array<ContradictionVerdict | null>
    if (batch.length === 1) {
      verdicts = [await judgeSingle(batch[0][0], batch[0][1])]
    } else {
      const prompt = buildBatchContradictionPrompt(
        batch.map(([a, b]) => [
          { id: a.id, statement: a.statement },
          { id: b.id, statement: b.statement },
        ]),
      )
      try {
        verdicts = parseBatchContradictionResponse(await llm(prompt), batch.length)
      } catch {
        verdicts = batch.map(() => null)
      }
      // Fallback: re-judge pairs with missing/unparseable batch verdicts
      // individually so a malformed batch response costs recall, not precision.
      for (let i = 0; i < verdicts.length; i++) {
        if (verdicts[i] === null) {
          verdicts[i] = await judgeSingle(batch[i][0], batch[i][1])
        }
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const verdict = verdicts[i]
      if (!verdict) continue
      const [a, b] = batch[i]
      if (verdict.is_contradiction && verdict.confidence >= minConfidence) {
        tensions.push({
          id_a: a.id,
          id_b: b.id,
          statement_a: a.statement,
          statement_b: b.statement,
          confidence: verdict.confidence,
          reason: verdict.reason,
        })
      }
    }
  }

  return {
    pairs_checked: candidates.length,
    new_tensions: tensions.length,
    tensions,
  }
}
