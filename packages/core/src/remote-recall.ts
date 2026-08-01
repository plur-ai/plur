/**
 * Server-authoritative remote recall (#776, plan A2′).
 *
 * One live `POST {host}/api/v1/recall` per configured (url, token) endpoint
 * group, timeout-bounded, merged by the caller with local results. There is
 * deliberately NO disk caching of remote engrams — engrams change, so remote
 * content is always retrieved live; an unreachable host means local-only
 * results plus loud degradation (plan A4′). The in-memory `RemoteStore` peek
 * cache keeps only its non-recall duties (stores_list counts, feedback/getById
 * routing).
 *
 * ## Failure semantics (per host)
 *
 * | Condition            | State              | Behavior                                    |
 * |----------------------|--------------------|---------------------------------------------|
 * | 2xx, valid envelope  | `ok`               | rows validated/namespaced/merged            |
 * | timeout / abort      | `timeout`          | breaker counts it                           |
 * | DNS/conn/5xx/bad body| `unreachable`      | breaker counts it                           |
 * | 401                  | `auth_expired`     | skip + surface re-auth (no breaker)         |
 * | 403 ×1               | `unreachable`      | unconfirmed — a transient proxy 403 must    |
 * |                      |                    | not read as revocation (detail: http_403)   |
 * | 403 ×2 consecutive   | `forbidden`        | treated as auth-level revocation            |
 * | 404                  | `unsupported`      | host parked for 10 min (NOT process life)   |
 * | 429                  | `rate_limited`     | honor Retry-After (else 30 s) cooldown      |
 * | breaker open         | `skipped_cooldown` | 3 straight failures → 5 min cooldown        |
 *
 * Breaker / cooldown / unsupported state is PERSISTED across processes in
 * `<plur root>/cache/remote-health.json` (atomic unique-tmp write; mutations
 * are read-merge-write under the shared file lock so concurrent processes
 * don't lose each other's updates): hooks are one-shot processes at ~86% of
 * recall volume, so in-memory state would reset every prompt and an off-LAN
 * host would burn the connect budget on every prompt indefinitely.
 *
 * ## Dialing rule (strict scope relevance — user decision, plan rows 39/44)
 *
 * A host is dialed only with the subset of its granted scopes relevant to the
 * current project/work:
 *   (a) group/project scopes sharing the org segment with the session's
 *       project scope (org of `project:plur/plur-ai/enterprise` is `plur` →
 *       all `group:plur/…` + `project:plur/…` scopes for that host);
 *   (b) the host's `user:*` (personal-family) scopes ONLY when an org context
 *       exists implicating that host.
 * No project/work context implicating a remote store → ZERO remote calls. A
 * host with an empty relevant subset is not dialed. Per-store `dial:
 * always|never` overrides; the `PLUR_REMOTE_RECALL` env kill-switch
 * (`off|0|false`) disables the leg entirely. The dialing itself lives in
 * `Plur._remoteRecallHosts` (index.ts); `scopeOrg` here is the shared org
 * extraction.
 */

import * as fs from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { z } from 'zod'
import type { Engram } from './schemas/engram.js'
import { RemoteRowSchema, normalizeEndpointUrl } from './store/remote-store.js'
import { isScopeWithin, isSharedScope } from './scope-util.js'
import { storePrefix } from './engrams.js'
import { logger } from './logger.js'
import { withLock } from './sync.js'

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
 *  pair prints again at most once per this window (plan A4′, default 4h). */
export const HOOK_HEADER_REPEAT_MS = 4 * 60 * 60 * 1000

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

export interface HostRecallOutcome {
  url: string
  state: RemoteHostState
  /** Wall time spent on this host (0 when skipped without a fetch). */
  ms: number
  /** Rows accepted from this host after validation + scope guard. */
  count: number
  /** Server-reported mode that ACTUALLY ran (envelope `mode`). */
  mode?: string
  /** Server-reported: the semantic (vector) leg actually ran. */
  vector?: boolean
  /** Requested scope selectors the server silently narrowed away (#628). */
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
  /** Store entries (config order) backing those scopes. Rows map to the
   *  FIRST entry whose scope contains the row's scope; `global` rows map to
   *  the first-configured entry, mirroring `_loadSecondaryAndPacks`. */
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
}

// ---------------------------------------------------------------------------
// Persistent per-host health state
// ---------------------------------------------------------------------------

interface HostHealth {
  /** Consecutive network-class failures (timeout/unreachable/5xx/bad body). */
  failures?: number
  /** Breaker open until (epoch ms) — `skipped_cooldown` while in force. Also
   *  set by 429 (Retry-After). */
  cooldown_until?: number
  /** 404 TTL — `unsupported` while in force. */
  unsupported_until?: number
  /** Consecutive 403s — 2 required before `forbidden` (revocation). */
  forbidden_count?: number
  last_state?: RemoteHostState
  updated_at?: number
  /** Hook-header suppression bookkeeping (plan A4′). */
  printed_state?: string
  printed_at?: number
}

interface RemoteHealthFile {
  version: 1
  hosts: Record<string, HostHealth>
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
 * state they read earlier must go through {@link mergeWriteRemoteHealth} or
 * {@link withRemoteHealthLock}, which re-read under the file lock.
 */
function writeRemoteHealth(path: string, file: RemoteHealthFile): void {
  try {
    fs.mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(file))
    fs.renameSync(tmp, path)
  } catch { /* health persistence is best-effort — never break recall */ }
}

/** Lock options for remote-health.json — the critical section is a
 *  read+merge+rename of a small JSON file (milliseconds), and withLock's
 *  retry delay is a synchronous busy-wait, so keep the worst-case wait small
 *  (25+50+100 = 175 ms) rather than the 3.1 s engrams.yaml default. */
const HEALTH_LOCK_OPTS = { maxRetries: 3, baseDelay: 25 }

/**
 * Run `fn` holding the remote-health.json file lock (the same #685 F7
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

/**
 * Merge-persist the host entries this process touched (lost-update fix).
 *
 * The naive end-of-call `writeRemoteHealth(path, healthReadAtEntry)` loses
 * concurrent updates: two processes read the same base, each writes its
 * whole in-memory copy, and the second write erases the first's breaker /
 * cooldown / suppression progress. Instead: re-read the CURRENT file inside
 * the lock and overlay only the entries in `touched`, so writers touching
 * different hosts both survive. Same-host collisions resolve last-writer-wins
 * at host granularity — acceptable for advisory state.
 *
 * The overlay deliberately KEEPS the current file's `printed_state` /
 * `printed_at`: remoteRecall never modifies those fields, and clobbering
 * them with the entry-time snapshot would undo a concurrent
 * {@link claimHookDegradationLines} claim and double-print headers.
 */
function mergeWriteRemoteHealth(statePath: string, touched: Record<string, HostHealth>): void {
  const readMergeWrite = (): void => {
    const current = readRemoteHealth(statePath)
    for (const [key, h] of Object.entries(touched)) {
      const cur = current.hosts[key]
      current.hosts[key] = cur
        ? { ...h, printed_state: cur.printed_state, printed_at: cur.printed_at }
        : h
    }
    writeRemoteHealth(statePath, current)
  }
  // Unlocked fallback is the same read-merge-write — still narrower than the
  // old whole-file overwrite even when the lock is unavailable.
  withRemoteHealthLock(statePath, readMergeWrite, readMergeWrite)
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
 * Tolerant envelope (#628 contract from enterprise PR #631). Old servers may
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
 * Validate + scope-guard + namespace one host's rows, and derive per-row
 * scores (server score when present, rank-mapped fallback otherwise).
 *
 * Scope guard: a row must fall `isScopeWithin` one of the DIALED scopes —
 * but `scope === 'global'` rows are ADMITTED and narrowed to the mapped
 * entry's scope during namespacing, mirroring `_loadSecondaryAndPacks`'s
 * global clause (index.ts). Dropping global rows would reimplement the #570
 * server bug client-side and throw away exactly the rows B-T1 restores.
 *
 * Deterministic row→store-entry mapping: a row's scope maps to the FIRST
 * dialed entry (config order) whose scope contains it; `global` maps to the
 * first-configured dialed entry. Same row → same namespaced id on every
 * call, or RRF dedup splits and feedback misroutes (pinned by test).
 *
 * Activation normalization: `last_accessed = today`,
 * `retrieval_strength = server value ?? 0.7` — server rows are fresh by
 * construction; without this they'd enter ranking mid-decay.
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
    // Rows are top-level engrams per the #628 envelope; tolerate the DB-row
    // shape {id, scope, status, data} some surfaces emit (same reshape rule
    // as RemoteStore: authoritative columns win over `data`).
    const candidate = (r.data && typeof r.data === 'object' && !('statement' in r))
      ? { ...(r.data as Record<string, unknown>), id: r.id, scope: r.scope, status: r.status }
      : r
    const parsed = RemoteRowSchema.safeParse(candidate)
    if (!parsed.success) {
      const safeId = String((candidate as Record<string, unknown>).id ?? '').replace(/[^\w:./-]/g, '?').slice(0, 64)
      logger.debug(`[plur:remote-recall] ${host.url} returned a malformed row (id="${safeId}") — dropped`)
      continue
    }
    const e = parsed.data as unknown as Engram
    // Scope guard with explicit global admission.
    const entry = e.scope === 'global'
      ? dialedEntries[0]
      : dialedEntries.find(en => isScopeWithin(e.scope, en.scope))
    if (!entry) {
      logger.debug(`[plur:remote-recall] ${host.url} row ${e.id} outside dialed scopes (${e.scope}) — dropped`)
      continue
    }
    const cloned = { ...e } as any
    if (cloned.scope === 'global') cloned.scope = entry.scope
    const originalId = cloned.id
    cloned.id = cloned.id.replace(/^(ENG|ABS|META)-/, `$1-${storePrefix(entry.scope)}-`)
    cloned._originalId = originalId
    cloned._storeScope = entry.scope
    // The injection scorer iterates `tags` unguarded — a row without them
    // must not throw at scoring time.
    if (!Array.isArray(cloned.tags)) cloned.tags = []
    // Activation normalization — synthesized-fresh (plan: decay-parity task
    // dissolved into this).
    const act = (cloned.activation && typeof cloned.activation === 'object') ? cloned.activation : {}
    cloned.activation = {
      storage_strength: typeof act.storage_strength === 'number' ? act.storage_strength : 1.0,
      frequency: typeof act.frequency === 'number' ? act.frequency : 0,
      ...act,
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
 * blocks past the budget. Health state is read once at entry; at exit only
 * the touched host entries are persisted, read-merge-write under the file
 * lock (see {@link mergeWriteRemoteHealth}) so concurrent processes don't
 * lose each other's updates.
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
  const statePath = opts.statePath ?? remoteHealthPath(env)
  const health = readRemoteHealth(statePath)
  const today = new Date().toISOString().slice(0, 10)
  const truncatedQuery = query.length > MAX_REMOTE_QUERY_CHARS ? query.slice(0, MAX_REMOTE_QUERY_CHARS) : query

  const dialHost = async (host: RemoteRecallHost): Promise<{
    outcome: HostRecallOutcome
    engrams: Engram[]
    scores: Map<string, number>
  }> => {
    const key = normalizeEndpointUrl(host.url)
    const h: HostHealth = health.hosts[key] ?? {}
    health.hosts[key] = h
    const t0 = now()
    const finish = (state: RemoteHostState, extra: Partial<HostRecallOutcome> = {},
      rows: { engrams: Engram[]; scores: Map<string, number> } = { engrams: [], scores: new Map() },
    ) => {
      h.last_state = state
      h.updated_at = now()
      return {
        outcome: { url: host.url, state, ms: now() - t0, count: rows.engrams.length, ...extra },
        engrams: rows.engrams,
        scores: rows.scores,
      }
    }
    const networkFailure = (state: 'timeout' | 'unreachable', detail?: string) => {
      h.failures = (h.failures ?? 0) + 1
      // Any observed non-403 response/failure breaks a 403 streak — the
      // forbidden threshold means 2 CONSECUTIVE 403s, not 2 total.
      h.forbidden_count = 0
      if (h.failures >= BREAKER_FAILURE_THRESHOLD) {
        h.cooldown_until = now() + BREAKER_COOLDOWN_MS
        h.failures = 0
      }
      return finish(state, detail ? { detail } : {})
    }

    if ((h.cooldown_until ?? 0) > t0) return finish('skipped_cooldown')
    if ((h.unsupported_until ?? 0) > t0) return finish('unsupported', { detail: 'unsupported_ttl' })

    const ctrl = new AbortController()
    const overallTimer = setTimeout(() => ctrl.abort(), timeoutMs)
    let connectTimer: ReturnType<typeof setTimeout> | undefined =
      setTimeout(() => ctrl.abort(), Math.min(connectMs, timeoutMs))
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
          // B-T7d wire param — the server races its embed() against this and
          // degrades to keyword rather than blowing the client budget. Old
          // servers ignore unknown body fields.
          timeout_ms: timeoutMs,
        }),
      })
      // Headers arrived — connect phase over; the overall timer still bounds
      // the body read.
      clearTimeout(connectTimer)
      connectTimer = undefined

      if (res.status === 401) {
        h.failures = 0
        h.forbidden_count = 0
        return finish('auth_expired')
      }
      if (res.status === 403) {
        h.failures = 0
        h.forbidden_count = (h.forbidden_count ?? 0) + 1
        // Require 2 CONSECUTIVE 403s before treating as revocation — a
        // transient proxy 403 must not read as auth loss (server-side scope
        // narrowing is silent-with-dropped_scopes, never 403 — B-T7 Q1).
        if (h.forbidden_count >= 2) return finish('forbidden')
        return finish('unreachable', { detail: 'http_403_unconfirmed' })
      }
      if (res.status === 404) {
        h.failures = 0
        h.forbidden_count = 0 // a non-403 breaks the consecutive-403 streak
        h.unsupported_until = now() + UNSUPPORTED_TTL_MS
        return finish('unsupported', { detail: 'http_404' })
      }
      if (res.status === 429) {
        h.failures = 0
        h.forbidden_count = 0 // a non-403 breaks the consecutive-403 streak
        const retryMs = parseRetryAfterMs(res.headers.get('retry-after'), now())
        h.cooldown_until = now() + Math.min(retryMs ?? RATE_LIMIT_DEFAULT_COOLDOWN_MS, RATE_LIMIT_MAX_COOLDOWN_MS)
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
      h.forbidden_count = 0
      h.cooldown_until = 0
      const rows = processHostRows(envelope.data.results, host, today)
      const dropped = envelope.data.dropped_scopes
      return finish('ok', {
        ...(envelope.data.mode ? { mode: envelope.data.mode } : {}),
        ...(typeof envelope.data.vector === 'boolean' ? { vector: envelope.data.vector } : {}),
        ...(dropped && dropped.length > 0 ? { dropped_scopes: dropped } : {}),
      }, rows)
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError'
      return networkFailure(isAbort ? 'timeout' : 'unreachable',
        isAbort ? undefined : (err instanceof Error ? err.message.slice(0, 120) : undefined))
    } finally {
      if (connectTimer) clearTimeout(connectTimer)
      clearTimeout(overallTimer)
    }
  }

  const settled = await Promise.allSettled(hosts.map(dialHost))
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
  // Persist only the host entries this call touched, read-merge-write under
  // the file lock — a concurrent process's updates to other hosts (or to the
  // print-suppression fields) survive. See mergeWriteRemoteHealth.
  const touched: Record<string, HostHealth> = {}
  for (const host of hosts) {
    const key = normalizeEndpointUrl(host.url)
    if (health.hosts[key]) touched[key] = health.hosts[key]
  }
  mergeWriteRemoteHealth(statePath, touched)
  return { engrams, scores, outcomes }
}

// ---------------------------------------------------------------------------
// A4′ — degradation string table (per state × per surface)
// ---------------------------------------------------------------------------

export interface RemoteStoreStatusEntry {
  host: string
  status: RemoteHostState
  dropped_scopes?: string[]
  ms?: number
  count?: number
}

/**
 * Agent-directed strings for MCP response surfaces: consequence + agent
 * action, because they enter model context ("Admin → Service accounts" is
 * not an agent action — the agent's action is to relay it). One line per
 * degraded host, joined by the caller.
 *
 * The re-auth string deliberately does NOT reference `plur login` — it
 * targets device-flow endpoints the enterprise server doesn't have, and the
 * token it writes has no consumers on the recall path (plan DX finding 1).
 */
export function mcpRemoteWarningLine(o: RemoteStoreStatusEntry): string {
  const host = o.host
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
      return null
  }
}

/** Human-directed plur_doctor remediation strings (cause + human fix). */
export function doctorRemoteRemediation(o: RemoteStoreStatusEntry): string | null {
  const host = o.host
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
      return `Remote ${host}: circuit breaker open after ${BREAKER_FAILURE_THRESHOLD} consecutive failures — dialing paused ~${Math.round(BREAKER_COOLDOWN_MS / 60000)} minutes, then retried automatically. Investigate reachability if this persists.`
  }
}

/**
 * Hook-header suppression policy (plan A4′): print on state CHANGE per host,
 * then at most once per {@link HOOK_HEADER_REPEAT_MS} per (host, state) —
 * persisted in the same remote-health.json, because hooks are one-shot
 * processes. `skipped_cooldown` and `unsupported` never print. A recovery to
 * `ok` resets the printed state (silently) so a recurrence prints again.
 *
 * "Claim" semantics: calling this consumes the print budget for the lines it
 * returns — callers must actually print them. The read→claim→write runs
 * under the remote-health file lock (read-merge-write), so two concurrent
 * hook processes cannot both read the pre-claim state and double-print, and
 * a claim cannot be erased by a concurrent whole-file persist.
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
