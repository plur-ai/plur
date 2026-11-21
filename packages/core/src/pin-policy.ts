/**
 * Who may pin an engram (overhaul D2) and how the pinned set fits its share
 * of the injection budget (overhaul D3).
 *
 * ## The write policy
 *
 * `pinning.agents` (config) decides what happens when a write would turn an
 * engram from unpinned into pinned and the caller is not the owner:
 *
 *   - `allow`   (default) — today's behaviour: the pin is written.
 *   - `request` — the engram is written UNPINNED and carries
 *                 `structured_data.pin_request` ({@link PinRequest}) for the
 *                 owner to approve (`plur pins review`) or reject.
 *   - `deny`    — the write is refused with {@link PinDeniedError}. Nothing is
 *                 stored.
 *
 * The caller is an {@link PinActor}: `owner` (the CLI, a person at a
 * terminal) is never restricted; `agent` (the MCP server, hooks) and an
 * ABSENT actor (any embedder that did not say — claw, opencode, scripts) are
 * subject to the config. With the default config (`allow`) an absent actor is
 * exactly today's behaviour.
 *
 * The policy is enforced in core's write path, not in an adapter: `learn`,
 * `learnRouted` (and through them `learnAsync`, `learnBatch` and import),
 * `updateEngram`, `setPinned` and change-journal applies all consult it. Only
 * a TRANSITION to pinned, and a stronger pin on a row already pinned (a
 * higher priority or the hard tier, {@link isPinEscalation}; refused under
 * `request` too, since a request cannot carry it), are policed. Re-writing
 * a pinned engram without strengthening its pin, and unpinning, are not.
 *
 * Not affected (documented behaviour, unchanged): pins that arrive with rows
 * PLUR reads rather than writes — team stores (`stores:` path or url
 * entries, whose rows another client wrote) and installed packs. Their pins
 * load exactly as before. An undo of a journalled change restores the
 * before-snapshot as it was, pin included.
 */
import type { Engram } from './schemas/engram.js'
import type { PlurConfig } from './schemas/config.js'
import { resolvePinningConfig } from './schemas/config.js'
import {
  estimateTokens, fillTokenBudget, pinnedShareRatio, pinnedHardCap, isHardPinned,
  effectivePinnedPriority, pinnedOriginRank, DEFAULT_PINNED_HARD_RATIO,
  type OmittedPinned,
} from './inject.js'
import { classifyPolarity } from './polarity.js'

/** Who is writing: the owner at a terminal, or an agent. */
export type PinActor = 'owner' | 'agent'

/** What the policy decides for one pin attempt. */
export type PinDecision = 'allow' | 'request' | 'deny'

/** A pending request to pin an engram, stored at `structured_data.pin_request`. */
export interface PinRequest {
  /** ISO timestamp of the request. */
  requested_at: string
  /**
   * Who asked: `agent`, `unknown` when the caller did not say, or
   * `consolidate` when a merge replaced a pinned original (overhaul R2).
   */
  by: PinActor | 'unknown' | 'consolidate'
  /** Why, when the caller said. */
  reason?: string
  /** The write path that asked (`learn`, `update`, `pin`, `change:<kind>`, `consolidate`). */
  via?: string
  /** For a merge: the originals whose pin (or pending request) this carries. */
  from?: string[]
  /** The tier and priority the caller asked for, applied on approval. */
  tier?: 'hard' | 'soft'
  priority?: number
}

/** A pin refused by `pinning.agents: deny`. Nothing was written. */
export class PinDeniedError extends Error {
  readonly code = 'pin_denied'
  constructor(readonly engramId: string | null, readonly via: string, message?: string) {
    super(message ?? (
      `Pinning is reserved for the owner on this install (pinning.agents: deny), so ${engramId ? `${engramId} was not pinned` : 'the engram was not stored'}. `
      + 'Store it unpinned, or ask the owner to pin it with `plur pin <id>`.'
    ))
    this.name = 'PinDeniedError'
  }
}

/**
 * The policy decision for a caller. `owner` is always allowed; `agent` and an
 * absent actor get `pinning.agents` (default `allow`).
 */
export function pinDecision(config: PlurConfig | undefined, actor: PinActor | undefined): PinDecision {
  if (actor === 'owner') return 'allow'
  return resolvePinningConfig(config).agents
}

/** The pending pin request an engram carries, or null (a pinned engram has none). */
export function pinRequestOf(e: { pinned?: unknown; structured_data?: unknown } | null | undefined): PinRequest | null {
  if (!e || e.pinned === true) return null
  const sd = e.structured_data as Record<string, unknown> | undefined
  const r = sd?.pin_request as PinRequest | undefined
  return r && typeof r === 'object' && typeof r.requested_at === 'string' ? r : null
}

/** Build the request record for a refused-to-pin write. */
export function buildPinRequest(
  actor: PinActor | 'consolidate' | undefined,
  via: string,
  extra?: { reason?: string; tier?: 'hard' | 'soft'; priority?: number; from?: string[]; requested_at?: string },
): PinRequest {
  return {
    requested_at: extra?.requested_at ?? new Date().toISOString(),
    by: actor ?? 'unknown',
    ...(extra?.reason ? { reason: extra.reason } : {}),
    via,
    ...(extra?.from && extra.from.length > 0 ? { from: extra.from } : {}),
    ...(extra?.tier ? { tier: extra.tier } : {}),
    ...(extra?.priority !== undefined ? { priority: extra.priority } : {}),
  }
}

/**
 * The row as a `request` decision stores it: unpinned (tier and priority
 * dropped, kept in the request instead), with `structured_data.pin_request`.
 * `prior` is the stored row, when there is one: its unpinned state is kept.
 */
export function asPinRequested<T extends Record<string, unknown>>(row: T, request: PinRequest): T {
  const out: Record<string, unknown> = { ...row }
  delete out.pinned
  delete out.pinned_tier
  delete out.pinned_priority
  const sd = (out.structured_data && typeof out.structured_data === 'object') ? { ...(out.structured_data as Record<string, unknown>) } : {}
  sd.pin_request = request
  out.structured_data = sd
  return out as T
}

/** The row with any pin request removed (on approval or rejection). */
export function withoutPinRequest<T extends Record<string, unknown>>(row: T): T {
  const sd = row.structured_data as Record<string, unknown> | undefined
  if (!sd || !('pin_request' in sd)) return row
  const rest = { ...sd }
  delete rest.pin_request
  const out: Record<string, unknown> = { ...row }
  if (Object.keys(rest).length > 0) out.structured_data = rest
  else delete out.structured_data
  return out as T
}

/** True when a write moves a row from unpinned (or absent) to pinned. */
export function isPinTransition(before: { pinned?: unknown } | null | undefined, after: { pinned?: unknown } | null | undefined): boolean {
  return !!after && after.pinned === true && before?.pinned !== true
}

/**
 * True when a write keeps a row pinned but makes the pin stronger: a higher
 * effective priority, or a move to the hard tier (H5). Under `request` or
 * `deny` that is refused for a restricted caller like a new pin; lowering a
 * pin, unpinning and a new pin ({@link isPinTransition}) are not escalations.
 */
export function isPinEscalation(
  before: { pinned?: unknown; pinned_tier?: unknown; pinned_priority?: unknown } | null | undefined,
  after: { pinned?: unknown; pinned_tier?: unknown; pinned_priority?: unknown } | null | undefined,
): boolean {
  if (!before || before.pinned !== true || !after || after.pinned !== true) return false
  if (isHardPinned(after) && !isHardPinned(before)) return true
  return effectivePinnedPriority(after) > effectivePinnedPriority(before)
}

/**
 * The refusal for a pin escalation by a restricted caller (H5). A pin request
 * cannot carry it: the request record lives on unpinned rows only, so under
 * `request` it is refused as under `deny`, with the owner's command named.
 */
export function pinEscalationDenied(id: string, via: string, agents: PinDecision): PinDeniedError {
  return new PinDeniedError(id, `${via}:escalate`,
    `Raising the priority or tier of a pin is reserved for the owner on this install (pinning.agents: ${agents}), so ${id} was not changed. `
    + `Ask the owner to run \`plur pins priority ${id} <n>\` or re-pin it with the tier wanted.`)
}

/** One pending request, as `pendingPinRequests()` lists it. */
export interface PendingPinRequest {
  id: string
  statement: string
  scope: string
  request: PinRequest
}

/**
 * The one-line session-start notice for pending pin requests, or '' when
 * there are none. The injection side prints it.
 */
export function formatPendingPinRequestsLine(pending: readonly unknown[] | number): string {
  const n = typeof pending === 'number' ? pending : pending.length
  if (n <= 0) return ''
  return `${n} pin request${n === 1 ? '' : 's'} waiting for the owner — review with \`plur pins review\`.`
}

// ── Fit report (D3) ─────────────────────────────────────────────────────────

/** True when the engram is a prohibition, by the injection's own polarity predicate. */
export function isProhibition(e: { statement: string; polarity?: unknown }): boolean {
  return (e.polarity ?? classifyPolarity(e.statement)) === 'dont'
}

/**
 * Order of pins that tie on origin, tier and priority (D3): prohibitions
 * first, then oldest first, then id. Exported so injection can adopt the same
 * order; the fit report uses it as the tiebreak a task's relevance score is
 * at injection time.
 */
export function comparePinTiebreak(
  a: { id: string; statement: string; polarity?: unknown; created_at?: unknown },
  b: { id: string; statement: string; polarity?: unknown; created_at?: unknown },
): number {
  const pa = isProhibition(a) ? 0 : 1
  const pb = isProhibition(b) ? 0 : 1
  if (pa !== pb) return pa - pb
  const ca = typeof a.created_at === 'string' ? a.created_at : ''
  const cb = typeof b.created_at === 'string' ? b.created_at : ''
  if (ca !== cb) return ca < cb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** One pin in the fit report. */
export interface PinFitEntry {
  id: string
  statement: string
  scope: string
  /** Effective priority (1–100, default 50; higher loads first). Not used for hard-tier pins. */
  priority: number
  /** Whether a priority was set explicitly. */
  priority_set: boolean
  tier: 'hard' | 'soft'
  /** Token cost against the injection budget (`estimateTokens`). */
  cost: number
  prohibition: boolean
  /** Where the pin comes from: the local store, a team/secondary store, or a pack. */
  origin: 'local' | 'store' | 'pack'
  /** Whether it fits the pinned share in the injection order. */
  fits: boolean
  /** Why it does not fit, when it does not. */
  reason?: OmittedPinned['reason']
}

/** The pinned set against its share of the budget. */
export interface PinFitReport {
  /** The injection budget the report is computed for. */
  budget: number
  /** `injection.pinned_ratio`, clamped. */
  pinned_ratio: number
  /** Tokens the pinned share holds: floor(budget × pinned_ratio). */
  share: number
  /** The hard tier's sub-cap inside the share. */
  hard_cap: number
  /** Tokens all pins together cost. */
  total_cost: number
  /** Tokens the pins that fit use. */
  used: number
  /** Share of the WHOLE budget the pins would take if all loaded (total_cost / budget). */
  load_ratio: number
  count: number
  overflow_count: number
  /** Every pin, in injection order. */
  entries: PinFitEntry[]
}

/**
 * Compute which pins fit the pinned share, by running the injection's own
 * selector (`fillTokenBudget`) over the pinned set alone. The share, the hard
 * cap and the ordering (origin, hard tier, priority) are therefore exactly
 * injection's; only the last tiebreak — a task's relevance score at
 * injection — is replaced by {@link comparePinTiebreak}, since a report has
 * no task.
 */
export function computePinFitReport(
  pinned: readonly Engram[],
  opts: { budget: number; pinnedRatio?: number; hardRatio?: number },
): PinFitReport {
  const budget = Math.max(0, Math.floor(opts.budget))
  const ratio = pinnedShareRatio(opts.pinnedRatio ?? 0.5)
  const hardRatio = opts.hardRatio ?? DEFAULT_PINNED_HARD_RATIO
  const share = Math.floor(budget * ratio)
  const hardCap = pinnedHardCap(budget, hardRatio, ratio)
  // Score encodes the tiebreak: the earlier in tiebreak order, the higher.
  const ordered = [...pinned].sort(comparePinTiebreak)
  const scored = ordered.map((e, i) => ({ ...(e as object), score: ordered.length - i }) as never as Engram & { score: number })
  const { selected, omitted_pinned } = fillTokenBudget(scored as never, budget, budget, { spent: 0 }, hardRatio, ratio)
  const fitIds = new Set(selected.map(s => s.id))
  const omittedById = new Map(omitted_pinned.map(o => [o.id, o]))
  // Injection order, for display: the selector's own sort.
  const inOrder = [...scored].sort((a, b) =>
    pinnedOriginRank(a as never) - pinnedOriginRank(b as never)
    || (isHardPinned(a as never) ? 0 : 1) - (isHardPinned(b as never) ? 0 : 1)
    || (isHardPinned(a as never) ? 0 : effectivePinnedPriority(b as never) - effectivePinnedPriority(a as never))
    || b.score - a.score)
  const entries: PinFitEntry[] = inOrder.map(e => {
    const rank = pinnedOriginRank(e as never)
    const cost = estimateTokens(e as never)
    const omitted = omittedById.get(e.id)
    return {
      id: e.id,
      statement: e.statement,
      scope: e.scope,
      priority: effectivePinnedPriority(e as never),
      priority_set: typeof (e as { pinned_priority?: unknown }).pinned_priority === 'number',
      tier: isHardPinned(e as never) ? 'hard' : 'soft',
      cost,
      prohibition: isProhibition(e),
      origin: rank === 2 ? 'pack' : rank === 1 ? 'store' : 'local',
      fits: fitIds.has(e.id),
      ...(omitted ? { reason: omitted.reason } : {}),
    }
  })
  const total = entries.reduce((n, e) => n + e.cost, 0)
  const used = entries.filter(e => e.fits).reduce((n, e) => n + e.cost, 0)
  return {
    budget, pinned_ratio: ratio, share, hard_cap: hardCap,
    total_cost: total, used,
    load_ratio: budget > 0 ? total / budget : 0,
    count: entries.length,
    overflow_count: entries.filter(e => !e.fits).length,
    entries,
  }
}

/**
 * The one-line notice for pins that do not fit the share, or '' when all fit.
 * Shared by `plur doctor`, `plur pins` and the session-start notice.
 */
export function formatPinOverflowLine(report: Pick<PinFitReport, 'overflow_count' | 'count' | 'total_cost' | 'share' | 'budget'>): string {
  if (report.overflow_count <= 0) return ''
  return `${report.overflow_count} of ${report.count} pinned engram${report.count === 1 ? '' : 's'} do not fit the pinned share `
    + `(${report.total_cost} tokens pinned, share ${report.share} of a ${report.budget}-token budget) and are not loaded — see \`plur pins\`.`
}
