/**
 * Scope discovery for company servers, in the background (#1631).
 *
 * A server entry (a store entry with a `scopes` list and an `enterprise`
 * block) learns its scopes from `GET /api/v1/me` through
 * `Plur.refreshServerScopes`. Editors give an MCP server a short startup
 * window, so nothing here is ever awaited on the way to a tool answer:
 *
 *   - createServer starts one refresh and does not wait for it;
 *   - plur_session_start starts another only when none is in flight;
 *   - meanwhile every tool works from the cached scopes in config.yaml, and a
 *     settled refresh is seen by the next tool call (refreshServerScopes
 *     reloads the in-memory config after it writes).
 *
 * A refresh never rejects to its caller and never throws out of here: an
 * outcome that is not `ok`, or a refresh that failed outright, is one stderr
 * line naming the server by its safe origin (scheme, host and port — never
 * userinfo, path, the key or the server's answer).
 *
 * State is per Plur instance (a WeakMap), so the many servers the test suite
 * creates do not share it.
 */
import { normalizeEndpointUrl, type Plur, type DiscoveryStatus, type ServerDiscoveryOutcome } from '@plur-ai/core'

/** The /me budget of one background refresh. */
export const BACKGROUND_DISCOVERY_TIMEOUT_MS = 5000

let timeoutOverrideMs: number | undefined

/** Tests only: lift the /me budget so a held answer settles when the test says, not the clock. */
export function _setBackgroundDiscoveryTimeoutForTests(ms: number | undefined): void {
  timeoutOverrideMs = ms
}

interface DiscoveryState {
  enabled: boolean
  inFlight: Promise<void> | null
  /** normalized endpoint url → this process's last settled outcome and when it settled (ISO). */
  last: Map<string, { status: DiscoveryStatus; at: string }>
}

const states = new WeakMap<Plur, DiscoveryState>()

function stateOf(plur: Plur): DiscoveryState {
  let st = states.get(plur)
  if (!st) { st = { enabled: true, inFlight: null, last: new Map() }; states.set(plur, st) }
  return st
}

/** `scheme://host[:port]` of a url: never userinfo, path or query. */
function safeOrigin(url: string): string {
  try { return new URL(url).origin } catch { return '<invalid url>' }
}

/** The url as reported to the agent: origin plus base path, no userinfo, query or trailing slash. */
function displayUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return '<invalid url>'
  }
}

function log(line: string): void {
  try { process.stderr.write(`[plur:discovery] ${line}\n`) } catch { /* never fail over a log line */ }
}

/** Turn background discovery on or off for this instance (createServer's `discovery` option). */
export function setBackgroundDiscovery(plur: Plur, enabled: boolean): void {
  stateOf(plur).enabled = enabled
}

/** False when createServer was given `discovery: false`: no /me at all, the legacy probe included. */
export function isDiscoveryEnabled(plur: Plur): boolean {
  return states.get(plur)?.enabled ?? true
}

/** Record `failed` for every server endpoint: a refresh that could not run or answered nonsense. */
function markAllFailed(plur: Plur, st: DiscoveryState): void {
  try {
    const at = new Date().toISOString()
    for (const key of plur._serverDiscoveryEndpoints().keys()) st.last.set(key, { status: 'failed', at })
  } catch { /* status only */ }
}

/**
 * Start one background refresh unless discovery is off or one is already in
 * flight. Returns at once; true when a refresh was started. The returned work
 * never rejects: every failure becomes a `failed` status and one log line.
 */
export function startBackgroundDiscovery(plur: Plur): boolean {
  const st = stateOf(plur)
  if (!st.enabled || st.inFlight) return false
  let run: Promise<ServerDiscoveryOutcome[]>
  try {
    run = Promise.resolve(plur.refreshServerScopes({ timeoutMs: timeoutOverrideMs ?? BACKGROUND_DISCOVERY_TIMEOUT_MS }))
  } catch (err) {
    markAllFailed(plur, st)
    log(`scope discovery could not start (${err instanceof Error ? err.name : 'error'}); the cached scopes stay in use`)
    return false
  }
  const settled: Promise<void> = run.then(outcomes => {
    if (!Array.isArray(outcomes)) throw new TypeError('refreshServerScopes answered without a list')
    for (const o of outcomes) {
      st.last.set(normalizeEndpointUrl(o.url), { status: o.status, at: new Date().toISOString() })
      if (o.status !== 'ok') log(`${safeOrigin(o.url)}: scope discovery ${o.status}; the cached scopes stay in use`)
    }
  }).catch(err => {
    // A refresh that did not finish is a failure — never the cached status,
    // which may say `ok` from an earlier run.
    markAllFailed(plur, st)
    // The error's text can carry a configured url or a server's answer: only its kind is logged.
    log(`scope discovery did not finish (${err instanceof Error ? err.name : 'error'}); the cached scopes stay in use`)
  }).finally(() => {
    if (st.inFlight === settled) st.inFlight = null
  })
  st.inFlight = settled
  return true
}

/** Resolves when no refresh is in flight (tests; never awaited on a tool's path). */
export async function whenDiscoverySettled(plur: Plur): Promise<void> {
  const st = states.get(plur)
  while (st?.inFlight) await st.inFlight
}

/**
 * The endpoints background discovery refreshes (core's own selection,
 * {@link Plur._serverDiscoveryEndpoints}: a row even for an empty scope
 * cache), each with the scopes it serves in memory. An entry with a `scopes`
 * list but no `enterprise` block on disk is not refreshed, so it is not here:
 * it keeps the legacy session-start probe.
 */
function serverEndpoints(plur: Plur): Map<string, { url: string; scopes: Set<string>; status?: unknown; checkedAt?: string }> {
  const out = new Map<string, { url: string; scopes: Set<string>; status?: unknown; checkedAt?: string }>()
  for (const [key, e] of plur._serverDiscoveryEndpoints()) {
    const g = { url: e.url, scopes: new Set<string>(), status: e.status as unknown, checkedAt: e.checked_at }
    for (const s of plur._storesForEndpoint(key)) {
      // Expanded server entries carry the enterprise block; a separate
      // per-scope entry on the same url (another key) is not counted.
      if (isPlainObject((s as unknown as Record<string, unknown>).enterprise)) g.scopes.add(s.scope)
    }
    out.set(key, g)
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const STATUSES: ReadonlySet<string> = new Set<DiscoveryStatus>(['ok', 'not_synced', 'failed', 'auth_failed', 'degraded'])

/** Normalized urls of the endpoints whose /me belongs to background discovery. */
export function serverEndpointKeys(plur: Plur): Set<string> {
  return new Set(plur._serverDiscoveryEndpoints().keys())
}

export interface DiscoveryRow {
  url: string
  status: DiscoveryStatus | 'pending'
  scopes: number
  /** While `pending`: the previous check's status, when one is known. */
  last_status?: DiscoveryStatus
}

/**
 * One row per server entry for the session_start result: the cached scope
 * count and the discovery status — `pending` while a refresh is in flight
 * (with the previous check's status as `last_status`, so a refused key is not
 * hidden behind it), else the newer of this process's last settled outcome
 * and the status cached in config.yaml.
 */
export function discoverySummary(plur: Plur): DiscoveryRow[] {
  const st = states.get(plur)
  return [...serverEndpoints(plur)].map(([key, g]) => {
    const cached = typeof g.status === 'string' && STATUSES.has(g.status) ? g.status as DiscoveryStatus : undefined
    // The newer of this process's last outcome and the status on disk, which
    // another process may have written since. A disk status with no time is
    // older than any outcome seen here; on a tie the disk wins.
    const mine = st?.last.get(key)
    const diskNewer = cached !== undefined && (!mine || (g.checkedAt !== undefined && g.checkedAt >= mine.at))
    const known = diskNewer ? cached : mine?.status
    const row: DiscoveryRow = { url: displayUrl(g.url), status: st?.inFlight ? 'pending' : (known ?? 'pending'), scopes: g.scopes.size }
    if (row.status === 'pending' && known) row.last_status = known
    return row
  })
}

/**
 * Guide warnings for server endpoints whose last known check failed (#295:
 * a refused key or an unreachable server is said out loud). Nothing for `ok`,
 * `not_synced` or `degraded`, nor before any check has finished.
 */
export function discoveryWarnings(rows: DiscoveryRow[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    const s = r.status === 'pending' ? r.last_status : r.status
    const when = r.status === 'pending' ? ' (at the last check; a new check is running)' : ''
    if (s === 'auth_failed') {
      out.push(`⚠️ COMPANY SERVER REFUSED THIS DEVICE'S KEY${when}: ${r.url}. Its scope list cannot be refreshed and ` +
        `team-scoped saves queue in the outbox until the key is replaced: sign in to the server again.`)
    } else if (s === 'failed') {
      out.push(`⚠️ COMPANY SERVER SCOPE CHECK FAILED${when}: ${r.url}. The cached scope list stays in use; ` +
        `check connectivity/VPN.`)
    }
  }
  return out
}
