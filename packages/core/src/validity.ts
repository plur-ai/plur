/**
 * One evaluator for engram validity windows, shared by retrieval and injection.
 *
 * ## The defect this replaces
 *
 * Validity was decided by comparing a timestamp STRING against today's DATE
 * string, in four places that each rewrote the same two lines. Lexically
 * `'2026-09-07T01:00:00Z' > '2026-09-07'` is true at every hour of that day,
 * because the `T` sorts after the end of the shorter string — so an RFC 3339
 * instant was read backwards in both directions.
 *
 * Measured at a fixed clock of 2026-09-07T12:00:00Z (#1150):
 *
 * | stored                              | should be | was       |
 * | ----------------------------------- | --------- | --------- |
 * | `valid_from: 2026-09-07T01:00:00Z`  | eligible  | hidden    |
 * | `valid_until: 2026-09-07T01:00:00Z` | expired   | eligible  |
 *
 * The same wrong pair appeared in `list()`, in `recall()` and in injection,
 * because the comparison was duplicated rather than shared. The expiry
 * direction is the one that matters: an instruction that lapsed hours ago still
 * entered the agent's context, and reads exactly like a current one.
 *
 * `spec/ENGRAM-STANDARD-v1.md` requires accepting both forms and
 * `TemporalSchema` does accept both, so these were valid stored records rather
 * than malformed input.
 *
 * ## The rule
 *
 * A bare `YYYY-MM-DD` denotes a whole DAY — that is the documented behaviour and
 * it is preserved exactly. An RFC 3339 value denotes an INSTANT and is compared
 * as one, offset included. So `valid_from` opens at the start of its day (or at
 * its instant), and `valid_until` closes at the END of its day (or at its
 * instant) — which is why a date-only expiry of `2026-09-06` is still valid all
 * through the 6th and expired on the 7th.
 *
 * @module
 */
import type { Engram } from './schemas/engram.js'

/** The `temporal` block, or nothing. */
type Temporal = Engram['temporal'] | undefined

/** A bare calendar date, as opposed to an RFC 3339 instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const DAY_MS = 86_400_000

/**
 * First instant a bound includes, in epoch ms; `null` when unparseable.
 *
 * A date-only value opens at midnight UTC of that day.
 */
function opensAt(value: string): number | null {
  const ms = Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Last instant a bound includes, in epoch ms; `null` when unparseable.
 *
 * A date-only value closes at the END of that day — the whole-day semantics the
 * lexical comparison happened to get right for this form, and the reason a
 * date-only `valid_until` must not be treated as midnight.
 */
function closesAt(value: string): number | null {
  const ms = Date.parse(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * True when `valid_from` has not yet been reached.
 *
 * An unparseable bound is treated as ABSENT rather than as a bound that has not
 * arrived: `TemporalSchema` validates these fields, so a value that fails to
 * parse is a data error, and hiding content because of one is the worse
 * outcome of the two.
 *
 * @param temporal - the engram's temporal block.
 * @param nowMs - the evaluation instant, in epoch ms.
 */
export function isNotYetValid(temporal: Temporal, nowMs: number): boolean {
  const from = temporal?.valid_from
  if (!from) return false
  const opens = opensAt(from)
  return opens === null ? false : nowMs < opens
}

/**
 * True when `valid_until` has passed.
 *
 * @param temporal - the engram's temporal block.
 * @param nowMs - the evaluation instant, in epoch ms.
 */
export function isExpired(temporal: Temporal, nowMs: number): boolean {
  const until = temporal?.valid_until
  if (!until) return false
  const closes = closesAt(until)
  return closes === null ? false : nowMs > closes
}

/**
 * True when the engram expired longer ago than the soft-expiry grace window.
 *
 * Same bound interpretation as {@link isExpired}, so soft mode cannot disagree
 * with hard mode about when something lapsed — they differ only in what they do
 * about it.
 *
 * @param temporal - the engram's temporal block.
 * @param nowMs - the evaluation instant, in epoch ms.
 * @param graceDays - days an expired engram stays eligible, marked.
 */
export function isExpiredBeyondGrace(temporal: Temporal, nowMs: number, graceDays: number): boolean {
  const until = temporal?.valid_until
  if (!until) return false
  const closes = closesAt(until)
  return closes === null ? false : closes < nowMs - graceDays * DAY_MS
}

/**
 * True when the engram is inside its validity window right now.
 *
 * The retrieval-side question: `list()` and `recall()` hide anything this
 * rejects unless `include_expired` is set.
 *
 * @param temporal - the engram's temporal block.
 * @param nowMs - the evaluation instant, in epoch ms.
 */
export function isCurrentlyValid(temporal: Temporal, nowMs: number): boolean {
  return !isNotYetValid(temporal, nowMs) && !isExpired(temporal, nowMs)
}
