import * as fs from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

export interface HistoryEvent {
  event: 'engram_created' | 'engram_updated' | 'engram_merged' | 'feedback_received' | 'engram_retired' | 'engram_decremented' | 'engram_promoted' | 'failure_reported' | 'procedure_evolved' | 'recurrence_detected' | 'contradiction_detected' | 'scope_promoted' | 'buffer_pruned' | 'weekly_review' | 'engram_route_failed' | 'co_injection' | 'injection_outcome'
  engram_id: string
  timestamp: string // ISO
  data: Record<string, unknown> // event-specific payload
}

/**
 * Append a history event to the JSONL file for the current month.
 * Files are stored in {root}/history/YYYY-MM.jsonl.
 * Auto-creates the history directory and file on first write.
 */
export function appendHistory(root: string, event: HistoryEvent): void {
  const historyDir = join(root, 'history')
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true })
  }

  const date = event.timestamp.slice(0, 7) // YYYY-MM
  const filePath = join(historyDir, `${date}.jsonl`)
  const line = JSON.stringify(event) + '\n'
  fs.appendFileSync(filePath, line, 'utf8')
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
