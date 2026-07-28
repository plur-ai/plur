/**
 * Non-blocking version check against npm registry.
 * Caches result in memory — one fetch per process lifetime.
 * Never throws or blocks startup.
 */

export interface VersionCheckResult {
  current: string
  latest: string | null
  updateAvailable: boolean
  checkedAt: number | null
}

/** Module-level cache: package name → result */
const cache = new Map<string, VersionCheckResult>()

/** Checks that have been started but have not yet written their result. */
const inflight = new Set<Promise<VersionCheckResult>>()

/**
 * Wait for every in-flight check to finish writing to the cache.
 *
 * `checkForUpdate` is called fire-and-forget from server startup, so its write
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
 * Check npm for a newer version. Fetches once, caches forever (process lifetime).
 * Fire-and-forget: call at startup, read later via getCachedUpdateCheck().
 */
export function checkForUpdate(
  packageName: string,
  currentVersion: string,
  onResult?: (result: VersionCheckResult) => void,
): Promise<VersionCheckResult> {
  const p = runCheck(packageName, currentVersion, onResult)
  inflight.add(p)
  // `runCheck` swallows its own errors, so neither arm can reject here; both are
  // supplied anyway so a future change cannot turn this into an unhandled
  // rejection.
  const done = () => { inflight.delete(p) }
  p.then(done, done)
  return p
}

async function runCheck(
  packageName: string,
  currentVersion: string,
  onResult?: (result: VersionCheckResult) => void,
): Promise<VersionCheckResult> {
  // Return cached result if available
  const cached = cache.get(packageName)
  if (cached) {
    if (onResult) onResult(cached)
    return cached
  }

  const result: VersionCheckResult = { current: currentVersion, latest: null, updateAvailable: false, checkedAt: null }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    clearTimeout(timeout)
    if (!res.ok) { cache.set(packageName, result); return result }
    const data = await res.json() as { version?: string }
    if (!data.version) { cache.set(packageName, result); return result }
    result.latest = data.version
    result.updateAvailable = isNewer(data.version, currentVersion)
    result.checkedAt = Date.now()
  } catch {
    // Network error, timeout, offline — cache the negative result
  }
  cache.set(packageName, result)
  if (onResult) onResult(result)
  return result
}

/**
 * Read the cached version check result. Returns null if checkForUpdate() hasn't
 * completed yet. This is the zero-cost read path for assemblers.
 */
export function getCachedUpdateCheck(packageName: string): VersionCheckResult | null {
  return cache.get(packageName) ?? null
}

/** Clear cache (for testing). */
export function clearVersionCache(): void {
  cache.clear()
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
