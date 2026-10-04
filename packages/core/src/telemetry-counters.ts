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
//
// Cross-process safety (formal verification R2, core-retrieval#7): every
// read-modify-write of counters.json and pending/ runs under ONE lock file
// (`<countersPath>.lock`, the `withLock` from sync.ts). Without it two
// processes reading the same snapshot merged yesterday into pending twice and
// lost same-day increments (replayed: spec/formal/findings/r2-retrieval.md §1).
// A flush CLAIMS a pending file by renaming it (under the same lock) before the
// POST, so a second flusher cannot send it again and a later merge for that date
// lands in a fresh pending file instead of being deleted with the sent one.
// Invariant, per date: shipped + on disk (counters, pending, claims) = recorded.
// If the lock cannot be taken (contended for ~1 s) the event is not written
// unlocked and not dropped: it is written to its own spill file
// (`<countersPath>.spill.<uuid>`, temp name then rename, no lock) and the next
// writer holding the lock, or the flush, folds the spill files in. Telemetry
// still never blocks or fails the tool call, and events are conserved — the
// old drop lost 1 of 160 under load. Spill files count as "on disk" above.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { isTelemetryEnabled } from './telemetry.js'
import { withLock } from './sync.js'
import { holderIsAlive } from './store/async-lock.js'

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

// Unique per call, not just per process (#188): pid-only tmp names collide
// when two writes to the same path interleave in async contexts — the second
// write clobbers the first tmp file before its rename.
function tmpPath(path: string): string {
  return `${path}.tmp.${process.pid}.${randomUUID()}`
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureParentDir(path)
  const tmp = tmpPath(path)
  writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

function atomicWriteString(path: string, data: string): void {
  ensureParentDir(path)
  const tmp = tmpPath(path)
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

// Held for a few file operations only, so retry fast: ~0.5 s of backoff in all.
const COUNTERS_LOCK = { maxRetries: 8, baseDelay: 2 }

// recordEvent runs on the learn and recall path, and `withLock` waits by
// spinning the CPU, so a contended retry ladder blocked the MCP server's event
// loop for up to ~510 ms per event (#1240). A contended event loses nothing by
// spilling (the next lock holder folds it in), so recordEvent makes ONE attempt.
const RECORD_EVENT_LOCK = { maxRetries: 0, baseDelay: 2 }

/**
 * Run `fn` holding the counters lock. `undefined` when the lock could not be
 * taken (fn never ran); an error thrown BY fn propagates as before.
 */
function underCountersLock<T>(
  opts: CountersOpts,
  fn: () => T,
  lockOpts: { maxRetries: number; baseDelay: number } = COUNTERS_LOCK,
): T | undefined {
  const target = opts.countersPath ?? defaultCountersPath()
  let ran = false
  try {
    ensureParentDir(target)
    return withLock(target, () => {
      ran = true
      return fn()
    }, lockOpts)
  } catch (err) {
    if (!ran) return undefined
    throw err
  }
}

export function readOrCreateInstallId(path: string): string {
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
  // If a pending file already exists for this date (a failed flush's claim put
  // back, or counters.json carrying that date again), merge counts so we don't
  // drop either snapshot. Caller holds the counters lock, so the two are
  // disjoint sets of events: two processes can no longer both merge the SAME
  // stale snapshot, which is what this merge used to double-count (#7).
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

/** Where a contended recorder leaves its event for the next lock holder. */
function spillPath(countersPath: string): string {
  return `${countersPath}.spill`
}

/** Leave one event for later folding, as its OWN file: written under a temp
 *  name and renamed into place, so a folder only ever sees complete files and
 *  nothing is ever appended to a file being folded. (A single shared spill
 *  file lost an event: an append that opened the file before the folder
 *  claimed it landed in the claimed copy after it was read.) Never throws. */
function spillEvent(countersPath: string, event: CounterEvent, date: string): void {
  try {
    ensureParentDir(countersPath)
    const id = randomUUID()
    const tmp = `${spillPath(countersPath)}.${id}.tmp`
    writeFileSync(tmp, JSON.stringify({ e: event, d: date }) + '\n', { flag: 'wx' })
    renameSync(tmp, `${spillPath(countersPath)}.${id}`)
  } catch { /* telemetry never fails the caller */ }
}

/**
 * Under the counters lock: every complete spill file (one event each). The
 * caller unlinks them only after counters.json / pending are written.
 */
function claimSpills(countersPath: string): { events: Array<{ e: CounterEvent; d: string }>; claims: string[] } {
  const events: Array<{ e: CounterEvent; d: string }> = []
  const claims: string[] = []
  const dir = dirname(countersPath)
  const prefix = `${spillPath(countersPath).slice(dir.length + 1)}.`
  let names: string[] = []
  try { names = readdirSync(dir).filter(n => n.startsWith(prefix) && !n.endsWith('.tmp')) } catch { return { events, claims } }
  for (const n of names) {
    const path = join(dir, n)
    let raw = ''
    try { raw = readFileSync(path, 'utf8') } catch { continue }
    claims.push(path)
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const v = JSON.parse(line) as { e?: unknown; d?: unknown }
        if ((v.e === 'learn' || v.e === 'recall' || v.e === 'session') && typeof v.d === 'string') {
          events.push({ e: v.e, d: v.d })
        }
      } catch { /* malformed: skip */ }
    }
  }
  return { events, claims }
}

/** Apply one event to a day's counters, with the session rule. */
function applyEvent(c: StoredCounters, event: CounterEvent): void {
  const sessionAlreadyCounted = c.session > 0
  if (event === 'learn') c.learn += 1
  else if (event === 'recall') c.recall += 1
  else if (event === 'session') c.session += 1
  if ((event === 'learn' || event === 'recall') && !sessionAlreadyCounted) c.session += 1
}

/**
 * Fold any spilled events into counters/pending without recording a new one.
 * Called by the flush first, so a quiet process ships what contended recorders
 * left behind. `false` when the lock could not be taken (they stay on disk).
 */
export function settleSpilledEvents(opts: CountersOpts = {}): boolean {
  const countersPath = opts.countersPath ?? defaultCountersPath()
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  return underCountersLock(opts, () => {
    const { events, claims } = claimSpills(countersPath)
    if (events.length === 0) {
      for (const c of claims) { try { unlinkSync(c) } catch { /* gone */ } }
      return true
    }
    // Roll a stale counters.json over FIRST, exactly as recordEvent does (audit
    // of #1228, finding 3). Without it a spill dated today, folded while
    // counters.json still said yesterday, went to pending/<today>.json and was
    // shipped by this very flush — and the events recorded later today shipped
    // again at the next rollover: two heartbeats for one date.
    const today = utcDate((opts.now ?? (() => new Date()))())
    const stored = readStoredCounters(countersPath)
    let current: StoredCounters
    if (stored && stored.date !== today) {
      moveToPending(stored, pendingDir)
      current = freshCounters(today)
    } else {
      // No counters yet (the very first events all contended): today's become
      // counters.json; an earlier day's spills go to that day's pending file.
      current = stored ?? freshCounters(today)
    }
    const byDay = new Map<string, StoredCounters>()
    for (const s of events) {
      if (s.d === current.date) { applyEvent(current, s.e); continue }
      const day = byDay.get(s.d) ?? freshCounters(s.d)
      applyEvent(day, s.e)
      byDay.set(s.d, day)
    }
    atomicWriteJson(countersPath, current)
    for (const day of byDay.values()) moveToPending(day, pendingDir)
    for (const c of claims) { try { unlinkSync(c) } catch { /* gone */ } }
    return true
  }) ?? false
}

export function recordEvent(event: CounterEvent, opts: CountersOpts = {}): boolean {
  if (!isTelemetryEnabled(gateOpts(opts))) return false

  const countersPath = opts.countersPath ?? defaultCountersPath()
  const installIdPath = opts.installIdPath ?? defaultInstallIdPath()
  const pendingDir = opts.pendingDir ?? defaultPendingDir()

  const result = underCountersLock(opts, () => {
    // Read the clock under the lock: a `today` taken before waiting could be
    // yesterday by the time we hold it.
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

    // Fold in events other recorders spilled while this lock was contended:
    // today's into counters.json, an earlier day's into that day's pending file.
    const { events, claims } = claimSpills(countersPath)
    const older = new Map<string, StoredCounters>()
    for (const s of events) {
      if (s.d === current.date) { applyEvent(current, s.e); continue }
      const day = older.get(s.d) ?? freshCounters(s.d)
      applyEvent(day, s.e)
      older.set(s.d, day)
    }
    for (const day of older.values()) moveToPending(day, pendingDir)

    applyEvent(current, event)

    atomicWriteJson(countersPath, current)
    // Only now are the claimed events durable in counters/pending.
    for (const c of claims) { try { unlinkSync(c) } catch { /* already gone */ } }
    return rolledOver
  }, RECORD_EVENT_LOCK)
  if (result === undefined) {
    const now = (opts.now ?? (() => new Date()))()
    spillEvent(countersPath, event, utcDate(now))
    return false
  }
  return result
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
  return underCountersLock(opts, () => {
    const now = (opts.now ?? (() => new Date()))()
    const today = utcDate(now)
    const stored = readStoredCounters(countersPath)
    if (!stored || stored.date >= today) return false
    moveToPending(stored, pendingDir)
    atomicWriteJson(countersPath, freshCounters(today))
    return true
  }) ?? false
}

// ── Flush claims (core-retrieval#7) ────────────────────────────────────────
//
// `claimPending` renames `pending/<date>.json` to
// `pending/<date>.json.sending.<host>.<pid>.<uuid>` under the counters lock.
// The rename is the claim: listPendingDates no longer sees the file, so no
// second flusher sends it, and a rollover merging into <date> meanwhile writes
// a NEW pending file that the next flush ships. After the POST the claim is
// either deleted (sent) or merged back (failed). A claim whose owner process
// is dead (crashed mid-POST) is merged back by the next flush — at-least-once,
// as a pending file left by a crash always was. A claim from another host, or
// whose owner cannot be probed, is left alone (never guessed dead).

export type PendingClaim = { date: string; path: string; counts: StoredCounters | null }

const CLAIM_RE = /^(\d{4}-\d{2}-\d{2})\.json\.sending\.(.+)\.(\d+)\.([0-9a-f-]{36})$/

export function claimPending(date: string, opts: CountersOpts = {}): PendingClaim | null {
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  return underCountersLock(opts, () => {
    const from = join(pendingDir, `${date}.json`)
    const to = join(
      pendingDir,
      `${date}.json.sending.${encodeURIComponent(hostname())}.${process.pid}.${randomUUID()}`,
    )
    try {
      renameSync(from, to)
    } catch {
      return null // gone: another flusher claimed it, or it was never there
    }
    return { date, path: to, counts: readStoredCounters(to) }
  }) ?? null
}

/** The claim was sent (or is unreadable): remove it. */
export function completeClaim(claim: PendingClaim): void {
  try {
    unlinkSync(claim.path)
  } catch {
    /* already gone */
  }
}

/** The POST failed: merge the claim back into pending/<date>.json. */
export function releaseClaim(claim: PendingClaim, opts: CountersOpts = {}): boolean {
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  return underCountersLock(opts, () => {
    if (claim.counts && claim.counts.date === claim.date) moveToPending(claim.counts, pendingDir)
    completeClaim(claim)
    return true
  }) ?? false // lock busy: the claim stays and is recovered once this process exits
}

/** Merge back claims whose owning process is known to be dead. Returns how many. */
export function recoverOrphanClaims(opts: CountersOpts = {}): number {
  if (!isTelemetryEnabled(gateOpts(opts))) return 0
  const pendingDir = opts.pendingDir ?? defaultPendingDir()
  if (!existsSync(pendingDir)) return 0
  let names: string[]
  try {
    names = readdirSync(pendingDir)
  } catch {
    return 0
  }
  const orphans = names.filter((f) => {
    const m = CLAIM_RE.exec(f)
    if (!m) return false
    let host: string
    try {
      host = decodeURIComponent(m[2])
    } catch {
      return false
    }
    return holderIsAlive(`${host}:${m[3]}`) === false
  })
  if (orphans.length === 0) return 0
  return underCountersLock(opts, () => {
    let n = 0
    for (const f of orphans) {
      const date = CLAIM_RE.exec(f)![1]
      const path = join(pendingDir, f)
      if (!existsSync(path)) continue
      const counts = readStoredCounters(path)
      if (counts && counts.date === date) moveToPending(counts, pendingDir)
      completeClaim({ date, path, counts })
      n++
    }
    return n
  }) ?? 0
}

export function getCounters(opts: CountersOpts = {}): CounterSnapshot | null {
  if (!isTelemetryEnabled(gateOpts(opts))) return null

  const countersPath = opts.countersPath ?? defaultCountersPath()
  const installIdPath = opts.installIdPath ?? defaultInstallIdPath()

  return underCountersLock(opts, () => {
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
  }) ?? null
}

export function resetCounters(opts: CountersOpts = {}): CounterSnapshot | null {
  if (!isTelemetryEnabled(gateOpts(opts))) return null

  const countersPath = opts.countersPath ?? defaultCountersPath()
  const installIdPath = opts.installIdPath ?? defaultInstallIdPath()

  return underCountersLock(opts, () => {
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
  }) ?? null
}
