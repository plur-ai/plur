import type { Engram, MeasuredUnder } from './schemas/engram.js'
import type { LlmFunction } from './types.js'
import { isExpired, evaluationInstant } from './validity.js'
import { ftsTokenize } from './fts.js'

export interface TensionPair {
  id_a: string
  id_b: string
  statement_a: string
  statement_b: string
  confidence: number
  reason: string
  /** Calendar days between the two engrams' recorded dates, when derivable. */
  days_apart?: number
  /** Judge confidence before the temporal discount / snapshot floor. Present only when adjusted. */
  raw_confidence?: number
}

export interface TensionScanResult {
  pairs_checked: number
  new_tensions: number
  tensions: TensionPair[]
  /**
   * Pairs the pre-filters removed for a reason that is a policy, not a
   * structural impossibility. A skip that leaves no trace is
   * indistinguishable from a pair that was never a candidate, so every
   * policy skip is counted here and its pair key (sorted ids joined by
   * ':') listed. Always present; zero when nothing was skipped.
   */
  skipped: { measured_under: number; measured_under_pairs: string[] }
}

/** A statement handed to the judge — `date` is its recorded date. */
export interface JudgeStatement {
  id: string
  statement: string
  /** ISO date (YYYY-MM-DD) the statement was recorded. Optional — prompts stay unchanged without it. */
  date?: string
}

/**
 * Resolve the recorded date of an engram.
 *
 * Prefers `temporal.learned_at`; falls back to the date embedded in the id.
 * Accepts the canonical `ENG-YYYY-MM-DD-NNN` (also what servers assign),
 * the legacy compact `ENG-YYYY-MMDD-NNN`, and either form behind a store
 * prefix (`ENG-{PREFIX}-...`). Returns undefined when no date is derivable —
 * callers must degrade gracefully.
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
 * Does a dotted domain fall under any configured temporal (snapshot) domain?
 * Matches the exact domain or a dotted sub-domain —
 * `war-analysis.hormuz` matches config entry `war-analysis`, but
 * `war-analysis-2` does not.
 */
export function inTemporalDomain(domain: string | undefined, temporalDomains: readonly string[]): boolean {
  if (!domain || temporalDomains.length === 0) return false
  return temporalDomains.some(td => domain === td || domain.startsWith(`${td}.`))
}

/**
 * Timestamp-aware confidence multiplier (OPT-IN, off by default). Pairs
 * recorded further apart are
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

/** Confidence cap for snapshot-vs-snapshot pairs in `snapshot_pairs: 'floor'` mode. */
export const SNAPSHOT_CONFIDENCE_CAP = 0.1

/** Temporal gating options shared by getCandidatePairs and scanForTensions. */
export interface TemporalGateOptions {
  /** Domains whose engrams are point-in-time snapshots by default (Layer 2). */
  temporal_domains?: string[]
  /**
   * Handling of snapshot-vs-snapshot pairs recorded on different days:
   * 'skip' (default) drops them before the judge; 'floor' judges them but
   * caps confidence at SNAPSHOT_CONFIDENCE_CAP.
   */
  snapshot_pairs?: 'skip' | 'floor'
  /**
   * Handling of same-origin measurement pairs whose `measured_under`
   * configuration differs: 'skip' (default) drops them before the
   * judge and counts them in `skipped.measured_under`; 'floor' judges them
   * but caps confidence at MEASURED_UNDER_CONFIDENCE_CAP. The gate never
   * applies across a trust boundary — see measuredUnderGateApplies.
   */
  measured_under_pairs?: 'skip' | 'floor'
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
 * Batched contradiction prompt: judge several pairs in one LLM call.
 *
 * Keeps the same contradiction definition and guardrails as the single-pair
 * prompt; each pair is numbered and the model answers one line per pair.
 * Dated pairs are annotated with their recorded dates and days-apart
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
 * Subject pre-filter: two statements pass when they share at least one subject token — a lowercased,
 * stopword-filtered content word (>3 chars) from the first clause (up to a verb-like boundary or 10 tokens).
 * Deliberately no stemming: it added no recall and over-stems unrelated words ('states'/'station' → 'stat').
 * A heuristic, not an NLP parse.
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
 * likely contradictions are LLM-judged first.
 */
export function statementOverlap(a: string, b: string): number {
  return intersectionSize(new Set(ftsTokenize(a)), new Set(ftsTokenize(b)))
}

/**
 * True when the pair is linked by an intentional-update edge:
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


/** Confidence cap for measured-under pairs in `measured_under_pairs: 'floor'` mode. */
export const MEASURED_UNDER_CONFIDENCE_CAP = 0.1

/**
 * Configuration dimensions of `measured_under` that identify a measurement
 * context. `date` is deliberately NOT here: a regression
 * benchmark — same config, different dates, different values — is a genuine
 * contradiction (or regression) and must surface as a tension.
 */
export const MEASURED_UNDER_DIMENSIONS: ReadonlyArray<string> = ['source_type', 'model', 'hardware', 'dataset']

/**
 * A dimension value as compared: trimmed, case-folded, and `null` when it
 * carries no information — absent, empty, or not a string. Labels are typed
 * by LLMs and humans, so `'GitLab'` and `'gitlab '` are the same
 * configuration; an empty string is "unknown", not a value, exactly like an
 * absent key.
 */
function measuredUnderValue(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const norm = v.trim().toLowerCase()
  return norm.length > 0 ? norm : null
}

/**
 * True when BOTH engrams have `measured_under` AND at least one of
 * MEASURED_UNDER_DIMENSIONS carries a value on both sides that differs after
 * normalisation. An engram without `measured_under` is an unconditional
 * assertion and stays a tension candidate regardless of the other side; a
 * dimension present on one side only is "unknown", not "same", so it cannot
 * establish a difference.
 *
 * This is a comparison, not a policy: whether a differing pair is skipped is
 * decided by measuredUnderGateApplies, which also checks who wrote each side.
 */
export function measuredUnderDiffers(a: Engram, b: Engram): boolean {
  const muA: MeasuredUnder | undefined = a.measured_under
  const muB: MeasuredUnder | undefined = b.measured_under
  if (!muA || !muB || typeof muA !== 'object' || typeof muB !== 'object') return false
  return MEASURED_UNDER_DIMENSIONS.some(dim => {
    const valA = measuredUnderValue((muA as Record<string, unknown>)[dim])
    const valB = measuredUnderValue((muB as Record<string, unknown>)[dim])
    return valA !== null && valB !== null && valA !== valB
  })
}

/**
 * Where a loaded engram came from, as the LOADER marked it: packs carry `_pack`, `stores:`/remote rows carry
 * `_storeScope`, primary rows carry neither. Foreign rows cannot forge a primary origin (the loader always stamps
 * them) nor borrow another (remote rows lose `_` keys in `salvageRemoteRow`). A row with BOTH markers gets an
 * `ambiguous:` origin, which {@link measuredUnderGateApplies} never gates.
 */
export function engramOrigin(e: Engram): string {
  const r = e as unknown as Record<string, unknown>
  const pack = typeof r._pack === 'string' ? r._pack : undefined
  const store = typeof r._storeScope === 'string' ? r._storeScope : undefined
  if (pack !== undefined && store !== undefined) return `ambiguous:pack:${pack}|store:${store}`
  if (pack !== undefined) return `pack:${pack}`
  if (store !== undefined) return `store:${store}`
  return 'primary'
}

/** A statement that carries a measured value — a number, optionally with a unit or percent. */
const MEASUREMENT_TOKEN = /(?<![A-Za-z])\d+(?:[.,:]\d+)*\s*%?(?![A-Za-z])/

/**
 * Whether the measured-under gate may remove this pair from the judge. All required, because a skipped pair is a
 * contradiction nobody sees:
 *   1. Same origin — `measured_under` is free-form, so a pair crossing a trust boundary always reaches the judge.
 *   2. Both statements carry a measured value (the rule is about measurements, not prose).
 *   3. The configurations differ (measuredUnderDiffers).
 */
export function measuredUnderGateApplies(a: Engram, b: Engram): boolean {
  const originA = engramOrigin(a)
  if (originA.startsWith('ambiguous:') || originA !== engramOrigin(b)) return false
  if (!MEASUREMENT_TOKEN.test(a.statement) || !MEASUREMENT_TOKEN.test(b.statement)) return false
  return measuredUnderDiffers(a, b)
}

/**
 * True when BOTH engrams are point-in-time snapshots (their domains fall in
 * a configured temporal domain) recorded on different days — an event log,
 * not a contradiction. Same-day snapshot pairs stay in: two
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
 * Build candidate pairs for the LLM contradiction scan: scope partition, then domain filter, then subject overlap.
 * - Pairs already adjudicated are skipped via `exclude_pairs`; `relations.conflicts` does NOT exempt a pair.
 * - Skipped: supersedes-linked pairs; pairs with a closed validity window; snapshot-vs-snapshot pairs from different
 *   days (unless `snapshot_pairs: 'floor'`); pairs whose `measured_under` differ on a config dimension (`date` is
 *   excluded — a same-config regression is a real tension).
 * Survivors are ranked by descending shared-token overlap (stable), so a `max_pairs` cap keeps the likeliest.
 */
export interface CandidatePairOptions {
  /**
   * Canonical pair keys (sorted ids joined by ':') to exclude — the persisted
   * tension records. Any recorded pair, whatever its status, is
   * skipped: dismissed records act as a suppress-list, detected/confirmed
   * records are already adjudicated and must not re-pay the judge.
   */
  exclude_pairs?: ReadonlySet<string>
}

export interface CandidatePairs {
  pairs: Array<[Engram, Engram]>
  /** Policy skips, so a scan can report what it did not look at. */
  skipped: { measured_under: number; measured_under_pairs: string[] }
}

export function getCandidatePairs(
  engrams: Engram[],
  options?: TemporalGateOptions & CandidatePairOptions,
): Array<[Engram, Engram]> {
  return getCandidatePairsDetailed(engrams, options).pairs
}

/** getCandidatePairs plus the skip accounting scanForTensions reports. */
export function getCandidatePairsDetailed(
  engrams: Engram[],
  options?: TemporalGateOptions & CandidatePairOptions,
): CandidatePairs {
  const active = engrams.filter(e => e.status === 'active')
  const temporalDomains = options?.temporal_domains ?? []
  const snapshotMode = options?.snapshot_pairs ?? 'skip'
  const measuredUnderMode = options?.measured_under_pairs ?? 'skip'
  const skippedMeasuredUnder: string[] = []
  // Use the shared validity evaluator, never a string comparison of a
  // timestamp against a date: `'2026-09-07T01:00:00Z' < '2026-09-07'` is false
  // at every hour of that day, so a window closed at 01:00 would read as live.
  const nowMs = evaluationInstant(options?.now)
  const excludePairs = options?.exclude_pairs

  // Tokenize each engram once instead of once per pair (O(n) vs O(n²) passes).
  const subjectTokens = active.map(e => extractSubjectTokens(e.statement))
  const statementTokens = active.map(e => new Set(ftsTokenize(e.statement)))
  const expired = active.map(e => isExpired(e.temporal, nowMs))

  const scored: Array<{ pair: [Engram, Engram]; overlap: number }> = []

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]

      // Stage 1: scope-based partition (cheapest gate)
      if (!scopesOverlap(a.scope, b.scope)) continue

      // Stage 2: domain segment filter
      if (!domainSegmentsOverlap(a.domain, b.domain)) continue

      // Skip pairs already adjudicated in the tension store. A
      // relations.conflicts edge does not exempt a pair: the importer writes
      // heuristic conflict suspects precisely so the scan can confirm them
      // with an LLM — only a persisted record does.
      if (excludePairs && excludePairs.has([a.id, b.id].sort().join(':'))) continue

      // Intentional updates are not tensions
      if (supersedesLinked(a, b)) continue

      // An engram whose validity window has closed is not a peer
      // claim about current truth — don't line it up against anything.
      if (expired[i] || expired[j]) continue

      // Snapshot-vs-snapshot at different timestamps is an
      // event log, not a contradiction.
      if (snapshotMode === 'skip' && isSnapshotPair(a, b, temporalDomains)) continue

      // Same-origin measurements taken under different
      // configurations are refinements, not contradictions. Never silent:
      // every skip is counted and keyed so the scan result says what it did
      // not judge. In 'floor' mode the pair goes to the judge and
      // scanForTensions caps its confidence instead.
      if (measuredUnderMode === 'skip' && measuredUnderGateApplies(a, b)) {
        skippedMeasuredUnder.push([a.id, b.id].sort().join(':'))
        continue
      }

      // Stage 3: subject-predicate pre-filter
      if (!setsIntersect(subjectTokens[i], subjectTokens[j])) continue

      scored.push({
        pair: [a, b],
        overlap: intersectionSize(statementTokens[i], statementTokens[j]),
      })
    }
  }

  // Rank: highest shared-token count first.
  scored.sort((x, y) => y.overlap - x.overlap)
  return {
    pairs: scored.map(s => s.pair),
    skipped: { measured_under: skippedMeasuredUnder.length, measured_under_pairs: skippedMeasuredUnder },
  }
}

/** Options for scanForTensions. */
export interface TensionScanOptions extends TemporalGateOptions, CandidatePairOptions {
  min_confidence?: number
  max_pairs?: number
  batch_size?: number
  /**
   * Timestamp-aware confidence discount.
   * OFF by default — the dated judge prompt is the default mechanism; the
   * blanket multiplier can bury genuine corrections that happen weeks apart.
   */
  temporal_discount?: boolean
}

/**
 * Scan engrams for contradictions with an LLM judge, over pre-ranked candidates from getCandidatePairs.
 * Pairs are judged in batches of `batch_size` (default 5; 1 = one per call); a missing or unparseable batch verdict
 * falls back to a single-pair call — never a contradiction without an explicit verdict. Each statement carries its
 * date; `temporal_discount: true` multiplies confidence by temporalDiscountFactor(days_apart); 'floor' snapshot pairs
 * are capped at SNAPSHOT_CONFIDENCE_CAP.
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

  const detailed = getCandidatePairsDetailed(engrams, options)
  const candidates = detailed.pairs.slice(0, maxPairs)
  const measuredUnderMode = options?.measured_under_pairs ?? 'skip'
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

      // Temporal adjustments — snapshot floor first, then the
      // opt-in days-apart discount.
      let confidence = verdict.confidence
      if (isSnapshotPair(a, b, temporalDomains)) {
        // Only reachable in 'floor' mode ('skip' drops these at candidate stage)
        confidence = Math.min(confidence, SNAPSHOT_CONFIDENCE_CAP)
      } else if (measuredUnderMode === 'floor' && measuredUnderGateApplies(a, b)) {
        // Judged rather than skipped, but a differing configuration is the
        // likelier explanation than a contradiction, so the verdict is capped.
        confidence = Math.min(confidence, MEASURED_UNDER_CONFIDENCE_CAP)
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
    skipped: detailed.skipped,
  }
}
