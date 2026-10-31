/**
 * One evaluator for engram validity windows, shared by retrieval and injection.
 * Timestamps are compared as instants, never as strings (lexical comparison of
 * date-only vs RFC 3339 values is wrong all day long); both forms are accepted
 * (`spec/ENGRAM-STANDARD-v1.md`, `TemporalSchema`).
 * The rule: a bare `YYYY-MM-DD` is a whole DAY, an RFC 3339 value an INSTANT
 * (offset included). `valid_from` opens at the start of its day; `valid_until`
 * closes at the END of its day, so an expiry of the 6th is valid through the 6th.
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
 * Pin a timestamp to UTC when it names no zone. A naive value would otherwise
 * parse in the host's local time and expire at different moments per machine;
 * such values only arrive hand-edited or from remote rows, and UTC matches
 * every `toISOString()` value the store mints.
 * Exported for tests (the difference only shows in a non-UTC timezone).
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
 * Interpret an "evaluate as of" parameter as an instant. A whole day resolves
 * to its END, so a date-only `valid_until` equal to `now` is NOT expired.
 * Unlike stored bounds (unparseable → absent), an explicit unparseable `now`
 * throws rather than silently answering as of the present.
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
