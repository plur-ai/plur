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
import { CollisionProbe } from './types.js'

export interface StoreIoMethods {
/**
   * Root directory of this instance's store (`~/.plur`, `PLUR_PATH`, or the
   * explicit constructor `path`). Synchronous mirror of `status().storage_root`
   * for callers that need the location without an async round-trip — e.g. the
   * MCP server's payload-drop forensic log, which must write
   * next to the store the dropped call was aimed at.
   */
/**
   * Record what a recall returned to a session, so the session's
   * manifest can list it. Called by the surfaces that answer an agent's recall
   * (MCP, CLI) — not by `recall()` itself, which inject and dedup also call.
   * Ids and a query hash only; never the query text. Best-effort: returns
   * whether the event was written.
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
   * Everything that is NOT the primary store: configured secondary stores
   * (file-path AND remote) plus installed packs, with the id namespacing, scope
   * narrowing and containment guard applied.
   *
   * Separate so the BM25 pushdown path can reach these rows without loading the
   * primary corpus. Every caller must use this one implementation: skipping
   * `url` stores, the id namespacing, the `global` narrowing or the
   * `isScopeWithin` guard each breaks reads. Namespacing in particular is not
   * cosmetic: every store mints date-sequenced ids (`ENG-YYYY-MM-DD-NNN`,
   * legacy `ENG-YYYY-MMDD-NNN`) from a per-store daily sequence, so ids collide
   * as the common case, and `feedback()` / `forget()` resolve by exact id
   * against the primary store first — an un-namespaced id would mutate an
   * unrelated engram.
   */
/**
   * Installed packs as every read path hands them out: each row under its
   * pack id ({@link packEngramId}), never under the id its author's store
   * minted. That id can be one of MY memory ids (same day, same sequence, or
   * picked on purpose), and a pack row shown under it reads to the agent as my
   * own memory. Injection, search/list and the receipt all load packs
   * through here, so the id a pack row carries is the same on every path.
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
   * What the ambiguity guards (forget, feedback) may conclude from a
   * store's cache WITHOUT a network call.
   *
   * - `present`: the cache holds the id — a collision, refuse.
   * - `absent`: ONLY when the cache is a complete load younger than the
   *   driver's TTL. A cold-cache `append()` seeds `{ ts: 0, [stored] }` —
   *   explicitly "one engram is not all engrams in this scope" — and a cache
   *   past its TTL may predate the remote row; neither proves absence.
   * - `unknown`: cold, empty, partial or stale — the caller probes live.
   *
   * Model: spec/formal/PlurSpec/R2CoreA.lean §2 (`peek_absent_sound`).
   */
/** @internal */
_remoteCacheAnswer(store: StoreEntry, serverId: string): 'present' | 'absent' | 'unknown'

/**
   * Does a bare id ALSO name an engram in a configured url store?
   *
   * One answer per url store, for the operations that act on a local row by
   * a bare id — forget, feedback, setPinned — since ids are minted per store
   * and two stores mint the same id on the same day.
   *
   * Run WITHOUT the store lock, so a hanging server cannot hold the lock every
   * other writer needs for a full request budget.
   * Each live probe is bounded by REMOTE_PROBE_TIMEOUT_MS, and the walk by
   * REMOTE_GUARD_BUDGET_MS. A warmed cache answers for free.
   *
   * Outcomes are reported, not acted on; each caller decides:
   *   - `present`: ambiguous — every caller refuses and says how to choose.
   *   - `auth_rejected` (401/403): this caller cannot read OR change anything
   *     in that store, so the bare id can only mean the local row it holds.
   *   - `unreachable`: cannot tell. forget refuses (irreversible); feedback
   *     and pin go ahead with a warning (recoverable).
   */
/** @internal */
_hasUrlStore(): boolean

/** @internal */
_probeIdCollisions(id: string, opts?: { skipLive?: boolean }): Promise<CollisionProbe[]>

/**
   * Local evidence that a bare id has ALSO named an engram on a server
   * A 401/403 probe only says this caller cannot SEE the
   * remote row — not that there is none — so before acting on the local row,
   * look for any sign this machine ever met that id remotely:
   *   - history: an event for this id routed to a remote (a team save the
   *     server numbered this way, a remote retire or rating) — excluding the
   *     deferred-push record, which logs the LOCAL id;
   *   - the outbox id map: a queued row delivered under this server id;
   *   - any url store's cached rows, fresh or stale.
   * Returns a plain description of the first piece found, or null. No network.
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
   * Persist one brand-NEW engram to the primary store.
   *
   * `corpus` is the caller's already-loaded primary corpus, held under
   * `_withStoreLock`; the engram is pushed into it here so the caller's view
   * and the fallback write stay consistent by construction. A store with the
   * `append` capability gets a true single-row INSERT; every other store gets
   * one `save()` of the corpus in hand. The corpus is REUSED, never re-loaded:
   * re-parsing a file the caller just parsed (under the same lock) is wasted
   * work on the hottest write path.
   */
/** @internal */
_appendEngram(corpus: Engram[], engram: Engram): Promise<void>

/**
   * Persist mutations to EXISTING primary-store engrams.
   *
   * `changed` are rows from `corpus` (the caller's already-loaded primary
   * corpus, held under `_withStoreLock`) that the caller has mutated in place.
   * A store with `updateMany` gets a targeted write of just those rows — the
   * same machinery recall's activation refresh uses, so there is ONE
   * incremental-update seam, not two. Every other store gets a whole-corpus
   * `save()`, reusing the corpus in hand.
   *
   * Missing-id policy: this cannot silently drop a mutation. `updateMany` is
   * an upsert on every capability store (Postgres `ON CONFLICT DO UPDATE`,
   * MemoryPrimaryStore mirrors it), so a row that vanished between the
   * caller's locked load and this write is re-inserted rather than lost; the
   * fallback writes the corpus, which contains the mutation by construction.
   * There is deliberately no found/not-found boolean here — a signal every
   * call site would have to remember to check is worse than semantics that
   * cannot lose the write.
   */
/**
   * Read the primary-store rows for `ids` — targeted when the store can, a
   * whole-corpus load when it cannot.
   *
   * Every caller is the same shape: load, find one row by id, mutate it, hand
   * it to {@link _updateEngrams}. A targeted read avoids a full table scan to
   * fetch a row by primary key on every feedback signal, pin toggle, update
   * and forget.
   *
   * `loadByIds` and `updateMany` are checked as a PAIR, and the pair is what
   * makes the return value safe to use as "the corpus in hand". Callers pass
   * the array straight on to `_updateEngrams`, which falls back to a FULL
   * REPLACE of whatever it is given when `updateMany` is absent. Taking the
   * targeted read alone would therefore hand a one-row array to a whole-corpus
   * save and delete everything else.
   * Requiring both means the subset is only ever produced when the write that
   * consumes it is itself targeted.
   *
   * Ids absent from the store are simply not returned, so a caller's
   * `find(...)` miss keeps its existing meaning and its existing fall-through
   * to the secondary stores.
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
   * Snapshot the primary store once per process per day.
   *
   * Called from INSIDE the lock and BEFORE `fn` runs, which is the whole point:
   * the copy must be of the on-disk bytes as they were before any write path
   * could replace them, and it must be under the lock so it cannot catch a
   * half-written file.
   *
   * Only the primary store, and only when writable. A read-only instance must
   * not have write side effects, and secondary stores are the remote's
   * or the pack's to protect — snapshotting them here would silently multiply
   * disk use for data this instance does not own.
   *
   * Never throws: the backup is a safety net for the write, not a precondition
   * of it. A failed snapshot warns and lets the write proceed.
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
        // Sanitise HERE, at the point pack content enters the injection corpus.
        // Pack install does not call learn() or learnRouted() —
        // it copies the pack's file into the packs directory and this loop
        // feeds those rows straight into the corpus — so a pack statement with
        // a forged boundary would mint a fabricated entry with neither write
        // path in front of it. Pack content is the explicit threat model in the
        // splitter's own docstring: it is the one corpus whose author is by
        // definition someone else.
        //
        // Load time rather than install time, deliberately. Install time would
        // leave every already-installed pack, and any pack placed in the
        // directory by hand or by a sync, unsanitised. This is the last gate
        // before injection, so it is the one that has to hold.
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
    // Backend-independent floor. The YAML writer has
    // its own shrink guard, but that guard lives in `saveEngrams` and so only
    // covers YAML. `save()` is a whole-corpus replace on EVERY backend, and on
    // Postgres it ends in `DELETE FROM engrams WHERE id NOT IN (…)` — with an
    // empty array, an unqualified `DELETE FROM engrams`.
    //
    // Emptying the corpus is never an incidental outcome: `compact`, `forget`,
    // the outbox handoff and pack uninstall all declare `allowShrink`. An
    // undeclared empty save means the caller read nothing and is about to make
    // that permanent.
    // (A remote-only binding writes through RemoteOnlyStoreGuard, which puts
    // every hidden row back: an empty visible set there removes queued saves
    // only.)
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
    // Cached per process, per day.
    //
    // Without this, every learn() would re-read and re-parse a month of
    // history.jsonl on the hottest write path. The cache is keyed on the DAY so it
    // self-invalidates across midnight (allocation is per-day, so yesterday's
    // ids are irrelevant to today's suffix).
    //
    // Staleness is safe in the one direction that matters: ids minted by
    // ANOTHER process after this cache was filled are missing from it, which
    // degrades to corpus-only allocation rather than introducing a
    // new hazard — and the corpus scan, which is always fresh, still sees any
    // engram that other process actually wrote. Ids minted by THIS process are
    // added below without a re-read, so a burst of writes in one session stays
    // monotonic without touching disk again.
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
