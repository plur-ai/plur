// Daily flush + POST /v1/heartbeat (slice D-2b of #51).
//
// Imports the gate (`isTelemetryEnabled`) and the counter snapshot
// (`getCounters` / `resetCounters`) from sibling modules. Owns the network.
//
// Privacy invariants (each pinned by a test):
//   1. Default-off install makes zero network calls.
//   2. Telemetry-on but no counter file → zero network calls.
//
// Trigger semantics: flush fires when `snapshot.date < today` (i.e. there is
// *yesterday* data to ship). Two call sites:
//   - lazy: `recordEvent` calls `flushIfNeeded` after the day-rollover write
//   - exit: `registerFlushOnExit` registered from cli startup (best-effort)
// No setInterval, no background polling.
//
// Failure semantics: `sendHeartbeat` never throws. On any failure (network,
// timeout, non-2xx) it returns false; counters stay local and the next
// rollover retries.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isTelemetryEnabled } from './telemetry.js'
import {
  getCounters,
  resetCounters,
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

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

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
  // When countersPath is provided (tests), short-circuit if missing.
  // When unset (production default in telemetry-counters), getCounters will
  // create the install-id file on first read; we still need to short-circuit
  // when there is no counter file yet, which getCounters handles by returning
  // a zero snapshot for today — that snapshot's date === today so we no-op
  // below, never touching the network.
  if (countersPath && !existsSync(countersPath)) return

  const snapshot = getCounters(opts)
  if (!snapshot) return

  const now = (opts.now ?? (() => new Date()))()
  const today = utcDate(now)
  if (snapshot.date >= today) return

  const payload = buildHeartbeatPayload(snapshot, opts)
  const ok = await sendHeartbeat(payload, opts)
  if (ok) resetCounters(opts)
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
