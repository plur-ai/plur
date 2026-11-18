/**
 * The writeback rule for `sensitivity`, shared by `mergeStoresForWriteback` and
 * `collapseExpandedStores`. `rawValue` (fresh from disk, unvalidated) counts only
 * if a plain object; `typed` had unknown `forbid` categories dropped at load.
 * - Nested unknown raw keys survive (one-level merge).
 * - The raw `forbid` is restored verbatim, so newer categories are never erased,
 *   unless `authoritative` (server policy just synced from `/me`): typed wins.
 * - No typed value: the raw value is kept.
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
