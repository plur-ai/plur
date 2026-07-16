// Daily flush + POST /v1/heartbeat (slice D-2b of #51).
//
// Imports the gate (`isTelemetryEnabled`) and the counter snapshot
// (`getCounters` / `resetCounters`) from sibling modules. Owns the network.
//
// Privacy invariants (each pinned by a test):
//   1. Default-off install makes zero network calls.
//   2. Telemetry-on but no counter file → zero network calls.
//
// Trigger semantics: flush drains the pending-flush directory written by
// `recordEvent` on day-rollover (#128). Two call sites:
//   - rollover: `recordEvent` returns `true` from its rollover branch; callers
//     fire `flushIfNeeded` async
//   - exit: `registerFlushOnExit` registered from cli startup (best-effort)
// No setInterval, no background polling.
//
// Failure semantics: `sendHeartbeat` never throws. On any failure (network,
// timeout, non-2xx) it returns false; pending files stay on disk for the next
// rollover or process restart to retry.

import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { isTelemetryEnabled } from './telemetry.js'
import {
  deletePending,
  getCounters,
  listPendingDates,
  migrateStaleCounters,
  readPendingCounters,
  type CounterSnapshot,
  type CountersOpts,
} from './telemetry-counters.js'

export type HeartbeatPayload = {
  install_id: string
  version: string
  platform: NodeJS.Platform
  date: string
  learn_count: number
  recall_count: number
  session_count: number
}

export type FlushOpts = CountersOpts & {
  fetch?: typeof globalThis.fetch
  endpoint?: string
  timeoutMs?: number
  packageVersion?: string
}

const DEFAULT_ENDPOINT = 'https://heartbeat.plur-ai.org/v1/heartbeat'
const DEFAULT_TIMEOUT_MS = 5000

function resolveEndpoint(opts: FlushOpts): string {
  if (opts.endpoint) return opts.endpoint
  const env = opts.env ?? process.env
  return env.PLUR_TELEMETRY_ENDPOINT ?? DEFAULT_ENDPOINT
}

let cachedPackageVersion: string | null = null

function readPackageVersion(): string {
  if (cachedPackageVersion !== null) return cachedPackageVersion
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // src → package root: ../package.json (when running tests against src)
    // dist → package root: ../package.json (when running built)
    const pkgPath = join(here, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    cachedPackageVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    cachedPackageVersion = 'unknown'
  }
  return cachedPackageVersion
}

export function buildHeartbeatPayload(
  snapshot: CounterSnapshot,
  opts: Pick<FlushOpts, 'env' | 'packageVersion'> = {},
): HeartbeatPayload {
  return {
    install_id: snapshot.installId,
    version: opts.packageVersion ?? readPackageVersion(),
    platform: process.platform,
    date: snapshot.date,
    learn_count: snapshot.learn,
    recall_count: snapshot.recall,
    session_count: snapshot.session,
  }
}

export async function sendHeartbeat(
  payload: HeartbeatPayload,
  opts: FlushOpts = {},
): Promise<boolean> {
  const endpoint = resolveEndpoint(opts)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetch ?? globalThis.fetch

  if (!fetchImpl) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function flushIfNeeded(opts: FlushOpts = {}): Promise<void> {
  if (!isTelemetryEnabled({ env: opts.env, configPath: opts.configPath })) return

  const countersPath = opts.countersPath
  // Privacy invariant 2: telemetry-on but no on-disk state → zero network.
  // When countersPath is set (tests), if it's missing AND pending-dir has
  // nothing, we have no data to ship. In production (no countersPath), the
  // pending-dir check below handles the empty case.
  if (countersPath && !existsSync(countersPath) && listPendingDates(opts).length === 0) return

  // Migrate any stale counters.json (e.g. upgrade from pre-#128, or beforeExit
  // firing after midnight on a process that never re-recorded). Adds an entry
  // to pending-dir; the drain loop below ships it.
  migrateStaleCounters(opts)

  // getCounters gives us install_id; we ignore its date/counts and instead
  // ship each pending file as its own heartbeat.
  const baseSnapshot = getCounters(opts)
  if (!baseSnapshot) return

  for (const date of listPendingDates(opts)) {
    const pending = readPendingCounters(date, opts)
    if (!pending) {
      // Malformed or already-removed; drop the file so we don't loop on it.
      deletePending(date, opts)
      continue
    }
    const snapshot: CounterSnapshot = {
      installId: baseSnapshot.installId,
      date: pending.date,
      learn: pending.learn,
      recall: pending.recall,
      session: pending.session,
    }
    const payload = buildHeartbeatPayload(snapshot, opts)
    const ok = await sendHeartbeat(payload, opts)
    if (ok) deletePending(date, opts)
    // On failure, file stays on disk and is retried on next flush.
  }
}

export function registerFlushOnExit(opts: FlushOpts = {}): () => void {
  let fired = false
  const handler = () => {
    if (fired) return
    fired = true
    void flushIfNeeded(opts).catch(() => {})
  }
  process.once('beforeExit', handler)
  return () => {
    process.off('beforeExit', handler)
  }
}
