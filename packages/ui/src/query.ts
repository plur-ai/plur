/**
 * Aggregation over a local PLUR store.
 *
 * Pure functions over plain rows — no engine import, no I/O, no framework. The
 * caller supplies engrams (from `plur.list()`); these shape them for display.
 * Keeping this layer pure is what makes the viewer testable without a store,
 * a browser, or a harness.
 *
 * @module
 */

/**
 * The engram fields the viewer reads.
 *
 * A structural subset of `@plur-ai/core`'s `Engram`, declared here so this
 * package stays dependency-free. Every field is treated as untrusted at
 * runtime: these rows come off disk and old stores predate newer fields.
 */
export interface EngramRow {
  readonly id: string
  readonly statement: string
  readonly scope?: string
  readonly status?: string
  readonly domain?: string
  readonly pinned?: boolean
  readonly commitment?: string
  /** Times this engram was selected into a session's context. */
  readonly injection_count?: number
  readonly temporal?: { readonly learned_at?: string }
  readonly activation?: { readonly frequency?: number; readonly last_accessed?: string }
}

/** Filters accepted by the browse view. */
export interface BrowseQuery {
  /** Free text, matched against statement and id. */
  q?: string
  scope?: string
  status?: string
  limit?: number
  offset?: number
}

/** One page of results plus the pre-pagination total. */
export interface BrowsePage {
  rows: EngramRow[]
  total: number
  limit: number
  offset: number
}

const DEFAULT_LIMIT = 50

/** The day portion of a date or ISO timestamp, or `undefined` if unparseable. */
function dayOf(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length < 10) return undefined
  const day = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined
}

/**
 * Engram ID date formats.
 *
 * Both are in the wild: `ENG-2026-0814-017` and `ENG-2026-08-14-005`, plus an
 * optional org segment (`ENG-GPL-2026-0814-017`). Between them they cover every
 * row in a real 5,429-engram store, which is why the ID is the reliable source
 * for a creation date and `temporal.learned_at` is not.
 */
const ID_DATE = /^ENG(?:-[A-Z]+)?-(\d{4})-(\d{2})-?(\d{2})-/

/**
 * How many times this engram has actually been recalled.
 *
 * Reads `activation.frequency` — the retrieval-event counter, populated on
 * 3,964 of 5,429 rows in a real store with eight months of history.
 *
 * NOT `injection_count`: that counter shipped in #866 on 2026-08-13, so it is
 * non-zero on a couple of dozen rows and reports a store with years of use as
 * essentially unread. It is kept as a fallback for the case where a future
 * store has injections but no recorded retrievals.
 *
 * @param row - the engram.
 * @returns the recall count, or 0.
 */
export function recallCount(row: EngramRow | null | undefined): number {
  const freq = row?.activation?.frequency
  if (typeof freq === 'number' && Number.isFinite(freq) && freq > 0) return freq
  const injected = row?.injection_count
  return typeof injected === 'number' && Number.isFinite(injected) && injected > 0 ? injected : 0
}

/**
 * The date this engram was created.
 *
 * Prefers the date encoded in the engram ID, because `temporal.learned_at` is
 * optional and in practice almost never set — 1 row in 5,429 on a real store,
 * which renders a "written per day" chart completely empty.
 *
 * @param row - the engram.
 * @returns a `YYYY-MM-DD` date, or `undefined` when neither source yields one.
 */
export function createdOn(row: EngramRow | null | undefined): string | undefined {
  const match = ID_DATE.exec(row?.id ?? '')
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  return dayOf(row?.temporal?.learned_at)
}

/**
 * Filter, sort and paginate engrams for the browse table.
 *
 * Newest first: the question a memory viewer answers most often is "what has it
 * learned lately", not "what did it learn first".
 *
 * @param rows - all engrams in scope.
 * @param query - the active filters.
 * @returns one page plus the total before pagination.
 */
export function filterEngrams(rows: readonly EngramRow[], query: BrowseQuery): BrowsePage {
  const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT)
  const offset = Math.max(0, query.offset ?? 0)
  const needle = query.q?.trim().toLowerCase()

  const matched = (Array.isArray(rows) ? rows : []).filter(row => {
    if (!row || typeof row !== 'object') return false
    if (query.scope && row.scope !== query.scope) return false
    if (query.status && row.status !== query.status) return false
    if (needle) {
      const haystack = `${row.statement ?? ''}\n${row.id ?? ''}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })

  matched.sort((a, b) => (createdOn(b) ?? '').localeCompare(createdOn(a) ?? ''))

  return { rows: matched.slice(offset, offset + limit), total: matched.length, limit, offset }
}

/** Headline counts for the viewer's stat row. */
export interface MemoryStats {
  total: number
  /** Engrams pulled into context at least once. */
  recalled: number
  /** Engrams never pulled into context. */
  neverRecalled: number
  /** `neverRecalled` as a whole-number percentage of `total`. */
  neverRecalledPct: number
  /** Distinct scopes present. */
  scopes: number
}

/**
 * Never-recalled share, as a whole-number percentage.
 *
 * Deliberately not a plain round: 5409 of 5429 rounds to 100%, and "100% never
 * recalled" printed beside "20 recalled at least once" reads as a bug in the
 * viewer rather than a fact about the store. The share is clamped to 99 while
 * ANY engram has been recalled, and to 1 while any has not.
 */
function pctNeverRecalled(neverRecalled: number, total: number): number {
  if (total === 0) return 0
  const raw = Math.round((neverRecalled / total) * 100)
  if (raw >= 100 && neverRecalled < total) return 99
  if (raw <= 0 && neverRecalled > 0) return 1
  return raw
}

/**
 * Headline store statistics.
 *
 * `neverRecalled` is the number that matters. A store that only grows is a
 * store nobody is reading, and it is the one pathology a memory system can have
 * while looking perfectly healthy by every other measure.
 *
 * @param rows - all engrams in scope.
 * @returns the counts.
 */
export function memoryStats(rows: readonly EngramRow[]): MemoryStats {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object')
  const total = list.length
  let recalled = 0
  const scopes = new Set<string>()
  for (const row of list) {
    if (recallCount(row) > 0) recalled++
    if (row.scope) scopes.add(row.scope)
  }
  const neverRecalled = total - recalled
  return {
    total,
    recalled,
    neverRecalled,
    neverRecalledPct: pctNeverRecalled(neverRecalled, total),
    scopes: scopes.size,
  }
}

/**
 * The most-recalled engrams.
 *
 * Never-recalled engrams are excluded: a "top" list padded with zeroes tells the
 * reader nothing, and the never-recalled count is already reported separately.
 *
 * @param rows - all engrams in scope.
 * @param limit - how many to return.
 * @returns rows ranked by recall count, descending.
 */
export function topByRecall(rows: readonly EngramRow[], limit: number): EngramRow[] {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && recallCount(row) > 0)
    .sort((a, b) => recallCount(b) - recallCount(a))
    .slice(0, Math.max(0, limit))
}

/** One column of the written-per-day chart. */
export interface DayCount {
  date: string
  count: number
}

/**
 * Engrams written per day, over a trailing window.
 *
 * Emits a contiguous run of days including empty ones, so the chart shows gaps
 * as gaps rather than silently compressing them into a misleadingly busy series.
 *
 * Dates come from {@link createdOn}, not `temporal.learned_at` — see that
 * function for why.
 *
 * Only WRITES are charted. A local store keeps no per-event recall log, only
 * cumulative counters, so a matching "recalled per day" band cannot be derived
 * without inventing data. The never-recalled share in {@link memoryStats}
 * carries that signal instead.
 *
 * @param rows - all engrams in scope.
 * @param days - window length in days, ending today.
 * @param now - injectable clock, for tests.
 * @returns one entry per day, oldest first.
 */
export function writtenPerDay(rows: readonly EngramRow[], days: number, now: Date = new Date()): DayCount[] {
  const span = Math.max(1, days)
  const counts = new Map<string, number>()
  for (const row of Array.isArray(rows) ? rows : []) {
    const day = createdOn(row)
    if (day) counts.set(day, (counts.get(day) ?? 0) + 1)
  }

  const out: DayCount[] = []
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  cursor.setUTCDate(cursor.getUTCDate() - (span - 1))
  for (let i = 0; i < span; i++) {
    const date = cursor.toISOString().slice(0, 10)
    out.push({ date, count: counts.get(date) ?? 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}
