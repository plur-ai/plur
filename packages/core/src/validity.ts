/**
 * One evaluator for engram validity windows, shared by retrieval and injection.
 *
 * Timestamps are compared as instants, never as strings: lexically
 * `'2026-09-07T01:00:00Z' > '2026-09-07'` is true at every hour of that day,
 * which would hide content that is already valid and keep content that has
 * already expired. `spec/ENGRAM-STANDARD-v1.md` and `TemporalSchema` accept both
 * date-only and RFC 3339 values, so both must be handled.
 *
 * ## The rule
 *
 * A bare `YYYY-MM-DD` denotes a whole DAY. An RFC 3339 value denotes an INSTANT
 * and is compared as one, offset included. So `valid_from` opens at the start of
 * its day (or at its instant), and `valid_until` closes at the END of its day
 * (or at its instant), which is why a date-only expiry of `2026-09-06` is still
 * valid all through the 6th and expired on the 7th.
 *
 * @module
 */
import type { Engram } from './schemas/engram.js'

/** The `temporal` block, or nothing. */
type Temporal = Engram['temporal'] | undefined

/** A bare calendar date, as opposed to an RFC 3339 instant. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const DAY_MS = 86_400_000

/** A trailing `Z` or `±HH:MM` / `±HHMM` zone designator. */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i

/**
/**
 * Pin a timestamp to UTC when it names no zone.
 *
 * `Date.parse('2026-09-07T01:00:00')` (no `Z`, no offset) resolves in the
 * HOST's local time, so the same stored engram would expire at different
 * moments on different machines. `TemporalSchema` accepts any string, and
 * `salvageRemoteRow` copies server values verbatim, so naive timestamps can
 * reach this function.
 *
 * UTC is the right default: every timestamp this codebase mints is
 * `toISOString()`, so a naive value is foreign or hand-edited, and reading it
 * as UTC agrees with the rest of the store.
 *
 * Exported for tests: the behavioural difference is only visible in a non-UTC
 * timezone, so the mechanism is asserted directly.
 */
export function pinToUtc(value: string): string {
  return HAS_ZONE.test(value) ? value : `${value}Z`
}

/**
 * First instant a bound includes, in epoch ms; `null` when unparseable.
 *
 * A date-only value opens at midnight UTC of that day.
 */
function opensAt(value: string): number | null {
  const ms = Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : pinToUtc(value))
  return Number.isNaN(ms) ? null : ms
}

/**
 * Last instant a bound includes, in epoch ms; `null` when unparseable.
 *
 * A date-only value closes at the END of that day; a date-only `valid_until`
 * must not be treated as midnight.
 */
function closesAt(value: string): number | null {
  const ms = Date.parse(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : pinToUtc(value))
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

/**
 * Interpret an "evaluate as of" parameter as an instant.
 *
 * Callers that expose a `now` option take a `YYYY-MM-DD` string or an RFC 3339
 * instant. A whole day is resolved to its END, so a date-only `valid_until`
 * equal to `now` is NOT expired. Resolving to midnight instead would expire
 * everything a day early.
 *
 * The sibling functions treat an unparseable bound as ABSENT, because stored
 * engrams have their fields validated by `TemporalSchema` and hiding content
 * over a data error is the worse outcome. A caller-supplied evaluation instant
 * is an explicit argument, so an unparseable value throws a `RangeError`
 * rather than silently answering as of the present moment.
 *
 * @param now - `YYYY-MM-DD`, or an RFC 3339 instant, or nothing for the
 *   current moment.
 * @throws {RangeError} When `now` is provided but cannot be parsed as a date or instant.
 */
export function evaluationInstant(now?: string): number {
  if (!now) return Date.now()
  const ms = closesAt(now)
  if (ms === null) {
    throw new RangeError(`Unparseable evaluation instant: "${now}". Expected YYYY-MM-DD or an RFC 3339 timestamp.`)
  }
  return ms
}
