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
  /** The new list when `replaceCache`, otherwise a copy of `cached`. */
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

/** Why `scope` is not one of this org's scopes, or null when it is. */
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

function filterScopes(me: MeResponse, otherServersScopes: ReadonlyMap<string, string>): { scopes: string[]; rejected: ScopeRejection[] } {
  const scopes: string[] = []
  const rejected: ScopeRejection[] = []
  for (const scope of me.scopes) {
    const reason = orgRejection(scope, me.org_id, me.username)
      ?? (otherServersScopes.has(scope) ? 'claimed-by-other-server' : null)
    if (reason) rejected.push({ scope, reason })
    else scopes.push(scope)
  }
  return { scopes, rejected }
}

export function acceptDiscoveredScopes(input: AcceptDiscoveredScopesInput): AcceptedDiscovery {
  const { me, error, cached, otherServersScopes } = input
  const keep = (status: DiscoveryStatus): AcceptedDiscovery => ({ status, replaceCache: false, scopes: [...cached], rejected: [] })
  const empty = (status: DiscoveryStatus): AcceptedDiscovery => ({ status, replaceCache: true, scopes: [], rejected: [] })

  if (error || !me) {
    const status = error?.status
    return keep(status === 401 || status === 403 ? 'auth_failed' : 'failed')
  }

  switch (me.scopes_status) {
    case 'ok':
      return { status: 'ok', replaceCache: true, ...filterScopes(me, otherServersScopes) }
    case 'not_synced':
      return cached.length > 0 ? keep('not_synced') : empty('not_synced')
    default:
      // 'absent': an older server that does not say whether its list is real.
      if (me.scopes.length > 0) return { status: 'ok', replaceCache: true, ...filterScopes(me, otherServersScopes) }
      return cached.length > 0 ? keep('degraded') : empty('degraded')
  }
}
