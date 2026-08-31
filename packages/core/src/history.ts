import * as fs from 'fs'
import { withLock } from './sync.js'
import { logger } from './logger.js'
import { join } from 'path'
import { createHash } from 'crypto'

export interface HistoryEvent {
  event: 'engram_created' | 'engram_updated' | 'engram_merged' | 'feedback_received' | 'engram_retired' | 'engram_decremented' | 'engram_promoted' | 'engram_rescoped' | 'failure_reported' | 'procedure_evolved' | 'recurrence_detected' | 'contradiction_detected' | 'scope_promoted' | 'buffer_pruned' | 'weekly_review' | 'engram_route_failed' | 'co_injection' | 'injection_outcome' | 'session_scope_changed' | 'dedup_near_duplicate' | 'engram_duplicate_absorbed' | 'checkpoint'
  /**
   * Engram this event belongs to. Session-level events
   * (`session_scope_changed`) carry no engram — they use `''`, which by
   * construction never matches a real id in `readHistoryForEngram`.
   */
  engram_id: string
  timestamp: string // ISO
  data: Record<string, unknown> // event-specific payload
  /**
   * SHA-256 over the canonical bytes of this event (sorted keys, no whitespace,
   * ISO-8601 timestamps). Set by appendHistory() for events written after #1051.
   * Legacy events have no hash field — readers must tolerate its absence.
   */
  hash?: string
  /**
   * Hash of the predecessor event in the chain, or null when this event is the
   * genesis of the chain (first chained event in the store) or when the
   * predecessor could not be read (gap — the write still proceeds, never fabricates).
   * Legacy events have no prev field — readers must tolerate its absence.
   */
  prev?: string | null
}

/**
 * Recursively sort object keys by UTF-16 code unit order (lexicographic), the
 * same sort order used by JSON.stringify's default key visitor in V8.
 * Arrays are preserved as arrays (elements sorted recursively if objects).
 *
 * This is the canonical-bytes normaliser for #1051: every event hash is
 * computed over JSON.stringify(sortKeysDeep(event_without_hash)), so two
 * independent implementations that agree on this function agree on all hashes.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key])
    }
    return sorted
  }
  return value
}

/**
 * Canonical bytes for a history event: UTF-8 JSON, keys sorted
 * lexicographically by UTF-16 code unit, no insignificant whitespace.
 *
 * The `hash` field is EXCLUDED from its own canonical representation (circular
 * by construction). The `prev` field is INCLUDED — it is a known value at hash
 * time and forms part of the chain linkage.
 *
 * Spec (#1051):
 * - UTF-8 JSON
 * - Keys sorted recursively by UTF-16 code unit (JS default sort)
 * - No insignificant whitespace (JSON.stringify with no space arg)
 * - Timestamps must be ISO-8601 strings, never floats
 * - Hashes: lowercase hex SHA-256
 */
export function canonicalEventBytes(event: HistoryEvent): Buffer {
  const { hash: _hash, ...rest } = event
  void _hash // excluded from the canonical form
  const sorted = sortKeysDeep(rest)
  return Buffer.from(JSON.stringify(sorted), 'utf8')
}

/**
 * Compute the SHA-256 hash of a history event's canonical bytes.
 * Returns lowercase hex string (64 chars).
 *
 * Callers must pass the event WITHOUT the hash field set, or use this before
 * setting event.hash (canonical bytes always exclude `hash` — see above).
 */
export function computeEventHash(event: HistoryEvent): string {
  return createHash('sha256').update(canonicalEventBytes(event)).digest('hex')
}

/**
 * Tail-seek the last non-empty line of a JSONL file and extract the `hash`
 * field from the parsed JSON. Returns null if the file does not exist, cannot
 * be read, has no non-empty lines, or the last line lacks a `hash` field.
 *
 * This is the predecessor-hash read for chain linkage. It is intentionally
 * robust: an unreadable or missing predecessor results in null (a documented
 * gap), not an error. The caller (appendHistory) writes the gap marker rather
 * than failing the mutation.
 *
 * Implementation: reads the last TAIL_WINDOW bytes of the file and scans
 * backwards for a newline, avoiding a full-file parse on the hot write path.
 */
const TAIL_WINDOW = 8192 // bytes — sufficient for any realistic event line

export function tailSeekLastHash(filePath: string): string | null {
  try {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return null // file does not exist
    }
    if (stat.size === 0) return null

    const readSize = Math.min(stat.size, TAIL_WINDOW)
    const offset = stat.size - readSize
    const buf = Buffer.allocUnsafe(readSize)
    const fd = fs.openSync(filePath, 'r')
    try {
      fs.readSync(fd, buf, 0, readSize, offset)
    } finally {
      fs.closeSync(fd)
    }

    const text = buf.toString('utf8')
    // Scan backwards for the last non-empty line
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed.hash === 'string' && parsed.hash.length === 64) {
          return parsed.hash
        }
        // Last event exists but has no hash (legacy event) — this is a gap in
        // the chain. Return null to signal "predecessor found but unchained".
        return null
      } catch {
        return null // malformed JSON — treat as unreadable
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Find the hash of the most recent chained event across all month files in the
 * history directory, looking at the current month file first and then scanning
 * backwards through prior months.
 *
 * Used by appendHistory for cross-month chain continuity: when the first event
 * of a new month is written, the predecessor is in the prior month's file.
 *
 * Returns null when no chained predecessor is found (genesis event, gap after
 * a legacy event, or unreadable files).
 */
export function findPredecessorHash(historyDir: string, currentMonthFile: string): string | null {
  // If the current month file exists and has content, the predecessor (if any)
  // is within it. A null return means either: last event is a legacy event
  // (no hash — gap) or the file is empty/unreadable. We don't cross back to
  // prior months when the current month file already has events written into it.
  try {
    const stat = fs.statSync(currentMonthFile)
    if (stat.size > 0) {
      // File exists with content — predecessor lives here (or it's a gap)
      return tailSeekLastHash(currentMonthFile)
    }
    // File exists but empty — treat as absent
  } catch {
    // File does not exist — this is the first event of a new month.
    // Look at the most recent prior month for cross-month continuity.
  }

  // Current month file absent or empty: walk backwards through prior months
  // for cross-month chain continuity.
  try {
    if (!fs.existsSync(historyDir)) return null
    const months = fs.readdirSync(historyDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort()
      .reverse() // newest first

    for (const month of months) {
      const filePath = join(historyDir, `${month}.jsonl`)
      // Skip the current month file — already checked above
      if (filePath === currentMonthFile) continue
      const hash = tailSeekLastHash(filePath)
      if (hash !== null) return hash
      // If the last event in the most recent prior month has no hash (legacy),
      // stop — no chained predecessor exists before this gap.
      break
    }
  } catch {
    // best-effort
  }
  return null
}

/**
 * Append a history event to the JSONL file for the current month.
 * Files are stored in {root}/history/YYYY-MM.jsonl.
 * Auto-creates the history directory and file on first write.
 *
 * Hash-chain (#1051): before writing, this function:
 *   1. Tail-seeks for the predecessor's hash — current month file first, then
 *      the most recent prior month file (cross-month continuity)
 *   2. Sets event.prev = predecessor hash | null (gap when predecessor unreadable)
 *   3. Computes SHA-256 over canonical bytes (sorted keys, no whitespace) and
 *      sets event.hash
 *
 * Concurrency: this function serializes itself. The read-predecessor →
 * compute-hash → append sequence is wrapped in a short cross-process lock on
 * the history directory, so two writers cannot both read the same tail and
 * both append from it.
 *
 * It used to document a precondition instead — "must be called from within the
 * store write lock" — which the codebase did not honour: 19 of 28 call sites in
 * index.ts were outside any `_withStoreLock`, and BOTH `emitCheckpoint` sites
 * were, which is what produced 83 duplicate-prev forks across 600 events in
 * review testing. A precondition that callers do not meet is not a design, and
 * the mutex is not re-entrant so `_withStoreLock` could not simply be called
 * here. Locking the thing that actually needs exclusion — this append — fixes
 * every call site at once, present and future.
 *
 * Lock ordering is one-way: a caller may hold the store lock and then take this
 * one, never the reverse (nothing here calls back into store code), so the two
 * cannot deadlock.
 *
 * This is the same critical section `.datacore/lib/ledger/log.py` serializes
 * with `fcntl.flock`. That ledger goes further and gives each actor its own
 * file, making forks unrepresentable rather than merely prevented; adopting
 * that partitioning here is the follow-up this lock buys time for.
 *
 * If the lock cannot be acquired, the event is still written but with
 * `prev: null` — a DECLARED GAP rather than a possibly-stale predecessor.
 * A gap is visible and honest; a fork is silent corruption. The write itself
 * must always land: history NAMES the engrams a restore cannot recover, so
 * dropping a record makes restore under-report the loss.
 *
 * Gap handling: if the predecessor cannot be read (file missing, malformed line,
 * legacy event without hash), prev is set to null. This is a documented gap in
 * the chain — never an error, never a fabricated hash.
 *
 * Legacy events: events written before #1051 carry no hash or prev fields. They
 * are loaded and reported as-is, never silently upgraded, never errored.
 */
export function appendHistory(root: string, event: HistoryEvent): void {
  const historyDir = join(root, 'history')
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true })
  }

  const date = event.timestamp.slice(0, 7) // YYYY-MM
  const filePath = join(historyDir, `${date}.jsonl`)

  // Hash-chain linkage (#1051) under exclusion. Reading the tail and appending
  // from it must be one atomic step, or two writers chain from the same
  // predecessor and the log forks. `withLock` is the synchronous twin of the
  // store's async lock — token-based release, stale detection, liveness check —
  // and `appendHistory` is synchronous, so it is the one that fits.
  let line: string
  const stamp = (): string => {
    const predecessorHash = findPredecessorHash(historyDir, filePath)
    event.prev = predecessorHash // null when gap or genesis
    event.hash = computeEventHash(event) // canonical bytes exclude the hash field
    return JSON.stringify(event) + '\n'
  }

  try {
    line = withLock(join(historyDir, 'chain'), stamp)
  } catch {
    // Could not take the lock. Do NOT chain from a tail we could not read
    // under exclusion — that is exactly how a fork is written. Declare a gap
    // instead: visible to `plur verify`, and never mistaken for tampering.
    event.prev = null
    event.hash = computeEventHash(event)
    line = JSON.stringify(event) + '\n'
  }
  // fsync the append (#813, audit finding 20). O_APPEND makes the write atomic
  // against concurrent writers, but not durable: a committed engram mutation
  // could survive a power cut while its history record did not. That matters
  // beyond bookkeeping — `plur restore` reads this log to NAME the engrams a
  // restore cannot recover, so a lost record makes restore UNDER-report the
  // loss, which is the one thing it exists not to do.
  //
  // Best-effort on the fsync itself: the append already succeeded, and failing
  // the caller's mutation because a diagnostic log could not be flushed would
  // trade a small durability gap for a large availability one.
  // Best-effort on the WHOLE append, not just the fsync.
  //
  // The reasoning above — that failing a caller's mutation because a
  // diagnostic log could not be written trades a small durability gap for a
  // large availability one — was applied only to `fsyncSync`. `openSync` and
  // `writeSync` were unguarded, so an unwritable history directory (disk full,
  // permissions, a path that is not a file) propagated out and failed the
  // learn/forget/feedback that called it. Found by a test that made the month
  // file unreadable to check id allocation degraded safely: it did not
  // degrade, it threw EISDIR out of `plur.learn()`.
  //
  // Warned rather than silently swallowed: history is load-bearing for `plur
  // restore` (it NAMES the engrams a restore cannot recover) and, since #816,
  // for id allocation. A store writing no history is degraded and the operator
  // needs to know — but the write itself must still land.
  try {
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeSync(fd, line)
      try { fs.fsyncSync(fd) } catch { /* append landed; durability is best-effort */ }
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    if (!warnedHistoryPaths.has(filePath)) {
      warnedHistoryPaths.add(filePath)
      logger.warning(
        `[plur] history could not be written to ${filePath}: ${(err as Error).message}. ` +
        `The operation itself succeeded. While this persists, \`plur restore\` cannot name ` +
        `unrecoverable engrams and engram-id allocation loses its cross-compaction guarantee (#816).`,
      )
    }
  }
}

/** Warn once per path — this is on the hot write path; a broken log must not
 *  also become a log flood. */
const warnedHistoryPaths = new Set<string>()

/**
 * Payload of a `checkpoint` history event (#1052).
 *
 * A checkpoint commits to every event that precedes it in the chain — the
 * chain linkage (prev/hash) makes the whole prior history tamper-evident
 * once this checkpoint is externally anchored.
 *
 * Fields:
 *   chain_head  — hash of the predecessor event (the last event before this
 *                 checkpoint), or null when this is the genesis checkpoint.
 *                 Redundant with the HistoryEvent.prev field, but kept in
 *                 data so the payload is self-contained without parsing chain
 *                 linkage separately.
 *   store_hash  — SHA-256 of the engrams.yaml bytes at checkpoint time,
 *                 hex-encoded. Never computed on append (hot path) — only
 *                 computed when a checkpoint is explicitly requested.
 *   engram_count — count of active (non-retired) engrams at checkpoint time.
 *   actor        — who/what triggered the checkpoint ('session_end' | 'cli' | string).
 */
export interface CheckpointData {
  chain_head: string | null
  store_hash: string
  engram_count: number
  actor: string
}

/**
 * Compute the SHA-256 hash of the engrams.yaml file at `engramsPath`.
 * Returns lowercase hex string. Throws if the file cannot be read.
 *
 * This is ONLY called when a checkpoint is explicitly requested — never on
 * the hot write path (learn/feedback/forget).
 */
export function hashEngramsFile(engramsPath: string): string {
  const bytes = fs.readFileSync(engramsPath)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Emit a `checkpoint` history event for the store at `root`.
 *
 * Computes:
 *   - chain_head: the predecessor hash (last chained event in the store)
 *   - store_hash: SHA-256 of engrams.yaml bytes (only done at checkpoint time)
 *   - engram_count: number of active engrams provided by the caller
 *
 * The checkpoint is itself a chained event — it gets its own hash and prev
 * via appendHistory, so two checkpoints across a month boundary chain correctly
 * via the existing cross-month mechanism.
 *
 * The `engram_id` field is set to '' (empty string — same convention as
 * session_scope_changed): checkpoints are store-level events, not engram-level.
 *
 * @param root        — plur store root (e.g. ~/.plur)
 * @param engramsPath — absolute path to engrams.yaml
 * @param engramCount — count of active engrams at this moment
 * @param actor       — who triggered the checkpoint ('session_end' | 'cli' | custom)
 * @param timestamp   — ISO-8601 timestamp; defaults to now
 * @returns the written CheckpointData
 */
export function emitCheckpoint(
  root: string,
  engramsPath: string,
  engramCount: number,
  actor: string,
  timestamp?: string,
): CheckpointData {
  const ts = timestamp ?? new Date().toISOString()

  // Compute chain head BEFORE writing (the predecessor of this checkpoint)
  const historyDir = join(root, 'history')
  const date = ts.slice(0, 7) // YYYY-MM
  const currentMonthFile = join(historyDir, `${date}.jsonl`)
  const chain_head = findPredecessorHash(historyDir, currentMonthFile)

  // Hash the store (only at checkpoint time — never on hot write path)
  const store_hash = hashEngramsFile(engramsPath)

  const data: CheckpointData = {
    chain_head,
    store_hash,
    engram_count: engramCount,
    actor,
  }

  const event: HistoryEvent = {
    event: 'checkpoint',
    engram_id: '', // store-level event; no single engram
    timestamp: ts,
    data: data as unknown as Record<string, unknown>,
  }

  appendHistory(root, event)
  return data
}

/**
 * Read history events from a specific month's JSONL file.
 * Returns empty array if file doesn't exist.
 */
export function readHistory(root: string, yearMonth: string): HistoryEvent[] {
  const filePath = join(root, 'history', `${yearMonth}.jsonl`)
  if (!fs.existsSync(filePath)) return []

  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  const events: HistoryEvent[] = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as HistoryEvent)
    } catch {
      // Skip malformed lines
    }
  }
  return events
}

/**
 * Ids this store has ever MINTED whose prefix matches one of `prefixes` (#816).
 *
 * `generateEngramId` allocates by scanning the corpus for the highest same-day
 * suffix, so the corpus is the only record of what has been handed out — and
 * `compact()` removes rows, which frees their ids for reuse. Two different
 * engrams then share an id, and everything keyed by id that outlives the corpus
 * entry (history itself, backups and restore diffs, `supersedes` edges, outbox
 * rows, remote store rows) silently merges two lives into one.
 *
 * The repair needs a record of allocation that survives removal. That record
 * already exists: this log is append-only, keyed by engram id, and written on
 * every create — nothing is ever deleted from it, which is exactly the property
 * the corpus lacks. No new state, no store-format change, no migration.
 *
 * ## Why this is safe even though history writes are best-effort
 *
 * Several call sites wrap `appendHistory` in try/catch, deliberately: a failed
 * history write must not fail the write it describes. So this can UNDER-report.
 * That is tolerable because the failure is one-directional — a missed record
 * leaves allocation exactly where it is today, while every record found can
 * only push the next suffix higher. Reading more allocation history can never
 * create a collision, only avoid one.
 *
 * Reads a single month (allocation is per-day, so only the current month can
 * hold same-day ids) and never throws: an unreadable log degrades to today's
 * corpus-only behaviour rather than blocking a write.
 */
export function mintedIdsWithPrefix(root: string, yearMonth: string, prefixes: string[]): string[] {
  try {
    const out: string[] = []
    for (const ev of readHistory(root, yearMonth)) {
      if (ev.event !== 'engram_created') continue
      const id = ev.engram_id
      if (typeof id === 'string' && prefixes.some(p => id.startsWith(p))) out.push(id)
    }
    return out
  } catch {
    return []
  }
}

/**
 * List all available history months (YYYY-MM format).
 */
export function listHistoryMonths(root: string): string[] {
  const historyDir = join(root, 'history')
  if (!fs.existsSync(historyDir)) return []
  return fs.readdirSync(historyDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace('.jsonl', ''))
    .sort()
}

/**
 * Read all history events for a specific engram, across all months.
 * Returns events sorted chronologically.
 */
export function readHistoryForEngram(root: string, engramId: string): HistoryEvent[] {
  const months = listHistoryMonths(root)
  const events: HistoryEvent[] = []
  for (const month of months) {
    const monthEvents = readHistory(root, month)
    for (const event of monthEvents) {
      if (event.engram_id === engramId) {
        events.push(event)
      }
    }
  }
  return events
}

// Per-process 2-char salt (PID mod 1296, base36) prevents cross-process
// same-millisecond collisions when the MCP server and a hook-spawned CLI
// process both call generateInjectionId()/generateEventId() concurrently.
// Suffix format: <2-char salt><4-char counter> = 6 chars [a-z0-9]{6}.
// Counter overflows to 5 chars past 36^4 (1,679,616 events/process) — not
// reachable in practice; suffix becomes 7 chars, IDs remain unique.
const _PROC_SALT = (process.pid % 1296).toString(36).padStart(2, '0')
let _evtSeq = 0
let _injSeq = 0

/**
 * Generate a globally-unique event ID for history entries.
 * Cross-process uniqueness via PID salt; intra-process via monotonic counter.
 * Format: EVT-<ts>-<2-char-pid-salt><4-char-counter>
 */
export function generateEventId(): string {
  return `EVT-${Date.now()}-${_PROC_SALT}${(_evtSeq++).toString(36).padStart(4, '0')}`
}

// --- Injection provenance (#452) ---
//
// Two event types feed the co-fire edge pipeline (#200/#201) and
// temporal-replay self-labeling (#202):
//
//   co_injection      — one per inject/session-start with >=1 injected engram.
//                       engram_id carries the injection ID (INJ-...) so the
//                       event is addressable; data = { ids, query_hash, ... }.
//                       Kept compact: engram IDs only, never statements.
//                       Measured: ~325 B at 5 ids, ~625 B at 20 ids.
//   injection_outcome — one per positive/negative plur_feedback verdict on an
//                       engram that was previously injected; data links back
//                       via { injection_id, signal }. ~170 B. "Ignored" is the
//                       ABSENCE of an outcome for an injected engram — no
//                       synthetic ignore events are ever written.
//
// Growth at ~50 sessions/day (one co_injection each, a handful of outcomes):
// under ~1 MiB/month of JSONL — see the #452 PR body for the measured table.

/**
 * Generate a globally-unique injection ID for co_injection events.
 * Cross-process uniqueness via PID salt; intra-process via monotonic counter.
 * Format: INJ-<ts>-<2-char-pid-salt><4-char-counter>
 */
export function generateInjectionId(): string {
  return `INJ-${Date.now()}-${_PROC_SALT}${(_injSeq++).toString(36).padStart(4, '0')}`
}

/**
 * Compact, stable hash of the injection query context. Case- and
 * whitespace-insensitive so retries of the same task hash identically.
 */
export function computeQueryHash(task: string): string {
  const normalized = task.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * Find the most recent co_injection event that included the given engram.
 * Scans the newest `maxMonths` history files only (bounded read) — feedback
 * on injections older than that is not attributable to a specific injection.
 * Returns null when no recent co_injection contains the engram.
 */
export function findLatestInjectionFor(
  root: string,
  engramId: string,
  maxMonths = 2,
): { injection_id: string; timestamp: string } | null {
  // Time-based window: the maxMonths calendar months ending at the current
  // month. A sparse store's newest files can be arbitrarily old — linking
  // feedback to an injection from years ago would be a false label.
  const now = new Date()
  const allowed = new Set<string>()
  for (let i = 0; i < maxMonths; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    allowed.add(d.toISOString().slice(0, 7))
  }
  const months = listHistoryMonths(root).filter(m => allowed.has(m)).reverse()
  for (const month of months) {
    let latest: HistoryEvent | null = null
    for (const event of readHistory(root, month)) {
      if (event.event !== 'co_injection') continue
      const ids = event.data.ids
      if (!Array.isArray(ids) || !ids.includes(engramId)) continue
      if (!latest || event.timestamp > latest.timestamp) latest = event
    }
    if (latest) return { injection_id: latest.engram_id, timestamp: latest.timestamp }
  }
  return null
}

/**
 * Which surface asked for an injection. `'recall'` is deliberately absent:
 * plur_recall / plur_recall_hybrid do not route through _formatInjection and
 * therefore emit no co_injection event at all.
 */
export type InjectionSource = 'session_start' | 'inject' | 'hook' | 'unknown'

const INJECTION_SOURCES: ReadonlySet<string> = new Set([
  'session_start', 'inject', 'hook', 'unknown',
])

// Strict ISO-8601 as produced by Date.prototype.toISOString (the only shape a
// co_injection timestamp legitimately takes). Used instead of a bare Date.parse
// check, which accepts control characters inside a date and returns non-NaN.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Payload of a `co_injection` event. `tokens_used` and `source` were added by
 * the memory-receipt work; events written before that lack them, so both are
 * optional and every reader must tolerate their absence.
 */
export interface CoInjectionData {
  ids: string[]
  query_hash: string
  tokens_used?: number
  source?: InjectionSource
  scope?: string
  session_id?: string
}

export interface CoInjectionEvent {
  injection_id: string
  timestamp: string
  data: CoInjectionData
}

export interface CoInjectionReadResult {
  events: CoInjectionEvent[]
  /**
   * Count of co_injection events that were unusable or had to be cleaned:
   * a malformed payload (no ids array / no query_hash / unparseable timestamp),
   * dropped entirely, OR a kept event that had non-string ids stripped out.
   * Corrupt-JSON lines are dropped upstream in readHistory and are NOT counted
   * here. A diagnostic signal only — not currently surfaced in the receipt.
   */
  skipped: number
}

/**
 * Read every co_injection event across all history months, oldest first.
 *
 * Defensive by design: this feeds a read-only report that must degrade to
 * "no data" rather than throw. Unknown `source` values are coerced to
 * 'unknown' so they can never become arbitrary keys in a caller's tally, and
 * non-string ids are dropped so they can never reach a renderer.
 */
export function readCoInjections(root: string, months?: string[]): CoInjectionReadResult {
  const events: CoInjectionEvent[] = []
  let skipped = 0
  const wanted = months ? new Set(months) : null

  for (const month of listHistoryMonths(root)) {
    if (wanted && !wanted.has(month)) continue
    for (const event of readHistory(root, month)) {
      if (event.event !== 'co_injection') continue
      const raw = event.data as Partial<CoInjectionData>
      if (!Array.isArray(raw.ids) || typeof raw.query_hash !== 'string') { skipped++; continue }
      // Strict ISO-8601 only. Date.parse is lenient (accepts control chars in a
      // date, returns non-NaN); the timestamp is later sliced into the rendered
      // window dates, so a crafted line must not pass. co_injection timestamps
      // are always toISOString().
      if (typeof event.timestamp !== 'string' || !ISO_TIMESTAMP.test(event.timestamp)) { skipped++; continue }

      const ids = raw.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      if (ids.length !== raw.ids.length) skipped++

      const data: CoInjectionData = { ids, query_hash: raw.query_hash }
      if (typeof raw.tokens_used === 'number' && Number.isFinite(raw.tokens_used)) {
        data.tokens_used = raw.tokens_used
      }
      if (raw.source !== undefined) {
        data.source = INJECTION_SOURCES.has(raw.source) ? raw.source : 'unknown'
      }
      if (typeof raw.scope === 'string') data.scope = raw.scope
      if (typeof raw.session_id === 'string') data.session_id = raw.session_id

      events.push({ injection_id: event.engram_id, timestamp: event.timestamp, data })
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return { events, skipped }
}

export interface InjectionEventCounts {
  co_injection: number
  injection_outcome: number
  outcome_positive: number
  outcome_negative: number
}

/**
 * Count injection-provenance events across all history months. Feeds the
 * #202 volume gate via plur_status — training on injection outcomes is
 * gated on having enough labels.
 */
export function countInjectionEvents(root: string): InjectionEventCounts {
  const counts: InjectionEventCounts = {
    co_injection: 0,
    injection_outcome: 0,
    outcome_positive: 0,
    outcome_negative: 0,
  }
  for (const month of listHistoryMonths(root)) {
    for (const event of readHistory(root, month)) {
      if (event.event === 'co_injection') {
        counts.co_injection++
      } else if (event.event === 'injection_outcome') {
        counts.injection_outcome++
        if (event.data.signal === 'positive') counts.outcome_positive++
        else if (event.data.signal === 'negative') counts.outcome_negative++
      }
    }
  }
  return counts
}
