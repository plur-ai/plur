/**
 * Explicit-expiry extraction for the write path (#347).
 *
 * The deterministic expiry machinery (inject/recall skip engrams whose
 * `temporal.valid_until` is in the past) existed long before anything
 * populated the field — time-bound facts were stored with the date only in
 * free text and kept injecting at full strength after going stale.
 *
 * This module lifts EXPLICIT expiry phrases ("valid until 31 May 2026",
 * "expires 2026-12-01") out of the statement into the structured field.
 * It is conservative by design — NEVER silently guess:
 *   - only fires when an expiry keyword is immediately followed by a date
 *   - only fully-specified, unambiguous dates parse (a missing year, or a
 *     numeric slash date like 05/31/2026 with its US/EU ambiguity, is a miss)
 *   - the parsed ISO date is echoed back to the caller for confirmation
 *     (see the `_expiry_extracted` marker and the plur_learn `expiry_note`)
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** Month name — full or 3-letter abbreviation (plus "sept"), case-insensitive. */
const MONTH_RE =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

/**
 * Date alternatives, all requiring an explicit 4-digit year:
 *   1. ISO           2026-05-31
 *   2. D Month YYYY  31 May 2026 / 31st May 2026
 *   3. Month D, YYYY May 31, 2026 / May 31 2026
 */
const DATE_RE =
  `(\\d{4}-\\d{2}-\\d{2})` +
  `|(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?,?\\s+(\\d{4})` +
  `|(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`

/**
 * Expiry keywords. `valid until|through|thru` and bare `valid <date>` (the
 * observed offer-engram shape), `expires [on|at]`, `expiry [date]`,
 * `expiration [date]`. `valid from` never matches — the date must follow the
 * keyword directly, and "from" is not a date.
 */
const KEYWORD_RE =
  '(?:valid\\s+(?:until|through|thru)|valid|expires?\\s+(?:on\\s+|at\\s+)?|expiry(?:\\s+date)?:?\\s*|expiration(?:\\s+date)?:?\\s*)'

const EXPIRY_RE = new RegExp(`\\b${KEYWORD_RE}\\s*(?:${DATE_RE})`, 'i')

export interface ExtractedExpiry {
  /** Normalized ISO date (YYYY-MM-DD). */
  valid_until: string
  /** The matched source phrase, echoed back for confirmation. */
  phrase: string
}

/** True when Y-M-D is a real calendar date (rejects 2026-02-30 etc.). */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Validate + normalize a strict ISO date string (YYYY-MM-DD).
 * Returns the normalized date, or null when malformed or not a real
 * calendar date. Used for caller-provided valid_from / valid_until.
 */
export function normalizeIsoDate(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (!m) return null
  const [, y, mo, d] = m
  if (!isRealDate(Number(y), Number(mo), Number(d))) return null
  return `${y}-${mo}-${d}`
}

/** Resolved validity window for a learn() write (#347). */
export interface ResolvedValidity {
  valid_from?: string
  valid_until?: string
  /** Set when valid_until came from statement extraction, not the caller. */
  extracted?: ExtractedExpiry
}

/**
 * Resolve the validity window for a new engram. Explicit caller params win
 * and are strictly validated (throws on malformed dates or an inverted
 * window); with no explicit valid_until, an explicit expiry phrase in the
 * statement is lifted into valid_until and flagged as `extracted` so the
 * caller can echo it back for confirmation. Pure — safe to call before
 * dedup/locking so malformed input fails fast.
 */
export function resolveValidity(
  statement: string,
  context: { valid_from?: string; valid_until?: string } | undefined,
): ResolvedValidity {
  let validFrom: string | undefined
  let validUntil: string | undefined
  let extracted: ExtractedExpiry | undefined

  if (context?.valid_from !== undefined) {
    const norm = normalizeIsoDate(context.valid_from)
    if (!norm) throw new TypeError(`plur.learn: valid_from must be an ISO date (YYYY-MM-DD), got "${context.valid_from}"`)
    validFrom = norm
  }
  if (context?.valid_until !== undefined) {
    const norm = normalizeIsoDate(context.valid_until)
    if (!norm) throw new TypeError(`plur.learn: valid_until must be an ISO date (YYYY-MM-DD), got "${context.valid_until}"`)
    validUntil = norm
  } else {
    const hit = extractExpiry(statement)
    if (hit) {
      validUntil = hit.valid_until
      extracted = hit
    }
  }

  if (validFrom && validUntil && validFrom > validUntil) {
    if (extracted) {
      // The inversion came from extraction, not the caller — drop the
      // extracted date rather than failing a write the caller didn't shape.
      validUntil = undefined
      extracted = undefined
    } else {
      throw new RangeError(`plur.learn: valid_from (${validFrom}) must not be after valid_until (${validUntil})`)
    }
  }

  return { valid_from: validFrom, valid_until: validUntil, extracted }
}

/**
 * Build the engram `temporal` block from a resolved validity window.
 * Returns undefined when there is no window — `temporal` stays unset for
 * ordinary engrams (schema field is optional; quality scoring counts it).
 */
export function buildTemporal(
  validity: ResolvedValidity,
  now: string,
): { learned_at: string; valid_from?: string; valid_until?: string } | undefined {
  if (!validity.valid_from && !validity.valid_until) return undefined
  return {
    learned_at: now,
    ...(validity.valid_from ? { valid_from: validity.valid_from } : {}),
    ...(validity.valid_until ? { valid_until: validity.valid_until } : {}),
  }
}

/**
 * Detect an explicit expiry phrase in a statement and parse it into an
 * ISO valid_until. Returns null when nothing unambiguous matches — the
 * caller must NOT infer a date any other way.
 */
export function extractExpiry(statement: string): ExtractedExpiry | null {
  const m = EXPIRY_RE.exec(statement)
  if (!m) return null

  let year: number, month: number, day: number
  if (m[1]) {
    // ISO: 2026-05-31
    const parts = m[1].split('-')
    year = Number(parts[0]); month = Number(parts[1]); day = Number(parts[2])
  } else if (m[2] && m[3] && m[4]) {
    // D Month YYYY
    day = Number(m[2]); month = MONTHS[m[3].slice(0, 3).toLowerCase()]; year = Number(m[4])
  } else if (m[5] && m[6] && m[7]) {
    // Month D, YYYY
    month = MONTHS[m[5].slice(0, 3).toLowerCase()]; day = Number(m[6]); year = Number(m[7])
  } else {
    return null
  }

  if (!isRealDate(year, month, day)) return null
  return {
    valid_until: `${year}-${pad(month)}-${pad(day)}`,
    phrase: m[0].trim(),
  }
}
