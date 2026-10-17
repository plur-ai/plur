import type { MeResponse } from './store/remote-store.js'

export type DiscoveryStatus = 'ok' | 'not_synced' | 'failed' | 'auth_failed' | 'degraded'

export interface ScopeRejection {
  scope: string
  reason: 'org-prefix' | 'foreign-personal' | 'claimed-by-other-server'
}

export interface AcceptedDiscovery {
  status: DiscoveryStatus
  replaceCache: boolean
  scopes: string[]
  rejected: ScopeRejection[]
}

/**
 * Pure decision table for scope discovery (#1631).
 *
 * Takes a /me answer (or an error) and the existing cache, and decides
 * whether to replace the cached scope list and which scopes to accept.
 * Never reads from disk, never writes to disk, no I/O.
 */
export function acceptDiscoveredScopes(input: {
  me: MeResponse | null
  error?: { status?: number; message: string }
  cached: string[]
  otherServersScopes: ReadonlyMap<string, string>
}): AcceptedDiscovery {
  const { me, error, cached, otherServersScopes } = input

  if (me === null) {
    const status: DiscoveryStatus =
      error?.status === 401 || error?.status === 403 ? 'auth_failed' : 'failed'
    return { status, replaceCache: false, scopes: [], rejected: [] }
  }

  const { scopes_status, scopes: rawScopes, org_id, username } = me

  let status: DiscoveryStatus
  let replaceCache: boolean

  if (scopes_status === 'ok') {
    status = 'ok'
    replaceCache = true
  } else if (scopes_status === 'not_synced') {
    status = 'not_synced'
    replaceCache = cached.length === 0
  } else {
    // 'absent': older server did not send scopes_status
    if (rawScopes.length > 0) {
      status = 'ok'
      replaceCache = true
    } else {
      status = 'degraded'
      replaceCache = cached.length === 0
    }
  }

  if (!replaceCache) {
    return { status, replaceCache: false, scopes: [], rejected: [] }
  }

  const accepted: string[] = []
  const rejected: ScopeRejection[] = []

  for (const scope of rawScopes) {
    const colonIdx = scope.indexOf(':')
    if (colonIdx === -1) {
      rejected.push({ scope, reason: 'org-prefix' })
      continue
    }

    const kind = scope.slice(0, colonIdx)
    const rest = scope.slice(colonIdx + 1)

    // An empty org_id means the server is misconfigured — reject everything.
    if (org_id === '') {
      rejected.push({ scope, reason: 'org-prefix' })
      continue
    }

    let rejection: ScopeRejection['reason'] | null = null

    if (kind === 'user') {
      // Must equal user:<org_id>:<username>, case-folded; original spelling kept.
      const expected = `${org_id}:${username}`.toLowerCase()
      if (rest.toLowerCase() !== expected) {
        rejection = 'foreign-personal'
      }
    } else if (kind === 'org') {
      if (rest !== org_id) {
        rejection = 'org-prefix'
      }
    } else if (
      kind === 'group' ||
      kind === 'project' ||
      kind === 'team' ||
      kind === 'space'
    ) {
      // Must equal <org_id> or start with <org_id>/
      if (rest !== org_id && !rest.startsWith(`${org_id}/`)) {
        rejection = 'org-prefix'
      }
    } else {
      rejection = 'org-prefix'
    }

    if (rejection !== null) {
      rejected.push({ scope, reason: rejection })
      continue
    }

    if (otherServersScopes.has(scope)) {
      rejected.push({ scope, reason: 'claimed-by-other-server' })
      continue
    }

    accepted.push(scope)
  }

  return { status, replaceCache: true, scopes: accepted, rejected }
}
