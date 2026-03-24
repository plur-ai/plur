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

/**
 * Check npm for a newer version. Fetches once, caches forever (process lifetime).
 * Fire-and-forget: call at startup, read later via getCachedUpdateCheck().
 */
export async function checkForUpdate(
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
