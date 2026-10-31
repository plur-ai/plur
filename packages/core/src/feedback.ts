/**
 * What a feedback signal does to an engram.
 *
 * The single rule used for the primary store, secondary stores and packs, so
 * the same signal has the same effect wherever an engram is kept. It is a pure
 * mutation (no I/O, no locking, no history), so a server-side deployment can
 * reuse it without the file-backed machinery that surrounds it in `Plur`.
 */
import type { Engram } from './schemas/engram.js'

export type FeedbackSignal = 'positive' | 'negative' | 'neutral'

/**
 * Who produced a feedback signal.
 *
 * - `explicit` — a person or agent deliberately rated the engram
 *   (`plur_feedback`, `plur feedback`). The default.
 * - `auto` — an editor hook inferred the verdict from the reply text
 *   (`injection-signal.ts`). It moves ranking only: `commitment` records how
 *   settled a person considers the knowledge, and a string match in a reply
 *   is not a person deciding anything.
 */
export type FeedbackSource = 'explicit' | 'auto'

export interface ApplyFeedbackOptions {
  source?: FeedbackSource
}

/** Strength added on a positive signal. Capped at 1.0. */
export const POSITIVE_STRENGTH_DELTA = 0.05
/** Strength removed on a negative signal. Floored at 0.0. */
export const NEGATIVE_STRENGTH_DELTA = 0.1

/**
 * Next commitment level after a positive signal: one step, never past
 * `decided` (`locked` requires explicit human intent). `undefined` seeds at
 * `leaning`. Unrecognised values (e.g. a deployment's `draft` review state, see
 * `schemas/engram.ts`) are returned untouched, so a thumbs-up never publishes
 * unreviewed content.
 */
export function nextCommitment(current: string | undefined): string | undefined {
  switch (current) {
    case undefined:    return 'leaning'
    case 'exploring':  return 'leaning'
    case 'leaning':    return 'decided'
    case 'decided':    return 'decided'
    case 'locked':     return 'locked'
    default:           return current
  }
}

/**
 * Apply a feedback signal to an engram, in place (callers own and write back
 * the whole collection).
 * @param engram  the engram to update
 * @param signal  the verdict
 * @param today   `YYYY-MM-DD` stamp for `last_accessed`; injectable for tests.
 * @param options `source: 'auto'` adjusts strength only and never advances
 *                `commitment`.
 */
export function applyFeedbackSignal(
  engram: Engram,
  signal: FeedbackSignal,
  today: string = new Date().toISOString().slice(0, 10),
  options: ApplyFeedbackOptions = {},
): void {
  if (!engram.feedback_signals) {
    engram.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
  }
  engram.feedback_signals[signal] += 1

  if (signal === 'positive') {
    engram.activation.retrieval_strength = Math.min(
      1.0, engram.activation.retrieval_strength + POSITIVE_STRENGTH_DELTA,
    )
    // Automatic verdicts never promote: only deliberate feedback may say
    // "this is more settled than it was".
    if (options.source !== 'auto') {
      const e = engram as Engram & { commitment?: string }
      const next = nextCommitment(e.commitment)
      if (next !== undefined) e.commitment = next as typeof e.commitment
    }
  } else if (signal === 'negative') {
    engram.activation.retrieval_strength = Math.max(
      0.0, engram.activation.retrieval_strength - NEGATIVE_STRENGTH_DELTA,
    )
  }

  // Re-anchor last_accessed when feedback adjusts stored strength. Read-time
  // decay (inject.ts decayedStrength) is computed against last_accessed, so
  // without advancing the anchor elapsed-time decay would immediately swallow
  // the adjustment on stale engrams. Mirrors _reactivateResults.
  //
  // Neutral changes no strength, and advancing the anchor would make "no
  // opinion" act as a liveness ping.
  if (signal !== 'neutral') {
    engram.activation.last_accessed = today
  }
}
