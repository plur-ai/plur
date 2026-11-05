import * as fs from 'fs'
import { join } from 'path'
import { resolveBackendTier, type BackendSelection } from '../backend-selection.js'
import { maybeDailyBackup } from '../backup.js'
import { loadAllPacks, namespaceEngramId, namespacePackEngrams, packEngramId, type LoadedPack } from '../engrams.js'
import { computeQueryHash, mintedIdsWithPrefix, readHistoryForEngram } from '../history.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { withoutRemoteOnlyQueued } from '../remote-only-rows.js'
import {
    stampStoreRow
} from '../remote-recall.js'
import { collapseLineTerminators } from '../sanitize.js'
import type { StoreEntry } from '../schemas/config.js'
import type { Engram } from '../schemas/engram.js'
import { ATTRIBUTION_UNIDENTIFIED } from '../schemas/engram.js'
import { isScopeWithin } from '../scope-util.js'
import { recordSeenOnServer, seenOnServer } from '../seen-on-server.js'
import { buildSessionManifest, verifySessionManifest, type ManifestVerification, type SessionManifest } from '../session-manifest.js'
import type { AsyncPrimaryStore } from '../store/primary-store.js'
import { ReadonlyStoreError, ReadonlyStoreGuard } from '../store/readonly-store-guard.js'
import { RemoteOnlyStoreGuard } from '../store/remote-only-store-guard.js'
import { RemoteHttpError } from '../store/remote-store.js'
import { YamlPrimaryStore } from '../store/yaml-primary-store.js'
import { REMOTE_GUARD_BUDGET_MS, REMOTE_PROBE_TIMEOUT_MS } from './helpers.js'
import { type CollisionProbe } from './types.js'

export interface StoreIoMethods {
  /**
   * Record what a recall returned to a session, for the session manifest. Called by
   * the surfaces that answer an agent's recall (MCP, CLI), not by `recall()` itself.
   * Ids and a query hash only; never the query text. Best-effort: returns whether written.
   */
  recordRecall(input: { session_id?: string; ids: readonly string[]; query: string; source?: 'recall' | 'recall_hybrid' }): boolean

  /**
   * The session memory manifest: which engrams were in this session's
   * context, with hashes that can be checked later. Local and offline.
   */
  sessionManifest(sessionId: string, opts?: { checkpoint?: SessionManifest['checkpoint'] }): Promise<SessionManifest>

  /** Where session manifests are anchored. `off` unless the user turned it on. */
  receiptsConfig(): { store: 'off' | 'swarm'; gateway_url?: string; stamp_id?: string }

  /** Re-hash every engram a manifest lists against this store. */
  verifyManifest(manifest: SessionManifest): Promise<ManifestVerification>

  /**
   * Resolve the active storage tier. Order:
   *   1. `PLUR_BACKEND` env var (yaml|sqlite|pglite|postgres)
   *   2. config.yaml `backend` field
   *   3. the size of the store — see `backend-selection.ts` / ADR-0005
   *
   * The estimate comes from `PrimaryStore.estimateCount()` — a `stat()`, not a
   * parse. Deciding which backend to build must not cost what the wrong backend
   * would have cost.
   */
  /** @internal */
  _resolveBackend(): BackendSelection

  /** Configured Postgres DSN, env first. Never logged unredacted. */
  /** @internal */
  _postgresUrl(): string | undefined

  /**
   * How this instance's storage tier was chosen — tier, reason, the estimate it
   * was made from, and (when the size estimate wanted a tier it could not have)
   * `wanted`. Diagnostics: a deployment should never have to guess which
   * backend it is on or why.
   */
  backendSelection(): BackendSelection

  /** @internal */
  _autoPurgeLegacyTensions(startDir: string): Promise<void>

  /**
   * Load engrams from primary store + all configured stores, with mtime-based caching.
   * Store engram IDs get namespaced: ENG-2026-0401-001 → ENG-DF-2026-0401-001.
   * Primary engrams are returned unchanged.
   */
  /** @internal */
  _loadAllEngrams(): Promise<Engram[]>

  /**
   * The corpus a WRITE dedups against. Everything, except in a remote-only
   * folder: there the folder's read corpus plus this scope's own queued rows,
   * so a team save is never matched to (or credited on) a personal engram.
   */
  /** @internal */
  _writeDedupCorpus(scope: string): Promise<Engram[]>

  /**
   * The corpus the READ paths (recall, inject) rank. Everything, except in a
   * remote-only folder: there it is the cached
   * rows of the folder's team store plus installed packs, never the personal
   * primary store or a local secondary store. Write paths keep
   * `_loadAllEngrams` — they need the primary corpus for ids and dedup.
   */
  /** @internal */
  _readCorpus(): Promise<Engram[]>

  /**
   * Non-primary rows (secondary file and url stores, packs) must all go through one
   * implementation: ids collide across stores, and `feedback()` / `forget()` resolve by
   * exact id, so skipping namespacing, `global` narrowing or `isScopeWithin` makes them change an
   * unrelated engram. Kept separate from the primary load because BM25 reaches these rows without it.
   */
  /**
   * Installed packs, each row under its pack id ({@link packEngramId}) on every read path,
   * never its author's id — which could equal one of the user's own memory ids.
   */
  /** @internal */
  _loadInstalledPacks(): LoadedPack[]

  /** @internal */
  _loadSecondaryAndPacks(opts?: { remoteOnlyScope?: string | null }): Promise<Engram[]>

  /**
   * Cached read from the store that owns `path`.
   *
   * Caching is the store's job (`YamlPrimaryStore` tracks mtime) — a cache is
   * a property of the backing medium, not of the caller, and a store whose
   * medium has no mtime (memory, Postgres) answers `loadCached()` its own way.
   */
  /** @internal */
  _loadCached(path: string): Promise<Engram[]>

  /**
   * What the ambiguity guards (forget, feedback) may conclude from a store's cache
   * without a network call:
   * - `present`: the cache holds the id — a collision, refuse.
   * - `absent`: ONLY for a complete load younger than the TTL (a cold-cache `append()`
   *   seed or a stale cache proves nothing).
   * - `unknown`: cold, empty, partial or stale — the caller probes live.
   * Model: spec/formal/PlurSpec/R2CoreA.lean §2 (`peek_absent_sound`).
   */
  /** @internal */
  _remoteCacheAnswer(store: StoreEntry, serverId: string): 'present' | 'absent' | 'unknown'

  /**
   * Does a bare id ALSO name an engram in a configured url store? (Ids are minted per store.)
   * Runs WITHOUT the store lock so a hanging server cannot block writers; bounded by
   * REMOTE_PROBE_TIMEOUT_MS per probe and REMOTE_GUARD_BUDGET_MS overall. Outcomes:
   *   - `present`: ambiguous — every caller refuses.
   *   - `auth_rejected` (401/403): the bare id can only mean the local row.
   *   - `unreachable`: forget refuses (irreversible); feedback and pin warn and proceed.
   */
  /** @internal */
  _hasUrlStore(): boolean

  /** @internal */
  _probeIdCollisions(id: string, opts?: { skipLive?: boolean }): Promise<CollisionProbe[]>

  /**
   * Local evidence that a bare id has also named a server engram (a 401/403 probe does
   * not prove there is none): a history event routed to a remote (excluding the
   * deferred-push record), the outbox id map, or any url store's cached rows.
   * Returns a description of the first evidence found, or null. No network.
   */
  /** @internal */
  _idSeenRemotely(id: string): string | null

  /**
   * The refusal when a store rejected the token AND this machine has met the
   * id remotely: the bare id may name that store's engram.
   */
  /** @internal */
  _rejectedTokenRefusal(p: CollisionProbe, id: string, evidence: string, verb: string, localHint: string): Error

  /** Remember server ids (best effort, never throws). */
  /** @internal */
  _noteSeenOnServer(entries: Array<{ id: string; scope: string }>): void

  /** Remember the server ids of team rows among recall/inject results. */
  /** @internal */
  _noteSeenRows(rows: readonly Engram[], allRemote?: boolean): void

  /** A local row being rewritten into a url-backed scope it was not in. */
  /** @internal */
  _isScopeMoveIntoRemote(localScope: string, targetScope: string): boolean

  /** {@link _idSeenRemotely} plus a fresh cache hit — the no-network twin check. */
  /** @internal */
  _cachedTwinEvidence(id: string): string | null

  /** @internal */
  _scopeMoveRefusal(updated: Engram, localScope: string, twin: string): Error

  /** The warning for a store whose token was rejected during a collision probe. */
  /** @internal */
  _rejectedTokenWarning(p: CollisionProbe, id: string, acted: string): string

  /**
   * forget()'s reading of the collision probe. Retiring is
   * irreversible, so "cannot tell" refuses; a rejected token does not, since
   * this caller cannot retire anything in that store either.
   */
  /** @internal */
  _decideForgetProbes(id: string, probes: CollisionProbe[], warnings: string[]): void

  /**
   * feedback()'s reading of the collision probe. Same as
   * forget() except that "cannot tell" rates the local engram with a warning.
   */
  /** @internal */
  _decideFeedbackProbes(id: string, probes: CollisionProbe[], warnings: string[]): void

  /** @internal */
  _loadRemoteCached(store: StoreEntry): Engram[]

  /**
   * Persist engrams to the store that owns `path`.
   *
   * The store invalidates its own cache on write (`PrimaryStore.save()`).
   * `YamlPrimaryStore.loadCached()` uses mtime-based invalidation, and on some
   * filesystems (e.g. tmpfs) mtime resolution is coarse enough that a stat()
   * before and after a write returns the same mtime, so the cache would serve
   * a pre-write snapshot. Invalidating on write removes the filesystem as a
   * source of cache freshness.
   */
  /** @internal */
  _writeEngrams(path: string, engrams: Engram[], opts?: { allowShrink?: boolean }): Promise<void>

  /**
   * Persist one brand-NEW engram to the primary store. `corpus` is the caller's
   * already-loaded corpus held under `_withStoreLock`; the engram is pushed into it.
   * `append`-capable stores get a single-row INSERT, others one `save()` of the corpus
   * in hand — never a re-load.
   */
  /** @internal */
  _appendEngram(corpus: Engram[], engram: Engram): Promise<void>

  /**
   * Persist in-place mutations: `updateMany` (an upsert, so a vanished row is re-inserted)
   * when available, else a whole-corpus `save()` of the corpus in hand.
   */
  /**
   * Read primary-store rows for `ids`, targeted only when `loadByIds` AND `updateMany` exist:
   * `_updateEngrams` otherwise does a full replace, and a subset would delete everything else.
   */
  /** @internal */
  _loadTargeted(ids: string[]): Promise<Engram[]>

  /** @internal */
  _updateEngrams(corpus: Engram[], changed: Engram[]): Promise<void>

  /**
   * Throw {@link ReadonlyStoreError} when this instance was opened with
   * `readonly: true`. Called at the top of every public mutator, BEFORE any
   * routing: remote-routed writes (learnRouted's server POST, outbox flush,
   * remote feedback/forget) never touch the guarded PrimaryStore, so the
   * store guard alone cannot stop them — this gate is what does.
   */
  /** @internal */
  _assertWritable(): void

  /**
   * Snapshot the primary store once per process per day, INSIDE the lock and BEFORE
   * `fn` runs, so the copy is of the pre-write bytes and never half-written.
   * Only the writable primary store (secondary stores are not ours to protect).
   * Never throws: a failed snapshot warns and the write proceeds.
   */
  /** @internal */
  _maybeDailyBackup(path: string): void

  /**
   * Ids this store has minted today that are no longer in the corpus.
   *
   * Read from the append-only history log, which — unlike the corpus — never
   * forgets. See `mintedIdsWithPrefix` for why an incomplete answer is safe.
   */
  /** @internal */
  _mintedTodayIds(): string[]

  /** Record an id this process just minted, so the next allocation sees it
   *  without re-reading history. */
  /** @internal */
  _rememberMintedId(id: string): void

  /** @internal */
  _storeAt(path: string): AsyncPrimaryStore

  /**
   * Ids a new local row must not take: those minted this process, plus — while
   * bound, when the store shows only queued saves — every id the primary store
   * holds (ids only, never content).
   */
  /** @internal */
  _idsInUse(): Promise<string[]>
}

export const storeIoMethods: StoreIoMethods & ThisType<Plur> = {
  recordRecall(input: { session_id?: string; ids: readonly string[]; query: string; source?: 'recall' | 'recall_hybrid' }): boolean {
    if (!input.session_id || input.ids.length === 0) return false
    return this._appendHistory({
      event: 'recall_returned',
      engram_id: '',
      timestamp: new Date().toISOString(),
      data: {
        ids: [...input.ids],
        query_hash: computeQueryHash(input.query),
        source: input.source ?? 'recall',
        session_id: input.session_id,
      },
    })
  },

  async sessionManifest(sessionId: string, opts?: { checkpoint?: SessionManifest['checkpoint'] }): Promise<SessionManifest> {
    return buildSessionManifest({
      root: this.paths.root,
      sessionId,
      actor: this._configuredIdentity() ?? ATTRIBUTION_UNIDENTIFIED,
      engrams: await this._loadAllEngrams(),
      checkpoint: opts?.checkpoint,
    })
  },

  receiptsConfig(): { store: 'off' | 'swarm'; gateway_url?: string; stamp_id?: string } {
    const r = (this.config as { receipts?: { store?: 'off' | 'swarm'; gateway_url?: string; stamp_id?: string } }).receipts
    return {
      store: r?.store === 'swarm' ? 'swarm' : 'off',
      ...(r?.gateway_url ? { gateway_url: r.gateway_url } : {}),
      ...(r?.stamp_id ? { stamp_id: r.stamp_id } : {}),
    }
  },

  async verifyManifest(manifest: SessionManifest): Promise<ManifestVerification> {
    return verifySessionManifest(manifest, await this._loadAllEngrams())
  },

  _resolveBackend(): BackendSelection {
    return resolveBackendTier({
      env: process.env.PLUR_BACKEND,
      config: (this.config as { backend?: string }).backend,
      engramCount: this._primaryStore.estimateCount?.() ?? 0,
      postgresConfigured: Boolean(this._postgresUrl()),
    })
  },

  _postgresUrl(): string | undefined {
    const env = process.env.PLUR_POSTGRES_URL
    if (env) return env
    return (this.config as { postgres?: { url?: string } }).postgres?.url
  },

  backendSelection(): BackendSelection {
    return this._backendSelection
  },

  async _autoPurgeLegacyTensions(startDir: string): Promise<void> {
    // A read-only instance must not run a write migration — and must not stamp
    // the sentinel either, or the purge would be recorded as done without ever
    // having happened. Left for the next writable instance to perform.
    if (this._readonly) return
    const sentinel = join(this.paths.root, '.tensions-purged')
    if (fs.existsSync(sentinel)) return
    // Starting in a folder where memory is off touches no memory: the
    // migration reads every store and stamps the sentinel, so it is left,
    // unstamped, for the next start outside that folder.
    if (this._startFolderOff(startDir)) return
    // After the constructor's caller had its turn to bind the instance: a
    // remote-only binding then refuses the purge, and it
    // is left for the next unbound instance.
    await Promise.resolve()
    if (this._boundFolder) return
    try {
      const result = await this.purgeTensions()
      if (result.purged_count > 0) {
        logger.info(`[plur] Auto-purged ${result.purged_count} legacy tension refs from ${result.engrams_modified} engrams across ${result.stores_cleaned} stores`)
      }
      fs.writeFileSync(sentinel, new Date().toISOString() + '\n', 'utf8')
    } catch {
      // Non-fatal — purge will retry next startup
    }
  },

  async _loadAllEngrams(): Promise<Engram[]> {
    // remote-only: the folder's queued saves (the guarded primary store shows
    // only those) plus its read corpus — never a personal url store's cache.
    if (this._remoteOnly) return [...(await this._loadCached(this.paths.engrams)), ...(await this._readCorpus())]
    const primary = await this._loadCached(this.paths.engrams)
    // Unbound, a queued remote-only save is not read at all: it is another folder's team memory, waiting to be delivered, and
    // reading it would hand it to recall, dedup, tensions or a model here.
    // The outbox, flush, forget and update reach it through the primary store.
    return withoutRemoteOnlyQueued([...primary, ...(await this._loadSecondaryAndPacks())])
  },

  async _writeDedupCorpus(scope: string): Promise<Engram[]> {
    if (!this._remoteOnly) return await this._loadAllEngrams()
    // Only rows QUEUED for delivery to this scope: a
    // primary row that merely carries the team scope may be private, written
    // before the store existed, or have had its delivery cancelled — it is
    // personal memory, and a team save must never be absorbed into it.
    // (An explicitly private write never carries `_outbox`: it is kept local
    // by design — so requiring the queue marker excludes it too.)
    const queued = (await this._loadCached(this.paths.engrams)).filter(e => e.scope === scope &&
      !!(e as any).structured_data?._outbox)
    return [...queued, ...(await this._readCorpus())]
  },

  async _readCorpus(): Promise<Engram[]> {
    if (!this._remoteOnly) return await this._loadAllEngrams()
    if (this._remoteOnly.blocked) return []
    // A scope that is not a deliverable team scope (a hand-written `user:`
    // one) reads packs only.
    const ro = this._remoteOnly.scope
    return await this._loadSecondaryAndPacks({ remoteOnlyScope: ro && this._isDeliverableTeamScope(ro) ? ro : null })
  },

  _loadInstalledPacks(): LoadedPack[] {
    return loadAllPacks(this.paths.packs).map(pack => ({
      ...pack,
      engrams: namespacePackEngrams(pack.engrams, pack.manifest.name),
    }))
  },

  async _loadSecondaryAndPacks(opts?: { remoteOnlyScope?: string | null }): Promise<Engram[]> {
    // remote-only: only the url store(s) serving the folder's team scope — no
    // secondary file store, which is this machine's disk like the primary.
    const remoteOnly = opts !== undefined && 'remoteOnlyScope' in opts
    const stores = (this.config.stores ?? []).filter(s => !remoteOnly || (!!s.url && s.scope === opts!.remoteOnlyScope))
    const all: Engram[] = []
    for (const store of stores) {
      const storeEngrams = store.url
        ? this._loadRemoteCached(store)
        : await this._loadCached(store.path!)
      for (const e of storeEngrams) {
        // Scope validation, segment-aware: a sibling that is a
        // mere string-prefix of the store scope (group:plur/eng-private under a
        // group:plur/eng store) must NOT load.
        if (e.scope !== 'global' && !isScopeWithin(e.scope, store.scope)) {
          logger.debug(`Skipping engram ${e.id} from store ${store.scope}: scope mismatch (${e.scope})`)
          continue
        }

        // The same stamp as the remote recall leg: drop `_`-prefixed keys the
        // row ships (a forged `_pack` would make a store row pass as pack
        // content), narrow `global` to the store scope, and namespace the id
        // IDEMPOTENTLY, so one row gets the same id here as on the recall leg.
        const cloned = stampStoreRow(e, store.scope) as any
        // Which store served the row, not just its scope: several stores may
        // share one scope (a url store and a path store both load), and
        // delivery reporting must classify by the one that held the row. A
        // boolean, not the url: every field of a loaded row is content-scanned
        // on the explicit-update path, and a url is not content. Set AFTER the
        // stamp, which drops `_`-prefixed keys a row ships.
        if (store.url) {
          cloned._fromRemoteStore = true
          this._heldBy.set(cloned, store.url)
        }
        all.push(cloned)
      }
    }

    // Include pack engrams so they're searchable via recall
    const packs = this._loadInstalledPacks()
    for (const pack of packs) {
      for (const e of pack.engrams) {
        if (e.status !== 'active') continue
        // A pack row cannot ship loader markers (`_storeScope`, `_originalId`,
        // its own `_pack`): only this loader stamps them.
        const cloned = Object.fromEntries(
          Object.entries(e as unknown as Record<string, unknown>).filter(([k]) => !k.startsWith('_')),
        ) as any
        cloned._pack = pack.manifest.name
        // Sanitise HERE, where pack content enters the injection corpus: pack install
        // bypasses learn()/learnRouted(), so a forged boundary would otherwise get through.
        // Load time, not install time, so hand-placed or synced packs are covered too —
        // this is the last gate before injection.
        for (const f of ['statement', 'rationale', 'source', 'summary', 'domain'] as const) {
          if (typeof cloned[f] === 'string') cloned[f] = collapseLineTerminators(cloned[f])
        }
        all.push(cloned)
      }
    }

    // A queued remote-only save held in a secondary file store is never a
    // candidate either: same rule as the primary.
    return withoutRemoteOnlyQueued(all)
  },

  async _loadCached(path: string): Promise<Engram[]> {
    return await this._storeAt(path).loadCached()
  },

  _remoteCacheAnswer(store: StoreEntry, serverId: string): 'present' | 'absent' | 'unknown' {
    const driver = this._getRemoteDriver({ url: store.url!, token: store.token, scope: store.scope })
    const view = driver as unknown as { cache: { ts: number; engrams: Engram[] } | null; ttlMs?: number }
    const cache = view.cache
    if (!cache || cache.engrams.length === 0) return 'unknown'
    if (cache.engrams.some(e => e.id === serverId)) return 'present'
    const ttl = typeof view.ttlMs === 'number' ? view.ttlMs : 60_000
    const age = Date.now() - cache.ts
    return cache.ts > 0 && age >= 0 && age < ttl ? 'absent' : 'unknown'
  },

  _hasUrlStore(): boolean {
    return (this.config.stores ?? []).some(s => !!s.url)
  },

  async _probeIdCollisions(id: string, opts?: { skipLive?: boolean }): Promise<CollisionProbe[]> {
    const out: CollisionProbe[] = []
    const deadline = Date.now() + REMOTE_GUARD_BUDGET_MS
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      // remote-only: a personal or non-team url store is out of reach.
      if (this._remoteOnly && !this._remoteOnlyWalkAllows(entry.scope)) continue
      const scope = entry.scope ?? entry.url
      const serverId = this._stripRemotePrefix(id, entry.scope)
      const peek = this._remoteCacheAnswer(entry, serverId)
      if (peek !== 'unknown') { out.push({ scope, url: entry.url, outcome: peek }); continue }
      if (opts?.skipLive) { out.push({ scope, url: entry.url, outcome: 'absent' }); continue }
      const left = deadline - Date.now()
      if (left <= 0) {
        out.push({ scope, url: entry.url, outcome: 'unreachable', detail: `the ${REMOTE_GUARD_BUDGET_MS}ms probe budget was spent before reaching it` })
        continue
      }
      try {
        const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        // The team store's host may also hold personal rows under the same token:
        // act on a bare id only when its row there is in a team scope.
        if (this._remoteOnly && !(await this._remoteRowOwnedByTeam(driver, serverId))) continue
        // existsById, NOT getById: getById returns null for a dead network
        // exactly as for a genuine 404 — the silent "no" this must refuse.
        const exists = await driver.existsById(serverId, { signal: AbortSignal.timeout(Math.min(REMOTE_PROBE_TIMEOUT_MS, left)) })
        out.push({ scope, url: entry.url, outcome: exists ? 'present' : 'absent' })
      } catch (err) {
        const status = err instanceof RemoteHttpError ? err.status : undefined
        out.push({
          scope, url: entry.url,
          outcome: status === 401 || status === 403 ? 'auth_rejected' : 'unreachable',
          detail: (err as Error).message,
        })
      }
    }
    return out
  },

  _idSeenRemotely(id: string): string | null {
    const seen = seenOnServer(this.paths.root, id)
    if (seen) return `this machine has seen ${id} on the server for "${seen.scope}" (${new Date(seen.at).toISOString().slice(0, 10)})`
    try {
      for (const ev of readHistoryForEngram(this.paths.root, id)) {
        const d = (ev as { data?: { routed_to?: string; outbox?: boolean; outbox_flush?: boolean } }).data
        // Events keyed by the LOCAL id are not evidence that the local id
        // names a server engram: a rescope logs the local
        // source (its server copy is `new_id`), and an outbox flush logs the
        // local row it delivered (the server id is in the seen record).
        const ev_ = (ev as { event?: string }).event
        if (ev_ === 'engram_rescoped' || d?.outbox_flush === true) continue
        if (d?.routed_to === 'remote' && d.outbox !== true) {
          return `this machine's history records ${id} as an engram on a server (${(ev as { event?: string }).event ?? 'event'})`
        }
      }
    } catch { /* history unreadable — keep looking */ }
    for (const [localId, entry] of Object.entries(this._readOutboxIdMap())) {
      if (entry?.server_id === id) return `the outbox delivered ${localId} to a server as ${id}`
    }
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      const serverId = this._stripRemotePrefix(id, entry.scope)
      if (this._loadRemoteCached(entry).some(e => e.id === serverId)) {
        return `rows cached from "${entry.scope ?? entry.url}" include ${serverId}`
      }
    }
    return null
  },

  _rejectedTokenRefusal(p: CollisionProbe, id: string, evidence: string, verb: string, localHint: string): Error {
    return new Error(
      `Cannot safely ${verb} "${id}": remote scope "${p.scope}" rejected this machine's token (${p.detail ?? 'HTTP 401/403'}), `
      + `so it could not be checked, and ${evidence} — this id may name that store's engram, not the local one. `
      + `If you mean the LOCAL engram: ${localHint}. `
      + `To reach the remote one, refresh the token for ${p.scope} (check it with \`plur login --status\`).`,
    )
  },

  _noteSeenOnServer(entries: Array<{ id: string; scope: string }>): void {
    recordSeenOnServer(this.paths.root, entries)
  },

  _noteSeenRows(rows: readonly Engram[], allRemote = false): void {
    const out: Array<{ id: string; scope: string }> = []
    for (const r of rows) {
      const x = r as { _originalId?: unknown; _storeScope?: unknown; _fromRemoteStore?: unknown; scope: string }
      if (typeof x._originalId !== 'string') continue
      // Live remote-recall rows are remote by construction; among loaded rows
      // only the loader's `_fromRemoteStore` marker says so (a path store can
      // share a scope with a url store).
      if (!allRemote && x._fromRemoteStore !== true) continue
      out.push({ id: x._originalId, scope: typeof x._storeScope === 'string' ? x._storeScope : x.scope })
    }
    if (out.length > 0) this._noteSeenOnServer(out)
  },

  _isScopeMoveIntoRemote(localScope: string, targetScope: string): boolean {
    return targetScope !== localScope && this._isRemoteBackedScope(targetScope) && !this._isRemoteBackedScope(localScope)
  },

  _cachedTwinEvidence(id: string): string | null {
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      if (this._remoteCacheAnswer(entry, this._stripRemotePrefix(id, entry.scope)) === 'present') {
        return `remote scope "${entry.scope ?? entry.url}" holds an engram with this id`
      }
    }
    return this._idSeenRemotely(id)
  },

  _scopeMoveRefusal(updated: Engram, localScope: string, twin: string): Error {
    return new Error(
      `Ambiguous engram ID "${updated.id}": the local engram with this id is in "${localScope}", the row passed is in `
      + `"${updated.scope}", and ${twin}. Nothing was written. To update the remote engram, pass its namespaced id `
      + `(${namespaceEngramId(updated.id, updated.scope)}); to move the local one there, use rescope.`,
    )
  },

  _rejectedTokenWarning(p: CollisionProbe, id: string, acted: string): string {
    return `Remote scope "${p.scope}" rejected this machine's token (${p.detail ?? 'HTTP 401/403'}), so it could not ` +
      `be checked for another engram with id ${id}; ${acted} the LOCAL engram. The token for ${p.scope} is expired, ` +
      `revoked or lacks access — check it with \`plur login --status\` and refresh it in config.yaml.`
  },

  _decideForgetProbes(id: string, probes: CollisionProbe[], warnings: string[]): void {
    for (const p of probes) {
      if (p.outcome === 'present') {
        throw new Error(
          `Ambiguous engram ID "${id}": exists in both the local store and remote scope "${p.scope}". `
          + `Retiring is destructive and irreversible from here, so it will not guess. `
          + `To retire the local engram: \`plur forget ${id} --scope primary\` (MCP: scope: "primary"). `
          + `To retire the remote one: --scope ${p.scope} (MCP: scope: "${p.scope}").`,
        )
      }
      if (p.outcome === 'unreachable') {
        throw new Error(
          `Cannot safely retire "${id}": remote scope "${p.scope}" could not be reached to rule out an id `
          + `collision (${p.detail ?? 'no answer'}). Retiring is destructive and irreversible from here, so it will `
          + `not guess. To retire the local engram without consulting the remote: `
          + `\`plur forget ${id} --scope primary\` (MCP: scope: "primary").`,
        )
      }
      if (p.outcome === 'auth_rejected') {
        const evidence = this._idSeenRemotely(id)
        if (evidence) throw this._rejectedTokenRefusal(p, id, evidence, 'retire', `\`plur forget ${id} --scope primary\` (MCP: scope: "primary")`)
        warnings.push(this._rejectedTokenWarning(p, id, 'retired'))
      }
    }
  },

  _decideFeedbackProbes(id: string, probes: CollisionProbe[], warnings: string[]): void {
    for (const p of probes) {
      if (p.outcome === 'present') {
        throw new Error(
          `Ambiguous engram ID "${id}": exists in both the local store and remote scope "${p.scope}". `
          + `To rate the local engram: \`plur feedback ${id} <signal> --scope primary\` (MCP: scope: "primary"). `
          + `To rate the remote one: --scope ${p.scope} (MCP: scope: "${p.scope}").`,
        )
      }
      if (p.outcome === 'auth_rejected') {
        const evidence = this._idSeenRemotely(id)
        if (evidence) throw this._rejectedTokenRefusal(p, id, evidence, 'rate', `\`plur feedback ${id} <signal> --scope primary\` (MCP: scope: "primary")`)
        const w = this._rejectedTokenWarning(p, id, 'rated')
        warnings.push(w)
        logger.warning(`[plur] ${w}`)
      }
      if (p.outcome === 'unreachable') {
        const w = `Remote scope "${p.scope}" could not be reached to rule out another engram with id ${id} `
          + `(${p.detail ?? 'no answer'}) — rated the LOCAL engram unverified. Pass --scope primary (MCP: scope: "primary") `
          + `to skip this check, or --scope ${p.scope} if you meant the remote one.`
        warnings.push(w)
        logger.warning(`[plur] ${w}`)
      }
    }
  },

  _loadRemoteCached(store: StoreEntry): Engram[] {
    const driver = this._getRemoteDriver({ url: store.url!, token: store.token, scope: store.scope })
    // Synchronously read whatever the driver currently has cached — no
    // background refresh.
    const cached = (driver as unknown as { cache: { engrams: Engram[] } | null }).cache
    return cached?.engrams ?? []
  },

  async _writeEngrams(path: string, engrams: Engram[], opts?: { allowShrink?: boolean }): Promise<void> {
    const store = this._storeAt(path)
    // Backend-independent floor: refuse an undeclared empty whole-corpus save. On Postgres
    // it would become an unqualified `DELETE FROM engrams`, and the YAML shrink guard
    // only covers YAML. Legitimate emptying (`compact`, `forget`, outbox handoff, pack
    // uninstall) declares `allowShrink`. (A remote-only binding restores hidden rows itself.)
    if (!opts?.allowShrink && engrams.length === 0 && !this._activeBinding()) {
      throw new Error(
        `[plur] refusing to write an empty corpus to ${path}.\n` +
        `A store write replaces the whole corpus, so this would delete every engram in it. ` +
        `Operations that legitimately empty a store declare it; this one did not, which means the ` +
        `caller most likely read the store as empty when it is not.\n` +
        `If the store really should be emptied, use the operation that says so (compact/forget).`,
      )
    }
    await store.save(engrams, opts)
  },

  async _appendEngram(corpus: Engram[], engram: Engram): Promise<void> {
    corpus.push(engram)
    if (this._primaryStore.append) {
      await this._primaryStore.append(engram)
    } else {
      await this._writeEngrams(this.paths.engrams, corpus)
    }
  },

  async _loadTargeted(ids: string[]): Promise<Engram[]> {
    const store = this._primaryStore
    return store.loadByIds && store.updateMany
      ? await store.loadByIds(ids)
      : await store.load()
  },

  async _updateEngrams(corpus: Engram[], changed: Engram[]): Promise<void> {
    if (changed.length === 0) return
    if (this._primaryStore.updateMany) {
      await this._primaryStore.updateMany(changed)
    } else {
      await this._writeEngrams(this.paths.engrams, corpus)
    }
  },

  _assertWritable(): void {
    if (this._readonly) throw new ReadonlyStoreError()
  },

  _maybeDailyBackup(path: string): void {
    if (this._readonly) return
    if (path !== this.paths.engrams) return
    if (this._primaryStore.kind !== 'yaml') return
    // Snapshot the file the store ACTUALLY owns, not the conventional path:
    // an injected store's corpus may live elsewhere.
    const target = this._primaryStore.location ?? path
    try {
      maybeDailyBackup(this.paths.root, target)
    } catch {
      /* maybeDailyBackup already logs; a backup must never fail a write */
    }
  },

  _mintedTodayIds(): string[] {
    const day = new Date().toISOString().slice(0, 10)
    // Cached per process, keyed on the DAY (allocation is per-day), so learn() does not
    // re-parse history.jsonl on every write. Missing other processes' ids is safe: the
    // always-fresh corpus scan still sees their engrams. Ids minted here are added below.
    if (this._mintedCache?.day !== day) {
      this._mintedCache = {
        day,
        ids: new Set(mintedIdsWithPrefix(this.paths.root, day.slice(0, 7), [
          `ENG-${day}-`,
          `ENG-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}-`,
        ])),
      }
    }
    return [...this._mintedCache.ids]
  },

  _rememberMintedId(id: string): void {
    const day = new Date().toISOString().slice(0, 10)
    if (this._mintedCache?.day === day) this._mintedCache.ids.add(id)
  },

  _storeAt(path: string): AsyncPrimaryStore {
    if (path === this.paths.engrams) return this._primaryStore
    let store = this._secondaryStores.get(path)
    if (!store) {
      store = new YamlPrimaryStore(path)
      // Read-only instances guard SECONDARY stores too: forget/feedback/
      // recurrence on a store engram write through `_storeAt(storeInfo.path)`,
      // not through the primary store, so wrapping only the primary would leave
      // every `stores:` file writable from a "read-only" engine.
      if (this._readonly) store = new ReadonlyStoreGuard(store)
      this._secondaryStores.set(path, store)
    }
    // remote-only: a secondary file store is personal — invisible and unwritable.
    const ro = this._activeBinding()
    return ro ? new RemoteOnlyStoreGuard(store, ro, false) : store
  },

  async _idsInUse(): Promise<string[]> {
    const minted = this._mintedTodayIds()
    if (!this._remoteOnly) return minted
    return [...minted, ...(await this._basePrimaryStore.loadCached()).map(e => e.id)]
  },
}
