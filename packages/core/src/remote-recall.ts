/**
 * Server-authoritative remote recall: one live, timeout-bounded `POST {host}/api/v1/recall`
 * per (url, token) group, merged with local results. NO disk caching of remote engrams; unreachable → local-only + loud degradation.
 * - States: timeout/unreachable count toward the breaker (3 → 5 min skipped_cooldown); 401 auth_expired;
 *   two consecutive 403s forbidden (one is unreachable); 404 unsupported 10 min; 429 honours Retry-After; 422 is neutral.
 * - Breaker, cooldown and 404 TTL are per HOST; 403 streak and 429 per CREDENTIAL. Persisted under the
 *   file lock in `<root>/cache/remote-health.json` (hooks are one-shot); tokens only as truncated hashes.
 * - Dial only relevant scopes (same org; `user:` only with org context; see `Plur._remoteRecallHosts`); no
 *   context → zero calls. `dial: always|never` per store and `PLUR_REMOTE_RECALL=off` override.
 */

import * as fs from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { z } from 'zod'
import type { Engram } from './schemas/engram.js'
import { normalizeEndpointUrl, salvageRemoteRow, safeOrigin } from './store/remote-store.js'
import { isScopeWithin, isSharedScope } from './scope-util.js'
import { namespaceEngramId } from './engrams.js'
import { logger } from './logger.js'
import { enterpriseRecoveryHint } from './enterprise.js'
import { withLock } from './file-lock.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the query text sent to a remote host — same privacy rationale
 * as the hook's task truncation (hook-inject.ts): retrieval only needs enough
 * signal to rank candidates; the rest is privacy bleed of pasted secrets or
 * proprietary content.
 */
export const MAX_REMOTE_QUERY_CHARS = 1000

/** Hard cap on a remote response body — prevents OOM/stall from a
 *  misconfigured or adversarial server returning multi-megabyte JSON. */
export const MAX_REMOTE_RESPONSE_BYTES = 128 * 1024

/** Default per-call budget. MCP recall keeps this; the hook passes 1500 ms,
 *  session_start warm passes 5000 ms. `PLUR_REMOTE_RECALL_TIMEOUT_MS` wins. */
export const DEFAULT_REMOTE_RECALL_TIMEOUT_MS = 2000

/** Consecutive network-class failures (timeout/unreachable/5xx/bad body)
 *  before the circuit breaker opens for {@link BREAKER_COOLDOWN_MS}. */
export const BREAKER_FAILURE_THRESHOLD = 3
export const BREAKER_COOLDOWN_MS = 5 * 60 * 1000

/**
 * How long an open breaker waits before it lets ONE trial read through, so a
 * host that recovers soon after the breaker opens is not parked for the full
 * {@link BREAKER_COOLDOWN_MS}. One trial per cooldown, claimed
 * under the health-file lock so concurrent processes do not all dial at once. A
 * success closes the breaker; a network failure re-opens it for a full cooldown.
 */
export const BREAKER_HALF_OPEN_AFTER_MS = 60 * 1000

/**
 * End-to-end deadline for one recall call, covering the local pipeline and the
 * post-recall bookkeeping write (which can wait up to 180 s for the store
 * lock) as well as the remote leg. A recall returns
 * within this deadline with whatever is ready and says what is missing.
 * `PLUR_RECALL_DEADLINE_MS` overrides it.
 */
export const DEFAULT_RECALL_DEADLINE_MS = 10_000

/**
 * How long a recall waits for the store lock before it skips its freshness
 * bookkeeping. The bookkeeping (frequency, last_accessed, co-access
 * edges) is not the answer to the read; a read must not queue behind a writer
 * for it. Uncontended, the lock is taken in milliseconds and nothing changes.
 */
export const RECALL_BOOKKEEPING_LOCK_WAIT_MS = 500

/**
 * How many `client_slow` results in a row a host is given before further ones
 * count as host timeouts. A `client_slow` result is not the
 * host's fault on its own; but a process whose loop is blocked on EVERY call
 * would otherwise never open the breaker against a server that is really
 * dead, and would pay the full hard cap on each call. After this many in a
 * row the host has had its chances: the next one is evidence about it too.
 * Any answer from the host resets the run.
 */
export const CLIENT_SLOW_STREAK_LIMIT = 3

/** How long before a recall's deadline the remote leg aborts the requests
 *  still in flight, so their outcome is recorded before the reply. */
const DEADLINE_ABORT_LEAD_MS = 25

/** Resolve the effective recall deadline: env override → caller value → default. */
export function resolveRecallDeadlineMs(
  callerMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envMs = parseInt(env.PLUR_RECALL_DEADLINE_MS ?? '', 10)
  if (Number.isFinite(envMs) && envMs > 0) return envMs
  if (typeof callerMs === 'number' && callerMs > 0) return callerMs
  return DEFAULT_RECALL_DEADLINE_MS
}

/** How long a 404 parks a host on `unsupported` — bounded, NOT process
 *  lifetime: a long-lived MCP server must not park a healthy host on the
 *  legacy path after one LB hiccup until restart. */
export const UNSUPPORTED_TTL_MS = 10 * 60 * 1000

/** 429 cooldown when the server sends no usable Retry-After. */
export const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 30 * 1000
/** Upper bound on an honored Retry-After — a hostile/buggy header must not
 *  park a host for a day. */
export const RATE_LIMIT_MAX_COOLDOWN_MS = 60 * 60 * 1000

/** Hook-header suppression window: after printing (host, state), the same
 *  pair prints again at most once per this window (default 4h). */
export const HOOK_HEADER_REPEAT_MS = 4 * 60 * 60 * 1000

/** How often {@link startBudgetTimer} samples the event loop to tell elapsed
 *  time apart from time this process spent unable to service I/O. */
export const BUDGET_TICK_MS = 50

/**
 * Ceiling on the extra wall time a request may earn back from event-loop
 * starvation (see {@link startBudgetTimer}).
 *
 * Absolute rather than a multiple of the budget: the hook path runs inside a
 * user's prompt with a 1500 ms budget, and a multiplier would let a starved
 * process stretch that into something a human notices. Credit is only ever
 * earned while the loop is genuinely blocked — during which the caller is
 * already waiting on that local work — so the practical worst case is bounded
 * by the local work, not by this constant.
 */
export const MAX_STARVATION_CREDIT_MS = 5000

/**
 * {@link startBudgetTimer}: a timeout that counts time the request was actually
 * SERVICED. Local work (e.g. BGE embedder init) blocks the event loop, and a
 * plain timer would charge that to the host, so the breaker parks healthy
 * hosts on cold hook calls. Ticks every {@link BUDGET_TICK_MS}; late ticks are
 * credited back, capped by {@link MAX_STARVATION_CREDIT_MS}. Returns a cancel function.
 */
/** Why a {@link startBudgetTimer} fired. */
export interface BudgetExpiry {
  /** Extra wall time credited back because this process's loop was blocked. */
  creditMs: number
  /** Wall time since the timer started. */
  wallMs: number
  /**
   * True when the timer fired (at the wall-clock hard cap) BEFORE the request
   * had its full serviced budget — the time was lost to this process's own
   * blocked event loop, not to the host. Such a timeout is `client_slow` and
   * is never counted against the host's breaker.
   */
  clientSlow: boolean
}

export function startBudgetTimer(
  budgetMs: number,
  onExpire: (info: BudgetExpiry) => void,
  opts: { tickMs?: number; maxCreditMs?: number; now?: () => number } = {},
): () => void {
  const now = opts.now ?? Date.now
  const tickMs = Math.max(1, opts.tickMs ?? BUDGET_TICK_MS)
  const maxCredit = Math.max(0, opts.maxCreditMs ?? MAX_STARVATION_CREDIT_MS)
  const started = now()
  let last = started
  let credit = 0
  /** All blocked time observed, uncapped — tells a client-side expiry apart:
   *  `credit` stops at the cap, the loop does not stop blocking. */
  let blocked = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false
  /** The delay the pending tick was scheduled for — a late tick is measured
   *  against it, not against the full `tickMs`. */
  let scheduled = tickMs

  const schedule = (): void => {
    if (done) return
    const serviced = (now() - started) - credit
    const remaining = Math.max(1, Math.min(tickMs, budgetMs - serviced))
    scheduled = remaining
    timer = setTimeout(tick, remaining)
    // Never hold the process open on account of a timeout sampler.
    ;(timer as { unref?: () => void }).unref?.()
  }

  const tick = (): void => {
    if (done) return
    const t = now()
    // Anything beyond the interval we asked for is time the loop was busy
    // elsewhere — the request was not being serviced, so it is not charged.
    const overshoot = Math.max(0, (t - last) - scheduled)
    blocked += overshoot
    credit = Math.min(maxCredit, credit + overshoot)
    last = t
    const wall = t - started
    if ((wall - credit) >= budgetMs || wall >= budgetMs + maxCredit) {
      done = true
      // Client-side when the time the request was actually serviced — wall
      // time minus ALL blocked time — is still short of the budget: the
      // budget ran out on this process's loop, not on the host.
      onExpire({ creditMs: credit, wallMs: wall, clientSlow: (wall - blocked) < budgetMs })
      return
    }
    schedule()
  }

  schedule()
  return () => { done = true; if (timer) clearTimeout(timer) }
}

/**
 * How long a recorded per-host outcome may still be shown as CURRENT. A recall
 * that dials nothing leaves the old entry in place, so without this an early
 * failure would be reported for the life of the process. Aligned with
 * {@link BREAKER_COOLDOWN_MS}.
 */
export const REMOTE_STATUS_TTL_MS = BREAKER_COOLDOWN_MS

/**
 * States a successful non-recall interaction (e.g. the `/me` probe) genuinely
 * contradicts and may therefore clear: network-class only. `unsupported`,
 * `rate_limited` and authorization states must not be masked by a probe on a
 * different route — a silent failure is worse than a false alarm.
 */
export const PROBE_CLEARABLE_STATES: ReadonlySet<RemoteHostState> =
  new Set<RemoteHostState>(['timeout', 'unreachable', 'skipped_cooldown', 'client_slow'])

/**
 * Wait for `p` until the epoch-ms `deadlineAt`. Never rejects: a
 * rejection reads as `{ done: true, error }`. The promise keeps running when
 * the deadline wins — callers that abandon it must not need its result.
 */
export async function settleBy<T>(
  p: Promise<T>,
  deadlineAt: number,
): Promise<{ done: true; value?: T; error?: unknown } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ done: false }>(resolve => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, deadlineAt - Date.now()))
  })
  try {
    return await Promise.race([
      p.then(value => ({ done: true as const, value }), error => ({ done: true as const, error })),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Env knobs
// ---------------------------------------------------------------------------

/** `PLUR_REMOTE_RECALL=off|0|false` (client convention) kills the remote
 *  recall leg entirely — zero fetches, zero new latency. */
export function isRemoteRecallDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PLUR_REMOTE_RECALL ?? '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false'
}

/** Resolve the effective per-call timeout: env override → caller value →
 *  default. Mirrors the hook's PLUR_HOOK_CEILING_MS env-override precedent. */
export function resolveRemoteRecallTimeoutMs(
  callerMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envMs = parseInt(env.PLUR_REMOTE_RECALL_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(envMs) && envMs > 0) return envMs
  if (typeof callerMs === 'number' && callerMs > 0) return callerMs
  return DEFAULT_REMOTE_RECALL_TIMEOUT_MS
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RemoteHostState =
  | 'ok'
  | 'timeout'
  | 'unreachable'
  | 'auth_expired'
  | 'forbidden'
  | 'rate_limited'
  | 'unsupported'
  | 'skipped_cooldown'
  /** The request timed out because THIS process's event loop was
   *  blocked (cold start, busy machine) — not counted against the host. */
  | 'client_slow'

/** One host's part in one recall call. */
export interface RecallRemoteHostReport {
  host: string
  state: RemoteHostState
  ms: number
  count: number
  /** The ids (namespaced, as in the results) of the rows THIS host returned,
   *  listed before rows from several hosts are merged: one server's ids can
   *  equal another's, and the merged results keep the first host's row. The
   *  only per-host attribution a caller gets. */
  ids: string[]
  detail?: string
}

/**
 * What the remote (server) leg did on ONE recall call. Unlike
 * `remote_stores` / {@link RemoteStoreStatusEntry}, which report the latest
 * outcome per host for the whole process, this describes this call only.
 * `state` is `ok` when every dialed host answered, the first non-ok host's
 * state otherwise, and `not_dialed` when no host was dialed (no store
 * configured or implicated, `remote: false`, or the kill-switch).
 */
export interface RecallRemoteReport {
  state: RemoteHostState | 'not_dialed'
  hosts: RecallRemoteHostReport[]
}

/** Build the per-call report from host outcomes. */
export function buildRecallRemoteReport(outcomes: HostRecallOutcome[]): RecallRemoteReport {
  const hosts: RecallRemoteHostReport[] = outcomes.map(o => ({
    host: normalizeEndpointUrl(o.url),
    state: o.state,
    ms: o.ms,
    count: o.count,
    ids: o.ids ?? [],
    ...(o.detail ? { detail: o.detail } : {}),
  }))
  if (hosts.length === 0) return { state: 'not_dialed', hosts }
  return { state: hosts.find(h => h.state !== 'ok')?.state ?? 'ok', hosts }
}

export interface HostRecallOutcome {
  url: string
  state: RemoteHostState
  /** Wall time spent on this host (0 when skipped without a fetch). */
  ms: number
  /** Rows accepted from this host after validation + scope guard. */
  count: number
  /** Their namespaced ids, in this host's order (absent: none accepted). */
  ids?: string[]
  /** Server-reported mode that ACTUALLY ran (envelope `mode`). */
  mode?: string
  /** Server-reported: the semantic (vector) leg actually ran. */
  vector?: boolean
  /** Requested scope selectors the server silently narrowed away. */
  dropped_scopes?: string[]
  /** Bounded diagnostic detail (never server-controlled free text). */
  detail?: string
}

/** One (url, token) endpoint group to dial, with the RELEVANT granted-scope
 *  subset (already dialing-filtered by the caller) and the store entries for
 *  deterministic row→entry namespacing (config order). */
export interface RemoteRecallHost {
  url: string
  token: string
  /** Scopes to request from this host — the dialed relevant subset. */
  scopes: string[]
  /** Store entries (config order) backing those scopes — the caller passes
   *  the DIALED entries only. Rows map to the FIRST dialed entry whose scope
   *  contains the row's scope; `global` rows map to the first DIALED entry.
   *  This is not what `_loadSecondaryAndPacks` does: that leg narrows a
   *  `global` row into EVERY store entry whose load returned it, so a global
   *  row has one load-leg id per such entry and the recall-leg id matches the
   *  one for this host's first dialed entry. */
  entries: Array<{ scope: string }>
}

export interface RemoteRecallResult {
  /** Validated, scope-guarded, namespaced rows across all hosts (deduped by
   *  namespaced id — first host wins, scores max-merged). */
  engrams: Engram[]
  /** Per-namespaced-id relevance in [0,1]: the server's per-response score
   *  when present, else rank-mapped within that host's accepted rows. */
  scores: Map<string, number>
  outcomes: HostRecallOutcome[]
}

export interface RemoteRecallOptions {
  /** Total per-host budget (headers + body). */
  timeoutMs?: number
  /** Connect-phase budget (until response headers). Must be shorter than the
   *  total budget so a blackholed route fails fast. Default: 2/3 of total. */
  connectTimeoutMs?: number
  limit?: number
  /** Health-state file path (default `<PLUR_PATH|~/.plur>/cache/remote-health.json`). */
  statePath?: string
  now?: () => number
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** Starvation-credit ceiling for the budget timers (default
   *  {@link MAX_STARVATION_CREDIT_MS}); a test seam. */
  maxStarvationCreditMs?: number
  /**
   * The recall's end-to-end deadline (epoch ms). Requests still in
   * flight are aborted just before it and reported `timeout` with detail
   * `recall_deadline` — without counting against the host's breaker, since
   * the recall's deadline is not the host's budget. Hosts that answered keep
   * their rows and outcomes. The call resolves by this time even when a
   * request ignores its abort signal.
   */
  deadlineAt?: number
}

// ---------------------------------------------------------------------------
// Persistent per-host health state
// ---------------------------------------------------------------------------

/**
 * Per-CREDENTIAL state. Recall dials per
 * (url, token), and two tokens on one url are two credentials with
 * independent validity and — the server limits per principal — independent
 * rate budgets. Keyed by {@link tokenHealthKey}, never by the token itself.
 */
interface TokenHealth {
  /** Consecutive 403s for THIS token — 2 required before `forbidden`. */
  forbidden_count?: number
  /** 429 Retry-After cooldown for THIS token (epoch ms). */
  rate_limited_until?: number
}

interface HostHealth {
  /** Consecutive network-class failures (timeout/unreachable/5xx/bad body).
   *  Reachability is a fact about the HOST, shared by every token. */
  failures?: number
  /** Breaker open until (epoch ms) — `skipped_cooldown` while in force, for
   *  every token. Set by the network breaker only; a 429 cools down the token
   *  that earned it (`tokens[k].rate_limited_until`). An older file may still
   *  carry a 429 cooldown here; it is honored until it expires. */
  cooldown_until?: number
  /** When the breaker cooldown opened (epoch ms), for the trial read. When
   *  absent it is derived as `cooldown_until − cooldown`. */
  cooldown_opened_at?: number
  /** When this cooldown's one trial read was claimed (epoch ms). */
  half_open_trial_at?: number
  /** 404 TTL — `unsupported` while in force. */
  unsupported_until?: number
  /** Consecutive `client_slow` results; reset by any answer. */
  client_slow_streak?: number
  /** Legacy host-wide 403 streak, from before the per-token split. Ignored
   *  and dropped on the next dial: a streak built from several tokens'
   *  403s is not evidence that any one of them was revoked. */
  forbidden_count?: number
  /** Per-credential state, keyed by {@link tokenHealthKey}. */
  tokens?: Record<string, TokenHealth>
  last_state?: RemoteHostState
  updated_at?: number
  /** Hook-header suppression bookkeeping. */
  printed_state?: string
  printed_at?: number
}

interface RemoteHealthFile {
  version: 1
  hosts: Record<string, HostHealth>
}

/**
 * The key a token's state is persisted under in remote-health.json: a
 * truncated SHA-256, so the file never holds a credential. 64 bits is ample to
 * keep a handful of tokens per host apart; a collision would only merge two
 * tokens' advisory state.
 */
export function tokenHealthKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16)
}

/** Default health-file path. Honors PLUR_PATH like the rest of the CLI. */
export function remoteHealthPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PLUR_PATH ?? join(homedir(), '.plur')
  return join(root, 'cache', 'remote-health.json')
}

export function readRemoteHealth(path: string): RemoteHealthFile {
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && raw.version === 1 && raw.hosts && typeof raw.hosts === 'object') {
      return raw as RemoteHealthFile
    }
  } catch { /* missing or corrupt → fresh state */ }
  return { version: 1, hosts: {} }
}

/**
 * Atomic unique-tmp write: two concurrent one-shot hook processes must never
 * interleave partial writes. Unique tmp name (pid + random) then rename.
 * Atomicity alone is not enough against LOST UPDATES — callers that mutate
 * state they read earlier must go through {@link persistHostChanges} or
 * {@link withRemoteHealthLock}, which re-read under the file lock.
 */
function writeRemoteHealth(path: string, file: RemoteHealthFile): boolean {
  try {
    fs.mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(file))
    fs.renameSync(tmp, path)
    return true
  } catch {
    // health persistence is best-effort — never break recall
    return false
  }
}

/** Lock options for remote-health.json — the critical section is a
 *  read+merge+rename of a small JSON file (milliseconds), and withLock's
 *  retry delay is a synchronous busy-wait, so keep the worst-case wait small
 *  (25+50+100 = 175 ms) rather than the 3.1 s engrams.yaml default. */
const HEALTH_LOCK_OPTS = { maxRetries: 3, baseDelay: 25 }

/**
 * Run `fn` holding the remote-health.json file lock (the same
 * `withLock` used for engrams.yaml/config.yaml persistence). Health state is
 * ADVISORY — if the lock cannot be acquired, `fallback` runs unlocked rather
 * than failing recall or dropping a degradation header.
 */
function withRemoteHealthLock<T>(statePath: string, fn: () => T, fallback: () => T): T {
  try {
    fs.mkdirSync(dirname(statePath), { recursive: true })
    return withLock(statePath, fn, HEALTH_LOCK_OPTS)
  } catch {
    return fallback()
  }
}

/** Counters: a change is applied as a delta against the current file, so two
 *  processes' increments add up; a reset to 0 is applied as 0. */
const COUNTER_FIELDS: ReadonlySet<string> = new Set(['failures', 'client_slow_streak', 'forbidden_count'])
/** Never written by a recall — owned by {@link claimHookDegradationLines}. */
const PRINT_FIELDS: ReadonlySet<string> = new Set(['printed_state', 'printed_at'])

/** Apply the field changes `before → after` onto `target` (in place). */
function applyFieldChanges(
  target: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  skip: ReadonlySet<string>,
  /** Fields this call observed and must write even when its own value did not
   *  change: the host answered, so `failures`, the
   *  cooldown and `last_state` are what it saw — whatever another process
   *  wrote meanwhile. */
  forced: ReadonlySet<string> = new Set(),
): boolean {
  let changed = false
  for (const k of new Set([...Object.keys(before), ...Object.keys(after), ...forced])) {
    if (skip.has(k)) continue
    const b = before[k]
    const a = after[k]
    if (forced.has(k)) {
      if (target[k] === a) continue
      changed = true
      if (a === undefined) delete target[k]; else target[k] = a
      continue
    }
    if (b === a) continue
    changed = true
    if (a === undefined) { delete target[k]; continue }
    if (COUNTER_FIELDS.has(k) && typeof a === 'number' && a !== 0) {
      const base = typeof target[k] === 'number' ? target[k] as number : 0
      target[k] = Math.max(0, base + a - (typeof b === 'number' ? b : 0))
      continue
    }
    target[k] = a
  }
  return changed
}

/**
 * Persist only the fields this call CHANGED about each host, against the
 * current file under the lock; counters apply as deltas. Writing whole entries
 * would erase concurrent updates (trial claims, cooldown clears, another
 * token's 429). Never write `printed_state`/`printed_at`: a recall does not own
 * them, and clobbering a {@link claimHookDegradationLines} claim double-prints.
 */
function persistHostChanges(
  statePath: string,
  changes: Array<{ key: string; before: HostHealth; after: HostHealth; forced?: ReadonlySet<string> }>,
): void {
  if (changes.length === 0) return
  const readApplyWrite = (): void => {
    const current = readRemoteHealth(statePath)
    let dirty = false
    for (const { key, before, after, forced } of changes) {
      const cur: HostHealth = { ...(current.hosts[key] ?? {}) }
      // A success this call saw is older than what the file now says about the host (another process recorded failures or
      // opened the breaker after it — e.g. while a slower host of this same
      // call was still pending). The newer record wins: this call's host-level
      // fields are not written; per-token state still is.
      const staleSuccess = after.last_state === 'ok'
        && typeof cur.updated_at === 'number' && typeof after.updated_at === 'number'
        && cur.updated_at > after.updated_at
      let changed = staleSuccess ? false : applyFieldChanges(
        cur as Record<string, unknown>, before as Record<string, unknown>, after as Record<string, unknown>,
        new Set([...PRINT_FIELDS, 'tokens']), forced,
      )
      // The record's time never moves backwards.
      if (changed && typeof current.hosts[key]?.updated_at === 'number' && typeof cur.updated_at === 'number'
        && cur.updated_at < current.hosts[key].updated_at!) {
        cur.updated_at = current.hosts[key].updated_at
      }
      const bt = before.tokens ?? {}
      const at = after.tokens ?? {}
      for (const tk of new Set([...Object.keys(bt), ...Object.keys(at)])) {
        const target: TokenHealth = { ...(cur.tokens?.[tk] ?? {}) }
        if (applyFieldChanges(target as Record<string, unknown>, (bt[tk] ?? {}) as Record<string, unknown>,
          (at[tk] ?? {}) as Record<string, unknown>, new Set())) {
          cur.tokens = { ...(cur.tokens ?? {}), [tk]: target }
          changed = true
        }
      }
      if (changed) { current.hosts[key] = cur; dirty = true }
    }
    if (dirty) writeRemoteHealth(statePath, current)
  }
  // Unlocked fallback is the same field-level read-apply-write — still far
  // narrower than a whole-entry overwrite when the lock is unavailable.
  withRemoteHealthLock(statePath, readApplyWrite, readApplyWrite)
}

/** When the current breaker cooldown opened. */
function cooldownOpenedAt(h: HostHealth): number {
  return h.cooldown_opened_at ?? ((h.cooldown_until ?? 0) - BREAKER_COOLDOWN_MS)
}

/**
 * Claim this cooldown's single trial read under the health-file lock
 * (re-reading inside it), so only one process dials.
 * - `trial`: claimed; dial it.
 * - `free`: cooldown already ended — dial normally; `current` resyncs the snapshot.
 * - `denied`: not due, already claimed, or the lock/persist failed (fails closed).
 */
function claimHalfOpenTrial(
  statePath: string, key: string, now: number,
): { result: 'trial' | 'free' | 'denied'; current?: HostHealth } {
  const claim = (): { result: 'trial' | 'free' | 'denied'; current?: HostHealth } => {
    const cur = readRemoteHealth(statePath)
    const ch: HostHealth = cur.hosts[key] ?? {}
    if (!((ch.cooldown_until ?? 0) > now)) return { result: 'free', current: { ...ch } }
    // A legacy host-wide 429 is honoured to its end (see remoteRecall).
    if (ch.last_state === 'rate_limited') return { result: 'denied' }
    const openedAt = cooldownOpenedAt(ch)
    if (now - openedAt < BREAKER_HALF_OPEN_AFTER_MS) return { result: 'denied' }
    if ((ch.half_open_trial_at ?? -Infinity) >= openedAt) return { result: 'denied' }
    ch.half_open_trial_at = now
    cur.hosts[key] = ch
    return writeRemoteHealth(statePath, cur) ? { result: 'trial' } : { result: 'denied' }
  }
  return withRemoteHealthLock(statePath, claim, () => ({ result: 'denied' }))
}

/**
 * Is this host's breaker open right now?
 *
 * Shared by the recall leg and the WRITE leg, so `flushOutbox()` does not
 * spend a full-timeout attempt per queued engram on a host the read leg
 * already knows is down: one host, one opinion about whether it is reachable.
 */
export function isHostInCooldown(
  url: string,
  now: number = Date.now(),
  statePath: string = remoteHealthPath(),
  /** The credential the caller will dial with. Without it only the host-wide
   *  breaker is consulted; with it, that token's own 429 cooldown too (a 429
   *  is per principal). */
  token?: string,
): { inCooldown: boolean; until?: number; reason?: 'breaker' | 'rate_limit' } {
  try {
    const health = readRemoteHealth(statePath)
    const h = health.hosts[normalizeEndpointUrl(url)]
    if (h?.cooldown_until && h.cooldown_until > now) {
      // Host-wide `cooldown_until` is the network breaker; only an older file
      // carries a 429 here, which `last_state` still labels. The skip decision is the same either way.
      return {
        inCooldown: true,
        until: h.cooldown_until,
        reason: h.last_state === 'rate_limited' ? 'rate_limit' : 'breaker',
      }
    }
    const th = token !== undefined ? h?.tokens?.[tokenHealthKey(token)] : undefined
    if (th?.rate_limited_until && th.rate_limited_until > now) {
      return { inCooldown: true, until: th.rate_limited_until, reason: 'rate_limit' }
    }
    return { inCooldown: false }
  } catch {
    // Health state is an optimisation. If it cannot be read, do NOT block the
    // write — a corrupt cache file must not become an outage.
    return { inCooldown: false }
  }
}

/**
 * Record a WRITE-leg failure into the same per-host state the recall leg uses,
 * so a host that only ever fails on writes still opens its breaker.
 *
 * Mirrors the recall leg's accounting: count consecutive network-class
 * failures, open for {@link BREAKER_COOLDOWN_MS} at
 * {@link BREAKER_FAILURE_THRESHOLD}. A success clears the counter.
 */
export function recordWriteOutcome(
  url: string,
  ok: boolean,
  now: number = Date.now(),
  statePath: string = remoteHealthPath(),
): void {
  try {
    const key = normalizeEndpointUrl(url)
    // Read-modify-write of the CURRENT entry under the lock: the change is
    // made against what the file says now, never against an earlier snapshot.
    const update = (): void => {
      const health = readRemoteHealth(statePath)
      const h: HostHealth = { ...(health.hosts[key] ?? {}) }
      if (ok) {
        h.failures = 0
        // The host answered: a run of client_slow results is over.
        h.client_slow_streak = 0
        // A save proves the host reachable, which ends a network cooldown
        // (timeout / unreachable). A host-wide 429 cooldown is the server's
        // own instruction to back off, not a reachability guess: a save does
        // not end it.
        const rateLimited = h.last_state === 'rate_limited' && (h.cooldown_until ?? 0) > now
        if (!rateLimited) {
          delete h.cooldown_until
          delete h.cooldown_opened_at
          delete h.half_open_trial_at
          h.last_state = 'ok'
        }
      } else {
        h.failures = (h.failures ?? 0) + 1
        h.last_state = 'unreachable'
        if (h.failures >= BREAKER_FAILURE_THRESHOLD) {
          h.cooldown_until = now + BREAKER_COOLDOWN_MS
          h.cooldown_opened_at = now
          delete h.half_open_trial_at
        }
      }
      h.updated_at = now
      health.hosts[key] = h
      writeRemoteHealth(statePath, health)
    }
    withRemoteHealthLock(statePath, update, update)
  } catch {
    // Same reasoning as above: never let health bookkeeping fail a write.
  }
}

// ---------------------------------------------------------------------------
// Org extraction for the dialing rule
// ---------------------------------------------------------------------------

/**
 * The org segment of a SHARED scope: `project:plur/plur-ai/enterprise` →
 * `plur`; `group:acme/eng` → `acme`; `group:test` → `test`. Personal-family
 * scopes (and `public`, which has no org) → null. Lower-cased for comparison
 * (scope prefixes are case-folded elsewhere too; stored values untouched).
 */
export function scopeOrg(scope: string | undefined): string | null {
  if (!scope || !isSharedScope(scope)) return null
  const colon = scope.indexOf(':')
  if (colon < 0) return null // bare 'public' — no org segment
  const org = scope.slice(colon + 1).split(/[/:]/)[0]?.trim().toLowerCase()
  return org || null
}

// ---------------------------------------------------------------------------
// Envelope validation
// ---------------------------------------------------------------------------

/**
 * Tolerant envelope. Old servers may
 * return a bare envelope without mode/vector/effective_scopes/dropped_scopes
 * — every field beyond `results` is optional, and unknown fields pass
 * through. A bare array body (defensively) coerces to `{results: [...]}`.
 */
const RecallEnvelopeSchema = z.object({
  results: z.array(z.unknown()).default([]),
  count: z.number().optional(),
  mode: z.string().optional(),
  requested_mode: z.string().optional(),
  vector: z.boolean().optional(),
  effective_scopes: z.array(z.string()).optional(),
  dropped_scopes: z.array(z.string()).optional(),
}).passthrough()

// ---------------------------------------------------------------------------
// Row post-processing
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Stamp a store row the way a store LOADER does: narrow `global` to the
 * store's scope, namespace the id (idempotently — `namespaceEngramId`), and
 * set the loader markers `_originalId` / `_storeScope`. Any `_`-prefixed key
 * the row itself carried is dropped first: loader markers are the loader's,
 * never the row's. The input is not mutated.
 *
 * Exported so both remote ingestion legs can share ONE rule; the recall leg
 * uses it below.
 */
export function stampStoreRow(e: Engram, storeScope: string): Engram {
  const cloned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e as unknown as Record<string, unknown>)) {
    if (!k.startsWith('_')) cloned[k] = v
  }
  if (cloned.scope === 'global') cloned.scope = storeScope
  const originalId = String(cloned.id)
  cloned.id = namespaceEngramId(originalId, storeScope)
  cloned._originalId = originalId
  cloned._storeScope = storeScope
  return cloned as unknown as Engram
}

/**
 * Validate, scope-guard and namespace one host's rows, and derive scores
 * (server score, else rank-mapped). Rows must fall within a DIALED scope;
 * `global` rows are admitted and narrowed, as in `_loadSecondaryAndPacks`.
 * Row→entry mapping is deterministic (first dialed entry in config order), or
 * RRF dedup splits and feedback misroutes. Rows get `last_accessed = today`
 * and `retrieval_strength = server ?? 0.7` so they do not enter ranking mid-decay.
 */
function processHostRows(
  rawRows: unknown[],
  host: RemoteRecallHost,
  today: string,
): { engrams: Engram[]; scores: Map<string, number> } {
  const dialed = new Set(host.scopes)
  const dialedEntries = host.entries.filter(e => dialed.has(e.scope))
  const accepted: Array<{ engram: Engram; serverScore: number | undefined }> = []

  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    // Rows are top-level engrams per the recall envelope; tolerate the DB-row
    // shape {id, scope, status, data} some surfaces emit (same reshape rule
    // as RemoteStore: authoritative columns win over `data`).
    const candidate = (r.data && typeof r.data === 'object' && !('statement' in r))
      ? { ...(r.data as Record<string, unknown>), id: r.id, scope: r.scope, status: r.status }
      : r
    // Schema-drift salvage — same rule as RemoteStore.reshape (shared helper):
    // an engram whose only problem is a drifted optional field stays in
    // recall, minus that field, instead of silently vanishing.
    const salvaged = salvageRemoteRow(candidate as Record<string, unknown>, { url: host.url, rowId: (candidate as Record<string, unknown>).id })
    if (!salvaged) {
      const safeId = String((candidate as Record<string, unknown>).id ?? '').replace(/[^\w:./-]/g, '?').slice(0, 64)
      logger.debug(`[plur:remote-recall] ${safeOrigin(host.url)} returned a malformed row (id="${safeId}") — dropped`)
      continue
    }
    const e = salvaged.data as unknown as Engram
    // Scope guard with explicit global admission.
    const entry = e.scope === 'global'
      ? dialedEntries[0]
      : dialedEntries.find(en => isScopeWithin(e.scope, en.scope))
    if (!entry) {
      logger.debug(`[plur:remote-recall] ${safeOrigin(host.url)} row ${e.id} outside dialed scopes (${e.scope}) — dropped`)
      continue
    }
    const cloned = stampStoreRow(e, entry.scope) as any
    // Served by a url store (see the same marker in `_loadSecondaryAndPacks`).
    // Set after the stamp, which drops `_`-prefixed keys the row ships.
    cloned._fromRemoteStore = true
    // The injection scorer iterates `tags` unguarded — a row without them
    // must not throw at scoring time.
    if (!Array.isArray(cloned.tags)) cloned.tags = []
    // Activation normalization — synthesized-fresh. The raw `...act` spread
    // goes FIRST: spread after the type-guarded defaults, it would overwrite
    // them with the very server values they guard (e.g. a string
    // `storage_strength` reaching ranking arithmetic). Unmodelled keys still
    // pass through.
    const act = (cloned.activation && typeof cloned.activation === 'object') ? cloned.activation : {}
    cloned.activation = {
      ...act,
      storage_strength: typeof act.storage_strength === 'number' ? act.storage_strength : 1.0,
      frequency: typeof act.frequency === 'number' ? act.frequency : 0,
      retrieval_strength: typeof act.retrieval_strength === 'number' ? act.retrieval_strength : 0.7,
      last_accessed: today,
    }
    const serverScore = typeof (r as any).score === 'number' && Number.isFinite((r as any).score)
      ? clamp01((r as any).score)
      : undefined
    // The wire `score` is response metadata, not engram data — don't let it
    // masquerade as an engram field downstream.
    delete cloned.score
    accepted.push({ engram: cloned as Engram, serverScore })
  }

  const n = accepted.length
  const scores = new Map<string, number>()
  const engrams: Engram[] = []
  for (let i = 0; i < n; i++) {
    const { engram, serverScore } = accepted[i]
    // Rank-mapped fallback when the server sent no score: top row → 1.0,
    // monotonically decreasing, matching the server contract's shape.
    scores.set(engram.id, serverScore ?? (n - i) / n)
    engrams.push(engram)
  }
  return { engrams, scores }
}

// ---------------------------------------------------------------------------
// Body reading with cap
// ---------------------------------------------------------------------------

async function readBodyCapped(res: Response, cap: number): Promise<string | null> {
  const len = res.headers.get('content-length')
  if (len && parseInt(len, 10) > cap) return null
  const body = (res as { body?: { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } }).body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > cap) {
          try { await reader.cancel() } catch { /* already dead */ }
          return null
        }
        chunks.push(Buffer.from(value))
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  const text = await res.text()
  return Buffer.byteLength(text, 'utf8') > cap ? null : text
}

function parseRetryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null
  const secs = parseInt(header, 10)
  if (Number.isFinite(secs) && String(secs) === header.trim()) return Math.max(0, secs * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return null
}

// ---------------------------------------------------------------------------
// remoteRecall
// ---------------------------------------------------------------------------

/**
 * Dial every host in parallel (`Promise.allSettled`), each within its own
 * AbortController budget (connect-phase budget shorter than total), and
 * return validated/namespaced rows + per-host outcomes. Never throws; never
 * blocks past the budget (nor past `opts.deadlineAt`). Health state is read
 * once at entry; at exit only the fields this call changed, for the hosts it
 * dialed, are written — against the current file, under the file lock (see
 * {@link persistHostChanges}) — so concurrent processes don't lose each
 * other's updates.
 */
export async function remoteRecall(
  hosts: RemoteRecallHost[],
  query: string,
  opts: RemoteRecallOptions = {},
): Promise<RemoteRecallResult> {
  const env = opts.env ?? process.env
  if (hosts.length === 0 || isRemoteRecallDisabled(env)) {
    return { engrams: [], scores: new Map(), outcomes: [] }
  }
  const timeoutMs = resolveRemoteRecallTimeoutMs(opts.timeoutMs, env)
  const connectMs = opts.connectTimeoutMs ?? Math.max(1, Math.floor(timeoutMs * 2 / 3))
  const now = opts.now ?? Date.now
  const fetchImpl = opts.fetchImpl ?? fetch
  const timerOpts = opts.maxStarvationCreditMs !== undefined ? { maxCreditMs: opts.maxStarvationCreditMs } : {}
  const statePath = opts.statePath ?? remoteHealthPath(env)
  const health = readRemoteHealth(statePath)
  const today = new Date().toISOString().slice(0, 10)
  const truncatedQuery = query.length > MAX_REMOTE_QUERY_CHARS ? query.slice(0, MAX_REMOTE_QUERY_CHARS) : query
  // Each host's entry as read at entry, so the end of the
  // call can persist only what THIS call changed — and only for hosts it
  // actually dialed. A call that did not dial has nothing new to say.
  const snapshots = new Map<string, HostHealth>()
  const dialedKeys = new Set<string>()
  const trialKeys = new Set<string>()
  /** Per host, the fields this call observed directly. */
  const forcedKeys = new Map<string, Set<string>>()
  const force = (key: string, ...fields: string[]) => {
    const set = forcedKeys.get(key) ?? new Set<string>()
    for (const f of fields) set.add(f)
    forcedKeys.set(key, set)
  }
  // The recall deadline aborts what is still in flight.
  const deadlineAt = opts.deadlineAt
  const inflight = new Set<AbortController>()
  let deadlineHit = false

  const dialHost = async (host: RemoteRecallHost): Promise<{
    outcome: HostRecallOutcome
    engrams: Engram[]
    scores: Map<string, number>
  }> => {
    const key = normalizeEndpointUrl(host.url)
    const h: HostHealth = health.hosts[key] ?? {}
    health.hosts[key] = h
    if (!snapshots.has(key)) snapshots.set(key, JSON.parse(JSON.stringify(h)) as HostHealth)
    // Credential state lives under the token's key: hosts sharing a url are
    // dialed in parallel here, and a shared counter would let a healthy token
    // reset a revoked token's streak, two tokens' single 403s add up to a
    // revocation, and one token's 429 park the other.
    delete h.forbidden_count
    const tokens = h.tokens ?? (h.tokens = {})
    const tk = tokenHealthKey(host.token)
    const th: TokenHealth = tokens[tk] ?? (tokens[tk] = {})
    const t0 = now()
    const finish = (state: RemoteHostState, extra: Partial<HostRecallOutcome> = {},
      rows: { engrams: Engram[]; scores: Map<string, number> } = { engrams: [], scores: new Map() },
    ) => {
      h.last_state = state
      h.updated_at = now()
      return {
        outcome: { url: host.url, state, ms: now() - t0, count: rows.engrams.length, ids: rows.engrams.map(e => e.id), ...extra },
        engrams: rows.engrams,
        scores: rows.scores,
      }
    }
    /** This dial is a cooldown's one trial read. */
    let trial = false
    const openBreaker = () => {
      h.cooldown_until = now() + BREAKER_COOLDOWN_MS
      h.cooldown_opened_at = now()
      delete h.half_open_trial_at
      h.failures = 0
    }
    /** The host answered: a trial read that got any HTTP answer closes the
     *  breaker — the breaker is about reachability, and the host is reachable. */
    const closeBreakerIfTrial = () => {
      if (!trial) return
      h.cooldown_until = 0
      delete h.cooldown_opened_at
      delete h.half_open_trial_at
      force(key, 'cooldown_until', 'cooldown_opened_at', 'half_open_trial_at')
    }
    const networkFailure = (state: 'timeout' | 'unreachable', detail?: string) => {
      h.failures = (h.failures ?? 0) + 1
      // Any observed non-403 response/failure breaks a 403 streak — the
      // forbidden threshold means 2 CONSECUTIVE 403s, not 2 total.
      th.forbidden_count = 0
      // A failed trial re-opens the breaker for a full cooldown at once.
      if (trial || h.failures >= BREAKER_FAILURE_THRESHOLD) openBreaker()
      return finish(state, detail ? { detail } : {})
    }

    if ((th.rate_limited_until ?? 0) > t0) return finish('skipped_cooldown')
    if ((h.cooldown_until ?? 0) > t0) {
      // A legacy host-wide 429 cooldown is honoured to the end — Retry-After
      // is the server's own instruction, not a reachability guess.
      if (h.last_state === 'rate_limited') return finish('skipped_cooldown')
      // A trial that could not be dialed anyway would burn the cooldown's one
      // trial on nothing.
      if ((h.unsupported_until ?? 0) > t0) return finish('skipped_cooldown')
      const openedAt = cooldownOpenedAt(h)
      const due = t0 - openedAt >= BREAKER_HALF_OPEN_AFTER_MS
        && (h.half_open_trial_at ?? -Infinity) < openedAt
      if (!due) return finish('skipped_cooldown')
      const claim = claimHalfOpenTrial(statePath, key, t0)
      if (claim.result === 'denied') return finish('skipped_cooldown')
      const snap = snapshots.get(key)!
      if (claim.result === 'free') {
        // The cooldown ended or a save cleared it meanwhile: take the file's
        // view of the breaker, so this call neither restores the cooldown nor
        // treats an ordinary dial as a trial.
        for (const f of ['cooldown_until', 'cooldown_opened_at', 'half_open_trial_at', 'failures'] as const) {
          const v = claim.current?.[f]
          if (v === undefined) { delete h[f]; delete snap[f] } else { h[f] = v; snap[f] = v }
        }
      } else {
        trial = true
        trialKeys.add(key)
        // The claim is in the file now; record it as the base, so releasing or
        // clearing it later is a change this call writes.
        h.half_open_trial_at = t0
        snap.half_open_trial_at = t0
      }
    }
    if ((h.unsupported_until ?? 0) > t0) return finish('unsupported', { detail: 'unsupported_ttl' })

    const ctrl = new AbortController()
    dialedKeys.add(key)
    inflight.add(ctrl)
    if (deadlineHit) ctrl.abort()
    // Why the request was aborted, when a budget timer did it.
    let expiry: BudgetExpiry | undefined
    const abortFor = (info: BudgetExpiry) => { expiry ??= info; ctrl.abort() }
    // Starvation-aware: a cold process spends its first
    // seconds initialising the embedder, and a wall-clock timer would abort a
    // request the loop never got round to servicing.
    const cancelOverall = startBudgetTimer(timeoutMs, abortFor, timerOpts)
    let cancelConnect: (() => void) | undefined =
      startBudgetTimer(Math.min(connectMs, timeoutMs), abortFor, timerOpts)
    try {
      const res = await fetchImpl(`${key}/api/v1/recall`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${host.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query: truncatedQuery,
          mode: 'hybrid',
          // Clamp to the server's documented bounds (1..100) — an over-limit
          // request would 400 and feed the breaker for a client-side mistake.
          ...(opts.limit != null ? { limit: Math.min(100, Math.max(1, Math.floor(opts.limit))) } : {}),
          ...(host.scopes.length > 0 ? { scopes: host.scopes } : {}),
          // The server races its embed() against this and
          // degrades to keyword rather than blowing the client budget. Old
          // servers ignore unknown body fields.
          timeout_ms: timeoutMs,
        }),
      })
      // Headers arrived — connect phase over; the overall timer still bounds
      // the body read.
      cancelConnect?.()
      cancelConnect = undefined
      // The host answered: a run of client_slow results is over.
      h.client_slow_streak = 0
      force(key, 'client_slow_streak')
      // Any answer below 500 proves the host reachable (a 5xx is counted below).
      if (res.status < 500) closeBreakerIfTrial()

      if (res.status === 401) {
        h.failures = 0
        th.forbidden_count = 0
        return finish('auth_expired')
      }
      if (res.status === 403) {
        h.failures = 0
        th.forbidden_count = (th.forbidden_count ?? 0) + 1
        // Require 2 CONSECUTIVE 403s before treating as revocation — a
        // transient proxy 403 must not read as auth loss (server-side scope
        // narrowing is silent-with-dropped_scopes, never 403).
        if (th.forbidden_count >= 2) return finish('forbidden')
        return finish('unreachable', { detail: 'http_403_unconfirmed' })
      }
      if (res.status === 404) {
        h.failures = 0
        th.forbidden_count = 0 // a non-403 breaks the consecutive-403 streak
        h.unsupported_until = now() + UNSUPPORTED_TTL_MS
        return finish('unsupported', { detail: 'http_404' })
      }
      if (res.status === 422) {
        // The host answered that the REQUEST was invalid — a refusal, like
        // 401/403/404, not a sign the host is down. Same rule as the write
        // leg: it neither counts toward the per-host breaker nor resets it,
        // so refused recalls cannot park queued writes to every scope on the host.
        th.forbidden_count = 0 // a non-403 breaks the token's consecutive-403 streak
        return finish('unreachable', { detail: 'http_422_refused' })
      }
      if (res.status === 429) {
        h.failures = 0
        th.forbidden_count = 0 // a non-403 breaks the consecutive-403 streak
        const retryMs = parseRetryAfterMs(res.headers.get('retry-after'), now())
        // Per principal: this token cools down, other tokens keep dialing.
        th.rate_limited_until = now() + Math.min(retryMs ?? RATE_LIMIT_DEFAULT_COOLDOWN_MS, RATE_LIMIT_MAX_COOLDOWN_MS)
        return finish('rate_limited')
      }
      if (!res.ok) {
        return networkFailure('unreachable', `http_${res.status}`)
      }

      const text = await readBodyCapped(res, MAX_REMOTE_RESPONSE_BYTES)
      if (text === null) return networkFailure('unreachable', 'oversize')
      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(text)
      } catch {
        return networkFailure('unreachable', 'bad_json')
      }
      if (Array.isArray(parsedBody)) parsedBody = { results: parsedBody }
      const envelope = RecallEnvelopeSchema.safeParse(parsedBody)
      if (!envelope.success) return networkFailure('unreachable', 'bad_envelope')

      h.failures = 0
      th.forbidden_count = 0
      h.cooldown_until = 0
      delete h.cooldown_opened_at
      delete h.half_open_trial_at
      // What this call saw: the host answered in full. Written even where the
      // values look unchanged, so a cooldown another process opened while the
      // request was in flight is closed.
      force(key, 'failures', 'cooldown_until', 'cooldown_opened_at', 'half_open_trial_at')
      const rows = processHostRows(envelope.data.results, host, today)
      const dropped = envelope.data.dropped_scopes
      return finish('ok', {
        ...(envelope.data.mode ? { mode: envelope.data.mode } : {}),
        ...(typeof envelope.data.vector === 'boolean' ? { vector: envelope.data.vector } : {}),
        ...(dropped && dropped.length > 0 ? { dropped_scopes: dropped } : {}),
      }, rows)
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError'
      if (isAbort && !expiry && deadlineHit) {
        // The RECALL's deadline, not this host's budget,
        // stopped the request. No evidence about the host either way: the
        // breaker neither counts nor resets, and a trial claim is released.
        if (trial) delete h.half_open_trial_at
        return finish('timeout', { detail: 'recall_deadline' })
      }
      if (isAbort && expiry?.clientSlow) {
        // The budget ran out on this process's blocked event loop
        // before the host had its serviced budget. Not the host's fault: the
        // breaker neither counts nor resets, and a trial claim is released so
        // the next call may try again — unless the run of such results is
        // already longer than CLIENT_SLOW_STREAK_LIMIT: then the
        // host has had its chances, and this counts as a timeout.
        h.client_slow_streak = (h.client_slow_streak ?? 0) + 1
        if (h.client_slow_streak > CLIENT_SLOW_STREAK_LIMIT) return networkFailure('timeout', 'client_slow_streak')
        if (trial) delete h.half_open_trial_at
        return finish('client_slow', { detail: 'event_loop_blocked' })
      }
      h.client_slow_streak = 0
      return networkFailure(isAbort ? 'timeout' : 'unreachable',
        isAbort ? undefined : (err instanceof Error ? err.message.slice(0, 120) : undefined))
    } finally {
      inflight.delete(ctrl)
      cancelConnect?.()
      cancelOverall()
    }
  }

  type HostResult = Awaited<ReturnType<typeof dialHost>>
  const startedAt = now()
  let abortTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let hardStop: Promise<void> | null = null
  if (deadlineAt !== undefined && Number.isFinite(deadlineAt)) {
    abortTimer = setTimeout(() => {
      deadlineHit = true
      for (const c of inflight) c.abort()
    }, Math.max(0, deadlineAt - DEADLINE_ABORT_LEAD_MS - Date.now()))
    // A request that ignores its abort signal still cannot hold the call.
    hardStop = new Promise<void>(resolve => {
      stopTimer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()))
    })
  }
  const pending = new Set<number>()
  const runs = hosts.map((host, i): Promise<HostResult> => {
    const p = dialHost(host)
    if (!hardStop) return p
    return Promise.race([p, hardStop.then((): HostResult => {
      pending.add(i)
      return {
        outcome: { url: host.url, state: 'timeout', ms: now() - startedAt, count: 0, detail: 'recall_deadline' },
        engrams: [],
        scores: new Map(),
      }
    })])
  })

  const settled = await Promise.allSettled(runs)
  if (abortTimer) clearTimeout(abortTimer)
  if (stopTimer) clearTimeout(stopTimer)
  const outcomes: HostRecallOutcome[] = []
  const engrams: Engram[] = []
  const scores = new Map<string, number>()
  const seen = new Set<string>()
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    if (s.status === 'rejected') {
      // dialHost never throws by construction; belt-and-braces.
      outcomes.push({ url: hosts[i].url, state: 'unreachable', ms: 0, count: 0, detail: 'internal_error' })
      continue
    }
    outcomes.push(s.value.outcome)
    for (const e of s.value.engrams) {
      const sc = s.value.scores.get(e.id) ?? 0
      if (seen.has(e.id)) {
        // Cross-host duplicate (same scope mounted twice) — first host's row
        // wins; boost collisions max-merge.
        scores.set(e.id, Math.max(scores.get(e.id) ?? 0, sc))
        continue
      }
      seen.add(e.id)
      engrams.push(e)
      scores.set(e.id, sc)
    }
  }
  // A host the deadline cut while its request ignored the abort: release a
  // trial claim it held, so the next call may try again.
  for (const i of pending) {
    const key = normalizeEndpointUrl(hosts[i].url)
    if (trialKeys.has(key)) delete health.hosts[key]?.half_open_trial_at
  }
  // Persist, field by field under the file lock, only what this call changed
  // about the hosts it dialed (see persistHostChanges).
  const changes: Array<{ key: string; before: HostHealth; after: HostHealth; forced?: ReadonlySet<string> }> = []
  for (const key of dialedKeys) {
    const after = JSON.parse(JSON.stringify(health.hosts[key] ?? {})) as HostHealth
    const forced = new Set(forcedKeys.get(key) ?? [])
    // last_state is what this call observed, when it observed the host at all.
    if (after.last_state === 'ok') forced.add('last_state')
    changes.push({ key, before: snapshots.get(key) ?? {}, after, forced })
  }
  persistHostChanges(statePath, changes)
  return { engrams, scores, outcomes }
}

// ---------------------------------------------------------------------------
// Degradation string table (per state × per surface)
// ---------------------------------------------------------------------------

export interface RemoteStoreStatusEntry {
  host: string
  enterprise?: boolean
  status: RemoteHostState
  dropped_scopes?: string[]
  ms?: number
  count?: number
  /** When this outcome was observed (epoch ms). */
  observed_at?: number
  /** Age of the observation at the time the status was read (ms).
   *  Renderers MUST NOT present a non-zero age as the host's state "now". */
  age_ms?: number
}

/**
 * Agent-directed strings for MCP response surfaces: consequence + agent
 * action, because they enter model context ("Admin → Service accounts" is
 * not an agent action — the agent's action is to relay it). One line per
 * degraded host, joined by the caller.
 *
 * The re-auth string deliberately does NOT reference `plur login` — it
 * targets device-flow endpoints the enterprise server doesn't have, and the
 * token it writes has no consumers on the recall path.
 */
export function mcpRemoteWarningLine(o: RemoteStoreStatusEntry): string {
  const host = o.host
  if (o.enterprise && (o.status === 'auth_expired' || o.status === 'forbidden')) {
    return `${host}: credentials rejected — team engrams unavailable; tell the user to ${enterpriseRecoveryHint(host)}.`
  }
  switch (o.status) {
    case 'ok':
      return o.dropped_scopes && o.dropped_scopes.length > 0
        ? `${host}: scope(s) ${o.dropped_scopes.join(', ')} not granted to your key — results may be missing those team engrams; tell the user to ask an admin (Admin → Service accounts).`
        : `${host}: ok`
    case 'timeout':
      return `${host}: timed out — results may be missing team engrams; serving local only; do not retry; run plur_doctor for detail.`
    case 'unreachable':
      return `${host}: unreachable — results may be missing team engrams; serving local only; do not retry; run plur_doctor for detail.`
    case 'auth_expired':
      return `${host}: token expired or revoked — team engrams unavailable; serving local only; tell the user to sign in at ${host}/auth and re-add the store via plur_stores_add.`
    case 'forbidden':
      return `${host}: access revoked (repeated 403) — team engrams unavailable; serving local only; tell the user to ask an admin (Admin → Service accounts) or re-add via plur_stores_add.`
    case 'rate_limited':
      return `${host}: rate limited — cooling down automatically; results may be missing team engrams this call; do not retry.`
    case 'unsupported':
      return `${host}: server has no live-recall endpoint (older server) — serving local only; team recall resumes automatically once the server is upgraded.`
    case 'skipped_cooldown':
      return `${host}: in cooldown after repeated failures — serving local only; dialing resumes automatically; run plur_doctor if this persists.`
    case 'client_slow':
      return `${host}: this client was too busy (slow start) to read the server's answer in time — results may be missing team engrams this call; the server is not at fault; retrying is fine.`
  }
}

/**
 * Human-directed hook-header lines. States `skipped_cooldown` and
 * `unsupported` NEVER print into a prompt header (they are steady, expected
 * back-off states — habituation camouflages new degradations). Returns null
 * for states that never print.
 */
export function hookRemoteHeaderLine(o: RemoteStoreStatusEntry): string | null {
  const host = o.host
  if (o.enterprise && (o.status === 'auth_expired' || o.status === 'forbidden')) {
    return `[PLUR] ${host}: credentials rejected — ${enterpriseRecoveryHint(host)}.`
  }
  switch (o.status) {
    case 'ok':
      return o.dropped_scopes && o.dropped_scopes.length > 0
        ? `[PLUR] ${host}: scope(s) ${o.dropped_scopes.join(', ')} not granted to your key — ask an admin (Admin → Service accounts).`
        : null
    case 'timeout':
      return `[PLUR] ${host}: timed out — team memory skipped this prompt (serving local only).`
    case 'unreachable':
      return `[PLUR] ${host}: unreachable — team memory skipped this prompt (serving local only).`
    case 'auth_expired':
      return `[PLUR] ${host}: token expired or revoked — sign in at ${host}/auth and re-add via plur_stores_add.`
    case 'forbidden':
      return `[PLUR] ${host}: access revoked — ask an admin (Admin → Service accounts), or sign in at ${host}/auth and re-add via plur_stores_add.`
    case 'rate_limited':
      return `[PLUR] ${host}: rate limited — team memory cooling down, back shortly.`
    case 'unsupported':
    case 'skipped_cooldown':
    // A one-off local condition (cold start): printing it into every prompt
    // header would habituate the user to warnings that are not about the server.
    case 'client_slow':
      return null
  }
}

/** Human-directed plur_doctor remediation strings (cause + human fix). */
export function doctorRemoteRemediation(o: RemoteStoreStatusEntry): string | null {
  const host = o.host
  if (o.enterprise && (o.status === 'auth_expired' || o.status === 'forbidden')) {
    return `Remote ${host}: credentials rejected — ${enterpriseRecoveryHint(host)}.`
  }
  switch (o.status) {
    case 'ok':
      return o.dropped_scopes && o.dropped_scopes.length > 0
        ? `Remote ${host}: scope(s) ${o.dropped_scopes.join(', ')} not granted to your key — the server silently narrowed your recall. Ask an admin (Admin → Service accounts) to grant them.`
        : null
    case 'timeout':
      return `Remote ${host}: live recall timed out — server slow or network path degraded. Check connectivity/VPN; raise PLUR_REMOTE_RECALL_TIMEOUT_MS if the host is genuinely slow.`
    case 'unreachable':
      return `Remote ${host}: unreachable — check connectivity/VPN/DNS. Recall serves local results only until it recovers; writes queue in the outbox.`
    case 'auth_expired':
      return `Remote ${host}: token expired or revoked — sign in at ${host}/auth and re-add the store via plur_stores_add (see the onboarding doc). Note: \`plur login\` does not work against enterprise servers.`
    case 'forbidden':
      return `Remote ${host}: two consecutive 403s — the token's access was revoked. Ask an admin (Admin → Service accounts), or sign in at ${host}/auth and re-add via plur_stores_add.`
    case 'rate_limited':
      return `Remote ${host}: server rate limit hit — the client honors Retry-After and cools down automatically. If persistent, ask the operator to raise the per-principal recall limit.`
    case 'unsupported':
      return `Remote ${host}: no /api/v1/recall endpoint (older server) — live team recall is parked for ${Math.round(UNSUPPORTED_TTL_MS / 60000)} minutes at a time. Upgrade the enterprise server to enable server-authoritative recall. (An old server also cannot report scope narrowing — absence of a dropped-scopes warning from this host proves nothing.)`
    case 'skipped_cooldown':
      return `Remote ${host}: circuit breaker open after ${BREAKER_FAILURE_THRESHOLD} consecutive failures — dialing paused ~${Math.round(BREAKER_COOLDOWN_MS / 60000)} minutes (one trial read after ~${Math.round(BREAKER_HALF_OPEN_AFTER_MS / 1000)} s), then retried automatically. Investigate reachability if this persists.`
    case 'client_slow':
      return `Remote ${host}: the last live recall ran out of time while this process was blocked (cold start or a busy machine), before the server had its full budget. Not counted against the server. If it recurs, the client is starting slowly; raise PLUR_REMOTE_RECALL_TIMEOUT_MS or warm the process first.`
  }
}

/**
 * Hook-header suppression: print on state CHANGE per host, then at most once
 * per {@link HOOK_HEADER_REPEAT_MS} per (host, state), persisted in
 * remote-health.json. `skipped_cooldown`/`unsupported` never print; recovery to
 * `ok` silently resets. Calling this CLAIMS the returned lines — callers must
 * print them. Runs under the health-file lock so concurrent hooks cannot double-print.
 */
export function claimHookDegradationLines(
  outcomes: RemoteStoreStatusEntry[],
  opts: { statePath?: string; now?: () => number; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const statePath = opts.statePath ?? remoteHealthPath(opts.env ?? process.env)
  const now = (opts.now ?? Date.now)()
  const claim = (): string[] => {
    // Read INSIDE the lock — claiming against a pre-lock snapshot would
    // reintroduce the lost-update race the lock exists to close.
    const health = readRemoteHealth(statePath)
    const lines: string[] = []
    let dirty = false
    for (const o of outcomes) {
      const key = normalizeEndpointUrl(o.host)
      const h: HostHealth = health.hosts[key] ?? {}
      health.hosts[key] = h
      const line = hookRemoteHeaderLine(o)
      // The suppression key distinguishes plain-ok (never prints) from
      // ok-with-dropped-scopes (prints like a state).
      const printKey = o.status === 'ok' && o.dropped_scopes?.length ? 'dropped_scopes' : o.status
      if (line === null) {
        // Recovery / never-print state: reset the printed marker on genuine
        // recovery so the next degradation prints as a state change.
        if (o.status === 'ok' && h.printed_state && h.printed_state !== 'ok') {
          h.printed_state = 'ok'
          h.printed_at = now
          dirty = true
        }
        continue
      }
      const changed = h.printed_state !== printKey
      const stale = now - (h.printed_at ?? 0) > HOOK_HEADER_REPEAT_MS
      if (changed || stale) {
        lines.push(line)
        h.printed_state = printKey
        h.printed_at = now
        dirty = true
      }
    }
    if (dirty) writeRemoteHealth(statePath, health)
    return lines
  }
  // Fallback (lock unavailable): claim unlocked — a rare duplicate header
  // beats silently dropping a degradation warning.
  return withRemoteHealthLock(statePath, claim, claim)
}
