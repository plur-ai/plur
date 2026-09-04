/**
 * `pinned_priority` — the one place its rules live (#1121 review).
 *
 * Pinned engrams bypass the relevance gate at injection, so the key that
 * orders them under budget pressure is a security control, not a cosmetic
 * field: whoever wins the order gets into every session's system prompt.
 * Three facts follow, and every reader and writer of the field goes through
 * this module so they cannot drift:
 *
 *   - A value is an integer in [1, 100]; 50 when absent. A stored or foreign
 *     value that is not a finite number is treated as absent, never as a
 *     crash or a quarantine — an ordering hint must not be able to remove a
 *     memory (`normalizePinnedPriority`).
 *   - A caller writing the field gets a clamp for a finite out-of-range
 *     number and a TypeError for anything else; NaN is never persisted
 *     (`validatePinnedPriority`).
 *   - Origin outranks priority. A row from a pack, a `stores:` entry or a
 *     remote store can never rank ahead of a primary-store pin, whatever
 *     priority it carries (`pinnedOriginRank`).
 */

export const PINNED_PRIORITY_MIN = 1
export const PINNED_PRIORITY_MAX = 100
export const DEFAULT_PINNED_PRIORITY = 50

/**
 * A stored or foreign value as the injector may use it: a finite number is
 * rounded and clamped into [1, 100]; anything else — NaN, Infinity, a string,
 * an object, null — is `undefined` (the default applies). Never throws.
 */
export function normalizePinnedPriority(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.max(PINNED_PRIORITY_MIN, Math.min(PINNED_PRIORITY_MAX, Math.round(v)))
}

/**
 * A caller-supplied value at write time. `undefined`/`null` mean "not set".
 * A finite number is clamped (a caller asking for 150 wants "highest", not
 * an error); a non-number or non-finite number is a TypeError, because
 * persisting it would either write `.nan` to disk or silently mean
 * something the caller did not ask for.
 */
export function validatePinnedPriority(v: unknown, fn: string): number | undefined {
  if (v === undefined || v === null) return undefined
  const norm = normalizePinnedPriority(v)
  if (norm === undefined) {
    throw new TypeError(`plur.${fn}: pinned_priority must be a finite number in [${PINNED_PRIORITY_MIN}, ${PINNED_PRIORITY_MAX}], got ${typeof v === 'number' ? String(v) : typeof v}`)
  }
  return norm
}

/** The priority the injector orders by: normalised value or the default. */
export function effectivePinnedPriority(e: { pinned_priority?: unknown }): number {
  return normalizePinnedPriority(e.pinned_priority) ?? DEFAULT_PINNED_PRIORITY
}

/**
 * Where a row came from, for ordering: 0 = primary store, 1 = a `stores:`
 * or remote store (loader-stamped `_storeScope`), 2 = an installed pack
 * (loader-stamped `_pack`, or a non-personal `pack` field). The loader sets
 * these markers on every foreign row it clones, so a foreign row cannot
 * present itself as primary; a row that ships its own marker can only look
 * more foreign, never less.
 */
export function pinnedOriginRank(e: Record<string, unknown>): 0 | 1 | 2 {
  if (typeof e._pack === 'string') return 2
  if (typeof e.pack === 'string' && e.pack.length > 0 && e.pack !== '__personal__') return 2
  if (typeof e._storeScope === 'string') return 1
  return 0
}
