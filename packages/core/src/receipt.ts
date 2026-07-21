import type { CoInjectionEvent, InjectionSource } from './history.js'

export interface ReceiptInput {
  /** Engram IDs in the user's own store (personal + team, excluding packs). */
  ownEngramIds: string[]
  /** Engram IDs available from installed packs. */
  packEngramIds: string[]
  /** All co_injection events, any order. */
  events: CoInjectionEvent[]
  /** Injected for determinism in tests; the "present" for windowing and skew. */
  now: Date
  /** Restrict to the last N days. Omit / 0 / NaN → all recorded history. */
  days?: number
  /**
   * ID prefixes of remote/team stores (e.g. "ENG-DF-"). A retrieved id that is
   * not in the local store but carries one of these prefixes is an engram from
   * a team store this local receipt does not scope — counted as `external`, not
   * as `retired`, so an enterprise user is never told their team memory was
   * deleted.
   */
  externalIdPrefixes?: string[]
  /**
   * Optional id → statement snippet map. When present, top entries carry a
   * short, single-line snippet so "most relied on" is readable rather than a
   * list of opaque ids. Statement text is local; it is never transmitted.
   */
  statements?: Record<string, string>
}

export interface ReceiptTopEntry {
  id: string
  count: number
  retired: boolean
  /** Short snippet of the engram's statement, when the caller supplies a lookup. */
  statement?: string
}

export interface Receipt {
  window: {
    /** Earliest and latest retrieval actually counted (in-window), YYYY-MM-DD. */
    from: string
    to: string
    /** The requested lookback in days, or null for all-time. */
    requested_days: number | null
    /** True when a days filter narrowed the counts below all recorded history. */
    windowed: boolean
    sessions: number
  }
  stored: { own: number; pack: number; total: number }
  retrieved: {
    engrams: number
    activation_rate: number
    retrievals: number
    /** Distinct (engram, session) pairs over all local engrams (own + packs). */
    engram_session_pairs: number
    /** Of those pairs, the ones for engrams the user taught (own store, not packs). */
    taught_pairs: number
    /** Of those pairs, the ones for engrams from installed packs. */
    pack_pairs: number
  }
  /** Reuse over engrams that are BOTH retrieved and still stored. */
  reuse: { median: number; mean: number; max: number; top: ReceiptTopEntry[] }
  dormant: {
    never_retrieved: number
    /** Retrieved, not in the local store, not from a known team store → genuinely gone. */
    unavailable_but_retrieved: number
  }
  /** Retrieved engrams that belong to a team store this local receipt excludes. */
  external_retrieved: number
  sources: Record<string, number>
  coverage: {
    source: 'co_injection' | 'none'
    /** Earliest date ANY retrieval was logged (all-time), so windowed numbers
     *  are never misread as lifetime. Null when nothing is logged. */
    complete_from: string | null
    session_id_coverage: number
  }
  /** Events dropped for a timestamp after `now` (clock skew). */
  skipped_future: number
}

const DAY_MS = 86_400_000

function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0
  const mid = Math.floor(sortedAsc.length / 2)
  return sortedAsc.length % 2 === 0
    ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2
    : sortedAsc[mid]
}

/** Locale-independent ascending string compare (localeCompare is ICU-dependent). */
function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Build a memory receipt from counted facts only.
 *
 * Deliberately contains no estimate, no counterfactual and no monetary value:
 * a retrieval's worth is not observable from this data (see the design spec
 * §2), and for subscription users marginal token cost is zero anyway.
 *
 * "Retrieval" means PLUR selected engrams for a query — one co_injection event.
 * It is NOT the number of times that text was shown to the model; the CLI hook
 * re-presents a session's injection on later prompts, which PLUR cannot observe
 * from inside.
 */
export function computeReceipt(input: ReceiptInput): Receipt {
  const { ownEngramIds, packEngramIds, events, now } = input
  const nowMs = now.getTime()

  const own = new Set(ownEngramIds)
  // Partition: an id in both own and pack counts as own, so own + pack === total.
  const packOnly = new Set([...packEngramIds].filter(id => !own.has(id)))
  const stored = new Set([...own, ...packOnly])

  // Drop clock-skewed (future) events entirely — they cannot be attributed to a
  // real lookback window and would otherwise stretch `window.to` to a fiction.
  let skippedFuture = 0
  const sane = events.filter(e => {
    const t = Date.parse(e.timestamp)
    if (Number.isNaN(t)) return false
    if (t > nowMs) { skippedFuture++; return false }
    return true
  })

  // All-time coverage floor: earliest logged retrieval regardless of window.
  let earliestAll: string | null = null
  for (const e of sane) {
    if (earliestAll === null || e.timestamp < earliestAll) earliestAll = e.timestamp
  }

  const days = Number.isFinite(input.days) && (input.days ?? 0) > 0 ? input.days! : null
  const cutoff = days === null ? null : nowMs - days * DAY_MS
  const inWindow = cutoff === null ? sane : sane.filter(e => Date.parse(e.timestamp) >= cutoff)

  const retrievalCount = new Map<string, number>()
  const engramSessions = new Map<string, Set<string>>()
  const sessions = new Set<string>()
  const sources: Record<string, number> = {}
  let withSessionId = 0
  let earliestWin: string | null = null
  let latestWin: string | null = null

  for (const [i, e] of inWindow.entries()) {
    const src: InjectionSource | 'unknown' = e.data.source ?? 'unknown'
    sources[src] = (sources[src] ?? 0) + 1

    // An event without a session_id is its own anonymous session: it genuinely
    // happened, and collapsing them all into one bucket would understate pairs.
    // The index keeps buckets distinct; session_id_coverage flags the imprecision.
    const sid = e.data.session_id ?? `__anon_${i}__`
    if (e.data.session_id) withSessionId++
    sessions.add(sid)

    if (earliestWin === null || e.timestamp < earliestWin) earliestWin = e.timestamp
    if (latestWin === null || e.timestamp > latestWin) latestWin = e.timestamp

    for (const id of e.data.ids) {
      retrievalCount.set(id, (retrievalCount.get(id) ?? 0) + 1)
      let s = engramSessions.get(id)
      if (!s) { s = new Set(); engramSessions.set(id, s) }
      s.add(sid)
    }
  }

  const externalPrefixes = input.externalIdPrefixes ?? []
  const isExternal = (id: string) => externalPrefixes.some(p => id.startsWith(p))

  const retrievedIds = [...retrievalCount.keys()]
  const liveRetrieved = retrievedIds.filter(id => stored.has(id))
  const externalRetrieved = retrievedIds.filter(id => !stored.has(id) && isExternal(id))
  const trulyGone = retrievedIds.filter(id => !stored.has(id) && !isExternal(id))
  const liveCounts = liveRetrieved.map(id => retrievalCount.get(id)!).sort((a, b) => a - b)

  // Split (engram, session) pairs by provenance so the headline can name what
  // the user TAUGHT without silently folding in installed-pack memories.
  const pairsFor = (id: string) => engramSessions.get(id)?.size ?? 0
  const taughtPairs = liveRetrieved.filter(id => own.has(id)).reduce((n, id) => n + pairsFor(id), 0)
  const packPairs = liveRetrieved.filter(id => packOnly.has(id)).reduce((n, id) => n + pairsFor(id), 0)

  // top spans local (stored) + genuinely-gone engrams, so a heavily-used but
  // since-retired engram stays visible; external team engrams are excluded from
  // this local receipt's "most reused". reuse median/mean/max are stored-only,
  // so max is always an upper bound on the live entries the reuse block describes.
  const statements = input.statements
  const snippet = (id: string): string | undefined => {
    const s = statements?.[id]
    if (!s) return undefined
    const oneLine = s.replace(/\s+/g, ' ').trim()
    return oneLine.length > 72 ? oneLine.slice(0, 71) + '…' : oneLine
  }
  const top: ReceiptTopEntry[] = [...retrievalCount.entries()]
    .filter(([id]) => !isExternal(id) || stored.has(id))
    .sort((a, b) => b[1] - a[1] || cmpId(a[0], b[0]))
    .slice(0, 10)
    .map(([id, count]) => {
      const entry: ReceiptTopEntry = { id, count, retired: !stored.has(id) }
      const s = snippet(id)
      if (s) entry.statement = s
      return entry
    })

  const toDate = (iso: string | null) => (iso ? iso.slice(0, 10) : null)

  return {
    window: {
      from: toDate(earliestWin) ?? '',
      to: toDate(latestWin) ?? '',
      requested_days: days,
      windowed: days !== null,
      sessions: sessions.size,
    },
    stored: { own: own.size, pack: packOnly.size, total: stored.size },
    retrieved: {
      engrams: liveRetrieved.length,
      activation_rate: stored.size > 0 ? liveRetrieved.length / stored.size : 0,
      retrievals: inWindow.length,
      engram_session_pairs: [...engramSessions.values()].reduce((n, s) => n + s.size, 0),
      taught_pairs: taughtPairs,
      pack_pairs: packPairs,
    },
    reuse: {
      median: median(liveCounts),
      mean: liveCounts.length > 0 ? liveCounts.reduce((a, b) => a + b, 0) / liveCounts.length : 0,
      max: liveCounts.length > 0 ? liveCounts[liveCounts.length - 1] : 0,
      top,
    },
    dormant: {
      never_retrieved: [...stored].filter(id => !retrievalCount.has(id)).length,
      unavailable_but_retrieved: trulyGone.length,
    },
    external_retrieved: externalRetrieved.length,
    sources,
    coverage: {
      source: inWindow.length > 0 ? 'co_injection' : 'none',
      complete_from: toDate(earliestAll),
      session_id_coverage: inWindow.length > 0 ? withSessionId / inWindow.length : 0,
    },
    skipped_future: skippedFuture,
  }
}
