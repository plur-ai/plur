import * as fs from 'fs'
import yaml from 'js-yaml'
import { writeConfigFile } from '../config-file.js'
import { loadConfig } from '../config.js'
import { DISCOVERY_FUTURE_SKEW_MS, DISCOVERY_MAX_AGE_MS } from '../git-origin.js'
import { Plur } from '../index.js'
import { decodeJwtExpiry, decodeJwtPayload } from '../jwt.js'
import { logger } from '../logger.js'
import { checkOwnerOnly } from '../owner-only.js'
import { redactToken } from '../redact-token.js'
import type { StoreEntry } from '../schemas/config.js'
import { ServerStoreEntrySchema } from '../schemas/config.js'
import { isSharedScope } from '../scope-util.js'
import { acceptDiscoveredScopes } from '../server-discovery.js'
import { isSafeScopeName, safeOrigin, withCompatScope } from '../store-expand.js'
import type { MeResponse } from '../store/remote-store.js'
import { normalizeEndpointUrl, RemoteHttpError, RemoteStore, tokenEnvUnsetMessage } from '../store/remote-store.js'
import { withLock } from '../sync.js'
import { DISCOVERY_SNAPSHOT_KEYS, discoveryChanged, isEnterpriseServerEntry, isPlainObject, sanitizeForbidCategories, scopesServedElsewhere, serverCredential, stableJson, stringList } from './helpers.js'
import { CheckResult, RegisterDiscoveredResult, RemoteHealth, RemoteScopeDiscovery, ServerDiscoveryOutcome, ServerStoreCheck, StoreSummary } from './types.js'

export interface DiscoveryMethods {
/** Build the primary-store summary row. Shared by listStores +
   * listStoresAsync to keep them in lockstep. */
/** @internal */
_primaryStoreRow(): Promise<StoreSummary>

/**
   * @deprecated Use {@link listStoresAsync} for accurate remote engram counts.
   * The sync variant reads only the remote drivers' in-memory peek cache,
   * which does not self-populate: a remote store's engram_count stays 0 on
   * EVERY call until something explicitly warms the cache
   * (`warmRemoteCaches()`, e.g. via session_start). Retained for callers
   * that cannot await.
   */
listStores(): Promise<Array<StoreSummary>>

/**
   * List all configured stores with accurate remote engram counts. Awaits
   * remote driver loads with a 5s per-store timeout so a single slow or
   * unreachable remote can never hang the entire call.
   *
   * Use for `plur_stores_list` and CLI diagnostics where freshness matters
   * more than latency.
   */
listStoresAsync(): Promise<Array<StoreSummary>>

/**
   * Pre-load all remote store caches so subsequent sync reads see data.
   * Call once before injection to avoid the cold-start race.
   *
   * Each remote load races against a 5-second timeout — a single hung or
   * slow remote must not block session_start indefinitely. Same pattern as
   * listStoresAsync. clearTimeout on the success path prevents
   * accumulating dangling timers in the long-lived MCP server process.
   */
warmRemoteCaches(): Promise<void>

/** Return writable remote store scopes for AI caller guidance. */
getWritableRemoteScopes(): Array<{ scope: string; url: string }>

/**
   * Group configured remote stores by distinct URL, returning one entry per URL
   * with the token to query it. Tokens should be identical across a URL's
   * entries (same user, same instance); the first is used.
   *
   * "Distinct" is keyed on {@link normalizeEndpointUrl}: `https://x.com`,
   * `https://x.com/` and `https://x.com/sse` are ONE endpoint, not three — an
   * exact-string key would probe the same server once per spelling and split
   * its registered-scope view across the copies. The FIRST configured
   * spelling is what gets reported/queried; stored values are never rewritten.
   *
   * Public so the remote-recall leg's callers and tests can enumerate
   * endpoint identity — but note recall dialing groups by (url, token) via
   * `_remoteRecallHosts`, NOT by url alone: this method's first-token-wins
   * collapse is only safe for probes (`/me`, health) where any of the tokens
   * answers the identity question.
   */
_distinctRemoteEndpoints(): Array<{ url: string; token?: string }>

/** All store entries registered against `url` under ANY spelling of that
   *  endpoint — the identity-normalized counterpart of
   *  `stores.filter(s => s.url === url)`. Public for the remote-recall leg's
   *  callers and tests. */
_storesForEndpoint(url: string): StoreEntry[]

/**
   * Distinct (url, token) groups among the configured remote stores —
   * the AUTH-identity counterpart of {@link _distinctRemoteEndpoints}. Same
   * `::` composite key as `_remoteRecallHosts`: two entries on one URL
   * with DIFFERENT tokens are two distinct credentials with independent
   * validity, so token-status surfaces must report them separately rather
   * than letting first-token-wins mask a dead second token. URL identity is
   * normalized ({@link normalizeEndpointUrl}); the first-configured spelling
   * is reported. `scopes` lists the group's registered scopes in config order.
   */
remoteEndpointTokenGroups(): Array<{ url: string; token?: string; scopes: string[]; tokenEnv?: string }>

/**
   * Discover which scopes each configured remote token is authorized for, via
   * `GET /api/v1/me`. For each distinct remote URL, reports the
   * server-authorized scope set and which of those are not yet registered
   * locally — the gap that lets a user authorized for N teams see only the
   * one(s) they happened to register.
   *
   * Read-only: never mutates config. Each `/me` is raced against a timeout and
   * failures are captured per URL (`ok:false`) so one unreachable endpoint
   * never sinks discovery for the others. Restricted to a single URL via
   * `opts.url`.
   */
discoverRemoteScopes(opts?: { url?: string; timeoutMs?: number }): Promise<RemoteScopeDiscovery[]>

/**
   * One `GET /api/v1/me` on this url's cached driver, raced against a timeout.
   * Shared by {@link discoverRemoteScopes}, {@link checkRemoteHealth} and
   * {@link refreshServerScopes}. Throws the driver's error (a
   * {@link RemoteHttpError} for a non-2xx answer) or a timeout error.
   */
/** @internal */
_probeMe(url: string, token: string | undefined, timeoutMs: number, scope?: string): Promise<MeResponse>

/**
   * Discover each server entry's scopes from `GET /api/v1/me` and write the
   * discovery cache into config.yaml.
   *
   * Only server entries are touched: a store entry with a `scopes` list and an
   * `enterprise` block. Per-scope entries are left alone; with none, this
   * returns [] without a request. Whether an answer replaces the cached list
   * is {@link acceptDiscoveredScopes}' decision: a failed, unauthorised,
   * not-synced or degraded answer never replaces a non-empty cache, and then
   * only `discovery.status` and `discovery.checked_at` are written — `scope`,
   * `scopes` and `discovery.discovered_at` stay exactly as they were.
   *
   * On an accepted answer it writes `scopes`, the compatibility `scope` (the
   * accepted personal `user:<org>:<username>` scope, when there is one) and a
   * fresh `discovery` block. It never writes `enterprise` or `pinned_scopes`;
   * `scope_settings` changes only through {@link persistScopeMetadata}, and
   * only when the server says its metadata is `ok`.
   *
   * An answer that changes nothing but the timestamps writes nothing: the
   * timestamp it would set (`discovered_at` for an accepted answer,
   * `checked_at` for a refused one) is refreshed at most once a day, so the
   * 7-day stale-cache checks still see an unchanged answer as fresh.
   *
   * The requests run in parallel and one server's failure never affects
   * another's outcome. The write is a raw read-modify-write of the server
   * entries under the config lock, so every other key of the entry (unknown
   * keys too) is kept as it is on disk.
   */
/**
   * The endpoints {@link refreshServerScopes} probes, keyed by normalized url:
   * the server entries in config.yaml that carry a `scopes` list and an
   * `enterprise` block, each with its configured url and the cached
   * `discovery.status` and `discovery.checked_at` of its first entry. Reads the file, never the network.
   * The MCP server uses it so an endpoint is either refreshed in the
   * background or probed by the legacy session-start path, never neither, and
   * so a server with an empty scope cache still has a status.
   */
_serverDiscoveryEndpoints(): Map<string, { url: string; status?: string; checked_at?: string }>

refreshServerScopes(opts?: { url?: string; timeoutMs?: number; onConfigWrite?: (before: string | null, after: string) => void }): Promise<ServerDiscoveryOutcome[]>

/** The raw `stores` array of config.yaml as on disk ([] when absent or unreadable). */
/** @internal */
_readRawStores(strict?: boolean): unknown[]

/**
   * Read-modify-write of the raw `stores` array under the config lock, written
   * atomically only when `mutate` reports a change; every other top-level key
   * and every untouched entry is kept. Same discipline as
   * {@link persistDismissedScopes}: a read error other than ENOENT aborts.
   */
/** @internal */
_updateRawStores(mutate: (rawStores: unknown[]) => boolean, onConfigWrite?: (before: string | null, after: string) => void): void

/** Observational diagnostics: never refresh grants, change permissions or flush saves. */
checkServerStores(opts?: { timeoutMs?: number }): Promise<ServerStoreCheck[]>

/** @internal */
_enterpriseRecoveryEndpoint(url: string): boolean

/**
   * Local-only read of each configured remote token's JWT expiry. No
   * network. Returns one entry per distinct remote URL; `expiresInDays`/`expired`
   * are null/false for opaque (non-JWT) keys. Used by session_start to warn
   * about imminent/past expiry without a round-trip.
   */
remoteTokenExpiries(now?: number): Array<{ url: string; scopes: string[]; enterprise?: boolean; expiresAt: string | null; expiresInDays: number | null; expired: boolean }>

/**
   * Probe each configured remote credential's auth/reachability by
   * calling `GET /api/v1/me` (raced against a timeout), combined with a local
   * JWT-expiry read. Distinguishes 'auth_expired' (token rejected or JWT exp
   * passed → reauth) from 'unreachable' (network/timeout/5xx). Read-only; one
   * bad endpoint never affects the others. Powers `plur_doctor`'s remote check
   * and `plur login --status`, so neither reports "healthy" when the
   * remote auth is dead.
   *
   * Probes per distinct (url, token) group ({@link remoteEndpointTokenGroups}),
   * not per URL: each token's validity is independent, and a first-token-wins
   * collapse would report a URL as ok while its second configured token was
   * expired. Also surfaces display-only JWT claims (`tokenSubject`,
   * `tokenOrg` — unverified) and, on a successful probe, the server-confirmed
   * `username`/`orgId`/`grantedScopes` from `/me`.
   */
checkRemoteHealth(opts?: { timeoutMs?: number }): Promise<RemoteHealth[]>

/**
   * Register every authorized-but-unregistered scope discovered for the
   * configured remote URL(s). One token → all the user's team scopes in
   * a single action. Relies on URL+scope dedup so multiple scopes coexist
   * under one URL. Scopes the user has dismissed are respected — the
   * batch path skips them; only the per-scope {@link registerScope}
   * overrides a dismissal.
   *
   * Returns per-URL what was newly `added` vs `already_registered`. A URL whose
   * `/me` failed yields `ok:false` and registers nothing.
   */
registerDiscoveredScopes(opts?: { url?: string; timeoutMs?: number }): Promise<RegisterDiscoveredResult[]>

/**
   * The single source of truth for the "authorized but unregistered" OFFER
   * offer, shared by the `plur scopes` CLI and the session-start hint. Returns
   * the shared-family scopes the token is authorized for that are neither
   * registered nor dismissed, deduped across remotes, each with its
   * self-describing metadata description when the server serves it.
   *
   * Personal-family scopes are excluded here (they can't be registered from
   * discovery — see {@link registerScope}), so the offer only ever shows
   * scopes the user can actually act on.
   *
   * Also returns any `failures` (remotes whose /me could not be reached / whose
   * token was rejected) so the caller can distinguish "genuinely nothing to
   * offer" from "couldn't reach the server" — the CLI must not report an empty
   * offer when it simply failed to talk to the remote.
   */
offerableScopes(opts?: { url?: string; timeoutMs?: number }): Promise<{
    scopes: Array<{ scope: string; url: string; description?: string }>
    failures: Array<{ url: string; error?: string }>
  }>

/**
   * Register a SINGLE authorized-but-unregistered shared scope — the
   * per-scope counterpart to {@link registerDiscoveredScopes} (all-or-nothing).
   * Discovers which configured remote authorizes `scope`, then adds one store
   * entry via the same url+scope-idempotent {@link addStore} path.
   *
   * Rejects personal-family scopes (`user:*`/`global`/…) — same guard as
   * the batch path: a `/me`-advertised personal scope must never become a
   * routing target for the user's default/unscoped writes. Throws if no
   * configured remote authorizes the scope.
   */
registerScope(scope: string, opts?: { url?: string; timeoutMs?: number }): Promise<{ url: string; status: 'added' | 'already_registered' | 'overwritten' | 'token_rotated' }>

/**
   * Dismiss a scope from the "authorized but unregistered" offer. It is
   * remembered in config (`dismissed_scopes`) and excluded from
   * discoverRemoteScopes().unregistered + the session-start hint until
   * {@link reofferScopes}. No-op if already dismissed.
   */
dismissScope(scope: string): void

/** Lowercased `dismissed_scopes` for case-insensitive membership tests.
   *  The stored values keep their original case. */
/** @internal */
_dismissedScopeKeys(): Set<string>

/** Clear all dismissals — dismissed scopes are offered again. */
reofferScopes(): void

/** The scopes currently dismissed from the offer. */
getDismissedScopes(): string[]

/**
   * Persist `dismissed_scopes` to config.yaml, preserving every other top-level
   * key, then refresh the in-memory config + mtime. Mirrors {@link persistStores}:
   * a transient read error on an EXISTING config aborts rather than truncating,
   * and the read-modify-write runs under {@link withLock} so a concurrent
   * config persist path can't be last-writer-wins'd away. Dedup is
   * case-insensitive (first spelling wins) so case variants of one scope
   * never accumulate.
   */
/** @internal */
persistDismissedScopes(list: string[]): void

/**
   * Sync server-authoritative scope metadata (covers/description/sensitivity)
   * from /me discoveries into the matching local config store entries.
   *
   * Without it listScopeMetadata() would return empty covers and
   * suggestScope() would be inert for remote scopes. Called after any /me pull
   * (session_start, registerDiscoveredScopes, registerScope).
   * Personal-family scopes are skipped — they are never routing targets.
   * No-op when nothing changed (avoids spurious config writes).
   *
   * TRUST RULE for `sensitivity`: remote-served
   * sensitivity may only TIGHTEN the write-time leak guard, never loosen it.
   * The guard checks `allow` BEFORE `forbid` and `allow` admits arbitrary
   * strings, so persisting a remote `allow:['secrets','infra']` verbatim would
   * let a hostile/compromised enterprise endpoint silently disarm the guard at
   * the next session_start. Therefore:
   *   - a remote `allow` is NEVER persisted (dropped, along with any unknown
   *     nested sensitivity fields the remote sent);
   *   - only the remote `forbid` is persisted, sanitized to the known
   *     SENSITIVITY_CATEGORIES (empty-after-sanitize falls to the safe
   *     default, mirroring ScopeSensitivitySchema);
   *   - a hand-edited `allow` in local config.yaml is preserved and remains
   *     honored by the guard — a deliberate LOCAL decision.
   *
   * The change-detector compares what WILL actually be persisted
   * (post-sanitization, post-merge) against the loaded entry, so an unchanged
   * server state is a true no-op — no write, no mtime bump, no config-reload
   * storm on every session_start. When `forbid` DOES change, the affected
   * scopes are named to persistStores (`serverSensitivityScopes`) so
   * mergeStoresForWriteback's raw-forbid restore doesn't discard the update.
   */
persistScopeMetadata(discoveries: RemoteScopeDiscovery[], onConfigWrite?: (before: string | null, after: string) => void): void

/**
   * Set a session-level default scope — the fallback in learn/learnRouted when
   * no explicit scope is provided.
   *
   * Omit `session` and this sets the process-wide slot: one
   * session per instance, one scope. That is right for the CLI and for an MCP
   * server handling one session at a time.
   *
   * Pass `session` and the scope is isolated to that session key. Any
   * deployment where one `Plur` serves concurrent sessions MUST do this and
   * thread the same key through `LearnContext.session` — otherwise the scope is
   * a single shared field, and a `setSessionScope` from one session decides
   * where another session's in-flight write lands. Passing `null` for a keyed
   * session pins it to "no session scope" (unscoped writes auto-route), which
   * is distinct from never having registered it (inherits the process slot).
   */
setSessionScope(scope: string | null, opts?: { session?: string }): void

/**
   * Adjust the session default scope MID-session — `setSessionScope`
   * plus observability: appends a `session_scope_changed` history event so the
   * scope active at any point in a session can be reconstructed retrospectively
   * (which scope routed a given engram, whether an agent oscillates scopes).
   *
   * `setSessionScope` stays the raw, silent primitive — session bootstrap
   * (every `plur_session_start`) uses it without flooding history; deliberate
   * mid-session changes go through here. Same registry, same keying rules:
   * omit `session` for the process slot, pass it for per-session isolation
   * (ADR-0004 — one `Plur` serving concurrent sessions MUST key).
   *
   * Returns the previous and new effective scope for the targeted slot.
   */
adjustSessionScope(scope: string | null, opts?: { session?: string; reason?: string; trigger?: 'set' | 'clear' }): { previous: string | null; next: string | null }

/**
   * Get the session-level default scope for `opts.session`, or the process-wide
   * one when no session is named. Returns null if not set.
   */
getSessionScope(opts?: { session?: string }): string | null

/**
   * Forget a session's scope registration. Call on session end: a long-lived
   * deployment would otherwise retain one entry per session it has ever served.
   * Omitting `session` clears the process-wide slot.
   */
clearSessionScope(opts?: { session?: string }): void

/** Session keys with their own scope registration. Diagnostic / test seam. */
trackedSessionScopes(): string[]
}

export const discoveryMethods: DiscoveryMethods & ThisType<Plur> = {
async _primaryStoreRow(): Promise<StoreSummary> {
    return {
      path: this.paths.engrams,
      scope: 'global',
      shared: false,
      readonly: false,
      engram_count: (await this._loadCached(this.paths.engrams)).filter(e => e.status !== 'retired').length,
    }
  },

async listStores(): Promise<Array<StoreSummary>> {
    this.reloadConfigIfChanged()  // pick up out-of-process config edits
    const stores = this.config.stores ?? []
    const additional = stores.map(async s => {
      let count = 0
      if (s.url) {
        try { count = this._loadRemoteCached(s).filter(e => e.status !== 'retired').length } catch {}
      } else if (s.path) {
        try { count = (await this._loadCached(s.path)).filter(e => e.status !== 'retired').length } catch {}
      }
      return {
        path:     s.path,
        url:      s.url,
        scope:    s.scope,
        shared:   s.shared,
        readonly: s.readonly,
        engram_count: count,
        // Surface self-describing metadata in discovery when present.
        ...(s.description !== undefined ? { description: s.description } : {}),
        ...(s.covers !== undefined ? { covers: s.covers } : {}),
      }
    })
    return [await this._primaryStoreRow(), ...(await Promise.all(additional))]
  },

async listStoresAsync(): Promise<Array<StoreSummary>> {
    this.reloadConfigIfChanged()  // pick up out-of-process config edits
    const stores = this.config.stores ?? []
    const REMOTE_LOAD_TIMEOUT_MS = 5000

    // remote-only: only the folder's own team store is loaded; the others are
    // listed from config.yaml alone, with no count.
    const ro = this._activeBinding()
    const additional = await Promise.all(stores.map(async s => {
      let count = 0
      if (s.url && ro && !(s.scope === ro.scope && !ro.blocked && this._isDeliverableTeamScope(s.scope))) {
        // not contacted
      } else if (s.url) {
        try {
          const driver = this._getRemoteDriver({ url: s.url, token: s.token, scope: s.scope })
          // Race driver.load() against a timeout — a hung remote must not
          // hang the listing call. On timeout, count stays 0. The clearTimeout
          // in finally is critical: in a long-lived MCP server, uncleaned
          // timers per remote × per call would keep the event loop active.
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined
          const loadWithTimeout = Promise.race([
            driver.load().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`remote load timeout (${REMOTE_LOAD_TIMEOUT_MS}ms)`)),
                REMOTE_LOAD_TIMEOUT_MS,
              )
            }),
          ])
          const engrams = await loadWithTimeout
          count = engrams.filter(e => e.status !== 'retired').length
        } catch { /* network/auth failure or timeout — report 0, don't crash */ }
      } else if (s.path) {
        try { count = (await this._loadCached(s.path)).filter(e => e.status !== 'retired').length } catch {}
      }
      return {
        path:     s.path,
        url:      s.url,
        scope:    s.scope,
        shared:   s.shared,
        readonly: s.readonly,
        engram_count: count,
        // Surface self-describing metadata in discovery when present.
        ...(s.description !== undefined ? { description: s.description } : {}),
        ...(s.covers !== undefined ? { covers: s.covers } : {}),
      }
    }))
    return [await this._primaryStoreRow(), ...(await Promise.all(additional))]
  },

async warmRemoteCaches(): Promise<void> {
    const stores = this.config.stores ?? []
    // remote-only: only the folder's own team store.
    const ro = this._activeBinding()
    const remoteStores = stores.filter(s => s.url && (!ro || (!ro.blocked && !!ro.scope && s.scope === ro.scope && this._isDeliverableTeamScope(s.scope))))
    const REMOTE_LOAD_TIMEOUT_MS = 5000
    await Promise.all(
      remoteStores.map(s => {
        const driver = this._getRemoteDriver({ url: s.url!, token: s.token, scope: s.scope })
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        return Promise.race([
          driver.load().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(`remote warm timeout (${REMOTE_LOAD_TIMEOUT_MS}ms)`)),
              REMOTE_LOAD_TIMEOUT_MS,
            )
          }),
        ]).catch(() => { /* errors logged inside RemoteStore; timeout swallowed */ })
      }),
    )
  },

getWritableRemoteScopes(): Array<{ scope: string; url: string }> {
    return (this.config.stores ?? [])
      .filter(s => s.url && !s.readonly)
      .map(s => ({ scope: s.scope, url: s.url! }))
  },

_distinctRemoteEndpoints(): Array<{ url: string; token?: string }> {
    const byUrl = new Map<string, { url: string; token?: string }>()
    for (const s of this.config.stores ?? []) {
      if (!s.url) continue
      const key = normalizeEndpointUrl(s.url)
      if (!byUrl.has(key)) byUrl.set(key, { url: s.url, token: s.token })
    }
    return [...byUrl.values()]
  },

_storesForEndpoint(url: string): StoreEntry[] {
    const key = normalizeEndpointUrl(url)
    return (this.config.stores ?? []).filter(s => s.url !== undefined && normalizeEndpointUrl(s.url) === key)
  },

remoteEndpointTokenGroups(): Array<{ url: string; token?: string; scopes: string[]; tokenEnv?: string }> {
    const groups = new Map<string, { url: string; token?: string; scopes: string[]; tokenEnv?: string }>()
    for (const s of this.config.stores ?? []) {
      if (!s.url) continue
      const key = `${normalizeEndpointUrl(s.url)}::${s.token ?? ''}`
      let g = groups.get(key)
      if (!g) { g = { url: s.url, token: s.token, scopes: [] }; groups.set(key, g) }
      if (!s.token && s.token_env && !g.tokenEnv) g.tokenEnv = s.token_env
      if (!g.scopes.includes(s.scope)) g.scopes.push(s.scope)
    }
    return [...groups.values()]
  },

async discoverRemoteScopes(opts?: { url?: string; timeoutMs?: number }): Promise<RemoteScopeDiscovery[]> {
    const timeoutMs = opts?.timeoutMs ?? 5000
    // Endpoint identity is normalized so a caller
    // restricting by one spelling still matches an entry configured under
    // another, and `registered` sees every spelling's entries.
    const endpoints = this._distinctRemoteEndpoints()
      .filter(e => !opts?.url || normalizeEndpointUrl(e.url) === normalizeEndpointUrl(opts.url))

    return Promise.all(endpoints.map(async ({ url, token }) => {
      const registered = this._storesForEndpoint(url).map(s => s.scope)
      try {
        const me = await this._probeMe(url, token, timeoutMs, registered[0] ?? '')
        this._noteMeIdentity(url, token, me)
        const registeredSet = new Set(registered)
        // Scopes the user has dismissed from the offer are not "actionable" —
        // drop them from `unregistered` so the session-start hint and CLI stop
        // re-surfacing them every session. `plur scopes --reoffer` clears these.
        // Membership is CASE-INSENSITIVE: the /me scope grammar admits
        // uppercase, so a case-variant re-advertisement of a dismissed scope
        // must not resurrect the offer. Stored values keep their original case.
        const dismissedSet = this._dismissedScopeKeys()
        return {
          url,
          ok: true,
          username: me.username,
          org_id: me.org_id,
          role: me.role,
          authorized: me.scopes,
          registered,
          unregistered: me.scopes.filter(s => !registeredSet.has(s) && !dismissedSet.has(s.toLowerCase())),
          // Server-authoritative metadata for the authorized scopes, already
          // validated in RemoteStore.me(). Empty for older servers.
          metadata: me.scope_metadata ?? [],
        }
      } catch (err) {
        this._noteMeIdentity(url, token, null)
        return {
          url, ok: false,
          authorized: [], registered, unregistered: [], metadata: [],
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }))
  },

async _probeMe(url: string, token: string | undefined, timeoutMs: number, scope = ''): Promise<MeResponse> {
    const driver = this._getRemoteDriver({ url, token, scope })
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      driver.me().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`/me timeout (${timeoutMs}ms)`)), timeoutMs)
      }),
    ])
  },

_serverDiscoveryEndpoints(): Map<string, { url: string; status?: string; checked_at?: string }> {
    const out = new Map<string, { url: string; status?: string; checked_at?: string }>()
    for (const r of this._readRawStores().filter(isEnterpriseServerEntry)) {
      const key = normalizeEndpointUrl(r.url)
      if (out.has(key)) continue
      const d = isPlainObject(r.discovery) ? r.discovery : {}
      out.set(key, {
        url: r.url,
        ...(typeof d.status === 'string' ? { status: d.status } : {}),
        ...(typeof d.checked_at === 'string' ? { checked_at: d.checked_at } : {}),
      })
    }
    return out
  },

async refreshServerScopes(opts?: { url?: string; timeoutMs?: number; onConfigWrite?: (before: string | null, after: string) => void }): Promise<ServerDiscoveryOutcome[]> {
    const timeoutMs = opts?.timeoutMs ?? 5000
    this.reloadConfigIfChanged()
    const wanted = opts?.url ? normalizeEndpointUrl(opts.url) : undefined
    const servers = this._readRawStores()
      .filter(isEnterpriseServerEntry)
      .filter(r => !wanted || normalizeEndpointUrl(r.url) === wanted)
    if (!servers.length) return []

    // Network first, outside the lock; each answer is judged against the file
    // as it is when the write happens.
    type Answer = { url: string; revision: string; me: MeResponse | null; error?: { status?: number; message: string } }
    const answers = await Promise.all(servers.map(async (r): Promise<Answer> => {
      const url = r.url
      const { token, tokenEnv, revision } = serverCredential(r)
      if (!token) {
        const message = tokenEnv ? tokenEnvUnsetMessage(tokenEnv, safeOrigin(url)) : `no key is configured for ${safeOrigin(url)}`
        return { url, revision, me: null, error: { message } }
      }
      try {
        const me = await this._probeMe(url, token, timeoutMs, typeof r.scope === 'string' ? r.scope : '')
        this._noteMeIdentity(url, token, me)
        return { url, revision, me }
      } catch (err) {
        this._noteMeIdentity(url, token, null)
        // A server or proxy can echo the key back in its error body: every
        // encoding of it is removed before the message is kept.
        const message = redactToken(err instanceof Error ? err.message : String(err), token)
        return { url, revision, me: null, error: { status: err instanceof RemoteHttpError ? err.status : undefined, message } }
      }
    }))

    const outcomes: ServerDiscoveryOutcome[] = []
    const now = new Date().toISOString()
    this._updateRawStores(rawStores => {
      let changed = false
      for (const { url, revision, me, error } of answers) {
        const key = normalizeEndpointUrl(url)
        const matches = rawStores.flatMap((r, i) => (isEnterpriseServerEntry(r) && normalizeEndpointUrl(r.url) === key ? [i] : []))
        if (matches.length === 0) {
          // Removed by another process since the read above: nothing to write.
          outcomes.push({ url, status: 'failed', applied: false, scopes: [], rejected: [], pinned_unlisted: [], error: 'the server entry is no longer in config.yaml' })
          continue
        }
        if (matches.length > 1) {
          // Two server entries on one url (another key each): which one this
          // answer belongs to cannot be told here, so neither is written — the
          // same refusal as key rotation. Applying it to the first one would
          // put another key's scopes on it (formal RoutingDiscovery D4).
          outcomes.push({ url, status: 'failed', applied: false, scopes: [], rejected: [], pinned_unlisted: [],
            error: `more than one server entry in config.yaml has the url ${safeOrigin(url)}; nothing was changed. Keep one of them.` })
          continue
        }
        const idx = matches[0]
        const entry = rawStores[idx] as Record<string, unknown> & { url: string }
        if (serverCredential(entry).revision !== revision) {
          // The entry's key was replaced (or its token_env now resolves to
          // another key) while /me was in flight: this answer describes the
          // old key, so it is not written to the new one.
          outcomes.push({ url, status: 'failed', applied: false, scopes: stringList(entry.scopes), rejected: [], pinned_unlisted: [],
            error: `entry changed during refresh: the key for ${safeOrigin(url)} changed while its scopes were requested; nothing was changed. Run the refresh again.` })
          continue
        }
        const cached = stringList(entry.scopes)
        const decision = acceptDiscoveredScopes({ me, error, cached, otherServersScopes: scopesServedElsewhere(rawStores, key) })
        const oldDiscovery = isPlainObject(entry.discovery) ? entry.discovery : {}
        let next: Record<string, unknown>
        if (decision.replaceCache && me) {
          const personal = decision.scopes.find(sc => sc.toLowerCase() === `user:${me.org_id}:${me.username}`.toLowerCase())
          // Unknown discovery keys (a newer client's) are kept; every known
          // snapshot key is replaced or, when this answer lacks it, removed.
          const unknownDiscovery = Object.fromEntries(Object.entries(oldDiscovery)
            .filter(([k]) => !(DISCOVERY_SNAPSHOT_KEYS as readonly string[]).includes(k)))
          // A changed compat scope takes the old one's top-level metadata
          // into scope_settings[old] first.
          next = {
            ...(personal ? withCompatScope(entry, personal) : entry),
            scopes: decision.scopes,
            discovery: {
              ...unknownDiscovery,
              discovered_at: now,
              ...(me.scopes_status !== 'absent' ? { scopes_status: me.scopes_status } : {}),
              ...(me.gitlab_host !== undefined ? { gitlab_host: me.gitlab_host } : {}),
              project_paths: me.project_paths,
              username: me.username,
              org_id: me.org_id,
              ...(me.key_expires_at !== undefined ? { key_expires_at: me.key_expires_at } : {}),
              status: decision.status,
              checked_at: now,
            },
          }
        } else {
          next = { ...entry, discovery: { ...oldDiscovery, status: decision.status, checked_at: now } }
        }
        if (discoveryChanged(entry, next, decision.replaceCache ? 'discovered_at' : 'checked_at', Date.now())) {
          rawStores[idx] = next
          changed = true
        }

        const pinned = stringList(entry.pinned_scopes)
        const listed = new Set(me?.scopes ?? [])
        const pinned_unlisted = decision.status === 'ok' ? pinned.filter(p => !listed.has(p)) : []
        for (const p of pinned_unlisted) {
          const once = `${key}\0${p}`
          if (this._warnedPinnedUnlisted.has(once)) continue
          this._warnedPinnedUnlisted.add(once)
          logger.warning(`[plur:discovery] pinned scope "${p}" is not in the scope list ${safeOrigin(url)} sent; it stays registered because it is pinned`)
        }
        outcomes.push({
          url, status: decision.status, applied: decision.replaceCache, scopes: decision.scopes,
          rejected: decision.rejected, pinned_unlisted,
          ...(me?.username ? { username: me.username } : {}),
          ...(error ? { error: error.message } : {}),
        })
      }
      return changed
    }, opts?.onConfigWrite)

    // Server metadata lands in scope_settings through the existing sync, once
    // the new scopes are expanded in memory.
    const metadata: RemoteScopeDiscovery[] = []
    for (const { url, me } of answers) {
      const o = outcomes.find(x => x.url === url)
      if (!me || !o?.applied || me.scope_metadata_status !== 'ok') continue
      const accepted = new Set(o.scopes)
      metadata.push({
        url, ok: true, username: me.username, org_id: me.org_id, role: me.role,
        authorized: o.scopes, registered: o.scopes, unregistered: [],
        metadata: (me.scope_metadata ?? []).filter(m => accepted.has(m.scope)),
      })
    }
    if (metadata.length) this.persistScopeMetadata(metadata, opts?.onConfigWrite)
    return outcomes
  },

_readRawStores(strict = false): unknown[] {
    try {
      const data = yaml.load(fs.readFileSync(this.paths.config, 'utf8')) as Record<string, unknown> | null
      if (strict && data != null && (!isPlainObject(data) || (data.stores !== undefined && !Array.isArray(data.stores)))) throw new Error('invalid configuration structure')
      return Array.isArray(data?.stores) ? data!.stores as unknown[] : []
    } catch (err) {
      if (strict && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('configuration could not be read')
      return []
    }
  },

_updateRawStores(mutate: (rawStores: unknown[]) => boolean, onConfigWrite?: (before: string | null, after: string) => void): void {
    let wrote = false
    withLock(this.paths.config, () => {
      let configData: Record<string, unknown> = {}
      let before: string | null = null
      try {
        const raw = fs.readFileSync(this.paths.config, 'utf8')
        before = raw
        if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      const rawStores = Array.isArray(configData.stores) ? [...(configData.stores as unknown[])] : []
      if (!mutate(rawStores)) return
      configData.stores = rawStores
      const after = yaml.dump(configData, { lineWidth: 120, noRefs: true })
      writeConfigFile(this.paths.config, after)
      onConfigWrite?.(before, after)
      wrote = true
    })
    if (!wrote) return
    this.config = this._loadConfig()
    this.configMtimeMs = this.statConfigMtime()
  },

async checkServerStores(opts?: { timeoutMs?: number }): Promise<ServerStoreCheck[]> {
    let entries: Array<Record<string, unknown> & { url: string }>
    try {
      const raw = this._readRawStores(true)
      for (const entry of raw) {
        if (!isPlainObject(entry) || !('enterprise' in entry)) continue
        // Loading is deliberately shape-tolerant; a diagnostic must not turn
        // discarded scope data into evidence that there is nothing to check.
        if (!isEnterpriseServerEntry(entry) || !ServerStoreEntrySchema.safeParse(entry).success ||
          !stringList(entry.scopes).every(isSafeScopeName) || stringList(entry.scopes).length !== (entry.scopes as unknown[]).length ||
          (entry.pinned_scopes !== undefined && (!Array.isArray(entry.pinned_scopes) || !entry.pinned_scopes.every(s => typeof s === 'string' && isSafeScopeName(s))))) {
          throw new Error('invalid enterprise entry')
        }
      }
      entries = raw.filter(isEnterpriseServerEntry)
    }
    catch {
      return [{ url: 'configuration', ok: false, checks: [{ name: 'key-file', result: 'could-not-check', detail: 'configuration could not be read; server checks were not run' }] }]
    }
    this.reloadConfigIfChanged()
    if (!entries.length) return []
    const timeoutMs = Math.max(1, Math.min(30_000, Math.floor(opts?.timeoutMs ?? 5000)))
    const file = checkOwnerOnly(this.paths.config)
    let queued: Awaited<ReturnType<Plur['listOutbox']>> = []
    const targets = new Map<string, string>()
    let queueFailed = !!this.remoteOnlyFolder()
    if (!queueFailed) try {
      queued = await this.listOutbox()
      if (queued.length) for (const e of await this._loadCached(this.paths.engrams)) {
        for (const [kind, field] of [['push', '_outbox'], ['retire', '_retireRemote']] as const) {
          const url = (e as any).structured_data?.[field]?.target_url
          if (typeof url === 'string') targets.set(`${kind}:${e.id}`, normalizeEndpointUrl(url))
        }
      }
    } catch { queueFailed = true }
    return Promise.all(entries.map(async entry => {
      const checks: ServerStoreCheck['checks'] = []
      const { token, tokenEnv } = serverCredential(entry)
      const endpoint = new URL(entry.url)
      const secrets = [token ?? '', entry.url, normalizeEndpointUrl(entry.url), endpoint.username, endpoint.password, ...endpoint.searchParams.values(), endpoint.hash.slice(1)]
      const scrub = (text: string) => secrets.reduce((s, secret) => secret ? redactToken(s, secret) : s, text)
      const add = (name: ServerStoreCheck['checks'][number]['name'], result: CheckResult, detail: string) => checks.push({ name, result, detail: scrub(detail) })
      const driver = new RemoteStore(entry.url, token ?? '', typeof entry.scope === 'string' ? entry.scope : '', { tokenEnv })
      const signal = AbortSignal.timeout(timeoutMs)
      let me: MeResponse | undefined
      if (!token) {
        add('reachable', 'could-not-check', 'no request sent without a key')
        add('key', 'fail', tokenEnv ? `key environment variable ${tokenEnv} is unset` : 'no key is configured')
      } else try {
        me = await driver.me(signal)
        add('reachable', 'ok', 'server answered')
        add('key', me.username && me.org_id ? 'ok' : 'could-not-check', me.username && me.org_id ? 'key accepted' : 'identity response is incomplete')
      } catch (err) {
        const http = err instanceof RemoteHttpError
        const detail = redactToken(err instanceof Error ? err.message : String(err), token)
        add('reachable', http ? 'ok' : 'fail', http ? `server answered HTTP ${err.status}` : detail)
        add('key', http && [401, 403].includes(err.status) ? 'fail' : http && err.code === 'scope_lookup_failed' ? 'ok' : 'could-not-check',
          http && err.code === 'scope_lookup_failed' ? 'key accepted; the server could not read your scopes' : detail)
      }
      add('key-file', file.ok === true ? 'ok' : file.ok === false ? 'fail' : 'could-not-check', file.ok === true ? 'credential file is owner-only' : file.detail)
      const cache = isPlainObject(entry.discovery) ? entry.discovery : {}
      const at = typeof cache.discovered_at === 'string' ? Date.parse(cache.discovered_at) : NaN
      const fresh = cache.status === 'ok' && Number.isFinite(at) && Date.now() - at <= DISCOVERY_MAX_AGE_MS && at - Date.now() <= DISCOVERY_FUTURE_SKEW_MS
      const knownScopes = me && !me.scopes_malformed && me.scopes_status === 'ok'
      add('scopes-fresh', fresh && knownScopes ? 'ok' : 'fail',
        !knownScopes ? 'the server could not confirm your scopes (missing, not synced, or unavailable)' : fresh ? 'cached scope list is current' : 'cached scope list is missing, stale, or not usable')
      const scopes = [...new Set([...stringList(entry.scopes), ...stringList(entry.pinned_scopes), ...(typeof entry.scope === 'string' ? [entry.scope] : [])])].filter(isSharedScope)
      const blocked = scopes.filter(scope => {
        const target = this._remoteWriteEntry(scope)
        return !target?.url || normalizeEndpointUrl(target.url) !== normalizeEndpointUrl(entry.url)
      })
      if (!scopes.length) add('write-path', 'ok', 'nothing to check (no team or project scopes)')
      else if (blocked.length) add('write-path', 'fail', `client routing does not select a writable path to this server for: ${blocked.join(', ')}`)
      else if (!knownScopes) add('write-path', 'could-not-check', 'scope lookup did not succeed')
      else try {
        const results = []
        for (let i = 0; i < scopes.length; i += 50) results.push(...await driver.writeCheck(scopes.slice(i, i + 50), signal))
        const refused = results.filter(r => !r.writable)
        add('write-path', refused.length ? 'fail' : 'ok', refused.length
          ? refused.map(r => `${r.scope}: ${r.reason ?? 'not writable'}`).join('; ')
          : results.some(r => r.review_held) ? 'writable; held for review where required' : 'all configured shared scopes are writable')
      } catch (err) { add('write-path', 'could-not-check', redactToken(err instanceof Error ? err.message : String(err), token ?? '')) }
      const waiting = queued.filter(e => {
        const current = e.kind === 'push' ? this._remoteWriteEntry(e.target_scope)?.url : undefined
        const target = current ? normalizeEndpointUrl(current) : targets.get(`${e.kind}:${e.id}`)
        return target === normalizeEndpointUrl(entry.url)
      })
      const dates = waiting.map(e => e.queued_at).filter(d => Number.isFinite(Date.parse(d))).sort()
      add('queue', queueFailed ? 'could-not-check' : waiting.length ? 'fail' : 'ok', queueFailed ? 'could not read the queued saves'
        : waiting.length ? `${waiting.length} queued operation(s), oldest ${dates[0]?.slice(0, 10) ?? 'unknown date'}` : 'no queued saves')
      return { url: redactToken(safeOrigin(entry.url), token ?? ''), checks, ok: checks.every(c => c.result === 'ok') }
    }))
  },

_enterpriseRecoveryEndpoint(url: string): boolean {
    const key = normalizeEndpointUrl(url)
    const entries = this._readRawStores().filter(s => isPlainObject(s) && typeof s.url === 'string' && normalizeEndpointUrl(s.url) === key)
    // Host-level outcomes cannot distinguish two keys on the same endpoint.
    // Do not promise enterprise setup repairs a retained legacy credential.
    return entries.length > 0 && entries.every(isEnterpriseServerEntry)
  },

remoteTokenExpiries(now: number = Date.now()): Array<{ url: string; scopes: string[]; enterprise?: boolean; expiresAt: string | null; expiresInDays: number | null; expired: boolean }> {
    return this._distinctRemoteEndpoints().map(({ url, token }) => {
      const scopes = this._storesForEndpoint(url).map(s => s.scope)
      const exp = decodeJwtExpiry(token, now)
      return {
        url, scopes,
        ...(this._enterpriseRecoveryEndpoint(url) ? { enterprise: true } : {}),
        expiresAt: exp.expiresAt ? exp.expiresAt.toISOString() : null,
        expiresInDays: exp.expiresInDays,
        expired: exp.expired,
      }
    })
  },

async checkRemoteHealth(opts?: { timeoutMs?: number }): Promise<RemoteHealth[]> {
    const timeoutMs = opts?.timeoutMs ?? 5000
    // Decode the token that is on DISK now, not the one read at construction:
    // reporting an expiry from a stale in-memory copy of a credential the
    // user has since rotated would send them to fix the server.
    this.reloadConfigIfChanged()
    const groups = this.remoteEndpointTokenGroups()
    return Promise.all(groups.map(async ({ url, token, scopes, tokenEnv }) => {
      // The token's variable is unset — say so, send nothing.
      if (!token && tokenEnv) {
        return { url, scopes, status: 'auth_expired' as const, ok: false, tokenEnvUnset: tokenEnv,
          reason: tokenEnvUnsetMessage(tokenEnv, scopes[0] ?? url) }
      }
      const exp = decodeJwtExpiry(token)
      const payload = decodeJwtPayload(token)
      const subject = typeof payload?.sub === 'string' ? payload.sub : undefined
      const orgClaim = [payload?.orgId, payload?.org_id, payload?.org]
        .find((v): v is string => typeof v === 'string')
      const expiryFields = {
        ...(this._enterpriseRecoveryEndpoint(url) ? { enterprise: true } : {}),
        tokenExpiresAt: exp.expiresAt ? exp.expiresAt.toISOString() : undefined,
        tokenExpiresInDays: exp.expiresInDays,
        ...(subject !== undefined ? { tokenSubject: subject } : {}),
        ...(orgClaim !== undefined ? { tokenOrg: orgClaim } : {}),
      }
      // A JWT we can already see is expired → don't bother probing; it's auth_expired.
      if (exp.expired) {
        return { url, scopes, status: 'auth_expired' as const, ok: false,
          reason: `token expired ${exp.expiresAt?.toISOString() ?? ''}`.trim(), ...expiryFields }
      }
      try {
        const me = await this._probeMe(url, token, timeoutMs, scopes[0] ?? '')
        // A host that just answered /me is not unreachable — retire any cached
        // network-class recall failure for it rather than reporting both.
        this.noteRemoteHostReachable(url)
        this._noteMeIdentity(url, token, me)
        return { url, scopes, status: 'ok' as const, ok: true,
          ...(me.username ? { username: me.username } : {}),
          ...(me.org_id ? { orgId: me.org_id } : {}),
          grantedScopes: me.scopes.length,
          ...expiryFields }
      } catch (err) {
        this._noteMeIdentity(url, token, null)
        const msg = err instanceof Error ? err.message : String(err)
        const isAuth = /\b40[13]\b/.test(msg)
        return { url, scopes, status: (isAuth ? 'auth_expired' : 'unreachable') as RemoteHealth['status'],
          ok: false, reason: msg, ...expiryFields }
      }
    }))
  },

async registerDiscoveredScopes(opts?: { url?: string; timeoutMs?: number }): Promise<RegisterDiscoveredResult[]> {
    const discoveries = await this.discoverRemoteScopes(opts)
    const results = discoveries.map(d => {
      if (!d.ok) return { url: d.url, ok: false, added: [], already_registered: [], skipped: [], error: d.error }
      // The sibling's token_env travels with its token, or the new
      // entry would store the value the reference was resolved to.
      const sibling = this._storesForEndpoint(d.url)[0]
      const token = sibling?.token
      const tokenEnv = sibling?.token_env
      const added: string[] = []
      const already: string[] = []
      const skipped: string[] = []
      // Dismissals gate the batch path: `plur_scopes_discover register:true`
      // must not override a recorded opt-out by registering a scope the user
      // explicitly dismissed. The per-scope {@link registerScope} remains the
      // deliberate override (it registers AND clears the dismissal).
      // Case-insensitive, matching the discover-time filter.
      const dismissed = this._dismissedScopeKeys()
      // Attempt every non-dismissed authorized scope (not just the pre-computed
      // unregistered set) and let addStore's url+scope idempotency classify
      // each — so the result is accurate even if config changed between
      // discover and now.
      for (const scope of d.authorized) {
        if (dismissed.has(scope.toLowerCase()) && !d.registered.includes(scope)) {
          // Dismissed and not currently registered → the batch path must not
          // register it. (A registered scope stays reported as
          // already_registered even if a stale dismissal lingers.)
          skipped.push(scope)
          logger.info(`[plur] skipping dismissed scope "${scope}" from ${safeOrigin(d.url)} — batch register respects dismissals; use \`plur scopes register ${scope}\` to override (it also clears the dismissal)`)
          continue
        }
        // SECURITY: never auto-register a PERSONAL-family scope returned
        // by `/me` as a writable remote store. A compromised/MITM'd endpoint can
        // claim `scopes:['global','user:<victim>','local']`; registering those
        // makes the hostile server the routing target for the user's default and
        // unscoped writes. Only shared-family scopes (group:/project:/space:/
        // team:/org:/public) are auto-registered. A genuine remote-backed
        // personal scope must be added deliberately via `plur stores add`.
        if (!isSharedScope(scope)) {
          skipped.push(scope)
          logger.warning(
            `[plur] refused to auto-register non-shared scope "${scope}" from ${safeOrigin(d.url)} — ` +
            `a /me-advertised personal-family scope is not auto-registered (it would route ` +
            `your default/unscoped writes to that endpoint). Add it explicitly if intended.`,
          )
          continue
        }
        try {
          const { status } = this.addStore('', scope, { url: d.url, token, ...(tokenEnv ? { tokenEnv } : {}) })
          if (status === 'added') added.push(scope)
          else already.push(scope)
        } catch (err) {
          // A single bad/conflicting scope (e.g. one already bound to a
          // DIFFERENT endpoint → addStore throws) must NOT abort the whole batch
          // and leave a partial registration. Record it as skipped and continue
          // with the remaining authorized scopes.
          skipped.push(scope)
          logger.warning(`[plur] could not auto-register scope "${scope}" from ${safeOrigin(d.url)}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return { url: d.url, ok: true, added, already_registered: already, skipped }
    })
    // Persist covers/description/sensitivity for all registered scopes
    this.persistScopeMetadata(discoveries)
    return results
  },

async offerableScopes(opts?: { url?: string; timeoutMs?: number }): Promise<{
    scopes: Array<{ scope: string; url: string; description?: string }>
    failures: Array<{ url: string; error?: string }>
  }> {
    const discoveries = await this.discoverRemoteScopes(opts)
    const seen = new Set<string>()
    const scopes: Array<{ scope: string; url: string; description?: string }> = []
    const failures: Array<{ url: string; error?: string }> = []
    for (const d of discoveries) {
      if (!d.ok) {
        failures.push({ url: d.url, error: d.error })
        continue
      }
      for (const scope of d.unregistered) {
        if (!isSharedScope(scope) || seen.has(scope)) continue
        seen.add(scope)
        const meta = d.metadata.find(m => m.scope === scope)
        scopes.push({ scope, url: d.url, description: meta?.description })
      }
    }
    return { scopes, failures }
  },

async registerScope(scope: string, opts?: { url?: string; timeoutMs?: number }): Promise<{ url: string; status: 'added' | 'already_registered' | 'overwritten' | 'token_rotated' }> {
    if (!isSharedScope(scope)) {
      throw new Error(`refusing to register non-shared scope "${scope}" — only shared-family scopes (group:/project:/space:/team:/org:/public) can be registered from discovery; add a personal-backed store explicitly with \`plur stores add\``)
    }
    const discoveries = await this.discoverRemoteScopes(opts?.url ? { url: opts.url, timeoutMs: opts?.timeoutMs } : { timeoutMs: opts?.timeoutMs })
    const match = discoveries.find(d => d.ok && d.authorized.includes(scope))
    if (!match) {
      const failed = discoveries.filter(d => !d.ok).map(d => d.url)
      throw new Error(`scope "${scope}" is not authorized on any configured remote${failed.length ? ` (could not reach: ${failed.join(', ')})` : ''}`)
    }
    const sibling = this._storesForEndpoint(match.url)[0]
    const token = sibling?.token
    const { status } = this.addStore('', scope, { url: match.url, token, ...(sibling?.token_env ? { tokenEnv: sibling.token_env } : {}) })
    // Persist covers/description/sensitivity so suggestScope activates.
    this.persistScopeMetadata(discoveries)
    // Registering a scope also clears any prior dismissal of it —
    // case-insensitively, so a case-variant dismissal can't linger and
    // re-suppress the scope from future offers.
    if ((this.config.dismissed_scopes ?? []).some(s => s.toLowerCase() === scope.toLowerCase())) {
      this.persistDismissedScopes((this.config.dismissed_scopes ?? []).filter(s => s.toLowerCase() !== scope.toLowerCase()))
    }
    return { url: match.url, status }
  },

dismissScope(scope: string): void {
    const current = this.config.dismissed_scopes ?? []
    // Case-insensitive membership: dismissing `Group:x` when `group:x` is
    // already recorded must stay a no-op, not a duplicate.
    if (current.some(s => s.toLowerCase() === scope.toLowerCase())) return
    this.persistDismissedScopes([...current, scope])
  },

_dismissedScopeKeys(): Set<string> {
    return new Set((this.config.dismissed_scopes ?? []).map(s => s.toLowerCase()))
  },

reofferScopes(): void {
    this.persistDismissedScopes([])
  },

getDismissedScopes(): string[] {
    return [...(this.config.dismissed_scopes ?? [])]
  },

persistDismissedScopes(list: string[]): void {
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const s of list) {
      const key = s.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(s)
    }
    withLock(this.paths.config, () => {
      let configData: Record<string, unknown> = {}
      try {
        const raw = fs.readFileSync(this.paths.config, 'utf8')
        if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      configData.dismissed_scopes = deduped.sort()
      // Atomic + fsynced. A plain writeFileSync truncates in place, and
      // loadConfig turns a parse failure into DEFAULT config — so a crash
      // mid-write would silently erase store registrations and route later
      // writes to the local default store. atomicWrite is tmp + fsync +
      // rename, so a crash leaves the previous complete config.
      writeConfigFile(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }))
    })
    this.config = this._loadConfig()
    this.configMtimeMs = this.statConfigMtime()
  },

persistScopeMetadata(discoveries: RemoteScopeDiscovery[], onConfigWrite?: (before: string | null, after: string) => void): void {
    // Raw config, not this.config: the in-memory list drops ignored duplicate
    // local entries, and writing it back would delete them from disk.
    const stores = loadConfig(this.paths.config).stores ?? []
    if (!stores.length) return

    let changed = false
    const serverSensitivityScopes = new Set<string>()
    const updated = stores.map(entry => {
      if (!entry.url) return entry                  // local store — no server metadata
      if (!isSharedScope(entry.scope)) return entry // never write covers to personal scopes
      // Endpoint identity is normalized: a discovery for https://x.com must
      // match an entry configured as https://x.com/sse.
      const discovery = discoveries.find(d => d.ok && normalizeEndpointUrl(d.url) === normalizeEndpointUrl(entry.url!))
      if (!discovery?.metadata.length) return entry
      const meta = discovery.metadata.find(m => m.scope === entry.scope)
      if (!meta) return entry

      // What WILL be persisted (trust rule above): server covers/description
      // verbatim; sensitivity = local entry's policy (incl. any hand-edited
      // `allow` + nested unknowns) with only `forbid` taken from the server,
      // sanitized to the category enum. No server sensitivity → local untouched.
      const nextSensitivity = meta.sensitivity !== undefined
        ? { ...(entry.sensitivity ?? { allow: [] }), forbid: sanitizeForbidCategories(meta.sensitivity.forbid) }
        : entry.sensitivity
      const nextCovers = meta.covers !== undefined ? meta.covers : entry.covers
      const nextDescription = meta.description !== undefined ? meta.description : entry.description

      // Only write when the PERSISTED value would differ — comparing the raw
      // server payload instead never converges once a field (e.g. `allow`) is
      // deliberately not persisted. stableJson keeps the compare
      // key-order-insensitive across spread/re-parse round-trips.
      const coversMatch = stableJson(nextCovers) === stableJson(entry.covers)
      const descMatch = nextDescription === entry.description
      const sensMatch = stableJson(nextSensitivity) === stableJson(entry.sensitivity)
      if (coversMatch && descMatch && sensMatch) return entry

      // Server-authoritative overwrite is by design — but overwriting a
      // DIFFERENT non-empty local value must be visible, not silent: a
      // hand-set covers/description vanishing with no trace looks like data
      // loss.
      const clobbered: string[] = []
      if (!coversMatch && (entry.covers?.length ?? 0) > 0) clobbered.push('covers')
      if (!descMatch && entry.description !== undefined && entry.description !== '') clobbered.push('description')
      if (clobbered.length) {
        logger.warning(`[plur:scope-metadata] scope "${entry.scope}": overwriting local ${clobbered.join(' + ')} with server values from ${safeOrigin(discovery.url)} (server-authoritative)`)
      }

      changed = true
      if (!sensMatch) serverSensitivityScopes.add(entry.scope)
      return {
        ...entry,
        ...(nextCovers !== undefined ? { covers: nextCovers } : {}),
        ...(nextDescription !== undefined ? { description: nextDescription } : {}),
        ...(nextSensitivity !== undefined ? { sensitivity: nextSensitivity } : {}),
      }
    })

    if (changed) this.persistStores(updated, { serverSensitivityScopes, onConfigWrite })
  },

setSessionScope(scope: string | null, opts?: { session?: string }): void {
    this._sessionScopes.set(scope, opts?.session)
  },

adjustSessionScope(scope: string | null, opts?: { session?: string; reason?: string; trigger?: 'set' | 'clear' }): { previous: string | null; next: string | null } {
    const previous = this._sessionScopes.get(opts?.session)
    this._sessionScopes.set(scope, opts?.session)
    this._appendHistory({
      event: 'session_scope_changed',
      engram_id: '', // session-level event — no engram (see HistoryEvent doc)
      timestamp: new Date().toISOString(),
      data: {
        previous,
        next: scope,
        ...(opts?.trigger ? { trigger: opts.trigger } : {}),
        ...(opts?.reason ? { reason: opts.reason } : {}),
        ...(opts?.session ? { session_id: opts.session } : {}),
      },
    })
    return { previous, next: scope }
  },

getSessionScope(opts?: { session?: string }): string | null {
    return this._sessionScopes.get(opts?.session)
  },

clearSessionScope(opts?: { session?: string }): void {
    this._sessionScopes.clear(opts?.session)
  },

trackedSessionScopes(): string[] {
    return this._sessionScopes.trackedSessions
  },
}
