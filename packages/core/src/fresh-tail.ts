/**
 * Fresh tail boost (Idea 13)
 *
 * Engrams created in last 7 days get a retrieval_strength boost.
 * Day 0: +0.2, Day 7: +0.0 (linear decay)
 *
 * ONLY applies to commitment='exploring' or 'leaning' (F14).
 * Decided/locked engrams don't need the boost (already high priority).
 *
 * Applied at scoring time, NOT stored on the engram.
 */

const FRESH_TAIL_DAYS = 7
const FRESH_TAIL_MAX_BOOST = 0.2

export function freshTailBoost(
  createdAt: string,
  commitment?: string,
  now?: Date,
): number {
  if (commitment && !['exploring', 'leaning'].includes(commitment)) return 0
  const created = new Date(createdAt)
  const today = now ?? new Date()
  const daysSinceCreation = (today.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)
  if (daysSinceCreation < 0 || daysSinceCreation > FRESH_TAIL_DAYS) return 0
  return FRESH_TAIL_MAX_BOOST * (1 - daysSinceCreation / FRESH_TAIL_DAYS)
}
