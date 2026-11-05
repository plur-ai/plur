/**
 * Non-blocking npm-registry version check; never throws or blocks.
 * - `latest` comes from the user's own npm (npm-latest.ts). When the registry
 *   gives no usable answer the result carries `failure` and `latest: null`.
 * - With `cacheFile` the answer is also kept on disk with the same TTLs; a
 *   failure read from disk never marks this process offline.
 * - The first attempt that cannot connect marks the process offline; then no
 *   request is made at all (an error response counts as reachable). offline.ts
 *   switches stop even the first attempt.
 * - TTL cache: VERSION_CHECK_SUCCESS_TTL_MS for OK answers,
 *   VERSION_CHECK_FAILURE_TTL_MS otherwise. Reads are synchronous: an expired
 *   entry is returned while a background refresh runs (unless offline).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { updateCheckDisabledByEnv, markOffline, offlineInferred, _resetInferredOffline } from './offline.js'
import { npmLatest, UNKNOWN_REGISTRY } from './npm-latest.js'

/** Why the registry gave no usable answer. */
export interface UpdateCheckFailure {
  /** host[:port] of the registry npm used, or a plain phrase when unknown. */
  registry: string
  reason: string
}

export interface VersionCheckResult {
  current: string
  latest: string | null
  updateAvailable: boolean
  checkedAt: number | null
  /** Set when the registry could not be reached or gave no usable answer. */
  failure?: UpdateCheckFailure
}

export interface CheckForUpdateOptions {
  /** Also keep the answer in this JSON file, shared across processes. Passing
   *  options without it stops any earlier file from being read or written. */
  cacheFile?: string
}

/** The one sentence every caller prints for a failed check; null when it did not fail. */
export function formatUpdateCheckFailure(r: { failure?: UpdateCheckFailure } | null | undefined): string | null {
  if (!r?.failure) return null
  return `Could not reach ${r.failure.registry} to check for updates (${r.failure.reason}). No update is advertised.`
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

// When a check could not connect the network is down for this
// process: the shared offline state (offline.ts) is set, the update checker
// makes no further attempt for any package, and the model loader downloads
// nothing.

/** True once this process inferred it is offline. */
export function updateCheckOffline(): boolean {
  return offlineInferred()
}

/** In-flight check per package — concurrent refresh requests piggyback. */
const inflightByPackage = new Map<string, Promise<VersionCheckResult>>()

/** The disk cache file each package was checked with, so refreshes keep using it. */
const cacheFileByPackage = new Map<string, string>()

interface DiskEntry { latest: string | null; ok: boolean; fetchedAt: number; failure?: UpdateCheckFailure }

function readDisk(file: string, packageName: string): DiskEntry | null {
  try {
    const e = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, DiskEntry>)?.[packageName]
    if (!e || typeof e.fetchedAt !== 'number' || typeof e.ok !== 'boolean') return null
    if (e.ok && typeof e.latest !== 'string') return null
    return e
  } catch {
    return null
  }
}

/** Write-to-temp then rename, so a reader never sees half a file. */
function writeDisk(file: string, packageName: string, e: DiskEntry): void {
  try {
    let all: Record<string, DiskEntry> = {}
    try { all = JSON.parse(readFileSync(file, 'utf8')) ?? {} } catch { /* new file */ }
    all[packageName] = e
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n')
    renameSync(tmp, file)
  } catch {
    // An unwritable cache only costs a lookup on the next start.
  }
}

function resultFromDisk(e: DiskEntry, currentVersion: string): VersionCheckResult {
  return e.ok && e.latest
    ? { current: currentVersion, latest: e.latest, updateAvailable: isNewer(e.latest, currentVersion), checkedAt: e.fetchedAt }
    : { current: currentVersion, latest: null, updateAvailable: false, checkedAt: null, ...(e.failure ? { failure: e.failure } : {}) }
}

/** Checks that have been started but have not yet written their result. */
const inflight = new Set<Promise<VersionCheckResult>>()

function isExpired(entry: CacheEntry, now: number): boolean {
  const ttl = entry.ok ? VERSION_CHECK_SUCCESS_TTL_MS : VERSION_CHECK_FAILURE_TTL_MS
  return now - entry.fetchedAt >= ttl
}

/**
 * Wait for every in-flight check to finish writing to the cache.
 *
 * `checkForUpdate` may be started without being awaited, so its write to the
 * module-level cache lands at an arbitrary later point, possibly after the
 * caller has gone away. Tests that start one check per test call this so a
 * check from one test cannot overwrite the cache fixture of the next.
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
  options?: CheckForUpdateOptions,
): Promise<VersionCheckResult> {
  if (options) {
    if (options.cacheFile) cacheFileByPackage.set(packageName, options.cacheFile)
    else cacheFileByPackage.delete(packageName)
  }
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
  // supplied anyway so this can never become an unhandled rejection.
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
  // and nothing cached, so a later read cannot start a refresh either.
  if (updateCheckDisabledByEnv()) {
    const skipped: VersionCheckResult = { current: currentVersion, latest: null, updateAvailable: false, checkedAt: null }
    if (onResult) onResult(skipped)
    return skipped
  }

  // Return the cached result while fresh; expired entries are re-fetched.
  // Offline: never fetch again; answer from the cache, or with nothing.
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

  // A fresh answer on disk (another process, or an earlier start) is used
  // without a lookup; a failure read from there does not mark this process offline.
  const cacheFile = cacheFileByPackage.get(packageName)
  const disk = cacheFile ? readDisk(cacheFile, packageName) : null
  if (disk && (!entry || disk.fetchedAt > entry.fetchedAt)) {
    const fromDisk: CacheEntry = { result: resultFromDisk(disk, currentVersion), fetchedAt: disk.fetchedAt, ok: disk.ok }
    if (!isExpired(fromDisk, Date.now())) {
      cache.set(packageName, fromDisk)
      if (onResult) onResult(fromDisk.result)
      return fromDisk.result
    }
  }

  const result: VersionCheckResult = { current: currentVersion, latest: null, updateAvailable: false, checkedAt: null }
  let ok = false
  try {
    const r = await npmLatest(packageName)
    if (r.state === 'ok') {
      result.latest = r.version
      result.updateAvailable = isNewer(r.version, currentVersion)
      result.checkedAt = Date.now()
      ok = true
    } else {
      result.failure = { registry: r.registry, reason: r.reason }
      // Could not connect: this process is offline and makes no further
      // update-check request. A registry that answered is reachable.
      if (r.state === 'unreachable' && r.connectFailure) markOffline()
    }
  } catch {
    // npmLatest never throws; this keeps startup safe if that ever changes.
    result.failure = { registry: UNKNOWN_REGISTRY, reason: 'the check failed' }
  }
  const fetchedAt = Date.now()
  cache.set(packageName, { result, fetchedAt, ok })
  if (cacheFile) writeDisk(cacheFile, packageName, { latest: result.latest, ok, fetchedAt, ...(result.failure ? { failure: result.failure } : {}) })
  if (onResult) onResult(result)
  return result
}

/**
 * Read the cached version check result. Returns null if checkForUpdate() hasn't
 * completed yet. This is the zero-cost read path for assemblers and tools.
 *
 * When the cached entry has outlived its TTL a background refresh is started
 * so the NEXT read sees fresh data; the current read still returns
 * synchronously with the stale value and never waits on the network. Offline,
 * no refresh is started.
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
  cacheFileByPackage.clear()
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
