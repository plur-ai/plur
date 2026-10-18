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

interface DiscoveryState {
  enabled: boolean
  inFlight: Promise<void> | null
  /** normalized endpoint url → the last settled outcome's status. */
  last: Map<string, DiscoveryStatus>
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

/**
 * Start one background refresh unless discovery is off or one is already in
 * flight. Returns at once; true when a refresh was started.
 */
export function startBackgroundDiscovery(plur: Plur): boolean {
  const st = stateOf(plur)
  if (!st.enabled || st.inFlight) return false
  let run: Promise<ServerDiscoveryOutcome[]>
  try {
    run = plur.refreshServerScopes({ timeoutMs: BACKGROUND_DISCOVERY_TIMEOUT_MS })
  } catch (err) {
    log(`scope discovery could not start (${err instanceof Error ? err.name : 'error'}); the cached scopes stay in use`)
    return false
  }
  const settled: Promise<void> = run.then(outcomes => {
    for (const o of outcomes) {
      st.last.set(normalizeEndpointUrl(o.url), o.status)
      if (o.status !== 'ok') log(`${safeOrigin(o.url)}: scope discovery ${o.status}; the cached scopes stay in use`)
    }
  }, err => {
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

/** The in-memory store entries expanded from a server entry, grouped by endpoint. */
function serverEndpoints(plur: Plur): Map<string, { url: string; scopes: Set<string>; status?: unknown }> {
  const out = new Map<string, { url: string; scopes: Set<string>; status?: unknown }>()
  for (const { url } of plur._distinctRemoteEndpoints()) {
    for (const s of plur._storesForEndpoint(url)) {
      const raw = s as unknown as Record<string, unknown>
      if (!isPlainObject(raw.enterprise) || !s.url) continue
      const key = normalizeEndpointUrl(s.url)
      let g = out.get(key)
      if (!g) {
        g = { url: s.url, scopes: new Set(), status: isPlainObject(raw.discovery) ? raw.discovery.status : undefined }
        out.set(key, g)
      }
      g.scopes.add(s.scope)
    }
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const STATUSES: ReadonlySet<string> = new Set<DiscoveryStatus>(['ok', 'not_synced', 'failed', 'auth_failed', 'degraded'])

/** True when this endpoint is served by a server entry — its /me belongs to background discovery. */
export function isServerEndpoint(plur: Plur, url: string): boolean {
  return serverEndpoints(plur).has(normalizeEndpointUrl(url))
}

/**
 * One row per server entry for the session_start result: the cached scope
 * count and the discovery status — `pending` while a refresh is in flight,
 * else the last settled outcome, else the status cached in config.yaml.
 */
export function discoverySummary(plur: Plur): Array<{ url: string; status: DiscoveryStatus | 'pending'; scopes: number }> {
  const st = states.get(plur)
  return [...serverEndpoints(plur)].map(([key, g]) => {
    const cached = typeof g.status === 'string' && STATUSES.has(g.status) ? g.status as DiscoveryStatus : undefined
    const status: DiscoveryStatus | 'pending' = st?.inFlight ? 'pending' : (st?.last.get(key) ?? cached ?? 'pending')
    return { url: displayUrl(g.url), status, scopes: g.scopes.size }
  })
}
