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
 *      in the reply                                          → positive, 0.7–0.9
 *   3. One sentence of the reply holds BOTH a correction
 *      phrase AND the statement's distinctive words          → negative, 0.65
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

/** Correction phrases that open a sentence. */
const LEADING_CORRECTION = /^(?:actually,|no,|correction:|wrong,|incorrect,)/
/** Correction phrases anywhere in a sentence. */
const INLINE_CORRECTION =
  /\b(?:that's wrong|that is wrong|is wrong|was wrong|is incorrect|was incorrect|not correct|is outdated|no longer (?:true|valid|applies|correct|needed|required))\b/

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

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_'-]+/gu) ?? []
}

function trigrams(words: string[]): Set<string> {
  if (words.length < 3) return new Set(words)
  const out = new Set<string>()
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  return out
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0)
}

/** Rate one injected engram against the assistant's reply. */
export function detectInjectionSignal(statement: string, reply: string): InjectionSignalResult {
  const stmtWords = tokens(statement)
  const replyWords = tokens(reply)
  if (stmtWords.length === 0 || replyWords.length === 0) return { signal: null, confidence: 0 }

  // 1. Verbatim, on token boundaries.
  if (` ${replyWords.join(' ')} `.includes(` ${stmtWords.join(' ')} `)) {
    return { signal: 'positive', confidence: EXACT_CONFIDENCE }
  }

  // 2. Trigram overlap.
  const stmtTris = trigrams(stmtWords)
  if (stmtTris.size > 0) {
    const replyTris = trigrams(replyWords)
    let shared = 0
    for (const t of stmtTris) if (replyTris.has(t)) shared++
    const overlap = shared / stmtTris.size
    if (overlap >= TRIGRAM_MIN_OVERLAP) {
      return { signal: 'positive', confidence: 0.7 + 0.2 * overlap }
    }
  }

  // 3. Correction in the same sentence as the statement's distinctive words.
  const distinctive = [...new Set(stmtWords)].filter(
    w => w.length > DISTINCTIVE_MIN_LENGTH && !STOPWORDS.has(w),
  )
  if (distinctive.length > 0) {
    const needed = Math.min(NEGATIVE_MIN_SHARED_WORDS, distinctive.length)
    for (const sentence of sentences(reply)) {
      if (!LEADING_CORRECTION.test(sentence) && !INLINE_CORRECTION.test(sentence)) continue
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
