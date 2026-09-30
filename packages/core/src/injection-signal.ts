/**
 * Automatic rating of injected engrams from the assistant's reply (#1310).
 *
 * An editor hook knows which engrams it injected this session and, at the end
 * of a turn, what the assistant replied. From those two it can often tell
 * whether an engram was used (the reply repeats it) or contradicted (the reply
 * corrects it). This module is the ONE implementation of that heuristic; it is
 * a port of plur-hermes's `_detect_injection_signal` (#1086), with the negative
 * rule tightened.
 *
 * Rules, first match wins:
 *
 *   1. The statement appears verbatim in the reply (case, whitespace and
 *      punctuation ignored)                                  → positive, 0.95
 *   2. At least 80% of the statement's word trigrams appear
 *      in the reply (statements of three words or more)      → positive, 0.7–0.9
 *   3. One sentence of the reply holds BOTH a correction
 *      phrase AND the statement's distinctive words          → negative, 0.65
 *
 * A match under rule 1 or 2 is only positive when neither the sentence(s)
 * holding it nor the sentence right after carry a correction phrase. A reply
 * that quotes a memory in order to correct it ("your note says 'use npm' —
 * that is no longer true") is rated negative, never positive (#1318 review).
 *
 * The match itself is also checked where it sits (#1362): a negation in the
 * word right before it ("Do not use pnpm" against "Use pnpm") or a
 * verdict right after it ('"use npm" is outdated', '… does not apply here',
 * '… was dropped') makes it negative too. "No longer", "instead of", "rather
 * than" and "ignore" count as negations when they sit right before it. "Stop"
 * does not: "Stop — use pnpm for installs" follows the engram.
 * Only the words next to the match count, so a reply that follows the engram
 * and says "not" about something else in the same sentence stays positive.
 * Each occurrence (each run of consecutive trigrams, under rule 2) is judged on
 * its own. The reply is negative only when every occurrence is rejected, and
 * gets no verdict when some are rejected and some are not.
 *
 * Statements under three words have no trigrams; comparing bare words would
 * rate "Prefer pnpm" positive for any short reply containing both words, so
 * they are matched verbatim only.
 *
 * Rule 3 used to look at a ±100–200 character window around any correction
 * word. A reply that fixed an unrelated thing next to a shared word therefore
 * marked the engram wrong. Sentences are the unit now, and "distinctive words"
 * means at least two of the statement's longer non-stopwords (or all of them
 * when it has fewer), so one shared common word is not enough.
 *
 * Only verdicts at or above {@link AUTO_FEEDBACK_MIN_CONFIDENCE} are returned
 * by {@link rateInjectedEngrams}. What a caller does with them is decided
 * elsewhere: automatic feedback adjusts ranking only and never commitment
 * (see `applyFeedbackSignal`'s `source` option).
 *
 * Pure functions — no I/O — so hooks can run them before paying for a store
 * load, and a server-side deployment can reuse them.
 */

export type InjectionSignal = 'positive' | 'negative'

export interface InjectionSignalResult {
  signal: InjectionSignal | null
  confidence: number
}

export interface RatedEngram {
  id: string
  signal: InjectionSignal
  confidence: number
}

/** Verdicts below this are never sent. */
export const AUTO_FEEDBACK_MIN_CONFIDENCE = 0.6

const EXACT_CONFIDENCE = 0.95
const TRIGRAM_MIN_OVERLAP = 0.8
const NEGATIVE_CONFIDENCE = 0.65
/** A word must be longer than this to count as distinctive. */
const DISTINCTIVE_MIN_LENGTH = 4
/** How many distinctive words a correcting sentence must share with the statement. */
const NEGATIVE_MIN_SHARED_WORDS = 2

/** Correction phrases that open a sentence and are a correction on their own. */
const LEADING_CORRECTION = /^(?:correction:|wrong,|incorrect,)/
/**
 * Discourse markers that open corrections AND agreements alike: "Actually,
 * let me also run the tests" and "No, the tests passed" agree with the memory
 * (audit M3). They count only when the same sentence also contradicts
 * something (see CONTRADICTION_CUE).
 */
const LEADING_MARKER = /^(?:actually,|no,)/
/** Words that make a sentence opened by LEADING_MARKER an actual correction. */
const CONTRADICTION_CUE =
  /\b(?:not|never|no longer|n't|instead|rather than|anymore|wrong|incorrect|outdated|obsolete|deprecated|retired|removed|dropped|replaced)\b|n't\b/
/**
 * Correction phrases anywhere in a sentence — constructions aimed at a prior
 * claim ("that is wrong", "is no longer true"), not a bare "is wrong", which
 * ordinary prose uses all the time ("check what is wrong with the deploy").
 */
const INLINE_CORRECTION =
  /\b(?:(?:that|this|it)(?:'s| is| was) (?:wrong|incorrect|outdated|out of date|not true|not correct|not accurate|no longer (?:true|valid|correct|accurate|the case))|(?:is|was|are|were) no longer (?:true|valid|correct|accurate|the case|needed|required)|no longer (?:applies|holds)|not correct anymore)\b/

/**
 * Longer words that carry no topic of their own. Kept small on purpose: a
 * word missing here only makes the negative rule slightly easier to meet, and
 * the two-word minimum already absorbs most of that.
 */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'always', 'before', 'being', 'below',
  'between', 'could', 'during', 'every', 'first', 'never', 'other', 'should',
  'since', 'their', 'there', 'these', 'thing', 'things', 'those', 'through',
  'under', 'until', 'using', 'where', 'which', 'while', 'would', 'without',
])

/**
 * Curly and modifier-letter apostrophes (U+2018, U+2019, U+02BC) count as
 * straight ones, so "don’t" is "don't" and "that’s wrong" is a correction.
 */
function straightApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc]/g, "'")
}

function tokens(text: string): string[] {
  // Inner apostrophes and hyphens belong to the word ("don't", "zebra-quartz");
  // leading/trailing ones are quote marks and dashes around it.
  return (straightApostrophes(text.toLowerCase()).match(/[\p{L}\p{N}_'-]+/gu) ?? [])
    .map(t => t.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean)
}

function trigrams(words: string[]): Set<string> {
  if (words.length < 3) return new Set(words)
  const out = new Set<string>()
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  return out
}

function sentences(text: string): string[] {
  // Normalised here, before the correction regexes see the sentence.
  return straightApostrophes(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0)
}

/** Words that negate what directly follows them ("do not use pnpm"). */
const NEGATORS = new Set([
  'not', 'never', "don't", 'dont', "doesn't", "didn't", "shouldn't",
  "mustn't", "won't", "can't", 'cannot', 'avoid', 'ignore',
])
/**
 * Two-word phrases that set aside what directly follows them: "we no longer
 * use pnpm", "instead of 'use pnpm'", "rather than use pnpm". Only right
 * before the match, so "Rather than npm, use pnpm" still follows it.
 */
const NEGATOR_PAIRS = new Set(['no longer', 'instead of', 'rather than'])
/**
 * Filler a negator may sit behind ("don't ever use pnpm"). Only the word right
 * before the match is checked otherwise, so "If not sure, use pnpm" follows it.
 */
const NEGATION_FILLER = new Set(['ever', 'just', 'really', 'even', 'actually', 'always'])
/**
 * A verdict on the matched text, read from the words right after it:
 * '"use npm" is outdated', "…, which is no longer true".
 */
const TRAILING_VERDICT =
  /^(?:which |that )?(?:(?:is|was|are|were|has been|have been)(?: now| also)? (?:outdated|out of date|obsolete|deprecated|stale|wrong|incorrect|false|dropped|removed|retired|replaced|reverted|superseded|(?:not|no longer) (?:true|valid|correct|accurate|right|the case|needed|required|recommended))|(?:does not|doesn't|do not|don't|no longer) apply|no longer (?:applies|holds))\b/

function isCorrection(sentence: string): boolean {
  return LEADING_CORRECTION.test(sentence)
    || INLINE_CORRECTION.test(sentence)
    || (LEADING_MARKER.test(sentence) && CONTRADICTION_CUE.test(sentence))
}

/** Rate one injected engram against the assistant's reply. */
export function detectInjectionSignal(statement: string, reply: string): InjectionSignalResult {
  const stmtWords = tokens(statement)
  const sents = sentences(reply)
  // The reply's tokens, each tagged with the sentence it sits in, so a match
  // can be traced back to the sentences that hold it.
  const flat: string[] = []
  const sentOf: number[] = []
  sents.forEach((s, i) => { for (const t of tokens(s)) { flat.push(t); sentOf.push(i) } })
  if (stmtWords.length === 0 || flat.length === 0) return { signal: null, confidence: 0 }

  // isCorrection by sentence index, computed at most once per sentence. Every
  // occurrence asks about its own sentence and the next one; without the memo
  // a long sentence full of occurrences was re-scanned once per occurrence,
  // which is quadratic (a 1 MiB reply took over a minute).
  const correctionMemo: Array<boolean | undefined> = new Array(sents.length)
  const sentenceCorrects = (i: number): boolean =>
    (correctionMemo[i] ??= isCorrection(sents[i]))

  /** Is the match in these sentences corrected there or in the next sentence? */
  const corrected = (idxs: Iterable<number>): boolean => {
    for (const i of idxs) {
      if (sentenceCorrects(i)) return true
      if (i + 1 < sents.length && sentenceCorrects(i + 1)) return true
    }
    return false
  }
  const quotedThenCorrected: InjectionSignalResult = { signal: 'negative', confidence: NEGATIVE_CONFIDENCE }

  /**
   * Is the matched span flat[start..end] negated right before it or given a
   * wrong/outdated verdict right after it, within its own sentence? (#1362)
   */
  const rejectedInPlace = (start: number, end: number): boolean => {
    let k = start - 1
    if (k >= 0 && sentOf[k] === sentOf[start] && NEGATION_FILLER.has(flat[k])) k--
    if (k >= 0 && sentOf[k] === sentOf[start] && NEGATORS.has(flat[k])) {
      // "Why not use pnpm?" recommends it.
      const whyNot = flat[k] === 'not' && k > 0 && sentOf[k - 1] === sentOf[k] && flat[k - 1] === 'why'
      if (!whyNot) return true
    }
    if (k >= 1 && sentOf[k - 1] === sentOf[start] && NEGATOR_PAIRS.has(`${flat[k - 1]} ${flat[k]}`)) return true
    const after: string[] = []
    for (let k = end + 1; k < flat.length && after.length < 6 && sentOf[k] === sentOf[end]; k++) after.push(flat[k])
    return TRAILING_VERDICT.test(after.join(' '))
  }

  /**
   * One verdict from every occurrence of the match (#1362): negative only when
   * each occurrence is rejected or corrected, positive only when none is. A
   * reply that both rejects and follows the engram ("I did not X yet — doing
   * it now: X") gets no verdict, so one rejected occurrence never overrides a
   * follow-through one, and one clean occurrence never hides a rejection.
   */
  const verdict = (rejected: boolean[], positive: InjectionSignalResult): InjectionSignalResult => {
    if (rejected.every(r => !r)) return positive
    if (rejected.every(r => r)) return quotedThenCorrected
    return { signal: null, confidence: 0 }
  }
  /** Is the span flat[start..end] rejected in place or corrected around it? */
  const spanRejected = (start: number, end: number): boolean => {
    const where = new Set<number>()
    for (let k = start; k <= end; k++) where.add(sentOf[k])
    return rejectedInPlace(start, end) || corrected(where)
  }

  // 1. Verbatim, on token boundaries.
  const n = stmtWords.length
  const exactRejected: boolean[] = []
  for (let k = 0; k + n <= flat.length; k++) {
    let hit = true
    for (let j = 0; j < n; j++) if (flat[k + j] !== stmtWords[j]) { hit = false; break }
    if (hit) exactRejected.push(spanRejected(k, k + n - 1))
  }
  if (exactRejected.length > 0) {
    return verdict(exactRejected, { signal: 'positive', confidence: EXACT_CONFIDENCE })
  }

  // 2. Trigram overlap — only for statements that have trigrams.
  if (n >= 3) {
    const stmtTris = trigrams(stmtWords)
    const matched = new Set<string>()
    // Runs of consecutive matching trigrams, each judged on its own: a
    // negation before one run says nothing about another run elsewhere.
    const runs: Array<[number, number]> = []
    for (let k = 0; k + 2 < flat.length; k++) {
      const t = `${flat[k]} ${flat[k + 1]} ${flat[k + 2]}`
      if (!stmtTris.has(t)) continue
      matched.add(t)
      const run = runs[runs.length - 1]
      if (run && run[1] === k + 1) run[1] = k + 2
      else runs.push([k, k + 2])
    }
    const overlap = matched.size / stmtTris.size
    if (overlap >= TRIGRAM_MIN_OVERLAP) {
      return verdict(
        runs.map(([start, end]) => spanRejected(start, end)),
        { signal: 'positive', confidence: 0.7 + 0.2 * overlap },
      )
    }
  }

  // 3. Correction in the same sentence as the statement's distinctive words.
  const distinctive = [...new Set(stmtWords)].filter(
    w => w.length > DISTINCTIVE_MIN_LENGTH && !STOPWORDS.has(w),
  )
  if (distinctive.length > 0) {
    const needed = Math.min(NEGATIVE_MIN_SHARED_WORDS, distinctive.length)
    for (const sentence of sents) {
      if (!isCorrection(sentence)) continue
      const words = new Set(tokens(sentence))
      const hits = distinctive.filter(w => words.has(w)).length
      if (hits >= needed) return { signal: 'negative', confidence: NEGATIVE_CONFIDENCE }
    }
  }

  return { signal: null, confidence: 0 }
}

/**
 * Rate every injected engram against one reply and keep only the verdicts
 * confident enough to send.
 */
export function rateInjectedEngrams(
  engrams: ReadonlyArray<{ id: string; statement: string }>,
  reply: string,
  minConfidence: number = AUTO_FEEDBACK_MIN_CONFIDENCE,
): RatedEngram[] {
  const out: RatedEngram[] = []
  for (const e of engrams) {
    if (!e.id || !e.statement) continue
    const { signal, confidence } = detectInjectionSignal(e.statement, reply)
    if (signal && confidence >= minConfidence) out.push({ id: e.id, signal, confidence })
  }
  return out
}
