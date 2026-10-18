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
 * - A malformed scope list (`MeResponse.scopes_malformed`: missing, null, not
 *   an array, or with an invalid member) is `degraded`: it never replaces a
 *   non-empty cache. Only an explicit, valid `[]` clears one.
 * - `scopes_status: 'not_synced'`, or an older server (no `scopes_status`)
 *   answering an empty list, replaces only an empty cache (with []).
 * - An answer with no `org_id` cannot be checked against an org, so every
 *   scope is rejected (`org-prefix`) and the answer is `degraded`: it never
 *   replaces a non-empty cache.
 * - Accepted scopes are filtered to the server's org; a scope another server
 *   entry already serves is refused.
 */
import { isDeepStrictEqual } from 'node:util'
import type { MeResponse } from './store/remote-store.js'
import { normalizeEndpointUrl, safeOrigin } from './store/remote-store.js'
import { isServerStoreEntry, withCompatScope, entryMetadata, isSafeScopeName } from './store-expand.js'
import { isSharedScope } from './scope-util.js'

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

  // A malformed scope list (missing, null, not an array, or a member that
  // failed the grammar) is not the server's list: whatever scopes_status
  // says, it never clears or replaces a non-empty cache (Codex round 2).
  if (me.scopes_malformed) {
    return cached.length > 0 ? keep('degraded') : empty('degraded')
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

// ── Registration and fold (#1631, plan B Task 5) ─────────────────────────────

/** Why a per-scope entry on the registered server was not folded into it. */
export type FoldKeptReason =
  | 'different-token' | 'different-token-env' | 'readonly-differs'
  /** Its explicit `shared` flag is not the one the scope expands with. */
  | 'shared-differs'
  /** Its scope fails the safe grammar, so expansion would drop it. */
  | 'invalid-scope'

export interface FoldReport {
  /** Per-scope entries absorbed into the server entry. */
  folded: Array<{ scope: string }>
  /** Per-scope entries on the same server left as they are, and why. */
  kept_separate: Array<{ scope: string; why: FoldKeptReason }>
  /** Outbox entries per scope the server entry serves, after the fold. */
  queued_by_scope: Record<string, number>
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

/** A non-empty string, else undefined (an empty token is no token). */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Positions of the server entries (url + own `scopes`) whose url has the
 *  canonical endpoint identity `key` ({@link normalizeEndpointUrl}). */
function serverEntriesAt(rawStores: unknown[], key: string): number[] {
  return rawStores.flatMap((r, i) =>
    isPlainObj(r) && isServerStoreEntry(r) && typeof r.url === 'string' && normalizeEndpointUrl(r.url) === key ? [i] : [])
}

/** The reason a same-server per-scope entry is not folded, or null to fold it.
 *  The credential is compared as stored on disk: the reference (`token_env`)
 *  first, then the inline key, then `readonly`. */
function keptReason(r: Record<string, unknown>, scope: string, token: string | undefined, tokenEnv: string | undefined,
  readonly: boolean): FoldKeptReason | null {
  if (!isSafeScopeName(scope)) return 'invalid-scope'
  if (str(r.token_env) !== tokenEnv) return 'different-token-env'
  if (str(r.token) !== token) return 'different-token'
  if ((r.readonly === true) !== readonly) return 'readonly-differs'
  if (typeof r.shared === 'boolean' && r.shared !== isSharedScope(scope)) return 'shared-differs'
  return null
}

/**
 * Fold the per-scope entries on one server into that server's one entry (pure).
 *
 * `rawStores` must hold exactly one server entry whose url has the canonical
 * endpoint identity of `serverUrl` (otherwise this throws: which entry the
 * scopes belong to cannot be told). `token`/`tokenEnv` are that entry's key
 * as stored on disk. A per-scope url entry (no `path`, no `scopes`) on the same
 * server is folded when its stored `token_env`, `token` and `readonly` equal the
 * server entry's (and its scope passes the grammar and any explicit `shared`
 * matches the scope's): it leaves the array, its scope joins `pinned_scopes`
 * (so a later discovery that omits it cannot drop it), and its metadata (every
 * key that is not identity, credentials or routing) goes to
 * `scope_settings[scope]`, over a value already there for the same key. Every
 * other entry is returned unchanged; the input array is not modified.
 *
 * The server entry takes the earliest position among itself and the entries
 * folded into it.
 */
export function foldStoresIntoServerEntry(
  rawStores: unknown[], serverUrl: string, token: string | undefined, tokenEnv: string | undefined,
): { stores: unknown[]; report: Omit<FoldReport, 'queued_by_scope'> } {
  const key = normalizeEndpointUrl(serverUrl)
  const at = serverEntriesAt(rawStores, key)
  if (at.length !== 1) {
    throw new Error(at.length
      ? `more than one server entry in config.yaml is for ${safeOrigin(serverUrl)}, so which one the scopes belong to is ambiguous. Nothing was changed. Keep one of them.`
      : `there is no server entry for ${safeOrigin(serverUrl)} in config.yaml. Nothing was changed.`)
  }
  const si = at[0]
  const server: Record<string, unknown> = { ...(rawStores[si] as Record<string, unknown>) }
  const readonly = server.readonly === true
  const pinned = Array.isArray(server.pinned_scopes) ? [...server.pinned_scopes] : []
  const settings: Record<string, unknown> = isPlainObj(server.scope_settings) ? { ...server.scope_settings } : {}
  const report: Omit<FoldReport, 'queued_by_scope'> = { folded: [], kept_separate: [] }
  const tok = str(token)
  const env = str(tokenEnv)

  const out: unknown[] = []
  let serverPos = -1
  rawStores.forEach((r, i) => {
    if (i === si) { if (serverPos < 0) serverPos = out.length; return }
    const candidate = isPlainObj(r) && !isServerStoreEntry(r) && typeof r.url === 'string' && r.path === undefined &&
      typeof r.scope === 'string' && r.scope !== '' && normalizeEndpointUrl(r.url) === key
    if (!candidate) { out.push(r); return }
    const entry = r as Record<string, unknown>
    const scope = entry.scope as string
    const why = keptReason(entry, scope, tok, env, readonly)
    if (why) { report.kept_separate.push({ scope, why }); out.push(r); return }
    report.folded.push({ scope })
    if (serverPos < 0) serverPos = out.length
    if (!pinned.includes(scope)) pinned.push(scope)
    const md = entryMetadata(entry)
    if (Object.keys(md).length) {
      const existing = isPlainObj(settings[scope]) ? settings[scope] as Record<string, unknown> : {}
      settings[scope] = { ...existing, ...md }
    }
  })
  if (!report.folded.length) return { stores: [...rawStores], report }
  server.pinned_scopes = pinned
  if (Object.keys(settings).length) server.scope_settings = settings
  out.splice(serverPos, 0, server)
  return { stores: out, report }
}

export interface ServerRegistration {
  url: string
  /** The key, stored inline when no `tokenEnv` is given. */
  token?: string
  /** The variable the key is read from; the entry then stores only this name. */
  tokenEnv?: string
  /** The compat `scope`: the personal scope the server's /me answer names
   *  (owner decision O6: the caller holds that answer). */
  personalScope: string
  /** Merged into the entry's `enterprise` block. */
  enterprise?: Record<string, string>
}

/**
 * Register a server entry in a raw `stores` array (pure; #1631, plan B Task 5).
 *
 * - No server entry for the url's canonical endpoint identity: one is added,
 *   `{ url, token | token_env, scope: personalScope, enterprise, scopes: [] }`.
 * - Exactly one: it is updated in place. A different key replaces the key of
 *   that entry only (a `token_env` reference replaces an inline key and the
 *   other way round); `opts.enterprise` is merged into its `enterprise` block;
 *   a different `personalScope` becomes its compat `scope` through
 *   {@link withCompatScope} (the old compat scope's top-level metadata moves to
 *   its `scope_settings`). Every other key of the entry is kept.
 * - More than one: refused (throws), like key rotation and discovery.
 *
 * Then {@link foldStoresIntoServerEntry} folds the per-scope entries that hold
 * the entry's key. `unchanged` means the result equals the input.
 */
export function registerServerEntry(rawStores: unknown[], reg: ServerRegistration): {
  stores: unknown[]; status: 'added' | 'updated' | 'unchanged'; report: Omit<FoldReport, 'queued_by_scope'>; entry: Record<string, unknown>
} {
  const key = normalizeEndpointUrl(reg.url)
  const at = serverEntriesAt(rawStores, key)
  if (at.length > 1) {
    throw new Error(`more than one server entry in config.yaml is for ${safeOrigin(reg.url)}, so which key to replace is ambiguous. Nothing was changed. Keep one of them.`)
  }
  const tokenEnv = str(reg.tokenEnv)
  const token = tokenEnv ? undefined : str(reg.token)
  const cred: Record<string, unknown> = tokenEnv ? { token_env: tokenEnv } : { token }
  let stores: unknown[]
  if (at.length === 0) {
    stores = [...rawStores, { url: reg.url, ...cred, scope: reg.personalScope, enterprise: { ...(reg.enterprise ?? {}) }, scopes: [] }]
  } else {
    const i = at[0]
    const old = rawStores[i] as Record<string, unknown>
    let e: Record<string, unknown> = withCompatScope({ ...old }, reg.personalScope)
    if (str(e.token_env) !== tokenEnv || str(e.token) !== token || ('token' in e && token === undefined) || ('token_env' in e && tokenEnv === undefined)) {
      e = { ...e }
      if (tokenEnv) { delete e.token; e.token_env = tokenEnv } else { delete e.token_env; e.token = token }
    }
    const block = isPlainObj(e.enterprise) ? e.enterprise : undefined
    const merged = { ...(block ?? {}), ...(reg.enterprise ?? {}) }
    if (!block || !isDeepStrictEqual(block, merged)) e = { ...e, enterprise: merged }
    stores = rawStores.map((r, j) => (j === i ? e : r))
  }
  const { stores: folded, report } = foldStoresIntoServerEntry(stores, reg.url, token, tokenEnv)
  const entry = folded[serverEntriesAt(folded, key)[0]] as Record<string, unknown>
  const status = at.length === 0 ? 'added' : isDeepStrictEqual(folded, rawStores) ? 'unchanged' : 'updated'
  return { stores: folded, status, report, entry }
}
