/**
 * What a feedback signal does to an engram.
 *
 * This was written out by hand in three places in `Plur.feedback` — once for
 * the primary store, once for secondary stores, once for packs — and the three
 * had already drifted: **only the primary copy promoted `commitment`**. The
 * same engram, given the same positive signal, advanced from `leaning` to
 * `decided` in your own store and stayed at `leaning` in a team store or an
 * installed pack. Nothing failed; the engram just quietly meant something
 * different depending on where it was kept.
 *
 * Three copies of a rule is how that happens, so there is now one. It is a pure
 * mutation over an engram — no I/O, no locking, no history — which is what lets
 * a server-side deployment reuse it without also inheriting the file-backed
 * single-user machinery that surrounds it in `Plur`.
 */
import type { Engram } from './schemas/engram.js'

export type FeedbackSignal = 'positive' | 'negative' | 'neutral'

/** Strength added on a positive signal. Capped at 1.0. */
export const POSITIVE_STRENGTH_DELTA = 0.05
/** Strength removed on a negative signal. Floored at 0.0. */
export const NEGATIVE_STRENGTH_DELTA = 0.1

/**
 * Next commitment level after a positive signal.
 *
 * Advances one step toward `decided` and never further: reaching `locked`
 * requires explicit human intent, and no amount of accumulated feedback should
 * substitute for it.
 *
 * `undefined` seeds at `leaning` rather than staying unset. An engram that has
 * received a positive signal has demonstrably been retrieved and found useful,
 * which is more than `exploring` claims and exactly what `leaning` means;
 * leaving it unset would let an older engram accrue unlimited positive signal
 * while still reading as though nobody had an opinion about it.
 *
 * Anything unrecognised is returned untouched. That is load-bearing rather than
 * defensive: a deployment may extend the enum — `commitment: 'draft'` stages an
 * engram in a review queue (see the extension note in `schemas/engram.ts`) — and
 * silently promoting a draft out of review on a thumbs-up would publish
 * unreviewed content. Unknown means "not mine to advance".
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
 * Apply a feedback signal to an engram, in place.
 *
 * Mutates rather than returning a copy because every caller already owns the
 * engram it loaded and writes the whole collection back; copying would just add
 * a merge step for each of them to get subtly wrong.
 *
 * @param engram  the engram to update
 * @param signal  the verdict
 * @param today   date stamp to re-anchor `last_accessed` with, `YYYY-MM-DD`.
 *                Injectable so tests are not clock-dependent.
 */
export function applyFeedbackSignal(
  engram: Engram,
  signal: FeedbackSignal,
  today: string = new Date().toISOString().slice(0, 10),
): void {
  if (!engram.feedback_signals) {
    engram.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
  }
  engram.feedback_signals[signal] += 1

  if (signal === 'positive') {
    engram.activation.retrieval_strength = Math.min(
      1.0, engram.activation.retrieval_strength + POSITIVE_STRENGTH_DELTA,
    )
    const e = engram as Engram & { commitment?: string }
    const next = nextCommitment(e.commitment)
    if (next !== undefined) e.commitment = next as typeof e.commitment
  } else if (signal === 'negative') {
    engram.activation.retrieval_strength = Math.max(
      0.0, engram.activation.retrieval_strength - NEGATIVE_STRENGTH_DELTA,
    )
  }

  // Re-anchor last_accessed when feedback adjusts stored strength. Read-time
  // decay (inject.ts decayedStrength) is computed against last_accessed, so
  // bumping strength without advancing the anchor lets elapsed-time decay
  // immediately swallow the adjustment — a >4x distortion on stale engrams,
  // exactly the ones where a fade-vs-keep signal matters most. Mirrors the
  // strength+anchor pairing in _reactivateResults.
  //
  // Neutral is excluded because it changes no strength: there is nothing to
  // protect from decay, and advancing the anchor would make "no opinion" act
  // as a liveness ping.
  if (signal !== 'neutral') {
    engram.activation.last_accessed = today
  }
}
