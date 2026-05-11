// Per-event counters for telemetry (slice D-2a of #51).
//
// Pure file-local plumbing: increment hooks at plur_learn / plur_recall_hybrid
// success persist to ~/.plur/telemetry-counters.json. NO network code lives here;
// transport is D-2b's territory and imports getCounters/resetCounters from this
// module.
//
// Privacy invariant: every public function MUST short-circuit on
// !isTelemetryEnabled() BEFORE any filesystem call. A default-off install must
// produce zero filesystem writes under ~/.plur/ for telemetry. The
// "default-off install touches zero files" test is the load-bearing guard.
//
// Session semantics (silent-ratified default-pick B, 2026-05-02T12:00Z, #51):
// 'session' fires on the first 'learn' or 'recall' recorded within a UTC day.
// No standalone session call site.
//
// Day-rollover safety (#128): on rollover, yesterday's snapshot is moved to a
// pending-flush directory (~/.plur/telemetry-pending/<date>.json) BEFORE
// counters.json is rewritten for today. flushIfNeeded drains that directory.
// Without this, a long-lived process emitting an event after midnight would
// silently overwrite yesterday's data on disk.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { isTelemetryEnabled } from './telemetry.js'

export type CounterEvent = 'learn' | 'recall' | 'session'

export type CounterSnapshot = {
  installId: string
  date: string
  learn: number
  recall: number
  session: number
}

export type CountersOpts = {
  env?: NodeJS.ProcessEnv
  configPath?: string
  countersPath?: string
  installIdPath?: string
  pendingDir?: string
  now?: () => Date
}

function defaultCountersPath(): string {
  return join(homedir(), '.plur', 'telemetry-counters.json')
}

function defaultInstallIdPath(): string {
  return join(homedir(), '.plur', 'install-id')
}

function defaultPendingDir(): string {
  return join(homedir(), '.plur', 'telemetry-pending')
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function gateOpts(opts: CountersOpts): { env?: NodeJS.ProcessEnv; configPath?: string } {
  return { env: opts.env, configPath: opts.configPath }
}

function ensureParentDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureParentDir(path)
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

function atomicWriteString(path: string, data: string): void {
  ensureParentDir(path)
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

function readOrCreateInstallId(path: string): string {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim()
    if (raw.length > 0) return raw
  }
  const id = randomUUID()
  atomicWriteString(path, id)
  return id
}

type StoredCounters = {
  date: string
  learn: number
  recall: number
  session: number
}

function readStoredCounters(path: string): StoredCounters | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.date === 'string' &&
      typeof parsed.learn === 'number' &&
      typeof parsed.recall === 'number' &&
      typeof parsed.session === 'number'
    ) {
      return parsed as StoredCounters
    }
    return null
  } catch {
    return null
  }
}

function freshCounters(date: string): StoredCounters {
  return { date, learn: 0, recall: 0, session: 0 }
}

// Synthesize a today-dated snapshot for callers that just want a current-day
// view (getCounters). Never used by recordEvent — recordEvent moves stale
// state to pending-dir before defaulting to fresh.
function viewAsToday(stored: StoredCounters | null, today: string): StoredCounters {
  if (!stored || stored.date !== today) return freshCounters(today)
  return stored
}

function moveToPending(stored: StoredCounters, pendingDir: string): void {
  const path = join(pendingDir, `${stored.date}.json`)
  // If a pending file already exists for this date (e.g. multiple processes
  // each detected the same rollover), merge counts so we don't double-count
  // OR drop the smaller snapshot.
  const existing = readStoredCounters(path)
  const merged: StoredCounters =
    existing && existing.date === stored.date
      ? {
          date: stored.date,
          learn: existing.learn + stored.learn,
          recall: existing.recall + stored.recall,
          session: Math.max(existing.session, stored.session),
        }
      : stored
  atomicWriteJson(path, merged)
}

export function recordEvent(event: CounterEvent, opts: CountersOpts = {}): boolean {
  if (!isTelemetryEnabled(gateOpts(opts))) return false

  const countersPath = opts.countersPath ?? defaultCountersPath()
  const installIdPath = opts.installIdPath ?? defaultInstallIdPath()
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  const now = (opts.now ?? (() => new Date()))()
  const today = utcDate(now)

  readOrCreateInstallId(installIdPath)

  const stored = readStoredCounters(countersPath)
  let current: StoredCounters
  let rolledOver = false
  if (stored && stored.date !== today) {
    // Rollover: preserve yesterday's snapshot in pending-dir BEFORE overwriting
    // counters.json with today's fresh state. This is the load-bearing fix for
    // #128 — without it, a long-lived process emitting an event after midnight
    // would silently discard yesterday's counts.
    moveToPending(stored, pendingDir)
    current = freshCounters(today)
    rolledOver = true
  } else {
    current = stored ?? freshCounters(today)
  }
  const sessionAlreadyCounted = current.session > 0

  if (event === 'learn') current.learn += 1
  else if (event === 'recall') current.recall += 1
  else if (event === 'session') current.session += 1

  if ((event === 'learn' || event === 'recall') && !sessionAlreadyCounted) {
    current.session += 1
  }

  atomicWriteJson(countersPath, current)
  return rolledOver
}

// Pending-flush directory helpers (#128). flushIfNeeded uses these to drain
// per-day snapshots that recordEvent stashed on rollover.

export function listPendingDates(opts: CountersOpts = {}): string[] {
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  if (!existsSync(pendingDir)) return []
  try {
    return readdirSync(pendingDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, -5))
      .sort()
  } catch {
    return []
  }
}

export function readPendingCounters(date: string, opts: CountersOpts = {}): StoredCounters | null {
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  return readStoredCounters(join(pendingDir, `${date}.json`))
}

export function deletePending(date: string, opts: CountersOpts = {}): void {
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  try {
    unlinkSync(join(pendingDir, `${date}.json`))
  } catch {
    /* ignore — already gone */
  }
}

// Migration helper: if counters.json holds a stale date (e.g. upgrade from a
// pre-#128 install), shunt it into pending-dir so flushIfNeeded picks it up.
// Returns true when migration ran.
export function migrateStaleCounters(opts: CountersOpts = {}): boolean {
  if (!isTelemetryEnabled(gateOpts(opts))) return false
  const countersPath = opts.countersPath ?? defaultCountersPath()
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  const now = (opts.now ?? (() => new Date()))()
  const today = utcDate(now)
  const stored = readStoredCounters(countersPath)
  if (!stored || stored.date >= today) return false
  moveToPending(stored, pendingDir)
  atomicWriteJson(countersPath, freshCounters(today))
  return true
}

export function getCounters(opts: CountersOpts = {}): CounterSnapshot | null {
  if (!isTelemetryEnabled(gateOpts(opts))) return null

  const countersPath = opts.countersPath ?? defaultCountersPath()
  const installIdPath = opts.installIdPath ?? defaultInstallIdPath()
  const now = (opts.now ?? (() => new Date()))()
  const today = utcDate(now)

  const installId = readOrCreateInstallId(installIdPath)
  const stored = viewAsToday(readStoredCounters(countersPath), today)

  return {
    installId,
    date: stored.date,
    learn: stored.learn,
    recall: stored.recall,
    session: stored.session,
  }
}

export function resetCounters(opts: CountersOpts = {}): CounterSnapshot | null {
  if (!isTelemetryEnabled(gateOpts(opts))) return null

  const countersPath = opts.countersPath ?? defaultCountersPath()
  const installIdPath = opts.installIdPath ?? defaultInstallIdPath()
  const now = (opts.now ?? (() => new Date()))()
  const today = utcDate(now)

  const installId = readOrCreateInstallId(installIdPath)
  const fresh = freshCounters(today)
  atomicWriteJson(countersPath, fresh)

  return {
    installId,
    date: fresh.date,
    learn: fresh.learn,
    recall: fresh.recall,
    session: fresh.session,
  }
}
