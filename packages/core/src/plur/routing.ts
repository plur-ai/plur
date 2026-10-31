import { computeContentHash, isHashable } from '../content-hash.js'
import { legacyStorePrefix, namespaceEngramId, parseNamespacedId, storePrefix } from '../engrams.js'
import { Plur } from '../index.js'
import type { StoreEntry } from '../schemas/config.js'
import type { Engram } from '../schemas/engram.js'
import { personalStoreEntry } from '../scope-target.js'
import { isScopeWithin } from '../scope-util.js'
import { resolveScopeTarget, ScopeConflictError, urlGroupsForScope } from '../store-resolver.js'
import { normalizeEndpointUrl, RemoteStore } from '../store/remote-store.js'
import { REMOTE_PROBE_TIMEOUT_MS } from './helpers.js'

export interface RoutingMethods {
/** The `token_env` variable configured for this url (+scope), if any (#1561). */
/** @internal */
_tokenEnvFor(url: string, scope?: string): string | undefined

/** Get or create a RemoteStore driver for a store config entry. */
/** @internal */
_getRemoteDriver(entry: { url: string; token?: string; scope: string }): RemoteStore

/**
   * Resolve a remote store for a write scope. Returns the RemoteStore driver
   * if the engram's scope matches a registered remote entry, else null.
   *
   * Match rule (pilot scope): exact-match `entry.scope === engramScope`. We
   * intentionally don't do prefix-match yet — agents that want to write to a
   * narrower scope than they registered must explicitly register the narrower
   * scope. Keeps routing predictable and prevents accidental cross-team writes.
   */
/** @internal */
_resolveRemoteStoreForScope(scope: string): RemoteStore | null

/**
   * Refuse a write to a scope two servers claim (#1631), BEFORE anything is
   * saved: learn()'s dedup can record a recurrence before it reaches the
   * router, so the router's own throw would come too late there.
   */
/** @internal */
_refuseScopeConflict(scope: string): void

/**
   * True when `scope` is backed by a REMOTE store — i.e. a `stores` entry with a
   * `url` (data leaves this machine) whose scope exactly matches; for a personal
   * scope, when the ONE selected store is a url store. Used for routing
   * decisions (auto-route refusal, `readIdFor`). The secret scan does NOT use
   * it: it uses {@link _hasUrlStoreForScope}, which ignores the selection
   * (#1515 re-audit 3, M2).
   *
   * Pure CONFIG lookup — NO driver instantiation, NO network, NO side effects —
   * because this runs on every learn(). It uses `_resolveRemoteStoreForScope`'s
   * exact-scope-match rule (no prefix matching), but DELIBERATELY does not
   * mirror its readonly skip (core-index#9, round 2): a readonly URL store is not
   * a write target, yet its scope names a remote namespace, so the leak guard
   * still scans writes into it. That can only demote more, never let more out.
   * Where "a write here reaches the remote" is the question, use
   * {@link _isRemoteWriteScope}.
   */
/** @internal */
_isRemoteBackedScope(scope: string): boolean

/**
   * The SECRET-SCAN predicate (#1515 re-audit 3, M2): any url store whose
   * scope is exactly `scope`, readonly or not, whatever the personal-store
   * selection says. The selection decides ROUTING only. Callers of the scan
   * also act on a concrete url entry — the remote update walk, the outbox
   * flush, a queued-row retarget — and that entry is not the selected one
   * when a local store shares the identical scope. Scanning there too can
   * only demote a write that would have stayed local; it never lets one out.
   */
/** @internal */
_hasUrlStoreForScope(scope: string): boolean

/** Exactly the router's rule (`_resolveRemoteStoreForScope`): a writable URL
   *  store for exactly this scope, so a write to it leaves the machine. */
/** @internal */
_isRemoteWriteScope(scope: string): boolean

/**
   * The entry a write to `scope` goes through when it leaves the machine: the
   * resolver's `remote`, writable answer (#1631), else undefined. The learn
   * path's outbox target reads it (#1633 row 34), so the queued `target_url`
   * is always the server the router dials.
   */
/** @internal */
_remoteWriteEntry(scope: string): StoreEntry | undefined

/**
   * The url store an explicit `scope` argument names for an id lookup
   * (forget, feedback, setPinned; #1633 row 34): the resolver's `remote`
   * entry, so a lookup acts on the store a write to that scope goes to, and
   * matching is exact. A scope two servers claim throws ScopeConflictError
   * before any server is asked (`outcome` says what did not happen); acting
   * on whichever server is listed first would rate, pin or retire a row on a
   * server the caller may not mean. Any other answer → undefined: no url
   * store claims exactly this scope.
   */
/** @internal */
_scopedUrlEntry(scope: string, outcome: string): StoreEntry | undefined

/**
   * The store a scoped pin PATCHes (#1633 row 34): {@link _scopedUrlEntry}
   * over the writable stores only, so a readonly store listed for the same
   * scope never competes (#1532 re-audit R6) and two writable servers are a
   * refused conflict.
   */
/**
   * The stores a scoped pin resolves over: every path store (a local store
   * keeps its place in the personal selection, even readonly) and the
   * writable url stores (a readonly url store never receives the PATCH).
   */
/** @internal */
_pinCandidateStores(): StoreEntry[]

/** @internal */
_pinTargetEntry(scope: string, outcome: string): StoreEntry | undefined

/** @internal */
_meKey(url: string, token: string | undefined): string

/** @internal */
_noteMeIdentity(url: string, token: string | undefined, me: { username?: string; org_id?: string } | null): void

/**
   * Is `scope` the user's OWN personal namespace on the URL store that backs
   * it, per that store's `/me` identity? Own = `user:<username>` or
   * `user:<org_id>:<username>` (case-folded), or a segment-descendant of
   * either (`isScopeWithin`). `agent:*` and every other personal scope are not
   * the user's own. Unknown identity → false (fail closed).
   */
/** @internal */
_isOwnRemoteNamespace(scope: string): boolean

/**
   * The configured scope a personal `user:` scope resolves to (#1515):
   * `personalStoreEntry` over EVERY configured store, path-backed and url —
   * exact case first, else case-folded; local before remote within each.
   * Returns `scope` unchanged when it is not personal, names no store, or
   * already names one exactly. One rule for writes (learn, learnAsync,
   * learnBatch) and for the read dial, so the same string reaches the same
   * store (re-audit N1/N3/N5).
   */
/** @internal */
_canonicalPersonalScope(scope: string): string

/**
   * Decision E1 "me-only": an auto-route candidate the router must refuse like
   * a shared scope — backed by a URL store (so the write would leave the
   * machine) and not the user's own `/me` namespace. Path-backed and unbacked
   * personal scopes are never refused here. Shared scopes are
   * `allow_shared_auto_route`'s business, not this predicate's.
   */
/** @internal */
_refuseRemotePersonalAutoRoute(scope: string): boolean

/**
   * Find which store owns an engram by ID. For namespaced IDs, strips prefix to find in store.
   *
   * `storeScope` — the loader's `_storeScope` stamp of the row, when the caller
   * holds one — names the store exactly. `storePrefix` is three letters, so
   * two store scopes can share one (group:plur/eng and group:plur/ops are both
   * GPL) and a namespaced id alone then names both; ids collide across stores
   * as the common case, so the first store with the bare id was the wrong one
   * (audit of #1228). A stamped row is never the primary's.
   *
   * The stored id may itself carry the prefix (a row from another client or
   * a sync): namespacing on load is idempotent, so the loaded id IS the stored
   * id, and the stripped form is not in the file (audit of #1228, finding 2).
   * Both forms are tried; `originalId` is the id as the store file has it.
   */
/** @internal */
_findEngramStore(id: string, storeScope?: string): Promise<{ path: string; readonly: boolean; originalId: string } | null>

/**
   * Strip the store namespace prefix from an ID before sending to a remote server.
   * _loadAllEngrams adds ENG-{PREFIX}- to avoid local ID collisions; the remote
   * server only knows the original ID. If the ID doesn't match this store's prefix,
   * return it unchanged (it may belong to a different store or be unprefixed).
   * See: https://github.com/plur-ai/plur/issues/86
   */
/** @internal */
_stripRemotePrefix(id: string, scope: string): string

/**
   * The server id of `id` in the store for `scope`, when the caller has NAMED
   * that store (an explicit `scope`): strips this scope's current prefix or
   * its old three-letter one. Only for scope-targeted routes — the scope, not
   * the prefix, says which store is meant, so the old shared prefix is safe
   * to read here.
   */
/** @internal */
_stripForScope(id: string, scope: string): string

/**
   * Whether a row a url store's driver handed back is that store's own. One
   * server answers `GET /engrams/:id` for every scope the token can read, so
   * the driver of a writable store "finds" a row that lives in another
   * (possibly readonly) store on the same server. Acting on it through this
   * store is the readonly bypass of the 0.21.1 audit (H1, and L1 of the #1576
   * review for bare ids). A row with no scope, or `global`, counts as the
   * store's, as the loaders treat it.
   */
/** @internal */
_rowInStore(row: { scope?: unknown } | null | undefined, entry: StoreEntry): boolean

/** @internal */
_sharedPrefixRefusal(id: string, verb: string, prefix: string, scopes: string[]): Error

/**
   * Resolve a namespaced id to the ONE store it names, before any action on
   * it (0.21.1 audit of #1570, H1). Returns the id to act with — the current
   * prefix form for the store that holds the row — or the id unchanged when it
   * carries no store prefix or no configured store matches it.
   *
   * The walks that act on a namespaced id (forget, feedback, pin, update) visit
   * every store whose prefix the id carries and act on the first that holds the
   * stripped id. That is only safe when the prefix names one store. Two cases
   * name several, and both are resolved here by asking each candidate store for
   * the row:
   *   - an id in the OLD three-letter form ({@link legacyStorePrefix}), which
   *     every team store of one org shared;
   *   - one scope configured on two stores (two servers, or a path store and a
   *     url store), which share a prefix by construction.
   *
   * A url store "holds" the row only when the row's scope falls within the
   * store's scope: one server serves every scope the token can read, so a
   * driver for scope A answers for a row in scope B, and acting through A is
   * how a readonly B row used to be retired. When several stores hold the SAME
   * row (one server, nested scopes), the store whose scope is the row's own —
   * or else the most specific — is the one named. Distinct rows in different
   * stores are ambiguous and refused; so is a candidate that could not be
   * reached, since it might hold another row with this id. Nothing is changed
   * before this returns.
   */
/** @internal */
_resolveNamespacedId(id: string, verb: string): Promise<string>

/** Content hash fast-path dedup. Scope-aware: same statement in a different
   * scope is a promotion, not a duplicate. Retired engrams are excluded —
   * re-learning a retired statement creates a fresh engram (issue #107).
   *
   * A statement with no hashable content never matches (#896). Every such
   * statement hashes to the SHA-256 of the empty string, so matching on it
   * declares unrelated facts to be the same fact — which is exactly how the
   * non-Latin collapse absorbed four distinct memories into one row. The
   * normalizer no longer produces that for real prose; this is the belt to its
   * braces, and it fails in the safe direction (a missed dedup costs a
   * duplicate row, a false dedup costs the memory). */
/** @internal */
_hashDedup(statement: string, engrams: Engram[], scope?: string): Engram | null
}

export const routingMethods: RoutingMethods & ThisType<Plur> = {
_tokenEnvFor(url: string, scope?: string): string | undefined {
    const key = normalizeEndpointUrl(url)
    const stores = (this.config.stores ?? []).filter(s => s.url && normalizeEndpointUrl(s.url) === key && s.token_env)
    return (stores.find(s => s.scope === scope) ?? stores[0])?.token_env
  },

_getRemoteDriver(entry: { url: string; token?: string; scope: string }): RemoteStore {
    // #394: include the token in the cache key so a ROTATED token produces a FRESH
    // driver instead of one still holding the old (now-401) token + its stale cache.
    // On rotation, drop any prior driver for the same url::scope so the old token
    // can't keep serving and the map doesn't grow unbounded across rotations.
    const baseKey = `${entry.url}::${entry.scope}`
    const key = `${baseKey}::${entry.token ?? ''}`
    let driver = this._remoteStores.get(key)
    if (!driver) {
      for (const k of this._remoteStores.keys()) {
        if (k !== key && k.startsWith(baseKey + '::')) this._remoteStores.delete(k)
      }
      // A `token_env` store whose variable is unset gets a driver that refuses
      // every request, naming the variable (#1564 review M2).
      const tokenEnv = entry.token ? undefined : this._tokenEnvFor(entry.url, entry.scope)
      driver = new RemoteStore(entry.url, entry.token ?? '', entry.scope, tokenEnv ? { tokenEnv } : {})
      this._remoteStores.set(key, driver)
    }
    return driver
  },

_resolveRemoteStoreForScope(scope: string): RemoteStore | null {
    // One resolver for routing and the leak guard (#1631). A personal scope
    // routes through the ONE selected entry (#1515 L1): when a local path
    // store shares the exact scope, the write stays local. A scope two
    // servers claim is refused, never sent to whichever is listed first.
    const target = resolveScopeTarget(scope, this.config.stores ?? [])
    if (target.kind === 'conflict') throw new ScopeConflictError(scope, target.servers)
    if (target.kind !== 'remote' || !target.writable) return null
    const { entry } = target
    return this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
  },

_refuseScopeConflict(scope: string): void {
    const target = resolveScopeTarget(scope, this.config.stores ?? [])
    if (target.kind === 'conflict') throw new ScopeConflictError(scope, target.servers)
  },

_isRemoteBackedScope(scope: string): boolean {
    // Fail-safe (#1631): a scope two servers claim, or one under a company
    // server's org that it has not granted, counts as remote-backed too.
    return resolveScopeTarget(scope, this.config.stores ?? []).kind !== 'local'
  },

_hasUrlStoreForScope(scope: string): boolean {
    return urlGroupsForScope(scope, this.config.stores ?? []).length > 0
  },

_isRemoteWriteScope(scope: string): boolean {
    return this._remoteWriteEntry(scope) !== undefined
  },

_remoteWriteEntry(scope: string): StoreEntry | undefined {
    const target = resolveScopeTarget(scope, this.config.stores ?? [])
    return target.kind === 'remote' && target.writable ? target.entry : undefined
  },

_scopedUrlEntry(scope: string, outcome: string): StoreEntry | undefined {
    const target = resolveScopeTarget(scope, this.config.stores ?? [])
    if (target.kind === 'conflict') throw new ScopeConflictError(scope, target.servers, outcome)
    // Under a company server's org but not granted: no store claims it, so
    // there is nothing to act on, and the remote walk must not act on a row
    // of another store instead (gate of #1667).
    if (target.kind === 'unauthorized') {
      throw new Error(`"${scope}" is not granted to you on ${target.server}; ${outcome}. `
        + 'Ask an admin for access, or pass a granted scope (plur stores list).')
    }
    return target.kind === 'remote' ? target.entry : undefined
  },

_pinCandidateStores(): StoreEntry[] {
    return (this.config.stores ?? []).filter(s => !s.url || s.readonly !== true)
  },

_pinTargetEntry(scope: string, outcome: string): StoreEntry | undefined {
    const target = resolveScopeTarget(scope, this._pinCandidateStores())
    if (target.kind === 'conflict') throw new ScopeConflictError(scope, target.servers, outcome)
    return target.kind === 'remote' ? target.entry : undefined
  },

_meKey(url: string, token: string | undefined): string {
    return `${normalizeEndpointUrl(url)}::${token ?? ''}`
  },

_noteMeIdentity(url: string, token: string | undefined, me: { username?: string; org_id?: string } | null): void {
    const key = this._meKey(url, token)
    if (me && typeof me.username === 'string' && me.username.length > 0) {
      this._meIdentities.set(key, { username: me.username, org_id: typeof me.org_id === 'string' ? me.org_id : '' })
    } else {
      this._meIdentities.delete(key)
    }
  },

_isOwnRemoteNamespace(scope: string): boolean {
    // The entry the write lands on: the resolver's answer (#1633 row 34),
    // which for a personal scope is the ONE selected store (#1515). A scope
    // two servers claim is nobody's own namespace (fail closed).
    const target = resolveScopeTarget(scope, this.config.stores ?? [])
    const entry = target.kind === 'remote' ? target.entry : undefined
    if (!entry?.url) return false
    const id = this._meIdentities.get(this._meKey(entry.url, entry.token))
    if (!id) return false
    const s = scope.toLowerCase()
    const user = id.username.toLowerCase()
    const own = [`user:${user}`, ...(id.org_id ? [`user:${id.org_id.toLowerCase()}:${user}`] : [])]
    return own.some(o => isScopeWithin(s, o))
  },

_canonicalPersonalScope(scope: string): string {
    // Read the CURRENT config (re-audit M1): learnAsync/learnBatch fold here
    // before the guard's own reload, and a store another process just added
    // must already count — a stale list would send a write meant for a new
    // local store to a remote case twin.
    this.reloadConfigIfChanged()
    const entry = personalStoreEntry(scope, (this.config.stores ?? []).filter(s => typeof s.scope === 'string'))
    return entry ? entry.scope : scope
  },

_refuseRemotePersonalAutoRoute(scope: string): boolean {
    return this._isRemoteBackedScope(scope) && !this._isOwnRemoteNamespace(scope)
  },

async _findEngramStore(id: string, storeScope?: string): Promise<{ path: string; readonly: boolean; originalId: string } | null> {
    // Check primary first (uses mtime cache)
    if (storeScope === undefined) {
      const primaryEngrams = await this._loadCached(this.paths.engrams)
      if (primaryEngrams.find(e => e.id === id)) {
        return { path: this.paths.engrams, readonly: false, originalId: id }
      }
    }

    // Check stores — ID might be namespaced. Remote stores are skipped
    // here because remote IDs are not namespaced (the remote PLUR
    // Enterprise server assigns its own IDs); writes to remote stores
    // go through their own path.
    const stores = this.config.stores ?? []
    for (const store of stores) {
      if (!store.path) continue
      if (storeScope !== undefined && store.scope !== storeScope) continue
      const prefix = storePrefix(store.scope)
      const nsPattern = new RegExp(`^(ENG|ABS|META)-${prefix}-`)
      if (nsPattern.test(id)) {
        // Strip the namespace prefix to get the original ID — or the id as it
        // is, when the store file already holds it namespaced.
        const stripped = id.replace(nsPattern, '$1-')
        const storeEngrams = await this._loadCached(store.path)
        const legacyStored = stripped.replace(/^(ENG|ABS|META)-/, `$1-${legacyStorePrefix(store.scope)}-`)
        const found = storeEngrams.find(e => e.id === stripped) ?? storeEngrams.find(e => e.id === id)
          ?? storeEngrams.find(e => e.id === legacyStored)
        if (found) {
          return { path: store.path, readonly: store.readonly ?? false, originalId: found.id }
        }
      }
    }

    return null
  },

_stripRemotePrefix(id: string, scope: string): string {
    const prefix = storePrefix(scope)
    const nsPattern = new RegExp(`^(ENG|ABS|META)-${prefix}-`)
    if (nsPattern.test(id)) {
      return id.replace(nsPattern, '$1-')
    }
    return id
  },

_stripForScope(id: string, scope: string): string {
    return this._stripRemotePrefix(namespaceEngramId(id, scope), scope)
  },

_rowInStore(row: { scope?: unknown } | null | undefined, entry: StoreEntry): boolean {
    const sc = row?.scope
    return typeof sc !== 'string' || sc === '' || sc === 'global' || isScopeWithin(sc, entry.scope)
  },

_sharedPrefixRefusal(id: string, verb: string, prefix: string, scopes: string[]): Error {
    return new Error(
      `Cannot ${verb} "${id}": the stores for ${scopes.map(s => `"${s}"`).join(' and ')} share the id prefix ${prefix}, `
      + `so this id cannot say which store is meant. Nothing was changed. Pass scope: "<the store's scope>" to choose one.`,
    )
  },

async _resolveNamespacedId(id: string, verb: string): Promise<string> {
    const loose = parseNamespacedId(id, true)
    if (!loose) return id
    const stores = this.config.stores ?? []
    let parsed = loose
    let candidates = stores.filter(s => typeof s.scope === 'string' && storePrefix(s.scope) === loose.prefix)
    let legacy = false
    if (candidates.length > 0) {
      // Two DIFFERENT configured scopes behind one prefix: the id cannot say
      // which store it names, whatever the stores hold. Refused before anything
      // is asked or changed (review of #1576: rare at eight digest letters,
      // never guessed at).
      const scopes = [...new Set(candidates.map(c => c.scope))]
      if (scopes.length > 1) throw this._sharedPrefixRefusal(id, verb, loose.prefix, scopes)
      if (candidates.length === 1) return id
    } else {
      // The OLD three-letter form. Only a dated server-form id can be one
      // (`ENG-XXX-YYYY-MM-DD-NNN`): pack ids such as `ENG-PFR-001` share the
      // shape of a prefix and must stay as they are (review of #1576, M1). And
      // it is rewritten only once a store is seen to hold the row — below.
      const strict = parseNamespacedId(id)
      if (!strict) return id
      parsed = strict
      candidates = stores.filter(s => typeof s.scope === 'string' && legacyStorePrefix(s.scope) === strict.prefix)
      if (candidates.length === 0) return id
      legacy = true
    }

    // remote-only: a url store is asked only when it is the folder's own team
    // store (Codex round 3); local path stores are read as before.
    if (this._activeBinding()) candidates = candidates.filter(c => !c.url || this._remoteOnlyWalkAllows(c.scope))
    type Holder = { entry: StoreEntry; rowScope: string; key: string }
    const holders: Holder[] = []
    const unreached: string[] = []
    const forms = new Set([parsed.bare, id])
    for (const entry of candidates) {
      forms.add(namespaceEngramId(parsed.bare, entry.scope))
      forms.add(parsed.bare.replace(/^(ENG|ABS|META)-/, `$1-${legacyStorePrefix(entry.scope)}-`))
    }
    for (const entry of candidates) {
      if (entry.path) {
        const rows = await this._loadCached(entry.path)
        const row = rows.find(e => forms.has(e.id))
        if (row) holders.push({ entry, rowScope: row.scope ?? entry.scope, key: `path\0${entry.path}\0${row.id}` })
        continue
      }
      if (!entry.url) continue
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      let row: Engram | null = null
      try {
        const ownership = driver.probeById
          ? await driver.probeById(parsed.bare, { signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS) })
          : 'assumed'
        if (ownership === 'unknown') { unreached.push(entry.scope); continue }
        if (ownership === 'absent') continue
        row = await driver.getById(parsed.bare)
        // The store said it holds the row, then could not hand it over
        // (`getById` reads a timeout or a 5xx as null): that is "cannot
        // tell", never "does not hold it" (review of #1576, L3).
        if (!row && ownership === 'owned') { unreached.push(entry.scope); continue }
      } catch {
        unreached.push(entry.scope)
        continue
      }
      if (!row) continue
      const rowScope = row.scope ?? 'global'
      if (rowScope !== 'global' && !isScopeWithin(rowScope, entry.scope)) continue
      holders.push({ entry, rowScope, key: `url\0${normalizeEndpointUrl(entry.url)}\0${row.id}` })
    }
    const rows = new Map<string, Holder[]>()
    for (const h of holders) rows.set(h.key, [...(rows.get(h.key) ?? []), h])
    const named = (h: Holder) => `"${h.entry.scope}" (${namespaceEngramId(parsed.bare, h.entry.scope)})`
    if (rows.size > 1) {
      const where = [...rows.values()].map(hs => named(hs[0]))
      throw new Error(
        `Ambiguous engram ID "${id}": it names an engram in ${where.join(' and in ')}. Nothing was changed. `
        + `Pass the id for the one you mean, or its scope.`
        + (legacy ? ` "${id}" is in the old id form, which these stores shared; recall now gives each its own id.` : ''),
      )
    }
    if (unreached.length > 0) {
      throw new Error(
        `Cannot reach ${unreached.map(x => `"${x}"`).join(', ')} to ${verb} "${id}" safely: it could not be reached, and it may hold an engram with this id`
        + (rows.size === 1 ? ` (so may "${[...rows.values()][0][0].entry.scope}")` : '')
        + `. Nothing was changed. Retry once the store is reachable, or pass the scope of the one you mean.`,
      )
    }
    if (rows.size === 0) return id
    const hs = [...rows.values()][0]
    const own = hs.find(h => h.entry.scope === h.rowScope)
      ?? [...hs].sort((a, b) => b.entry.scope.length - a.entry.scope.length)[0]
    return namespaceEngramId(parsed.bare, own.entry.scope)
  },

_hashDedup(statement: string, engrams: Engram[], scope?: string): Engram | null {
    if (!isHashable(statement)) return null
    const hash = computeContentHash(statement)
    for (const e of engrams) {
      if (e.status === 'active' && (e as any).content_hash === hash) {
        if (scope === undefined || e.scope === scope) return e
      }
    }
    return null
  },
}
