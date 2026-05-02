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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  now?: () => Date
}

function defaultCountersPath(): string {
  return join(homedir(), '.plur', 'telemetry-counters.json')
}

function defaultInstallIdPath(): string {
  return join(homedir(), '.plur', 'install-id')
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

function rolloverIfNeeded(stored: StoredCounters | null, today: string): StoredCounters {
  if (!stored || stored.date !== today) return freshCounters(today)
  return stored
}

export function recordEvent(event: CounterEvent, opts: CountersOpts = {}): void {
  if (!isTelemetryEnabled(gateOpts(opts))) return

  const countersPath = opts.countersPath ?? defaultCountersPath()
  const installIdPath = opts.installIdPath ?? defaultInstallIdPath()
  const now = (opts.now ?? (() => new Date()))()
  const today = utcDate(now)

  readOrCreateInstallId(installIdPath)

  const current = rolloverIfNeeded(readStoredCounters(countersPath), today)
  const sessionAlreadyCounted = current.date === today && current.session > 0

  if (event === 'learn') current.learn += 1
  else if (event === 'recall') current.recall += 1
  else if (event === 'session') current.session += 1

  if ((event === 'learn' || event === 'recall') && !sessionAlreadyCounted) {
    current.session += 1
  }

  atomicWriteJson(countersPath, current)
}

export function getCounters(opts: CountersOpts = {}): CounterSnapshot | null {
  if (!isTelemetryEnabled(gateOpts(opts))) return null

  const countersPath = opts.countersPath ?? defaultCountersPath()
  const installIdPath = opts.installIdPath ?? defaultInstallIdPath()
  const now = (opts.now ?? (() => new Date()))()
  const today = utcDate(now)

  const installId = readOrCreateInstallId(installIdPath)
  const stored = rolloverIfNeeded(readStoredCounters(countersPath), today)

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
