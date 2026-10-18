/**
 * Server scope discovery — pure decision rules (#1631).
 *
 * `acceptDiscoveredScopes` decides, from one GET /api/v1/me answer (or the
 * error it threw), whether a server entry's cached `scopes` list is replaced
 * and with what. It never touches the network or the config file.
 *
 * Rules:
 * - A failed, unauthorised, timed-out or network answer never replaces the
 *   cache (not even an empty one).
 * - `scopes_status: 'ok'` replaces the cache with the server's list, even [].
 * - `scopes_status: 'not_synced'`, or an older server (no `scopes_status`)
 *   answering an empty list, replaces only an empty cache (with []).
 * - An answer with no `org_id` cannot be checked against an org, so every
 *   scope is rejected (`org-prefix`) and the answer is `degraded`: it never
 *   replaces a non-empty cache.
 * - Accepted scopes are filtered to the server's org; a scope another server
 *   entry already serves is refused.
 */
import type { MeResponse } from './store/remote-store.js'

export type DiscoveryStatus = 'ok' | 'not_synced' | 'failed' | 'auth_failed' | 'degraded'

export interface ScopeRejection {
  scope: string
  reason: 'org-prefix' | 'foreign-personal' | 'claimed-by-other-server'
}

export interface AcceptedDiscovery {
  status: DiscoveryStatus
  /** true → the caller writes `scopes` as the new cache. */
  replaceCache: boolean
  /** When replaceCache, the new list. When not, a copy of `cached`. */
  scopes: string[]
  rejected: ScopeRejection[]
}

export interface AcceptDiscoveredScopesInput {
  me: MeResponse | null
  error?: { status?: number; message: string }
  cached: string[]
  /** scope → url of the other server entry that already serves it. */
  otherServersScopes: ReadonlyMap<string, string>
}

const ORG_PREFIXED_KINDS = ['group', 'project', 'team', 'space'] as const

function orgRejection(scope: string, orgId: string, username: string): ScopeRejection['reason'] | null {
  if (!orgId) return 'org-prefix'
  if (scope.startsWith('user:')) {
    return scope.toLowerCase() === `user:${orgId}:${username}`.toLowerCase() ? null : 'foreign-personal'
  }
  if (scope === `org:${orgId}`) return null
  for (const kind of ORG_PREFIXED_KINDS) {
    const head = `${kind}:${orgId}`
    if (scope === head || scope.startsWith(`${head}/`)) return null
  }
  return 'org-prefix'
}

function filterScopes(
  me: MeResponse,
  otherServersScopes: ReadonlyMap<string, string>,
): { scopes: string[]; rejected: ScopeRejection[] } {
  const scopes: string[] = []
  const rejected: ScopeRejection[] = []
  for (const scope of me.scopes) {
    const reason =
      orgRejection(scope, me.org_id, me.username) ??
      (otherServersScopes.has(scope) ? 'claimed-by-other-server' : null)
    if (reason) rejected.push({ scope, reason })
    else scopes.push(scope)
  }
  return { scopes, rejected }
}

/**
 * Pure decision table for scope discovery (#1631).
 *
 * Takes a /me answer (or an error) and the existing cache, and decides
 * whether to replace the cached scope list and which scopes to accept.
 * Never reads from disk, never writes to disk, no I/O.
 */
export function acceptDiscoveredScopes(input: AcceptDiscoveredScopesInput): AcceptedDiscovery {
  const { me, error, cached, otherServersScopes } = input
  const keep = (status: DiscoveryStatus, rejected: ScopeRejection[] = []): AcceptedDiscovery =>
    ({ status, replaceCache: false, scopes: [...cached], rejected })
  const empty = (status: DiscoveryStatus, rejected: ScopeRejection[] = []): AcceptedDiscovery =>
    ({ status, replaceCache: true, scopes: [], rejected })

  if (error || !me) {
    const status = error?.status
    return keep(status === 401 || status === 403 ? 'auth_failed' : 'failed')
  }

  // An empty org_id means the server's response cannot be checked against an
  // org — treat it as degraded regardless of scopes_status. not_synced is
  // excluded because its scope list is always [], so there is nothing to check.
  if (!me.org_id && me.scopes_status !== 'not_synced') {
    const rejected = me.scopes.map((scope): ScopeRejection => ({ scope, reason: 'org-prefix' }))
    return cached.length > 0 ? keep('degraded', rejected) : empty('degraded', rejected)
  }

  switch (me.scopes_status) {
    case 'ok':
      return { status: 'ok', replaceCache: true, ...filterScopes(me, otherServersScopes) }
    case 'not_synced':
      return cached.length > 0 ? keep('not_synced') : empty('not_synced')
    default: {
      // 'absent': an older server that does not say whether its list is real.
      if (me.scopes.length > 0) return { status: 'ok', replaceCache: true, ...filterScopes(me, otherServersScopes) }
      return cached.length > 0 ? keep('degraded') : empty('degraded')
    }
  }
}
