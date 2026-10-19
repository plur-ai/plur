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
import { ServerStoreEntrySchema, StoreEntrySchema } from './schemas/config.js'

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
  /** Another entry that stays (another key, server or path) also serves the
   *  scope; which of them a write takes depends on config order, so moving it
   *  into the server entry could move the scope onto another key. */
  | 'scope-served-elsewhere'
  /** Its metadata differs from another source for the scope (another entry
   *  folded with it, or the server entry's own settings); the one in force
   *  is the first in config order, so merging could change it — for one,
   *  weaken a sensitivity policy. */
  | 'metadata-differs'
  /** The loader rejects the entry (schema), so it serves nothing today;
   *  folding it would start sending its scope to the server. */
  | 'invalid-entry'

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

/** The scopes a raw entry serves: its `scope`, and a server entry's `scopes`
 *  and `pinned_scopes`. */
function servedScopes(r: unknown): string[] {
  if (!isPlainObj(r)) return []
  const out = typeof r.scope === 'string' ? [r.scope] : []
  for (const k of ['scopes', 'pinned_scopes'] as const) {
    const v = r[k]
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x)
  }
  return out
}

/** Whether a served scope `x` competes with `scope` for a write: equal, or for
 *  a personal `user:` scope equal case-folded (the personal selection folds). */
function sameRoute(x: string, scope: string): boolean {
  if (x === scope) return true
  return scope.toLowerCase().startsWith('user:') && x.toLowerCase() === scope.toLowerCase()
}

/**
 * Whether the server entry at `si` of `stores`, newly serving the personal
 * scope `scope`, could take its writes from an entry that serves it now
 * (scope-target.ts `personalStoreEntry`: exact matches, else case-folded; a
 * path entry, then a writable url entry, then a readonly one; config order
 * breaks ties). Judged on every raw entry, valid at load or not, so an entry
 * the loader drops cannot hide a takeover: true when any other url entry
 * serving it exactly would rank behind this one, when one serves it only in
 * another letter case, or when a path entry serves it only in another case.
 */
function personalScopeHolders(stores: unknown[], si: number, scope: string): number[] {
  const me = stores[si] as Record<string, unknown>
  const rank = (r: Record<string, unknown>): number => (r.readonly === true ? 2 : 1)
  return stores.flatMap((r, j) => {
    if (!isPlainObj(r)) return []
    const served = servedScopes(r)
    // The entry itself, after the fold, serving it in another case: an entry
    // folded into it served the personal scope (case-folded) before.
    if (j === si) return served.some(x => x !== scope && x.toLowerCase() === scope.toLowerCase()) ? [j] : []
    const exact = served.includes(scope)
    if (!exact) return served.some(x => x.toLowerCase() === scope.toLowerCase()) ? [j] : []
    if (typeof r.url !== 'string') return []
    return rank(me) < rank(r) || (rank(me) === rank(r) && si < j) ? [j] : []
  })
}

/**
 * An entry that holds the personal scope's writes, as `plur login` names it
 * (#1638): the url's origin (never a user name, password or key) or the path,
 * the scope as that entry spells it, and whether it is readonly. `sameServer`
 * marks the server entry being registered itself, serving the scope in
 * another letter case; that one is not removed for the caller.
 */
export interface ScopeHolder {
  url?: string
  path?: string
  scope: string
  readonly: boolean
  sameServer?: true
}

/**
 * Registration refused: another entry takes the personal scope's writes and
 * registering would take them over (owner decision on B5: refuse; the
 * installer offers to remove the stale entry). `holders` names those entries;
 * `removable` is true when all of them are separate entries that
 * `removeStale` can remove.
 */
export class PersonalScopeTakenError extends Error {
  constructor(message: string, readonly personalScope: string, readonly holders: ScopeHolder[], readonly removable: boolean) {
    super(message)
    this.name = 'PersonalScopeTakenError'
  }
}

function describeHolder(r: Record<string, unknown>, scope: string, sameServer: boolean): ScopeHolder {
  const served = servedScopes(r)
  const variant = served.find(x => x !== scope && x.toLowerCase() === scope.toLowerCase())
  const spelled = (sameServer ? variant : served.find(x => x === scope) ?? variant) ?? scope
  return {
    ...(typeof r.url === 'string' ? { url: safeOrigin(r.url) } : typeof r.path === 'string' ? { path: r.path } : {}),
    scope: spelled,
    readonly: r.readonly === true,
    ...(sameServer ? { sameServer: true as const } : {}),
  }
}

/**
 * Registration with `keepSignIn` refused: config.yaml already holds a sign-in
 * (an entry with that server's url) for the server, which is never replaced
 * (#1638: the one-time config.json move). Names the origin only.
 */
export class SignInHeldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignInHeldError'
  }
}

/** True when a url string carries a user name or password. */
function hasUserinfo(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try { const u = new URL(url); return u.username !== '' || u.password !== '' } catch { return false }
}

/** The reason a same-server per-scope entry is not folded, or null to fold it.
 *  The credential is compared as stored on disk: the reference (`token_env`)
 *  first, then the inline key, then `readonly`. */
function keptReason(r: Record<string, unknown>, scope: string, token: string | undefined, tokenEnv: string | undefined,
  readonly: boolean): FoldKeptReason | null {
  // `__proto__` would set the prototype of scope_settings, not a key of it.
  if (!isSafeScopeName(scope) || scope === '__proto__') return 'invalid-scope'
  if (!StoreEntrySchema.safeParse(r).success) return 'invalid-entry'
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
 * A write takes the first entry in config order that serves its scope, so the
 * fold keeps every route as it was: the server entry stays where it is (moving
 * it ahead of an entry that serves one of its scopes with another key would
 * move that scope onto this key), and an entry is folded only when no entry
 * that stays — another key, another server or a path — serves its scope
 * (`scope-served-elsewhere`).
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

  // Pass 1: the entries that hold the server entry's key and could fold.
  const why = new Map<number, FoldKeptReason | null>()
  rawStores.forEach((r, i) => {
    if (i === si) return
    const candidate = isPlainObj(r) && !isServerStoreEntry(r) && typeof r.url === 'string' && r.path === undefined &&
      typeof r.scope === 'string' && r.scope !== '' && normalizeEndpointUrl(r.url) === key
    if (candidate) why.set(i, keptReason(r as Record<string, unknown>, r.scope as string, tok, env, readonly))
  })
  // Pass 2: an entry that stays and serves the same scope keeps it separate.
  for (const [i, w] of why) {
    if (w !== null) continue
    const scope = (rawStores[i] as Record<string, unknown>).scope as string
    // The same spelling counts from an entry that stays; another letter case
    // of a personal scope counts from any entry, the server entry and other
    // folding ones included, since the personal selection folds case.
    const elsewhere = rawStores.some((r, j) => j !== i && servedScopes(r).some(x =>
      sameRoute(x, scope) && (x !== scope || (j !== si && why.get(j) !== null))))
    if (elsewhere) why.set(i, 'scope-served-elsewhere')
  }
  // Pass 3: fold a scope only when its metadata in force does not change.
  const byScope = new Map<string, number[]>()
  for (const [i, w] of why) {
    if (w !== null) continue
    const scope = (rawStores[i] as Record<string, unknown>).scope as string
    byScope.set(scope, [...(byScope.get(scope) ?? []), i])
  }
  for (const [scope, idx] of byScope) {
    const own = {
      ...(server.scope === scope ? entryMetadata(server) : {}),
      ...(isPlainObj(settings[scope]) ? entryMetadata(settings[scope] as Record<string, unknown>) : {}),
    }
    // The scope's metadata once folded is the server entry's (dormant or
    // not) with the folded entries' over it; every source the scope had in
    // force must already have exactly that, absent keys included (`dial` is
    // read per entry): the folding entries, and the server entry when it
    // serves the scope.
    const mds = idx.map(i => entryMetadata(rawStores[i] as Record<string, unknown>))
    const after = Object.assign({}, own, ...mds) as Record<string, unknown>
    const sources = [...(servedScopes(server).includes(scope) ? [own] : []), ...mds]
    if (sources.some(m => !isDeepStrictEqual(m, after))) {
      for (const i of idx) why.set(i, 'metadata-differs')
    }
  }

  const slot = Symbol('server entry')
  const out: unknown[] = []
  rawStores.forEach((r, i) => {
    if (i === si) { out.push(slot); return }
    if (!why.has(i)) { out.push(r); return }
    const entry = r as Record<string, unknown>
    const scope = entry.scope as string
    const w = why.get(i)!
    if (w) { report.kept_separate.push({ scope, why: w }); out.push(r); return }
    report.folded.push({ scope })
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
  return { stores: out.map(r => (r === slot ? server : r)), report }
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
  /** Remove the entries that hold the personal scope (the ones a
   *  {@link PersonalScopeTakenError} names) and register, in one result
   *  (#1638). Refused as before when one of them cannot be removed. */
  removeStale?: boolean
  /** Refuse with {@link SignInHeldError} when any entry for this server's
   *  url already holds a key (token or token_env); judged on the file under
   *  the lock. */
  keepSignIn?: boolean
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
  removed: ScopeHolder[]
} {
  // One object per position: YAML aliases load as the same object at several
  // positions, and the holders are mapped back to their positions by identity
  // (#1665 gate). A shallow copy changes no content.
  rawStores = rawStores.map(r => (isPlainObj(r) ? { ...r } : r))
  const key = normalizeEndpointUrl(reg.url)
  // A sign-in: an entry for the url with a key or a key reference (token or
  // token_env, set or not); an entry with neither signs nothing in.
  if (reg.keepSignIn && rawStores.some(r => isPlainObj(r) && typeof r.url === 'string' && normalizeEndpointUrl(r.url) === key &&
    ((typeof r.token === 'string' && r.token !== '') || (typeof r.token_env === 'string' && r.token_env !== '')))) {
    throw new SignInHeldError(`config.yaml already holds a sign-in for ${safeOrigin(reg.url)}; it is kept. Nothing was changed.`)
  }
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
    if (hasUserinfo(old.url)) {
      throw new Error(`the server entry for ${safeOrigin(reg.url)} in config.yaml has a user name or password in its url. Nothing was changed. Remove them from the url (the key belongs in token or token_env), then register again.`)
    }
    // The old compat scope stays served by this entry (pinned) when nothing
    // else on it lists it: replacing it would drop its route, or hand it to
    // another entry with another key.
    const base: Record<string, unknown> = { ...old }
    const oldScope = old.scope
    if (typeof oldScope === 'string' && oldScope !== '' && oldScope !== reg.personalScope &&
      ![...(Array.isArray(old.scopes) ? old.scopes : []), ...(Array.isArray(old.pinned_scopes) ? old.pinned_scopes : [])].includes(oldScope)) {
      base.pinned_scopes = [...(Array.isArray(old.pinned_scopes) ? old.pinned_scopes : []), oldScope]
    }
    let e: Record<string, unknown> = withCompatScope(base, reg.personalScope)
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
  // The compat scope is the one claim registration adds. When another entry
  // already takes the personal scope's writes, this entry must not take them
  // over (another server or key); a re-run with a new key for the entry that
  // already serves it changes its key, which is the point of the re-run.
  const si = serverEntriesAt(folded, key)[0]
  const parsed = ServerStoreEntrySchema.safeParse(entry)
  if (!parsed.success) {
    // Field paths only: a schema message can quote the value (#408).
    throw new Error(`the server entry for ${safeOrigin(reg.url)} in config.yaml is not valid (${parsed.error.issues.map(it => it.path.join('.') || '(root)').join(', ')}), so it would not load. Nothing was changed. Fix or remove it, then register again.`)
  }
  // Only an entry that loaded served its scopes: one the loader rejected
  // (a numeric token, say) gets no re-run exemption.
  const oldEntry = at.length ? rawStores[at[0]] : undefined
  const alreadyServed = ServerStoreEntrySchema.safeParse(oldEntry).success && servedScopes(oldEntry).includes(reg.personalScope)
  if (!alreadyServed) {
    const holders = personalScopeHolders(folded, si, reg.personalScope)
    if (holders.length) {
      // Each holder as an entry of the input: a separate entry is the same
      // object in `folded`; a holder that is the server entry itself comes
      // from the input entries folded into it in another case (removable),
      // or from that entry's own scopes (not removable for the caller).
      const remove = new Set<number>()
      const named: ScopeHolder[] = []
      let removable = true
      const lower = reg.personalScope.toLowerCase()
      for (const j of holders) {
        if (j !== si) {
          const k = rawStores.indexOf(folded[j])
          if (k < 0) removable = false
          else remove.add(k)
          named.push(describeHolder(folded[j] as Record<string, unknown>, reg.personalScope, false))
          continue
        }
        const sources = rawStores.flatMap((r, k) => (k !== at[0] && !folded.includes(r) &&
          servedScopes(r).some(x => x !== reg.personalScope && x.toLowerCase() === lower) ? [k] : []))
        const own = at.length ? servedScopes(rawStores[at[0]]).some(x => x !== reg.personalScope && x.toLowerCase() === lower) : false
        if (own || !sources.length) {
          removable = false
          named.push(describeHolder(entry, reg.personalScope, true))
        }
        for (const k of sources) {
          remove.add(k)
          named.push(describeHolder(rawStores[k] as Record<string, unknown>, reg.personalScope, false))
        }
      }
      if (reg.removeStale && removable && remove.size) {
        const rest = registerServerEntry(rawStores.filter((_, k) => !remove.has(k)), { ...reg, removeStale: false })
        return { ...rest, status: rest.status === 'unchanged' ? 'updated' : rest.status, removed: named }
      }
      throw new PersonalScopeTakenError(`the personal scope ${reg.personalScope} is already served by another entry in config.yaml, and registering ${safeOrigin(reg.url)} would move its writes there. Nothing was changed. Remove that entry, then register again.`,
        reg.personalScope, named, removable)
    }
  }
  const status = at.length === 0 ? 'added' : isDeepStrictEqual(folded, rawStores) ? 'unchanged' : 'updated'
  return { stores: folded, status, report, entry, removed: [] }
}
