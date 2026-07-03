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
  /** Calendar days between the two engrams' recorded dates, when derivable (#240). */
  days_apart?: number
  /** Judge confidence before the temporal discount / snapshot floor (#240). Present only when adjusted. */
  raw_confidence?: number
}

export interface TensionScanResult {
  pairs_checked: number
  new_tensions: number
  tensions: TensionPair[]
}

/** A statement handed to the judge — `date` is its recorded date (#240). */
export interface JudgeStatement {
  id: string
  statement: string
  /** ISO date (YYYY-MM-DD) the statement was recorded. Optional — prompts stay unchanged without it. */
  date?: string
}

/**
 * Resolve the recorded date of an engram (#240 Layer 3 prompt half).
 *
 * Prefers `temporal.learned_at`; falls back to the date embedded in the
 * canonical id forms `ENG-YYYY-MMDD-NNN`, `ENG-{PREFIX}-YYYY-MMDD-NNN`, and
 * the server-assigned `ENG-YYYY-MM-DD-NNN`. Returns undefined when no date
 * is derivable — callers must degrade gracefully.
 */
export function engramDate(e: Engram): string | undefined {
  const learned = e.temporal?.learned_at
  if (learned && /^\d{4}-\d{2}-\d{2}/.test(learned)) return learned.slice(0, 10)
  const m = e.id.match(/(\d{4})-(\d{2})-?(\d{2})(?=-|$)/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return undefined
}

/** Absolute whole-day distance between two ISO dates (UTC, calendar days). */
export function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`))
  return Math.round(ms / 86_400_000)
}

/**
 * Does a dotted domain fall under any configured temporal (snapshot) domain
 * (#240 Layer 2)? Matches the exact domain or a dotted sub-domain —
 * `war-analysis.hormuz` matches config entry `war-analysis`, but
 * `war-analysis-2` does not.
 */
export function inTemporalDomain(domain: string | undefined, temporalDomains: readonly string[]): boolean {
  if (!domain || temporalDomains.length === 0) return false
  return temporalDomains.some(td => domain === td || domain.startsWith(`${td}.`))
}

/**
 * Timestamp-aware confidence multiplier (#240 Layer 3 — OPT-IN, off by
 * default). The ladder follows the issue: pairs recorded further apart are
 * more likely temporal evolution than contradiction. Kept opt-in because a
 * blanket multiplier can bury genuine standing-fact corrections that happen
 * weeks apart — the dated judge prompt is the default mechanism.
 */
export function temporalDiscountFactor(days: number): number {
  if (days <= 0) return 1.0
  if (days <= 3) return 0.8
  if (days <= 14) return 0.5
  return 0.3
}

/** Confidence cap for snapshot-vs-snapshot pairs in `snapshot_pairs: 'floor'` mode (#240). */
export const SNAPSHOT_CONFIDENCE_CAP = 0.1

/** Temporal gating options shared by getCandidatePairs and scanForTensions (#240). */
export interface TemporalGateOptions {
  /** Domains whose engrams are point-in-time snapshots by default (Layer 2). */
  temporal_domains?: string[]
  /**
   * Handling of snapshot-vs-snapshot pairs recorded on different days:
   * 'skip' (default) drops them before the judge; 'floor' judges them but
   * caps confidence at SNAPSHOT_CONFIDENCE_CAP.
   */
  snapshot_pairs?: 'skip' | 'floor'
  /** ISO date treated as "today" for expired-validity gating. Defaults to the current date. */
  now?: string
}

function temporalGuidance(dateA: string, dateB: string): string {
  const days = daysApart(dateA, dateB)
  const apart = days === 0 ? 'on the same day' : `${days} day${days === 1 ? '' : 's'} apart`
  return `The statements were recorded ${apart} (A: ${dateA}, B: ${dateB}). Consider whether the difference reflects a genuine contradiction about the same claim, or temporal evolution of a changing situation — statements that were each true when recorded, describing how events unfolded over time, do NOT contradict.`
}

export function buildContradictionPrompt(
  a: JudgeStatement,
  b: JudgeStatement,
): string {
  const bothDated = Boolean(a.date && b.date)
  const label = (s: JudgeStatement, name: string) =>
    `STATEMENT ${name} [${s.id}]${bothDated ? ` (recorded ${s.date})` : ''}:`
  return `You are a memory consistency checker. Determine whether these two statements CONTRADICT each other.

${label(a, 'A')}
"${a.statement}"

${label(b, 'B')}
"${b.statement}"

Two statements CONTRADICT when one asserts X is true and the other asserts X is false, different, or mutually exclusive.
Do NOT flag as contradictions: different topics in the same domain, complementary facts, or unrelated statements that happen to share keywords.
${bothDated ? `${temporalGuidance(a.date!, b.date!)}\n` : ''}
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
 * Dated pairs (#240) are annotated with their recorded dates and days-apart
 * distance so the judge can distinguish contradiction from evolution.
 */
export function buildBatchContradictionPrompt(
  pairs: Array<[JudgeStatement, JudgeStatement]>,
): string {
  const anyDated = pairs.some(([a, b]) => a.date && b.date)
  const blocks = pairs
    .map(([a, b], i) => {
      const bothDated = Boolean(a.date && b.date)
      const apart = bothDated ? daysApart(a.date!, b.date!) : undefined
      const header = bothDated
        ? `PAIR ${i + 1} (recorded ${apart === 0 ? 'on the same day' : `${apart} day${apart === 1 ? '' : 's'} apart`}):`
        : `PAIR ${i + 1}:`
      const dateTag = (s: JudgeStatement) => (bothDated ? ` (${s.date})` : '')
      return `${header}
A [${a.id}]${dateTag(a)}: "${a.statement}"
B [${b.id}]${dateTag(b)}: "${b.statement}"`
    })
    .join('\n\n')

  const formatLines = pairs
    .map((_, i) => `PAIR_${i + 1}: CONTRADICTS: yes|no | CONFIDENCE: 0.0-1.0 | REASON: <one sentence>`)
    .join('\n')

  const temporalNote = anyDated
    ? '\nFor dated pairs, consider whether the difference reflects a genuine contradiction about the same claim, or temporal evolution of a changing situation — statements that were each true when recorded, describing how events unfolded over time, do NOT contradict.'
    : ''

  return `You are a memory consistency checker. For each numbered pair of statements below, determine whether the two statements CONTRADICT each other.

Two statements CONTRADICT when one asserts X is true and the other asserts X is false, different, or mutually exclusive.
Do NOT flag as contradictions: different topics in the same domain, complementary facts, or unrelated statements that happen to share keywords.
Judge each pair independently.${temporalNote}

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
 * True when the pair is linked by an intentional-update edge (#240):
 * `relations.supersedes` / `relations.superseded_by` in either direction.
 * An intentional update is not a tension — the newer engram is MEANT to
 * replace the older one.
 */
function supersedesLinked(a: Engram, b: Engram): boolean {
  return Boolean(
    a.relations?.supersedes?.includes(b.id) ||
    a.relations?.superseded_by?.includes(b.id) ||
    b.relations?.supersedes?.includes(a.id) ||
    b.relations?.superseded_by?.includes(a.id),
  )
}

/** True when the engram's validity window has closed (`temporal.valid_until` before `now`). */
function validityExpired(e: Engram, now: string): boolean {
  const until = e.temporal?.valid_until
  return Boolean(until && until < now)
}

/**
 * True when BOTH engrams are point-in-time snapshots (their domains fall in
 * a configured temporal domain) recorded on different days — an event log,
 * not a contradiction (#240 Layer 2). Same-day snapshot pairs stay in: two
 * reports of the same day ARE a likely correction. Pairs whose dates cannot
 * be derived also stay in (conservative — let the judge see them).
 */
function isSnapshotPair(a: Engram, b: Engram, temporalDomains: readonly string[]): boolean {
  if (!inTemporalDomain(a.domain, temporalDomains) || !inTemporalDomain(b.domain, temporalDomains)) return false
  const dateA = engramDate(a)
  const dateB = engramDate(b)
  if (!dateA || !dateB) return false
  return dateA !== dateB
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
 * Temporal gates (#240):
 *   - Supersedes-linked pairs are skipped in both directions — an
 *     intentional update is not a tension.
 *   - Pairs where either side's validity window has closed
 *     (`temporal.valid_until` in the past) are skipped — an expired engram
 *     is no longer a peer claim about CURRENT truth, so lining it up
 *     against a newer claim manufactures a false tension.
 *   - Snapshot-vs-snapshot pairs (both domains in `temporal_domains`)
 *     recorded on different days are skipped by default — they are an
 *     event log, not a contradiction. `snapshot_pairs: 'floor'` keeps them
 *     for the judge (scanForTensions caps their confidence instead).
 *
 * Surviving pairs are ranked by descending shared-token overlap (#180) so
 * that the pairs most likely to be genuine contradictions are judged first
 * when the caller applies a max_pairs cap. Ties keep insertion order
 * (stable sort).
 */
export function getCandidatePairs(
  engrams: Engram[],
  options?: TemporalGateOptions,
): Array<[Engram, Engram]> {
  const active = engrams.filter(e => e.status === 'active')
  const temporalDomains = options?.temporal_domains ?? []
  const snapshotMode = options?.snapshot_pairs ?? 'skip'
  const now = options?.now ?? new Date().toISOString().slice(0, 10)

  // Tokenize each engram once instead of once per pair (O(n) vs O(n²) passes).
  const subjectTokens = active.map(e => extractSubjectTokens(e.statement))
  const statementTokens = active.map(e => new Set(ftsTokenize(e.statement)))
  const expired = active.map(e => validityExpired(e, now))

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

      // #240: intentional updates are not tensions
      if (supersedesLinked(a, b)) continue

      // #240: an engram whose validity window has closed is not a peer
      // claim about current truth — don't line it up against anything.
      if (expired[i] || expired[j]) continue

      // #240 Layer 2: snapshot-vs-snapshot at different timestamps is an
      // event log, not a contradiction.
      if (snapshotMode === 'skip' && isSnapshotPair(a, b, temporalDomains)) continue

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

/** Options for scanForTensions. Temporal gates/adjustments are #240. */
export interface TensionScanOptions extends TemporalGateOptions {
  min_confidence?: number
  max_pairs?: number
  batch_size?: number
  /**
   * Timestamp-aware confidence discount (#240 Layer 3 multiplier).
   * OFF by default — the dated judge prompt is the default mechanism; the
   * blanket multiplier can bury genuine corrections that happen weeks apart.
   */
  temporal_discount?: boolean
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
 *
 * Temporal behavior (#240): each judged statement carries its recorded date
 * (engramDate) so the judge can tell evolution from contradiction. With
 * `temporal_discount: true`, verdict confidence is additionally multiplied
 * by temporalDiscountFactor(days_apart). Snapshot-vs-snapshot pairs are
 * skipped by getCandidatePairs (default) or confidence-capped at
 * SNAPSHOT_CONFIDENCE_CAP in `snapshot_pairs: 'floor'` mode.
 */
export async function scanForTensions(
  engrams: Engram[],
  llm: LlmFunction,
  options?: TensionScanOptions,
): Promise<TensionScanResult> {
  const minConfidence = options?.min_confidence ?? 0.7
  const maxPairs = options?.max_pairs ?? 50
  const rawBatchSize = options?.batch_size ?? 5
  const batchSize = Number.isFinite(rawBatchSize) ? Math.max(1, Math.floor(rawBatchSize)) : 5
  const temporalDomains = options?.temporal_domains ?? []
  const discountEnabled = options?.temporal_discount === true

  const candidates = getCandidatePairs(engrams, options).slice(0, maxPairs)
  const tensions: TensionPair[] = []

  const toJudgeStatement = (e: Engram): JudgeStatement => ({
    id: e.id,
    statement: e.statement,
    date: engramDate(e),
  })

  const judgeSingle = async (a: Engram, b: Engram): Promise<ContradictionVerdict | null> => {
    const prompt = buildContradictionPrompt(toJudgeStatement(a), toJudgeStatement(b))
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
        batch.map(([a, b]) => [toJudgeStatement(a), toJudgeStatement(b)]),
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

      const dateA = engramDate(a)
      const dateB = engramDate(b)
      const days = dateA && dateB ? daysApart(dateA, dateB) : undefined

      // #240: temporal adjustments — snapshot floor first, then the
      // opt-in days-apart discount.
      let confidence = verdict.confidence
      if (isSnapshotPair(a, b, temporalDomains)) {
        // Only reachable in 'floor' mode ('skip' drops these at candidate stage)
        confidence = Math.min(confidence, SNAPSHOT_CONFIDENCE_CAP)
      } else if (discountEnabled && days !== undefined) {
        confidence = confidence * temporalDiscountFactor(days)
      }

      if (verdict.is_contradiction && confidence >= minConfidence) {
        tensions.push({
          id_a: a.id,
          id_b: b.id,
          statement_a: a.statement,
          statement_b: b.statement,
          confidence,
          reason: verdict.reason,
          ...(days !== undefined ? { days_apart: days } : {}),
          ...(confidence !== verdict.confidence ? { raw_confidence: verdict.confidence } : {}),
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
