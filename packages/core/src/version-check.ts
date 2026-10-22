/**
 * Non-blocking version check against the npm registry. Never throws or
 * blocks startup.
 *
 * TEAM-5 (owner decision 2026-10-19): with no internet at all PLUR tries the
 * network at most once, with this check, and when that cannot connect it
 * assumes it is offline. So the first attempt that fails to connect (a
 * network error or a timeout) marks the process offline, and from then on the
 * update checker makes no request of any kind: not on the periodic re-check,
 * not on a refresh-on-read, not on an explicit check. Those answer from the
 * cache (or with nothing). A registry that answers with an error is reachable,
 * so that is not offline. The offline switches (offline.ts) stop even the
 * first attempt.
 *
 * Results are cached in memory with a TTL (#760): a successful registry
 * answer is reused for VERSION_CHECK_SUCCESS_TTL_MS, a non-OK answer only for
 * VERSION_CHECK_FAILURE_TTL_MS. Without the TTL a long-lived MCP server
 * process that started while current cached "no update" forever and never
 * learned about releases published after startup (the #760 report).
 *
 * Reads stay synchronous and zero-cost: an expired entry is returned as-is
 * while a background refresh is kicked off (unless offline), so no caller
 * ever waits on the network.
 */

import { updateCheckDisabledByEnv, markOffline, offlineInferred, _resetInferredOffline } from './offline.js'

export interface VersionCheckResult {
  current: string
  latest: string | null
  updateAvailable: boolean
  checkedAt: number | null
}

/** Reuse a successful registry answer for this long before re-checking. */
export const VERSION_CHECK_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

/** Retry a failed attempt (offline, timeout) after this long. */
export const VERSION_CHECK_FAILURE_TTL_MS = 30 * 60 * 1000 // 30 minutes

interface CacheEntry {
  result: VersionCheckResult
  /** When the fetch attempt finished (success or failure) — drives the TTL. */
  fetchedAt: number
  /** Whether the registry answered with a usable version. */
  ok: boolean
}

/** Module-level cache: package name → entry */
const cache = new Map<string, CacheEntry>()

// When a check could not connect (TEAM-5) the network is down for this
// process: the shared offline state (offline.ts) is set, the update checker
// makes no further attempt for any package, and the model loader downloads
// nothing.

/** True once this process inferred it is offline (TEAM-5). */
export function updateCheckOffline(): boolean {
  return offlineInferred()
}

/** In-flight check per package — concurrent refresh requests piggyback. */
const inflightByPackage = new Map<string, Promise<VersionCheckResult>>()

/** Checks that have been started but have not yet written their result. */
const inflight = new Set<Promise<VersionCheckResult>>()

function isExpired(entry: CacheEntry, now: number): boolean {
  const ttl = entry.ok ? VERSION_CHECK_SUCCESS_TTL_MS : VERSION_CHECK_FAILURE_TTL_MS
  return now - entry.fetchedAt >= ttl
}

/**
 * Wait for every in-flight check to finish writing to the cache.
 *
 * `checkForUpdate` may be started without being awaited, so its write
 * to the module-level cache lands at an arbitrary later point — including after
 * the caller that started it has gone away. In a process that only ever starts
 * one server that is harmless. In a test file that starts one per test it is
 * not: a check started by test N resolves during test N+1 and overwrites the
 * cache that test N+1 had just set up, so an assertion about staleness
 * intermittently sees the real registry's answer instead of its own fixture.
 *
 * The failure is invisible in isolation and only appears under load, which is
 * the worst shape a test failure can have — it reads as flake and gets retried
 * away. This gives callers a way to say "let the background work land first"
 * instead of hoping.
 */
export async function settleVersionChecks(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight])
}

/**
 * Check npm for a newer version. Returns the cached result while it is within
 * its TTL, or whenever the process is offline; otherwise fetches and refreshes
 * the cache. Fire-and-forget: call at startup, read later via
 * getCachedUpdateCheck().
 */
export function checkForUpdate(
  packageName: string,
  currentVersion: string,
  onResult?: (result: VersionCheckResult) => void,
): Promise<VersionCheckResult> {
  // Piggyback on an already-running check for the same package instead of
  // issuing a duplicate fetch (refresh-on-read, the periodic re-check and an
  // explicit request can otherwise race each other).
  const running = inflightByPackage.get(packageName)
  const p = running
    ? running.then((r) => { if (onResult) onResult(r); return r })
    : runCheck(packageName, currentVersion, onResult)
  if (!running) inflightByPackage.set(packageName, p)
  inflight.add(p)
  // `runCheck` swallows its own errors, so neither arm can reject here; both are
  // supplied anyway so a future change cannot turn this into an unhandled
  // rejection.
  const done = () => {
    inflight.delete(p)
    if (inflightByPackage.get(packageName) === p) inflightByPackage.delete(packageName)
  }
  p.then(done, done)
  return p
}

async function runCheck(
  packageName: string,
  currentVersion: string,
  onResult?: (result: VersionCheckResult) => void,
): Promise<VersionCheckResult> {
  // Offline, or the check turned off (offline.ts): no request of any kind,
  // and nothing cached, so a later read cannot start a refresh either (TEAM-5).
  if (updateCheckDisabledByEnv()) {
    const skipped: VersionCheckResult = { current: currentVersion, latest: null, updateAvailable: false, checkedAt: null }
    if (onResult) onResult(skipped)
    return skipped
  }

  // Return cached result while fresh (#760: expired entries are re-fetched,
  // not returned forever). Offline (TEAM-5): never fetch again; answer from
  // the cache, or with nothing.
  const entry = cache.get(packageName)
  if (offlineInferred()) {
    const result = entry?.result ?? { current: currentVersion, latest: null, updateAvailable: false, checkedAt: null }
    if (onResult) onResult(result)
    return result
  }
  if (entry && !isExpired(entry, Date.now())) {
    if (onResult) onResult(entry.result)
    return entry.result
  }

  const result: VersionCheckResult = { current: currentVersion, latest: null, updateAvailable: false, checkedAt: null }
  let ok = false
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    clearTimeout(timeout)
    if (res.ok) {
      const data = await res.json() as { version?: string }
      if (data.version) {
        result.latest = data.version
        result.updateAvailable = isNewer(data.version, currentVersion)
        result.checkedAt = Date.now()
        ok = true
      }
    }
  } catch {
    // Network error or timeout: the check could not connect, so this process
    // is offline and makes no further update-check request (TEAM-5).
    markOffline()
  }
  cache.set(packageName, { result, fetchedAt: Date.now(), ok })
  if (onResult) onResult(result)
  return result
}

/**
 * Read the cached version check result. Returns null if checkForUpdate() hasn't
 * completed yet. This is the zero-cost read path for assemblers and tools.
 *
 * When the cached entry has outlived its TTL a background refresh is started
 * (#760) so the NEXT read sees fresh data; the current read still returns
 * synchronously with the stale value and never waits on the network. Offline
 * (TEAM-5), no refresh is started.
 */
export function getCachedUpdateCheck(packageName: string): VersionCheckResult | null {
  const entry = cache.get(packageName)
  if (!entry) return null
  if (!offlineInferred() && isExpired(entry, Date.now()) && !inflightByPackage.has(packageName)) {
    checkForUpdate(packageName, entry.result.current)
  }
  return entry.result
}

/** Clear cache (for testing). */
export function clearVersionCache(): void {
  cache.clear()
  _resetInferredOffline()
  inflightByPackage.clear()
}

/** Count how many minor versions behind `current` is from `latest`. Returns 0 if current >= latest. */
export function minorVersionsBehind(current: string, latest: string): number {
  const pa = current.split('.').map(Number)
  const pb = latest.split('.').map(Number)
  if ((pa[0] ?? 0) < (pb[0] ?? 0)) {
    // Different major — treat as very stale
    return ((pb[0] ?? 0) - (pa[0] ?? 0)) * 10 + (pb[1] ?? 0)
  }
  if ((pa[0] ?? 0) > (pb[0] ?? 0)) return 0
  // Same major
  const diff = (pb[1] ?? 0) - (pa[1] ?? 0)
  return diff > 0 ? diff : 0
}

/** True if a is newer than b (simple semver comparison). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return false
}
