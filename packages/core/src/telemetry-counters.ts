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
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { isTelemetryEnabled } from './telemetry.js'
import { atomicWrite, withLock, fsyncDir } from './sync.js'

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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Also retry an earlier failed directory sync: existence is not durability.
  fsyncDir(dir)
}

function atomicWriteJson(path: string, data: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The canonical writer syncs the complete ancestry after replacement.
  atomicWrite(path, JSON.stringify(data), { mode: 0o600 })
}

export function telemetryQueuePath(opts: CountersOpts): string {
  return join(opts.pendingDir ?? defaultPendingDir(), '.queue')
}

export function prepareTelemetryQueue(opts: CountersOpts): string {
  const path = telemetryQueuePath(opts)
  ensureParentDir(path)
  return path
}

function withTelemetryLock<T>(opts: CountersOpts, fn: () => T): T {
  const path = telemetryQueuePath(opts)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return withLock(path, fn)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function validDate(date: unknown): date is string {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0000')
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
}

export function readOrCreateInstallId(path: string): string {
  ensureParentDir(path)
  return withLock(path, () => {
    let raw: string
    try { raw = readFileSync(path, 'utf8').trim() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const id = randomUUID()
      atomicWrite(path, id, { mode: 0o600 })
      return id
    }
    if (!UUID.test(raw)) throw new Error('Invalid telemetry install identity; existing data preserved')
    return raw
  })
}

type StoredCounters = {
  date: string
  learn: number
  recall: number
  session: number
  _rolloverId?: string
  _applied?: string[]
  _deliveryId?: string
  _wireIdentity?: DeliveryIdentity
  _deliveryCounters?: Pick<StoredCounters, 'date' | 'learn' | 'recall' | 'session'>
}

type DeliveryIdentity = { installId: string; version: string; platform: NodeJS.Platform }

function readStoredCounters(path: string): StoredCounters | null {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Cannot read telemetry counters; existing data preserved')
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !validDate(parsed.date)
      || !['learn', 'recall', 'session'].every(key => Number.isSafeInteger(parsed[key]) && parsed[key] >= 0)
      || ['_rolloverId', '_deliveryId'].some(key => parsed[key] !== undefined && (typeof parsed[key] !== 'string' || !UUID.test(parsed[key])))
      || (parsed._applied !== undefined && (!Array.isArray(parsed._applied) || !parsed._applied.every((v: unknown) => typeof v === 'string' && UUID.test(v))))
      || (parsed._deliveryCounters !== undefined && (!parsed._deliveryCounters
        || parsed._deliveryCounters.date !== parsed.date
        || !['_deliveryId', '_wireIdentity'].every(key => parsed[key] !== undefined)
        || !['learn', 'recall', 'session'].every(key => Number.isSafeInteger(parsed._deliveryCounters[key])
          && parsed._deliveryCounters[key] >= 0 && parsed._deliveryCounters[key] <= parsed[key])))
      || (parsed._wireIdentity !== undefined && (!parsed._wireIdentity || !UUID.test(parsed._wireIdentity.installId)
        || typeof parsed._wireIdentity.version !== 'string' || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(parsed._wireIdentity.version)
        || !['linux', 'darwin', 'win32'].includes(parsed._wireIdentity.platform)))) throw new Error('invalid')
    return parsed as StoredCounters
  } catch {
    throw new Error('Invalid telemetry counters; existing data preserved')
  }
}

function countsOnly(stored: StoredCounters): StoredCounters {
  const { date, learn, recall, session } = stored
  return { date, learn, recall, session }
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

function moveToPending(stored: StoredCounters, pendingDir: string, countersPath: string): void {
  // Persist a stable transfer identity BEFORE touching the destination. A
  // retry after either replacement reuses it instead of summing twice.
  if (!stored._rolloverId) {
    stored = { ...stored, _rolloverId: randomUUID() }
    atomicWriteJson(countersPath, stored)
  }
  const path = join(pendingDir, `${stored.date}.json`)
  const existing = readStoredCounters(path)
  if (existing && existing.date !== stored.date) throw new Error('Telemetry pending date mismatch')
  if (existing?._applied?.includes(stored._rolloverId!)) return
  const merged: StoredCounters = {
    ...existing,
    date: stored.date,
    learn: (existing?.learn ?? 0) + stored.learn,
    recall: (existing?.recall ?? 0) + stored.recall,
    session: Math.max(existing?.session ?? 0, stored.session),
    _applied: [...(existing?._applied ?? []), stored._rolloverId!],
    _deliveryId: existing?._deliveryId ?? randomUUID(),
  }
  if (![merged.learn, merged.recall, merged.session].every(Number.isSafeInteger)) throw new Error('Telemetry counter limit exceeded')
  atomicWriteJson(path, merged)
}

export function recordEvent(event: CounterEvent, opts: CountersOpts = {}): boolean {
  if (!isTelemetryEnabled(gateOpts(opts))) return false
  return withTelemetryLock(opts, () => recordEventLocked(event, opts))
}

function recordEventLocked(event: CounterEvent, opts: CountersOpts = {}): boolean {
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
  if (stored && (stored.date !== today || stored._rolloverId)) {
    // Rollover: preserve yesterday's snapshot in pending-dir BEFORE overwriting
    // counters.json with today's fresh state. This is the load-bearing fix for
    // #128 — without it, a long-lived process emitting an event after midnight
    // would silently discard yesterday's counts.
    moveToPending(stored, pendingDir, countersPath)
    current = freshCounters(today)
    rolledOver = true
  } else {
    current = stored ?? freshCounters(today)
  }
  if (current._rolloverId) throw new Error('Telemetry rollover is incomplete; retry using the later date before recording')
  const sessionAlreadyCounted = current.session > 0

  if (event === 'learn') current.learn += 1
  else if (event === 'recall') current.recall += 1
  else if (event === 'session') current.session += 1

  if ((event === 'learn' || event === 'recall') && !sessionAlreadyCounted) {
    current.session += 1
  }

  if (![current.learn, current.recall, current.session].every(Number.isSafeInteger)) throw new Error('Telemetry counter limit exceeded')
  atomicWriteJson(countersPath, current)
  return rolledOver
}

// Pending-flush directory helpers (#128). flushIfNeeded uses these to drain
// per-day snapshots that recordEvent stashed on rollover.

export function listPendingDates(opts: CountersOpts = {}): string[] {
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  try {
    return readdirSync(pendingDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, -5)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Cannot list pending telemetry; existing data preserved')
  }
}

function pendingPath(date: string, opts: CountersOpts): string {
  if (!validDate(date)) throw new Error('Invalid pending telemetry date')
  return join(opts.pendingDir ?? defaultPendingDir(), `${date}.json`)
}

export function readPendingCounters(date: string, opts: CountersOpts = {}): StoredCounters | null {
  const stored = readStoredCounters(pendingPath(date, opts))
  if (stored && stored.date !== date) throw new Error('Telemetry pending date mismatch')
  return stored && countsOnly(stored)
}

export type PendingDelivery = { counters: StoredCounters; id: string; identity: DeliveryIdentity }
export function readPendingDelivery(date: string, opts: CountersOpts, identity: DeliveryIdentity): PendingDelivery | null {
  return withTelemetryLock(opts, () => {
    const path = pendingPath(date, opts)
    const stored = readStoredCounters(path)
    if (!stored) return null
    if (stored.date !== date) throw new Error('Telemetry pending date mismatch')
    if (!stored._deliveryId || !stored._wireIdentity || !stored._deliveryCounters) {
      stored._deliveryId ??= randomUUID()
      stored._wireIdentity ??= identity
      // Freeze the exact acknowledged prefix before sending. New counts can
      // arrive while a response is lost, or before local acknowledgement.
      stored._deliveryCounters ??= countsOnly(stored)
      atomicWriteJson(path, stored)
    }
    return { counters: countsOnly(stored._deliveryCounters), id: stored._deliveryId, identity: stored._wireIdentity }
  })
}

export function deletePending(date: string, opts: CountersOpts, sent: PendingDelivery): void {
  withTelemetryLock(opts, () => {
    const path = pendingPath(date, opts)
    const current = readStoredCounters(path)
    if (!current) return
    if (current._deliveryId !== sent.id) throw new Error('Pending telemetry identity changed; data preserved')
    if ((['learn', 'recall', 'session'] as const).every(key => current[key] === sent.counters[key])) {
      unlinkSync(path)
      fsyncDir(dirname(path))
      return
    }
    // New rollover counts arrived during the request. Remove only the
    // acknowledged prefix and give the retained remainder a new identity.
    const next = { ...current, _deliveryId: randomUUID(), _deliveryCounters: undefined, _wireIdentity: undefined }
    for (const key of ['learn', 'recall', 'session'] as const) {
      if (next[key] < sent.counters[key]) throw new Error('Pending telemetry changed incompatibly; data preserved')
      next[key] -= sent.counters[key]
    }
    atomicWriteJson(path, next)
  })
}

// Migration helper: if counters.json holds a stale date (e.g. upgrade from a
// pre-#128 install), shunt it into pending-dir so flushIfNeeded picks it up.
// Returns true when migration ran.
export function migrateStaleCounters(opts: CountersOpts = {}): boolean {
  if (!isTelemetryEnabled(gateOpts(opts))) return false
  return withTelemetryLock(opts, () => migrateStaleCountersLocked(opts))
}

function migrateStaleCountersLocked(opts: CountersOpts): boolean {
  if (!isTelemetryEnabled(gateOpts(opts))) return false
  const countersPath = opts.countersPath ?? defaultCountersPath()
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  const now = (opts.now ?? (() => new Date()))()
  const today = utcDate(now)
  const stored = readStoredCounters(countersPath)
  if (!stored || (stored.date >= today && !stored._rolloverId)) return false
  moveToPending(stored, pendingDir, countersPath)
  atomicWriteJson(countersPath, freshCounters(today))
  return true
}

export function getCounters(opts: CountersOpts = {}): CounterSnapshot | null {
  if (!isTelemetryEnabled(gateOpts(opts))) return null
  return withTelemetryLock(opts, () => getCountersLocked(opts))
}

function getCountersLocked(opts: CountersOpts): CounterSnapshot | null {
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
  return withTelemetryLock(opts, () => resetCountersLocked(opts))
}

function resetCountersLocked(opts: CountersOpts): CounterSnapshot | null {
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
