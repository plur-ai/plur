/**
 * Fresh tail boost: engrams created in the last 7 days get a retrieval_strength
 * boost that decays linearly from +0.2 on day 0 to +0.0 on day 7.
 *
 * Applies only to commitment 'exploring' or 'leaning'; decided/locked engrams
 * already rank high. Applied at scoring time, never stored on the engram.
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
