/**
 * The writeback rule for a store's `sensitivity` (PR-3 #353, R2-D #14,
 * scope-audit 2026-07-24), shared by per-scope entries
 * (`mergeStoresForWriteback`) and server entries (`collapseExpandedStores`,
 * #1631).
 *
 * `rawValue` is the on-disk value, read fresh and unvalidated: it can be
 * anything a hand-edit put there, so it only counts when it is a plain object.
 * `typed` is the parsed value, whose `forbid` was normalized at load (unknown
 * categories dropped).
 *
 *   - Nested unknown keys of the raw value survive (one-level deep merge).
 *   - The raw `forbid` is restored verbatim, so a forward-compatible category
 *     a newer client wrote is never erased by the first writeback.
 *   - `authoritative` (the server just synced this scope's policy from `/me`):
 *     the typed `forbid` wins, or the server's change would be discarded.
 *   - No typed value: the raw value is kept as it is.
 */
export function mergeSensitivityForWriteback(
  rawValue: unknown,
  typed: object | undefined,
  authoritative: boolean,
): Record<string, unknown> | undefined {
  const raw = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
    ? (rawValue as Record<string, unknown>)
    : undefined
  if (!typed) return raw
  const restoreRawForbid = raw !== undefined && 'forbid' in raw && !authoritative
  return {
    ...(raw ?? {}),
    ...typed,
    ...(restoreRawForbid ? { forbid: raw.forbid } : {}),
  }
}
