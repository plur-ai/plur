import { z } from 'zod'
import { ActivationSchema, type Engram } from '../schemas/engram.js'
import { logger } from '../logger.js'
import { normalizeEngramInput } from '../normalize-engram.js'
import { ScopeMetadataSchema, type ScopeMetadata } from '../schemas/scope-metadata.js'
import type { ScopeSource } from '../scope-routing.js'
import { redactToken } from '../redact-token.js'

export interface WriteCheckResult { scope: string; writable: boolean; review_held: boolean; reason?: string }

/** The values `scope_source` may carry on the wire; anything else is omitted. */
const SCOPE_SOURCES: ReadonlySet<string> = new Set<ScopeSource>(['explicit', 'session', 'default', 'routed'])

/**
 * Lenient validation for semi-trusted remote rows: optional fields may be omitted,
 * but security-relevant fields are type-checked and broken rows rejected, so a
 * malicious remote cannot inject type-confused data into the injection pool.
 * `.passthrough()` keeps unmodeled fields. Exported so remote-recall.ts validates
 * /api/v1/recall rows through the SAME schema — one trust boundary.
 */
export const RemoteRowSchema = z.object({
  id: z.string().regex(/^(ENG|ABS|META)-[A-Za-z0-9-]+$/),
  scope: z.string().min(1),
  status: z.enum(['active', 'dormant', 'retired', 'candidate']),
  statement: z.string().min(1),
  type: z.enum(['behavioral', 'terminological', 'procedural', 'architectural']).optional(),
  pinned: z.boolean().optional(),
  commitment: z.enum(['exploring', 'leaning', 'decided', 'locked', 'draft']).optional(),
  visibility: z.enum(['private', 'public', 'template']).optional(),
  // Fields rendered into agent context or used in arithmetic — type confusion
  // here either throws at injection time (confidence_score.toFixed in
  // formatLayer3) or feeds non-string data into the context. nullish() because
  // servers may emit explicit nulls for absent values.
  confidence_score: z.number().nullish(),
  rationale: z.string().nullish(),
  summary: z.string().nullish(),
  domain: z.string().nullish(),
}).passthrough()

// Truncate and strip control chars from server error bodies before persisting
// (_outbox.last_error) or throwing them. Only \x00-\x1F and \x7F are replaced, so
// localised text stays readable. Truncation is by CODE POINT (no lone surrogates in
// YAML) and runs AFTER substitution.
function sanitiseResponseBody(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, '?')
  return Array.from(cleaned).slice(0, 200).join('')
}

// Timeout for each page fetch inside load(). Background loads are not on
// the hot path — a degraded network that never delivers headers must still
// eventually unblock the caller. 30 s is generous for a healthy
// server while still keeping the process mortal on a blackholed route.
export const LOAD_FETCH_TIMEOUT_MS = 30_000

/**
 * `scheme://host[:port]` of a url, without userinfo, path or query: the only
 * form of a configured url that goes into a log line or a message, since the
 * configured url can carry credentials.
 */
export function safeOrigin(url: string): string {
  try { return new URL(url).origin } catch { return '<invalid url>' }
}

/**
 * Canonical endpoint identity for a configured remote URL: `https://x.com`,
 * `https://x.com/` and `https://x.com/sse` (and `:443`) name the same server.
 * Every identity comparison (endpoint dedup, addStore, /me metadata matching) must
 * use this fold. Scheme/host are lowercased, default port, userinfo and fragment
 * dropped; a base path keeps its case, less a trailing `/sse` and slash.
 * Comparison-time only: NEVER rewrite a stored config value with the normalized form.
 */
export function normalizeEndpointUrl(url: string): string {
  const foldPath = (p: string): string => p.replace(/\/sse\/?$/, '').replace(/\/$/, '')
  let u: URL
  try { u = new URL(url) } catch { return foldPath(url) }
  // URL-parsed: scheme and host case-folded, the
  // scheme's default port dropped, userinfo and fragment never part of it.
  // The base path keeps its case; only a trailing /sse and slash fold.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return foldPath(url)
  return `${u.protocol}//${u.host}${foldPath(u.pathname)}${u.search}`
}

// ── Host-level failure breaker ──────────────────────────────────────────────
// Process-wide memory of origins that failed at the NETWORK level; for a cooldown
// the PASSIVE read path (load() paging) fast-fails to its cache. fetchBounded
// (writes, /me, retries) marks and clears but NEVER fast-fails — its probes are the
// recovery signal. HTTP responses never trip it. Per-process, not persisted.
const HOST_DOWN_COOLDOWN_MS = 60_000
const downHosts = new Map<string, number>()

function hostKey(url: string): string {
  try { return new URL(url).origin } catch { return url }
}

export function markRemoteHostDown(url: string, at: number = Date.now()): void {
  const key = hostKey(url)
  if (!downHosts.has(key)) {
    logger.warning(
      `[plur:remote-store] ${key} failed at the network level — fast-failing every store on this host for ${HOST_DOWN_COOLDOWN_MS / 1000}s (#1069)`,
    )
  }
  downHosts.set(key, at)
}

/** Milliseconds of cooldown remaining for this URL's host; 0 = host is not marked down. */
export function remoteHostDownRemainingMs(url: string, now: number = Date.now()): number {
  const at = downHosts.get(hostKey(url))
  if (at === undefined) return 0
  const remaining = HOST_DOWN_COOLDOWN_MS - (now - at)
  if (remaining <= 0) {
    downHosts.delete(hostKey(url))
    return 0
  }
  return remaining
}

/** A network-level SUCCESS against the host clears its down mark — the recovery half of the breaker. */
export function clearRemoteHostDown(url: string): void {
  downHosts.delete(hostKey(url))
}

/** Test seam. */
export function _resetRemoteHostBreaker(): void {
  downHosts.clear()
}

/**
 * Fields whose ABSENCE is more permissive than any present value, so salvage must
 * never strip them (that would turn a fail-closed check into fail-open):
 *   - `visibility`: the pack-export privacy gate; an unvalidated row must DROP.
 *   - `pinned`: stripping silently un-pins a team engram.
 * Other optional fields only remove content or privilege when absent.
 */
const NEVER_STRIP = new Set(['visibility', 'pinned'])

/** Per-process dedupe for salvage warnings: one line per (store, field-set), on BOTH read paths. */
const warnedSalvages = new Set<string>()

/**
 * Thrown when a bounded request misses its deadline, at ANY phase.
 *
 * A distinct type rather than a message: `existsById()` has to re-word a
 * timeout in its own terms, and matching on the text of another function's
 * error is the kind of coupling that breaks silently when the wording changes.
 */
export class RemoteTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`request to ${url} timed out after ${ms}ms`)
    this.name = 'RemoteTimeoutError'
  }
}

/**
 * The CALLER's budget ran out, not the remote's.
 *
 * Distinct from {@link RemoteTimeoutError} on purpose: a request cut because a
 * hook had 1.5s left says nothing about whether the host is reachable, so it
 * must not mark the host down or feed the circuit breaker.
 */
export class RemoteAbortedError extends Error {
  constructor(url: string) {
    super(`request to ${url} was cut at the caller's time budget`)
    this.name = 'RemoteAbortedError'
  }
}

/**
 * The remote answered a write with a non-2xx status.
 *
 * The status is carried as a field so the outbox can record it and
 * tell a refusal (403) from a transient failure (503) without parsing prose.
 */
export class RemoteHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string, readonly code?: 'scope_lookup_failed') {
    super(message)
    this.name = 'RemoteHttpError'
    this.status = status
  }
}

/**
 * A remote store whose token comes from an environment variable (`token_env`)
 * that is unset or empty where PLUR runs. Thrown before any request is
 * made, so no unauthenticated call reaches the server. The
 * message names the variable to set and never suggests writing the token into
 * config.yaml — that would undo the reference.
 */
export class TokenEnvUnsetError extends Error {
  readonly code = 'token_env_unset'
  constructor(readonly variable: string, readonly scope: string) {
    super(tokenEnvUnsetMessage(variable, scope))
    this.name = 'TokenEnvUnsetError'
  }
}

/** The one wording for an unset `token_env` variable, on every surface. */
export function tokenEnvUnsetMessage(variable: string, scope: string): string {
  return `the token for ${scope} comes from the environment variable ${variable}, which is unset or empty where PLUR runs — ` +
    `set ${variable} there and run again (PLUR stores only the variable's name, never the token)`
}

/**
 * The doctor's check detail for a store whose `token_env` variable is unset —
 * one wording for `plur doctor` and `plur_doctor`.
 */
export function tokenEnvUnsetDetail(variable: string, scope: string): string {
  return `NO TOKEN — ${tokenEnvUnsetMessage(variable, scope)}. Team-scoped writes are queuing to the outbox.`
}

/**
 * The doctor's fix for that store, on both doctors. A running editor or MCP
 * server keeps the environment it started with, so it must be restarted to
 * see the variable.
 */
export function tokenEnvUnsetFix(url: string, variable: string): string {
  return `Remote ${url}: set the environment variable ${variable} where PLUR runs (your shell profile, or the env of the editor's MCP server), ` +
    'then restart the editor or its MCP server so it picks the variable up. Queued engrams flush on the next session start, or run `plur outbox --flush`.'
}

/** Finds the variable named by {@link tokenEnvUnsetMessage} in recorded error text. */
export const TOKEN_ENV_UNSET_RE = /environment variable (\S+), which is unset or empty/

/**
 * A response whose body has already been read, inside the request deadline.
 *
 * `json` is present only for a 2xx (and is `undefined` when the payload would
 * not parse); `text` only for a non-2xx, already sanitised. Keeping both off
 * the same object as a live `Response` is what stops a caller reading a body
 * after the deadline has been cleared.
 */
interface BoundedResponse {
  readonly ok: boolean
  readonly status: number
  readonly json?: unknown
  readonly text?: string
}

/**
 * Top-level `_`-prefixed keys are LOADER bookkeeping, never server data:
 * `_pack`, `_storeScope` and `_originalId` are stamped by the code that loads
 * a row and are read as the row's origin (tensions.ts `engramOrigin`, the
 * `withoutPacks` filter, injected-pack counting). Left in place, a
 * server-supplied `_pack` would let a remote writer give its row an installed
 * pack's origin and defeat the measured-under gate. Stripped here, at the one trust
 * boundary both remote legs share, so the loaders' own stamps are the only
 * markers a remote row can carry.
 */
function withoutLoaderMarkers(candidate: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(candidate)) if (!k.startsWith('_')) out[k] = v
  return out
}

/**
 * Validate a remote row against RemoteRowSchema, salvaging schema drift: on failure
 * strip exactly the top-level fields the issues name and re-parse ONCE, so an older
 * or newer server's drifted value does not hide the whole engram. A missing required
 * field still fails. Returns null if unusable. Shared by RemoteStore.reshape and
 * remote-recall's processHostRows.
 */
export function salvageRemoteRow(
  rawCandidate: Record<string, unknown>,
  logContext?: { url: string; rowId?: unknown },
): { data: Record<string, unknown>; salvagedFields: string[] } | null {
  const candidate = withoutLoaderMarkers(rawCandidate)
  const first = RemoteRowSchema.safeParse(candidate)
  if (first.success) return { data: first.data as Record<string, unknown>, salvagedFields: [] }
  const failing = [...new Set(first.error.issues.map(i => String(i.path[0] ?? '')).filter(Boolean))]
  if (failing.length === 0) return null
  if (failing.some(key => NEVER_STRIP.has(key))) return null // fail closed — see NEVER_STRIP
  const slim: Record<string, unknown> = { ...candidate }
  for (const key of failing) delete slim[key]
  const second = RemoteRowSchema.safeParse(slim)
  if (!second.success) return null
  const salvagedFields = failing.sort()
  if (logContext) {
    const dedupeKey = `${logContext.url}|${salvagedFields.join(',')}`
    if (!warnedSalvages.has(dedupeKey)) {
      warnedSalvages.add(dedupeKey)
      const safeId = String(logContext.rowId ?? '').replace(/[^\w:./-]/g, '?').slice(0, 64)
      logger.warning(
        `[plur:remote-store] ${safeOrigin(logContext.url)} serves engrams with drifted field(s) [${salvagedFields.join(',')}] this client ` +
        `cannot validate (first seen id="${safeId}") — keeping the engrams WITHOUT those fields. ` +
        `The server and client schemas need reconciling (#1071); recall is degraded, not blind.`,
      )
    }
  }
  return { data: second.data as Record<string, unknown>, salvagedFields }
}

/**
 * Capability a server advertises in `GET /api/v1/me` → `capabilities[]` when it
 * honours `source` on `POST /engrams/:id/feedback`.
 */
export const FEEDBACK_SOURCE_CAPABILITY = 'feedback.source'

/** Host grammar for server-supplied strings. */
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/
/** A bracketed IPv6 literal with an optional port, e.g. `[2001:db8::1]:8443`. */
const IPV6_HOST_RE = /^(\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/

/**
 * A server-supplied host: a name or IPv4 address (HOST_RE), or a bracketed
 * IPv6 literal in the canonical form the URL parser prints, with an optional
 * port in range. No userinfo, path or other characters can pass.
 */
export function isSafeHost(h: string): boolean {
  if (HOST_RE.test(h)) return true
  const m = IPV6_HOST_RE.exec(h)
  if (!m) return false
  if (m[2] !== undefined && Number(m[2]) > 65535) return false
  try {
    return new URL(`http://${m[1]}/`).hostname === m[1]
  } catch {
    return false
  }
}
/** Path grammar for server-supplied project paths.
 *  Each segment must start with a word char to prevent path traversal (e.g. `..`). */
const PATH_RE = /^[\w][\w.-]*(\/[\w][\w.-]*)*$/
/** ISO-8601 date or date-time. `Date.parse` alone also accepts '1', '2026' and 'March 7, 2026'. */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * The resolved fields returned by GET /api/v1/me.
 * Older servers omit some fields; see per-field comments for the absent values.
 */
export interface MeResponse {
  username: string
  org_id: string
  role: string
  scopes: string[]
  scope_metadata: ScopeMetadata[]
  capabilities: string[]
  /** 'absent' when the server sent no field (older server). */
  scopes_status: 'ok' | 'not_synced' | 'absent'
  /** 'absent' when the server sent no field (older server). */
  scope_metadata_status: 'ok' | 'unavailable' | 'absent'
  /** undefined = field absent; null = GitLab not configured. */
  gitlab_host: string | null | undefined
  /** Only entries whose key is in `scopes` and whose value passes the path grammar. */
  project_paths: Record<string, string>
  /** undefined = absent = unknown; null = no expiry; string = ISO-8601. */
  key_expires_at: string | null | undefined
  /**
   * True when the body's `scopes` was missing, null, not an array, or an array
   * with a member that failed the grammar: `scopes` above is then not the
   * server's list, and discovery treats the answer as degraded (keeps a
   * non-empty cache). Absent/false = an explicit, valid array (`[]` included).
   */
  scopes_malformed?: boolean
}

/**
 * Advertised capabilities per (url, token), for the life of the process.
 * Filled by every successful `me()` — session start already calls it
 * — and consulted by `hasCapability()`, which calls `/me` at most once per
 * (url, token) when nothing has filled it yet. Never one call per rating.
 */
const CAPABILITY_CACHE = new Map<string, Promise<string[]>>()

/** Test seam — forget every cached capability set. */
export function _resetRemoteCapabilityCache(): void {
  CAPABILITY_CACHE.clear()
}

/**
 * Remote engram store — speaks to a PLUR Enterprise server over its REST API
 * (/api/v1), with the same load/append/getById/remove shape as file-backed stores.
 * load() holds a per-instance TTL cache (default 60s), since recall calls it every
 * time. Any network error makes load() return an empty array (logged), not throw.
 */
export class RemoteStore {
  private cache: { ts: number; engrams: Engram[] } | null = null
  private inFlight: Promise<Engram[]> | null = null

  constructor(
    private readonly url: string,    // e.g. https://plur.example.com/sse — but we hit /api/v1
    private readonly token: string,
    private readonly scope: string,  // narrow listing on the server side
    private readonly opts: { ttlMs?: number; tokenEnv?: string } = {},
  ) {}

  /** The configured endpoint url — the key the per-host health state uses
   *  (normalized by its readers). Read-only. */
  get endpointUrl(): string {
    return this.url
  }

  /** Never send a request without the token a `token_env` names. */
  private assertToken(): void {
    if (!this.token && this.opts.tokenEnv) throw new TokenEnvUnsetError(this.opts.tokenEnv, this.scope)
  }

  private get apiBase(): string {
    // The user configures the SSE URL (consistent with mcp.json shape);
    // /api/v1 is rooted at the same host. Strip /sse if present, then
    // append /api/v1. Shares normalizeEndpointUrl so HTTP-time and
    // identity-time normalization can never drift.
    return normalizeEndpointUrl(this.url) + '/api/v1'
  }

  private get ttlMs(): number { return this.opts.ttlMs ?? 60_000 }

  /**
   * A response whose body has ALREADY been read, inside the request deadline.
   *
   * Returned instead of a `Response` so that no caller can be handed a live
   * body to read after the timer has been cleared. Callers branch on
   * `ok`/`status`; the payload is already here.
   */
  private static async readBounded(res: Response): Promise<BoundedResponse> {
    // 2xx carries the payload; anything else carries an error body that gets
    // sanitised before it can reach a log line or an exception message.
    return res.ok
      ? { ok: true, status: res.status, json: await res.json().catch(() => undefined) }
      : { ok: false, status: res.status, text: sanitiseResponseBody(await res.text().catch(() => '')) }
  }

  /**
   * Run a request AND read its body under ONE deadline; every request in this class
   * goes through here. Unbounded requests inherit undici's 300s timeout while some
   * callers hold the primary store lock (180s budget), and `fetch()` resolves on
   * headers, so the body read must be inside the bound too.
   *
   * @param consume - reads the body. Runs INSIDE the deadline, and the abort
   *   signal is wired to the response stream, so a stalled read rejects.
   */
  private async fetchBounded<T>(
    url: string,
    init: RequestInit,
    consume: (res: Response) => Promise<T>,
    /** The caller's own budget. Aborting it cuts the request with a
     *  {@link RemoteAbortedError}, which does not mark the host down. */
    callerSignal?: AbortSignal,
  ): Promise<T> {
    // A network-level failure here MARKS the host down (so the passive
    // read path fast-fails), but this method never fast-fails itself. It
    // carries writes, /me and explicit retries — an outbox flush the user just
    // invoked against a host that recovered must be allowed to probe, not be
    // told "still down" for the rest of the cooldown. The probe doubles as the
    // breaker's recovery check: on success the next failure window starts
    // clean; on failure the mark is refreshed.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), LOAD_FETCH_TIMEOUT_MS)
    const timedOut = () => callerSignal?.aborted
      ? new RemoteAbortedError(url)
      : new RemoteTimeoutError(url, LOAD_FETCH_TIMEOUT_MS)
    const onCallerAbort = () => ctrl.abort()
    if (callerSignal?.aborted) ctrl.abort()
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    try {
      let res: Response
      try {
        res = await fetch(url, { ...init, signal: ctrl.signal })
      } catch (err) {
        // A cut at the CALLER's budget says nothing about the host.
        if (callerSignal?.aborted) throw new RemoteAbortedError(url)
        // fetch only throws on network-level failures (and our abort) — an HTTP
        // error status resolves normally — so any throw here marks the host.
        markRemoteHostDown(url)
        throw ctrl.signal.aborted ? timedOut() : (err as Error)
      }
      clearRemoteHostDown(url) // the host answered — any HTTP status is a live host
      try {
        const out = await consume(res)
        // The SIGNAL is the authority on whether the deadline was met, not the
        // shape of what came back. A reader that tolerates a malformed payload
        // — `readBounded` returns `json: undefined` rather than throwing — will
        // otherwise swallow an abort and hand back an empty body as if the
        // request had succeeded: a stalled `/me` would return zero scopes,
        // silently, instead of timing out.
        if (ctrl.signal.aborted) throw timedOut()
        return out
      } catch (err) {
        // Deliberately NOT a host-down mark. The peer answered; a 5xx body, a
        // decode failure or a stalled stream says nothing about reachability,
        // and tripping the breaker on them would fast-fail a live host. Only
        // the deadline is reinterpreted, so a stalled body reports as the
        // timeout it is rather than as a bare AbortError.
        throw ctrl.signal.aborted ? timedOut() : (err as Error)
      }
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }


  /**
   * Reshape a DB row {id, scope, status, data} into an Engram and validate it.
   * Authoritative columns (id/scope/status) win over anything in `data`. Returns
   * null (and logs) for malformed rows so callers can drop them.
   */
  private reshape(raw: { id?: unknown; scope?: unknown; status?: unknown; data?: unknown; created_at?: unknown }): Engram | null {
    const d = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : {}
    // Same field-compat rules as the YAML and Postgres loaders, so a row with
    // a legacy `reference_count` arrives as `write_count` and read sites need
    // no fallback.
    const candidate = normalizeEngramInput({ ...d, id: raw.id, scope: raw.scope, status: raw.status })
    // Schema-drift salvage (see salvageRemoteRow): keep an engram whose only
    // problem is a drifted optional field, dropping just that field.
    const salvaged = salvageRemoteRow(candidate as Record<string, unknown>, { url: this.url, rowId: raw.id })
    if (!salvaged) {
      // Do NOT echo server-controlled VALUES into the log. Zod messages can
      // embed the received value, and a crafted id could carry newlines/control
      // chars to forge log lines (log injection) or leak data. Log only the field
      // PATHS + failure CODES, plus a sanitized, bounded id.
      const reparse = RemoteRowSchema.safeParse(candidate)
      const why = reparse.success ? 'unknown' : reparse.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.code}`).join('; ')
      const safeId = String(raw.id ?? '').replace(/[^\w:./-]/g, '?').slice(0, 64)
      logger.warning(`[plur:remote-store] ${safeOrigin(this.url)} returned a malformed engram (id="${safeId}") — dropped: ${why}`)
      return null
    }
    const parsed = { data: salvaged.data }
    // The server stores the validity window FLAT in row data
    // (valid_from / valid_until), while every local consumer
    // reads the nested `temporal` block (inject's expiry gate, decay). Map
    // flat → nested on ingest so remote validity windows actually drive local
    // expiry. Nested values win; only well-typed strings are mapped.
    const out = parsed.data as Record<string, unknown>
    const nested = out.temporal && typeof out.temporal === 'object'
      ? out.temporal as Record<string, unknown>
      : {}
    const flatFrom  = typeof out.valid_from  === 'string' ? out.valid_from  : undefined
    const flatUntil = typeof out.valid_until === 'string' ? out.valid_until : undefined
    const mapFrom  = flatFrom  !== undefined && typeof nested.valid_from  !== 'string'
    const mapUntil = flatUntil !== undefined && typeof nested.valid_until !== 'string'
    if (mapFrom || mapUntil) {
      out.temporal = {
        ...nested,
        // `temporal.learned_at` is required by the schema — prefer what the
        // row carries, then the row's created_at, then "now" as a last resort.
        learned_at: typeof nested.learned_at === 'string' ? nested.learned_at
          : typeof raw.created_at === 'string' ? raw.created_at
          : new Date().toISOString(),
        ...(mapFrom  ? { valid_from: flatFrom }   : {}),
        ...(mapUntil ? { valid_until: flatUntil } : {}),
      }
    }
    // Rows stored without `tags` or `activation` get what a local engram gets
    // by default: inject walks `tags` and recall reads `activation`, so one
    // such row would otherwise fail session start, inject and recall for
    // every user of the scope.
    if (!Array.isArray(out.tags) || !(out.tags as unknown[]).every(t => typeof t === 'string')) out.tags = []
    if (!ActivationSchema.safeParse(out.activation).success) {
      out.activation = {
        retrieval_strength: 0.7,
        storage_strength: 1.0,
        frequency: 0,
        last_accessed: (typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString()).slice(0, 10),
      }
    }
    return out as unknown as Engram
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    this.assertToken()
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      ...extra,
    }
  }

  /** Read-only permission prediction, with complete request-ordered evidence. */
  async writeCheck(scopes: string[], signal?: AbortSignal): Promise<WriteCheckResult[]> {
    if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 50 || !scopes.every(s => typeof s === 'string')) {
      throw new Error('write-check requires one to fifty scope strings')
    }
    const r = await this.fetchBounded(`${this.apiBase}/write-check`, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ scopes }),
    }, RemoteStore.readBounded, signal)
    if (!r.ok) throw new RemoteHttpError(r.status, `Remote write-check failed: ${r.status} ${redactToken(r.text ?? '', this.token)}`)
    const results = (r.json as { results?: unknown } | undefined)?.results
    if (!Array.isArray(results) || results.length !== scopes.length) throw new Error('write-check returned an incomplete result list')
    return results.map((item: unknown, i): WriteCheckResult => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('write-check returned an invalid result')
      const row = item as Record<string, unknown>
      if (row.scope !== scopes[i] || typeof row.writable !== 'boolean' || typeof row.review_held !== 'boolean' ||
        (row.reason !== undefined && typeof row.reason !== 'string')) throw new Error('write-check returned invalid scope or permission evidence')
      return { scope: scopes[i], writable: row.writable, review_held: row.review_held,
        ...(typeof row.reason === 'string' ? { reason: sanitiseResponseBody(redactToken(row.reason, this.token)) } : {}) }
    })
  }

  /**
   * Resolve the identity behind this token — `GET /api/v1/me`: the full authorized
   * scope set plus `scopes_status`, `scope_metadata_status`, `gitlab_host`,
   * `project_paths` and `key_expires_at`, validated at this trust boundary.
   * Scope-independent (keyed on the token alone).
   * Throws {@link RemoteHttpError} on non-2xx; keeps the `Remote /me failed: <status>`
   * message so callers' `/\b40[13]\b/` auth-expired checks still match.
   */
  async me(signal?: AbortSignal): Promise<MeResponse> {
    const r = await this.fetchBounded(`${this.apiBase}/me`, { headers: this.headers() }, RemoteStore.readBounded, signal)
    if (!r.ok) {
      let code: 'scope_lookup_failed' | undefined
      try { if (r.status === 503 && JSON.parse(r.text ?? '').error === 'scope_lookup_failed') code = 'scope_lookup_failed' } catch { /* generic errors are not authentication evidence */ }
      throw new RemoteHttpError(r.status, `Remote /me failed: ${r.status} ${r.text}`, code)
    }
    // A 200 whose JSON body is not an object (a string, number, array or null) is
    // read as an older server that sent no fields — never a TypeError from `in`.
    const body = (r.json !== null && typeof r.json === 'object' && !Array.isArray(r.json)
      ? r.json : {}) as Record<string, unknown>
    // Values dropped at this boundary, as `field: reason` — never the value.
    const dropped: string[] = []
    // Optional, additive. Older servers omit it → []. Same safe-grammar
    // filter as scope names: nothing malformed enters from a hostile remote.
    const capabilities = Array.isArray(body['capabilities'])
      ? (body['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string' && /^[\w.:-]{1,64}$/.test(c))
      : []
    CAPABILITY_CACHE.set(this.capabilityKey(), Promise.resolve(capabilities))
    const rawScopes = body['scopes']
    const scopes = Array.isArray(rawScopes)
      // Validate every /me scope to a safe grammar at the trust boundary:
      //  - a non-string element would later throw in isSharedScope's
      //    `scope.startsWith(...)` BEFORE the per-scope try/catch — drop non-strings.
      //  - scope names render verbatim into the session-start guide (the
      //    agent's directive surface); a name carrying newlines/control chars is a
      //    prompt-injection channel — require `[\w:./-]+` (allows group:org/team,
      //    user:*, etc.) so nothing malformed enters from a hostile/MITM remote.
      ? (rawScopes as unknown[]).filter((s): s is string => typeof s === 'string' && /^[\w:./-]+$/.test(s))
      : []
    // Only an explicit array whose every member passed is the server's list.
    // Missing/null/non-array or a dropped member must not read as an
    // authoritative [] that clears a cache.
    const scopes_malformed = !Array.isArray(rawScopes) || scopes.length !== (rawScopes as unknown[]).length
    if (scopes_malformed && rawScopes !== undefined) dropped.push(Array.isArray(rawScopes) ? `scopes: ${(rawScopes as unknown[]).length - scopes.length} invalid` : 'scopes: not a list')

    // scopes_status — unknown values → 'absent' (forward-compat)
    const rawScopesStatus = body['scopes_status']
    const scopes_status: MeResponse['scopes_status'] =
      rawScopesStatus === 'ok' || rawScopesStatus === 'not_synced' ? rawScopesStatus : 'absent'

    // scope_metadata_status — unknown values → 'absent'
    const rawScopeMetadataStatus = body['scope_metadata_status']
    const scope_metadata_status: MeResponse['scope_metadata_status'] =
      rawScopeMetadataStatus === 'ok' || rawScopeMetadataStatus === 'unavailable'
        ? rawScopeMetadataStatus : 'absent'

    // gitlab_host — must pass host grammar; null stays null; absent → undefined
    const rawGitlabHost = body['gitlab_host']
    const gitlab_host: MeResponse['gitlab_host'] =
      rawGitlabHost === null ? null
      : typeof rawGitlabHost === 'string' && isSafeHost(rawGitlabHost) ? rawGitlabHost
      : undefined
    if (rawGitlabHost !== undefined && gitlab_host === undefined) dropped.push('gitlab_host: invalid')

    // project_paths — only entries whose key is in scopes AND whose value
    // passes the path grammar; an absent field yields {}
    const project_paths: Record<string, string> = {}
    const rawPaths = body['project_paths']
    if (rawPaths !== null && typeof rawPaths === 'object') {
      let notGranted = 0
      let badPath = 0
      for (const [k, v] of Object.entries(rawPaths as Record<string, unknown>)) {
        if (!scopes.includes(k)) notGranted++
        else if (typeof v !== 'string' || !PATH_RE.test(v)) badPath++
        else project_paths[k] = v
      }
      if (notGranted) dropped.push(`project_paths: ${notGranted} not-granted`)
      if (badPath) dropped.push(`project_paths: ${badPath} invalid`)
    }

    // key_expires_at — absent → undefined (unknown); null → null (no expiry);
    // a string that is not valid ISO-8601 → undefined
    const rawKeyExpiry = body['key_expires_at']
    const key_expires_at: MeResponse['key_expires_at'] =
      !('key_expires_at' in body) ? undefined
      : rawKeyExpiry === null ? null
      : typeof rawKeyExpiry === 'string' && ISO_8601_RE.test(rawKeyExpiry) && !isNaN(Date.parse(rawKeyExpiry)) ? rawKeyExpiry
      : undefined
    if (rawKeyExpiry !== undefined && key_expires_at === undefined) dropped.push('key_expires_at: invalid')
    if (dropped.length) {
      logger.warning(`[plur:remote-store] ${safeOrigin(this.url)} sent /me fields that do not conform (${dropped.join('; ')}) — DROPPED (#426).`)
    }

    return {
      username: typeof body['username'] === 'string' ? body['username'] : '',
      org_id:   typeof body['org_id'] === 'string' ? body['org_id'] : '',
      role:     typeof body['role'] === 'string' ? body['role'] : '',
      scopes,
      capabilities,
      scopes_status,
      scope_metadata_status,
      gitlab_host,
      project_paths,
      key_expires_at,
      ...(scopes_malformed ? { scopes_malformed: true } : {}),
      // Self-describing scope metadata served by the enterprise
      // `scopes` table. Validate each entry through the SAME ScopeMetadataSchema
      // the local config path uses — a hostile/old remote can send anything, so
      // drop entries that don't parse (and any whose `scope` isn't in the
      // authorized set, so a remote can't smuggle metadata for an unrelated
      // scope into discovery). Absent/empty → [] (older servers).
      // A dropped entry must SAY SO: `rankScopes` skips entries with empty
      // covers, so a server/client shape mismatch would silently disable
      // covers-based auto-routing and send every unscoped write to the
      // personal `unscoped_default`. The authorized-set drop stays quiet: that
      // one is a deliberate refusal, not an unexpected shape.
      scope_metadata: Array.isArray(body['scope_metadata'])
        ? (body['scope_metadata'] as unknown[]).flatMap((m) => {
            const parsed = ScopeMetadataSchema.safeParse(m)
            if (!parsed.success) {
              // Log PATHS and CODES only, never server-controlled values:
              // a Zod message can embed the received value, and a crafted one
              // could carry control chars to forge log lines.
              const why = parsed.error.issues
                .map(i => `${i.path.join('.') || '(root)'}: ${i.code}`)
                .join('; ')
              // Named only when it is a scope this answer granted: any other
              // text is the server's and could carry anything, the bearer key
              // included.
              const rawScope = (m as { scope?: unknown } | null)?.scope
              const safeScope = typeof rawScope === 'string' && scopes.includes(rawScope)
                ? rawScope.replace(/[^\w:./-]/g, '?').slice(0, 64)
                : '<a scope not granted>'
              logger.warning(
                `[plur:remote-store] ${safeOrigin(this.url)} sent scope metadata for "${safeScope}" that does not conform ` +
                `(${why}) — DROPPED. That scope cannot participate in covers-based auto-routing until the ` +
                `server sends a conforming shape, so unscoped writes may fall back to the personal default (#843).`,
              )
              return []
            }
            if (!scopes.includes(parsed.data.scope)) return []
            return [parsed.data]
          })
        : [],
    }
  }

  /**
   * Load all engrams visible to this token at this scope. Cached up to
   * ttlMs; in-flight calls deduplicate to avoid thundering-herd on
   * the remote when 5 things ask for engrams at once.
   */
  async load(): Promise<Engram[]> {
    // Before the page loop, whose catch would read a missing token as a dead host.
    this.assertToken()
    const now = Date.now()
    if (this.cache && now - this.cache.ts < this.ttlMs) return this.cache.engrams
    if (this.inFlight) return this.inFlight

    this.inFlight = (async () => {
      try {
        // Page through results — the server caps at 200/page.
        const all: Engram[] = []
        let offset = 0
        const limit = 200
        const maxPages = 50  // hard cap to avoid runaway loops
        // Only cache a result set from a clean (complete) pagination run.
        // A mid-pagination abort/error must not overwrite a prior good cache
        // with a partial view.
        let paginationComplete = false
        for (let i = 0; i < maxPages; i++) {
          // Several entries on one dead host must cost ONE timeout per
          // process, not one each — fast-fail to the prior cache during cooldown.
          if (remoteHostDownRemainingMs(this.url) > 0) break
          const u = `${this.apiBase}/engrams?scope=${encodeURIComponent(this.scope)}&limit=${limit}&offset=${offset}`
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), LOAD_FETCH_TIMEOUT_MS)
          try {
            let r: Response
            try {
              r = await fetch(u, { headers: this.headers(), signal: ctrl.signal })
            } catch (err) {
              // Network-level failure (fetch only throws on those + our abort):
              // mark the host so sibling stores skip their own timeouts.
              markRemoteHostDown(this.url)
              const msg = (err as Error).name === 'AbortError'
                ? `page fetch timed out after ${LOAD_FETCH_TIMEOUT_MS}ms`
                : (err as Error).message
              console.error(`[plur:remote-store] ${safeOrigin(this.url)} load page failed: ${msg}`)
              break
            }
            clearRemoteHostDown(this.url) // answered — alive, whatever the status
            if (!r.ok) {
              // 403 (no read access) and 404 (scope doesn't exist) are stable
              // states: the scope genuinely has nothing for us. Cache [] so we
              // don't spam the server on every TTL expiry.
              // 5xx are transient — don't cache the partial/empty result; fall
              // back to the prior good cache so recall stays useful.
              if (r.status === 403 || r.status === 404) {
                paginationComplete = true
              } else if (r.status >= 500) {
                console.error(`[plur:remote-store] ${safeOrigin(this.url)} returned ${r.status} loading scope ${this.scope}`)
              }
              break
            }
            // The host ANSWERED. From here on nothing marks it down: HTTP
            // responses never trip the breaker. An unreadable or malformed
            // body ends pagination as incomplete (prior cache kept), the same
            // as fetchBounded treats a bad body. A body stalled past the
            // deadline is reported as a timeout, still without a mark.
            let body: unknown
            try {
              body = await r.json()
            } catch {
              const why = ctrl.signal.aborted
                ? `a page body that stalled past ${LOAD_FETCH_TIMEOUT_MS}ms`
                : 'an unreadable (non-JSON) page body'
              console.error(`[plur:remote-store] ${safeOrigin(this.url)} returned ${why} loading scope ${this.scope}`)
              break
            }
            const page = body as { rows?: unknown; total_count?: unknown } | null
            if (!page || typeof page !== 'object' || !Array.isArray(page.rows)) {
              console.error(`[plur:remote-store] ${safeOrigin(this.url)} returned a malformed page (no rows array) loading scope ${this.scope}`)
              break
            }
            const rows = page.rows as any[]
            // Server returns DB rows shaped {id, scope, status, data, created_at, updated_at}
            // — the engram contents live in row.data. Reshape + validate; drop malformed.
            for (const row of rows) {
              const e = row && typeof row === 'object' ? this.reshape(row) : null
              if (e) all.push(e)
            }
            const total = typeof page.total_count === 'number' ? page.total_count : Infinity
            if (all.length >= total || rows.length < limit) {
              paginationComplete = true
              break
            }
            offset += limit
          } finally {
            clearTimeout(t)
          }
        }
        if (paginationComplete) {
          this.cache = { ts: Date.now(), engrams: all }
          return all
        }
        // Incomplete pagination (transient error / abort): preserve the prior
        // good cache and return it so callers keep seeing valid engrams. Fall
        // back to the partial set only if there is no prior cache at all.
        return this.cache?.engrams ?? all
      } catch (err) {
        console.error(`[plur:remote-store] ${safeOrigin(this.url)} load failed: ${(err as Error).message}`)
        // Don't poison the cache on failure — let the next call retry.
        return this.cache?.engrams ?? []
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  /**
   * Append a single engram to the remote store. POST /api/v1/engrams
   * carries the core four (statement + scope + domain + type) plus every
   * optional field that is set — pinned, rationale, tags, commitment,
   * validity window, supersedes, locked_reason. The server handles
   * ID assignment, content_hash, status.
   *
   * Returns void. Callers that need the server-assigned ID (e.g. so the
   * user can later forget/feedback on it) should use `appendAndGetServerId()`
   * instead.
   */
  async append(engram: Engram): Promise<void> {
    await this.appendAndGetServerId(engram)
  }

  /**
   * Like append() but returns the server-assigned ID. Required because
   * the server picks its own ID (e.g. ENG-2026-05-06-007) and ignores
   * any id we'd send. Without this, callers see the local placeholder
   * ID (e.g. ENG-2026-0506-017) and a later `forget(id)` against that
   * placeholder will fail — the engram only exists on the server with
   * the server's ID.
   */
  async appendAndGetServerId(
    engram: Engram,
    opts?: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<{ id: string; review_required?: true; deduplicated?: true }> {
    // Transmit the full engram, not just the core four, so pins, validity
    // windows, supersedes etc. round-trip. Optional fields are included only
    // when set, so older servers that ignore unknown keys see no change.
    const e = engram as any
    // Canonical engrams carry the validity window nested under `temporal`
    // (temporal.valid_from / temporal.valid_until) and supersession
    // under `relations.supersedes` — the wire contract
    // (POST /api/v1/engrams) takes them as FLAT top-level
    // keys, so flatten here. Top-level reads are kept as a fallback for
    // non-canonical shapes; they are always undefined on production engrams.
    const valid_from  = e.temporal?.valid_from  ?? e.valid_from
    const valid_until = e.temporal?.valid_until ?? e.valid_until
    const supersedes  = Array.isArray(e.relations?.supersedes) && e.relations.supersedes.length > 0
      ? e.relations.supersedes
      : e.supersedes
    // Who chose the scope. Stamped by learnRouted on the shape that crosses
    // the wire; `structured_data` itself is not transmitted, so without this
    // the server could not tell a scope the user typed from one the router
    // picked out of `covers`. Omitted when absent rather than claiming
    // `explicit` it cannot vouch for.
    //
    // `structured_data` is caller-settable on update, so the value is checked
    // against the four `ScopeSource` values rather than trusted: anything else
    // is omitted.
    const rawScopeSource: unknown = e.structured_data?._scopeSource
    const scope_source = typeof rawScopeSource === 'string' && SCOPE_SOURCES.has(rawScopeSource)
      ? rawScopeSource
      : undefined
    const idempotencyKey = opts?.idempotencyKey
    const body = JSON.stringify({
      // docs/remote-store-contract.md: the key is also recorded with the row,
      // so a retry can find what an earlier, cut attempt stored.
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      statement: e.statement,
      scope:     engram.scope,
      domain:    e.domain,
      type:      e.type,
      ...(scope_source != null ? { scope_source } : {}),
      ...(Array.isArray(e.tags) && e.tags.length > 0 ? { tags: e.tags } : {}),
      ...(e.pinned !== undefined            ? { pinned: e.pinned }             : {}),
      ...(e.rationale != null               ? { rationale: e.rationale }       : {}),
      ...(e.commitment !== undefined        ? { commitment: e.commitment }     : {}),
      ...(valid_from != null                ? { valid_from }                   : {}),
      ...(valid_until != null               ? { valid_until }                  : {}),
      ...(Array.isArray(supersedes) && supersedes.length > 0 ? { supersedes } : {}),
      ...(e.locked_reason != null           ? { locked_reason: e.locked_reason } : {}),
      // Provenance rides the wire when present (e.g. a rescoped copy carries
      // "rescoped from <original id>" in `source`). Additive — servers that
      // don't model `source` ignore the field, and it is omitted when unset.
      ...(e.source != null                  ? { source: e.source }             : {}),
      // Carry provenance records so the receiving store can answer
      // origin/chain/licence questions. Omitted when unset.
      ...(e.provenance != null              ? { provenance: e.provenance }     : {}),
      // The conditions a measurement was taken under, the material that
      // supports it, and its worked example. `measured_under` matters most: a
      // measured claim carries what makes it true (hardware, dataset, source,
      // date); without it, a result that held on one machine arrives at a
      // teammate as an unconditional fact.
      ...(e.measured_under != null          ? { measured_under: e.measured_under } : {}),
      ...(Array.isArray(e.knowledge_anchors) && e.knowledge_anchors.length > 0
        ? { knowledge_anchors: e.knowledge_anchors } : {}),
      ...(e.dual_coding != null             ? { dual_coding: e.dual_coding }   : {}),
      // Who is answerable for the claim, and what kind of claim it is, so the
      // receiving side can tell a person's statement from a model's inference
      // (`inject.ts` marks `claim_class: 'inferred'` at layers 1 and 2).
      //
      // `license` needs no line here: it lands in `provenance.license`, and
      // `provenance` is already above.
      ...(e.attribution != null             ? { attribution: e.attribution }   : {}),
      ...(e.claim_class != null             ? { claim_class: e.claim_class }   : {}),
    })
    const r = await this.fetchBounded(`${this.apiBase}/engrams`, {
      method: 'POST',
      // Unique per LOGICAL write and stable across that write's retries — a
      // random UUID the caller mints once and persists (docs/remote-store-
      // contract.md). NEVER derived from the engram id: that is `__pending__`
      // on every direct write and a per-day sequence that collides across
      // machines. No key, no header.
      headers: this.headers({
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      }),
      body,
    }, RemoteStore.readBounded, opts?.signal)
    if (!r.ok) throw new RemoteHttpError(r.status, `Remote store append failed: ${r.status} ${r.text}`)
    const data = (r.json ?? {}) as { id?: unknown; review_required?: unknown; deduplicated?: unknown }
    // Validate the server-assigned id's SHAPE, not just truthiness. It
    // becomes this engram's id (cached, rendered, used as a key), so a non-string,
    // empty, over-long, or control-char-bearing id from a buggy/hostile endpoint
    // must be rejected rather than trusted.
    const id = data.id
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || !/^[\w:./-]+$/.test(id)) {
      const shown = typeof id === 'string' ? `"${id.slice(0, 64).replace(/[^\w:./-]/g, '?')}"` : typeof id
      throw new Error(`Remote store append: server returned an invalid id (${shown})`)
    }
    // Optimistic cache insert: the POST succeeded so the server
    // has the engram. Insert with the server-assigned id so the very next
    // recall sees it without waiting for a background refresh. If the server
    // transformed other fields, the next refresh corrects them.
    if (data.review_required === true) {
      this.cache = null
      return { id, review_required: true, ...(data.deduplicated === true ? { deduplicated: true as const } : {}) }
    }
    const stored = { ...(engram as any), id } as Engram
    if (this.cache) {
      this.cache.engrams.push(stored)
    } else {
      // Cold cache (no prior load()): one engram is not "all engrams in
      // this scope". Mark stale (ts: 0) so the next load() refetches
      // from the server instead of treating the partial view as fresh.
      this.cache = { ts: 0, engrams: [stored] }
    }
    return { id, ...(data.deduplicated === true ? { deduplicated: true as const } : {}) }
  }

  /**
   * `save(all)` — used by migrations to bulk-replace. Not supported
   * on remote: the server keeps an audit trail and we don't want a
   * single client to be able to nuke + replace the whole store. Throws.
   */
  async save(_engrams: Engram[]): Promise<void> {
    throw new Error('Remote store does not support bulk save() — use append()/remove() per engram')
  }

  async getById(id: string): Promise<Engram | null> {
    try {
      const r = await this.fetchBounded(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, { headers: this.headers() }, RemoteStore.readBounded)
      if (r.status === 404) return null
      if (!r.ok) return null
      // An unparseable 2xx body arrives as `undefined` rather than throwing.
      if (r.json === undefined) return null
      return this.reshape(r.json as any)
    } catch {
      return null
    }
  }

  /**
   * Existence probe that distinguishes "definitely absent" from "cannot tell"
   * (`getById` returns `null` for both). Returns false ONLY on an authoritative 404;
   * transport failure, 5xx or auth rejection throw, so `forget()` never mistakes an
   * unreachable store for absence. BOUNDED: `forget()`/`feedback()` call it inside the
   * primary store lock, and a stalled host must not outlast the lock acquire timeout.
   */
  async existsById(id: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
    // Uses the shared helper so the body read is bounded too (see the method
    // doc: an unbounded probe here, inside the store lock, loses writes).
    let r: BoundedResponse
    try {
      r = await this.fetchBounded(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, {
        headers: this.headers(),
      }, RemoteStore.readBounded, opts?.signal)
    } catch (err) {
      // An abort is "cannot tell", not "absent" — the whole point of this
      // method — so it must surface as a throw like any other transport
      // failure, with a message that says which it was. A cut at the
      // CALLER's budget (the collision probe is bounded well below the 30 s
      // request deadline) is a timeout too.
      throw new Error(
        err instanceof RemoteTimeoutError
          ? `existence probe for ${id} timed out after ${LOAD_FETCH_TIMEOUT_MS}ms against ${this.apiBase}`
          : err instanceof RemoteAbortedError
            ? `existence probe for ${id} timed out (no answer within the probe budget) against ${this.apiBase}`
            : `existence probe for ${id} failed against ${this.apiBase}: ${(err as Error).message}`,
      )
    }
    if (r.status === 404) return false
    // The status rides along so a caller can tell a rejected token (401/403)
    // from a server it could not reach.
    if (!r.ok) throw new RemoteHttpError(r.status, `HTTP ${r.status} from ${this.apiBase}`)
    // A 200 is not on its own proof of existence — confirm the body actually
    // describes THIS engram. Servers and proxies return 200 with collection or
    // envelope payloads on routes they do not recognise, and inferring
    // existence from the status line alone would turn that into a false
    // collision report on every forget.
    const row = (r.json ?? null) as { id?: unknown } | null
    return typeof row?.id === 'string' && row.id === id
  }

  /**
   * Ownership probe with a THIRD state, `unknown`. Ownership is decided by `reshape`
   * exactly as in `getById`; only "absent" (404) and "could not look" are split.
   * Not `existsById`, which rejects a bare 200 (proxy envelopes) — too strict here.
   */
  async probeById(id: string, opts?: { signal?: AbortSignal }): Promise<'owned' | 'absent' | 'unknown'> {
    let r: BoundedResponse
    try {
      r = await this.fetchBounded(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, {
        headers: this.headers(),
      }, RemoteStore.readBounded, opts?.signal)
    } catch {
      return 'unknown'
    }
    if (r.status === 404) return 'absent'
    // Any other non-ok says nothing about whether the row exists.
    if (!r.ok) return 'unknown'
    const row = r.json ?? null
    if (row === null) return 'unknown'
    return this.reshape(row as { id?: unknown; scope?: unknown; status?: unknown; data?: unknown })
      ? 'owned' : 'absent'
  }

  /**
   * Retire `id` on the server, idempotently (used by the queued "retire on
   * remote" entry). `'removed'` on 2xx; `'absent'` on 404/410 —
   * the row is already gone, which is the goal, so the entry is done. Any
   * other status throws (the caller keeps the entry queued and retries);
   * a network failure throws from `fetchBounded` as usual.
   */
  async removeIdempotent(id: string): Promise<'removed' | 'absent'> {
    const r = await this.fetchBounded(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    }, RemoteStore.readBounded)
    if (r.ok) { this.cache = null; return 'removed' }
    if (r.status === 404 || r.status === 410) return 'absent'
    throw new Error(`Remote delete failed: ${r.status} ${r.text}`)
  }

  /** Remove → DELETE /api/v1/engrams/:id (server soft-retires). */
  async remove(id: string): Promise<boolean> {
    const r = await this.fetchBounded(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers(),
    }, RemoteStore.readBounded)
    if (!r.ok) return false
    this.cache = null
    return true
  }

  /**
   * Apply feedback to a remote engram. POST /api/v1/engrams/:id/feedback
   * sends the raw signal; the server owns the mutation logic (strength
   * adjustment, commitment promotion, counter increment).
   *
   * RemoteStore-specific — no file-backed counterpart; requires server support.
   */
  async feedback(
    id: string,
    signal: 'positive' | 'negative' | 'neutral',
    options?: { source?: 'auto' },
  ): Promise<void> {
    // `source` is sent only when set, so an explicit rating's request body
    // is unchanged. Callers send `source: 'auto'` only to
    // a server that advertises FEEDBACK_SOURCE_CAPABILITY.
    const payload = options?.source === 'auto' ? { signal, source: 'auto' } : { signal }
    const r = await this.fetchBounded(`${this.apiBase}/engrams/${encodeURIComponent(id)}/feedback`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    }, RemoteStore.readBounded)
    if (!r.ok) throw new Error(`Remote feedback failed: ${r.status} ${r.text}`)
    this.cache = null
  }

  private capabilityKey(): string {
    return `${this.apiBase}::${this.token}`
  }

  /**
   * Does the server advertise `name` in `/me` → `capabilities`? Cached per
   * (url, token) for the process; a failed `/me` reads as "no" and is cached
   * too, so an unreachable host costs one bounded attempt, not one per call.
   */
  async hasCapability(name: string): Promise<boolean> {
    const key = this.capabilityKey()
    let pending = CAPABILITY_CACHE.get(key)
    if (!pending) {
      pending = this.me().then(m => m.capabilities, () => [] as string[])
      CAPABILITY_CACHE.set(key, pending)
    }
    return (await pending).includes(name)
  }

  async count(filter?: { status?: string }): Promise<number> {
    // Cheap-ish: load (cached) and filter client-side.
    const all = await this.load()
    if (filter?.status) return all.filter(e => e.status === filter.status).length
    return all.length
  }

  /**
   * Partial update of a remote engram. PATCH /api/v1/engrams/:id accepts
   * any subset of {pinned, status, statement, ...}. The server applies
   * the diff atomically; unsupplied fields are unchanged.
   *
   * RemoteStore-specific — no file-backed counterpart; requires server support.
   * Used by setPinned, promote, reportFailure for remote routing.
   */
  async patch(id: string, updates: Partial<Engram>): Promise<Engram | null> {
    const r = await this.fetchBounded(`${this.apiBase}/engrams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(updates),
    }, RemoteStore.readBounded)
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`Remote patch failed: ${r.status} ${r.text}`)
    // The server confirmed the write (2xx). Capture the pre-write row
    // from the cache BEFORE invalidating so the fallback below can merge it.
    const prev = this.cache?.engrams.find(e => e.id === id) ?? null
    this.cache = null
    // Server returns {engram: {id, scope, status, data: {...}, ...}}; reshape
    // to top-level Engram (same as load() does for rows[]).
    const body = (r.json ?? null) as { engram?: { id: string; scope: string; status: string; data?: any } } | null
    const reshaped = body?.engram ? this.reshape(body.engram) : null
    if (reshaped) return reshaped
    // 2xx but the echoed row was missing or failed validation. Returning
    // null here would be indistinguishable from the 404 above — callers would
    // misreport a successful write as not-found, or retry it. Return the
    // optimistically-merged engram (pre-write cached row + the acknowledged
    // updates); the next load() observes the server's authoritative state.
    // Only defined update values are applied, mirroring what JSON.stringify
    // actually sent to the server. Same id sanitization as reshape().
    const safeId = id.replace(/[^\w:./-]/g, '?').slice(0, 64)
    logger.warning(`[plur:remote-store] ${safeOrigin(this.url)} PATCH ${safeId} succeeded but the echoed row was unusable — returning optimistic merge`)
    const merged: Record<string, unknown> = prev ? { ...(prev as unknown as Record<string, unknown>) } : {}
    for (const [k, v] of Object.entries(updates)) if (v !== undefined) merged[k] = v
    merged.id = id
    return merged as unknown as Engram
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to close. Drop the cache for hygiene.
    this.cache = null
  }
}
