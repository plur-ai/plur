import { computeContentHash, isHashable } from '../content-hash.js'
import { namespaceEngramId, parseNamespacedId, storePrefix } from '../engrams.js'
import { applyFeedbackSignal, type FeedbackSource } from '../feedback.js'
import { findLatestInjectionFor } from '../history.js'
import { Plur } from '../index.js'
import { DEFAULT_PINNED_HARD_RATIO, estimateTokens, isHardPinned, pinnedHardCap } from '../inject.js'
import { logger } from '../logger.js'
import type { Engram } from '../schemas/engram.js'
import { assertScopeNamesATarget, isLocalOnlyScope } from '../scope-target.js'
import { isScopeWithin } from '../scope-util.js'
import { detectSecrets } from '../secrets.js'
import { computeRecordHash } from '../session-manifest.js'
import { resolveScopeTarget, ScopeConflictError } from '../store-resolver.js'
import { FEEDBACK_SOURCE_CAPABILITY, RemoteStore } from '../store/remote-store.js'
import { REMOTE_PROBE_TIMEOUT_MS } from './helpers.js'
import { type MutationOutcome } from './types.js'

export interface FeedbackPinMethods {
  /**
   * Update feedback_signals and adjust retrieval_strength. Searches primary, stores, then packs.
   * `scope` routes directly ("primary" or a remote scope); without it, an id present both
   * locally and in a warmed remote cache is an error — the caller must disambiguate.
   * `options.source: 'auto'` (hook-inferred) adjusts ranking only, never `commitment`; it is
   * sent only to remotes advertising `feedback.source` in `/me`, and never dials a cold remote.
   */
  feedback(id: string, signal: 'positive' | 'negative' | 'neutral', scope?: string, options?: { source?: FeedbackSource }): Promise<MutationOutcome>

  /**
   * Log an injection_outcome event linking a feedback verdict to the
   * co_injection event the engram came from. Only positive/negative
   * verdicts are outcomes — "ignored" is the absence of an outcome, so
   * neutral signals and feedback on never-injected engrams write nothing.
   * Link resolution: in-process map first, then a bounded history scan for
   * injections logged by another process (hook-inject, CLI).
   */
  /** @internal */
  _logInjectionOutcome(engramId: string, signal: 'positive' | 'negative' | 'neutral', source?: FeedbackSource): void

  /**
   * Save extracted meta-engrams, skipping ids that already exist, behind the same
   * scope-security guard as learn/updateEngram:
   *  - HARD `detectSecrets`: a raw secret at a shared scope THROWS unless `config.allow_secrets`.
   *  - SOFT `_offendingHitsForScope`: infra-sensitive content at a shared scope is DEMOTED
   *    to local/private and stamped with `_demoted{from,to,patterns}`.
   */
  saveMetaEngrams(metas: Engram[]): Promise<{ saved: number; skipped: number }>

  /**
   * Update an existing engram by ID. Returns true if it was found and written,
   * false if no local or writable remote store holds it.
   *
   * A remote-routed update is awaited and its outcome reported, so a `true`
   * means the write happened. {@link updateEngramAsync} is the same operation
   * returning the written engram.
   */
  updateEngram(updated: Engram): Promise<boolean>

  /**
   * @deprecated Use {@link updateEngram}, which also awaits the remote PATCH.
   * This differs only in returning the written engram (the server-authoritative
   * view for a remote hit) instead of a boolean.
   */
  updateEngramAsync(updated: Engram): Promise<Engram | null>

  /** @internal */
  _updateEngramReturning(updated: Engram): Promise<Engram | null>

  /**
   * When an update changes the scope of a row still queued for a remote (`_outbox`):
   *   - new scope local-family → pending delivery cancelled;
   *   - new scope has a writable URL store → `_outbox` retargeted (attempts reset);
   *   - no or only readonly store → cancelled with a warning;
   *   - scope claimed by two servers → refused (ScopeConflictError) before any write.
   * `_outbox` and `_retireRemote` are read from the STORED row, never the caller's
   * object, which could otherwise direct a push or remote DELETE. Mutates `toWrite`.
   */
  /** @internal */
  _reconcileQueuedScope(stored: Engram, toWrite: Engram): void

  /**
   * Toggle the always-load (pinned) flag for an engram.
   *
   * Returns the updated engram on success, `null` if it is not found in the
   * local primary store or in any writable remote. The remote PATCH is awaited
   * and the real engram returned — {@link setPinnedAsync} is the same call.
   */
  setPinned(id: string, pinned: boolean, options?: { scope?: string }): Promise<Engram | null>

  /**
   * @deprecated Use {@link setPinned}, which also awaits the remote PATCH.
   * This is an alias of it.
   */
  setPinnedAsync(id: string, pinned: boolean, options?: { scope?: string }): Promise<Engram | null>

  /** List engrams that have pinned: true. */
  listPinned(): Promise<Engram[]>

  /**
   * Token cap of the HARD pinned tier at write time (pinned two-tier model):
   * `injection.pinned_hard_ratio` of the same quota {@link pinnedQuota}
   * enforces. The ratio is bounded to [0, 1], so the hard tier can never
   * exceed the pinned quota. Default: 0.5 × 1000 = 500 tokens.
   */
  hardTierCap(): number

  /**
   * Refuse a write that would GROW the hard pinned tier past {@link hardTierCap} — the one
   * check every hard-tier write path uses. MUST be called holding the primary store lock
   * (a cap is a read-modify-write on a shared total). Cost is `estimateTokens` over the
   * engram as committed, matching injection. Remote rows count only as far as their cache
   * holds them, so injection enforces the cap again (`fillTokenBudget`, `hard-tier-cap`).
   * @param pendingTokens hard-tier tokens accepted earlier in the same locked batch.
   * @returns the candidate's cost if it counts toward the tier, else 0.
   */
  /** @internal */
  _assertHardTierFits(candidate: Engram, pendingTokens?: number): Promise<number>

  /**
   * Pinned-budget accounting.
   *
   * `pinned` is an "always-load flag", so injection must not silently evict
   * pinned engrams to fit the budget. Instead the quota is checked at pin
   * time, where a human is present to decide: over quota, the user unpins
   * something or raises the limit.
   */
  pinnedQuota(candidateId?: string, options?: { scope?: string }): Promise<{
    quota: number
    used: number
    free: number
    count: number
    over: boolean
    /** Pinned engrams, most-expendable first — the unpin suggestion order. */
    entries: Array<{ id: string; statement: string; cost: number; net_feedback: number; last_accessed: string | null }>
    /** Set when `candidateId` names a not-yet-pinned engram: what pinning it would cost. */
    candidate?: { id: string; cost: number; would_be: number; fits: boolean }
  }>

  /**
   * Recompute `content_hash` for primary-store engrams whose hash no longer describes
   * their statement. Read-only unless `apply` is set.
   * - Goes through `_withStoreLock` and `_loadTargeted`/`_updateEngrams`: an unlocked
   *   load-mutate-save would silently lose a concurrent append.
   * - Primary store, not `list()`: packs are not ours, and retired rows' hashes matter too.
   * - Reports STALE (actively wrong) and MISSING (inert) separately; UNHASHABLE statements
   *   (normalize to empty, so all share one hash) are listed and skipped.
   */
  repairContentHashes(opts?: { apply?: boolean }): Promise<{
    scanned: number
    stale: Array<{ id: string; statement: string }>
    missing: Array<{ id: string; statement: string }>
    unhashable: Array<{ id: string; statement: string }>
    repaired: number
  }>
}

export const feedbackPinMethods: FeedbackPinMethods & ThisType<Plur> = {
  async feedback(id: string, signal: 'positive' | 'negative' | 'neutral', scope?: string, options?: { source?: FeedbackSource }): Promise<MutationOutcome> {
    this._assertWritable()
    await this._remoteOnlyRefuseLocalRow(id, 'Rating', scope)
    const warnings: string[] = []
    // The id as the caller gave it: injection records are keyed by the form
    // the agent was shown, which may be the old three-letter one.
    const asGiven = id
    const auto = options?.source === 'auto'
    const applyOpts = auto ? { source: 'auto' as const } : {}
    const sourceData = auto ? { source: 'auto' as const } : {}
    const refuseRemote = (where: string): never => {
      throw new Error(
        `Automatic feedback is not sent to this remote store: ${id} is in "${where}", whose server does not `
        + `advertise the "${FEEDBACK_SOURCE_CAPABILITY}" capability. Rate it with plur_feedback to send an explicit signal.`,
      )
    }
    // Only a capable server may receive an automatic verdict.
    const remoteAccepts = async (driver: RemoteStore): Promise<boolean> =>
      !auto || await driver.hasCapability(FEEDBACK_SOURCE_CAPABILITY)
    const remoteOpts = auto ? { source: 'auto' as const } : undefined

    if (scope !== undefined && (typeof scope !== 'string' || scope.trim() === '')) {
      throw new TypeError('plur.feedback: scope must be a non-empty string')
    }
    // Pick up out-of-process config edits so a store registered after
    // startup is not rejected as unknown by the validation below — mirrors
    // rescope() and forget().
    if (scope) this.reloadConfigIfChanged()

    // Scope-targeted routing: when the caller knows which store the engram
    // lives in, route directly and skip the first-match-wins walk.
    if (scope && scope !== 'primary') {
      // The resolver's entry: exact match, and a scope two
      // servers claim is refused before either is asked.
      const entry = this._scopedUrlEntry(scope, 'nothing was rated')
      if (entry) {
        if (entry.readonly === true) throw new Error('Engram is in a readonly store')
        const serverId = this._stripForScope(id, entry.scope)
        const driver = this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
        if (!(await remoteAccepts(driver))) refuseRemote(entry.scope ?? entry.url!)
        const remoteEngram = await driver.getById(serverId)
        if (!remoteEngram) throw new Error(`Engram "${id}" not found in store "${scope}"`)
        await driver.feedback(serverId, signal, remoteOpts)
        try {
          this._appendHistory({
            event: 'feedback_received',
            engram_id: id,
            timestamp: new Date().toISOString(),
            data: { signal, routed_to: 'remote', scope, ...sourceData },
          })
        } catch (err) {
          logger.warning(
            `[plur] feedback on ${id} was applied remotely but its history record could not be written: ` +
            `${(err as Error).message}. Do not retry — the signal is already counted.`,
          )
        }
        this._logInjectionOutcome(asGiven, signal, options?.source)
        return { warnings }
      }
      // No URL-backed store carries this scope. Falling through would skip the
      // `if (!scope)` ambiguity guard below (`scope` is truthy), so a MISTYPED
      // scope would silently restore first-match-wins. Validate that the scope
      // names something, following rescope().
      assertScopeNamesATarget(scope, this.config.stores ?? [], 'rate in', 'rate the LOCAL engram')
    }

    // A namespaced id acts on the one store it names.
    if (!scope) id = await this._resolveNamespacedId(id, 'rate')

    // Try primary engrams first
    // Collision probe OUTSIDE the store lock, bounded per store —
    // the same walk forget() runs, read the same way except that "cannot
    // tell" goes ahead with a warning: a mis-targeted rating is recoverable.
    // An automatic signal never waits on the network (a cold cache reads as
    // no collision; it moves strength one step and never commitment).
    let probedOutsideLock = false
    if (!scope && this._hasUrlStore()) {
      const pre = (await this._loadTargeted([id])).find(e => e.id === id)
      if (pre) {
        this._decideFeedbackProbes(id, await this._probeIdCollisions(id, { skipLive: auto }), warnings)
        probedOutsideLock = true
      }
    }
    const found = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read: rating one engram is a lookup by primary key,
      // not a reason to materialise the corpus. A miss still means "not in the
      // primary store" and still falls through to the secondary stores below.
      const engrams = await this._loadTargeted([id])
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false

      // Ambiguity guard: without a scope, refuse when the bare id also exists remotely —
      // a wrong-target write looks like a correct one. Peek the cache first, probe live only
      // when it is cold. Unlike forget(), an unreachable store only warns: a mis-targeted
      // rating is recoverable. Only rows that appeared since the pre-lock probe are probed here.
      if (!scope && !probedOutsideLock) {
        this._decideFeedbackProbes(id, await this._probeIdCollisions(id, { skipLive: auto }), warnings)
      }

      applyFeedbackSignal(engram, signal, undefined, applyOpts)

      // Incremental write: only the rated engram changed.
      await this._updateEngrams(engrams, [engram])
      await this._syncIndex()
      // The counter has already changed on disk. Rejecting the call on a history
      // failure would make a retry apply the signal a SECOND time, so log and
      // continue: the mutation committed.
      try {
        this._appendHistory({
          event: 'feedback_received',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { signal, ...sourceData },
        })
      } catch (err) {
        logger.warning(
          `[plur] feedback on ${id} was applied but its history record could not be written: ` +
          `${(err as Error).message}. Do not retry — the signal is already counted.`,
        )
      }
      return true
    })

    if (found) {
      this._logInjectionOutcome(asGiven, signal, options?.source)
      return { warnings }
    }

    // scope: "primary" means local-only — do not try secondary or remote stores
    if (scope === 'primary') {
      throw new Error(`Engram "${id}" not found in primary store`)
    }

    // Try configured stores (namespaced IDs)
    const storeInfo = await this._findEngramStore(id)
    if (storeInfo && storeInfo.path !== this.paths.engrams) {
      if (storeInfo.readonly) {
        throw new Error('Engram is in a readonly store')
      }
      // Under the SECONDARY store's own lock, as on the primary store: without
      // it two processes rating the same team engram could both load, increment
      // and write back, losing one increment, and a whole-file replace would
      // delete anything the other process added in between.
      // Returns whether the engram was found and handled here; a miss falls
      // through to the remote-store search below.
      const handled = await this._withStoreLock(storeInfo.path, async () => {
      // Must load fresh (not cached) since we're about to mutate and write back
      const storeEngrams = await this._storeAt(storeInfo.path).load()
      const engram = storeEngrams.find(e => e.id === storeInfo.originalId)
      if (engram) {
        applyFeedbackSignal(engram, signal, undefined, applyOpts)
        await this._writeEngrams(storeInfo.path, storeEngrams)
        await this._syncIndex()
        this._logInjectionOutcome(asGiven, signal, options?.source)
        return true
      }
      return false
      })
      if (handled) return { warnings }
    }

    // Check remote stores — the engram may live on an enterprise server.
    //
    // Same local-only guard as forget()'s: `feedback(id, signal, 'primary')`
    // on an id absent locally must not rate a REMOTE engram.
    // An explicit scope the resolver keeps local (a path store, or the local
    // store a personal scope selects) is local too.
    if (scope && (isLocalOnlyScope(scope, this.config.stores ?? [])
      || resolveScopeTarget(scope, this.config.stores ?? []).kind === 'local')) {
      throw new Error(
        `Engram not found in the local store: ${id} (scope: "${scope}"). `
        + `That scope names a local target, so no remote store was searched. `
        + `Omit scope to search everywhere, or pass the remote scope to target it directly.`,
      )
    }
    // The ID may be prefixed (ENG-GPL-...) from _loadAllEngrams namespacing.
    // Strip the prefix before querying the remote server.
    /** Stores this walk could not reach — so "not found" can say so. */
    const unverifiedStores: string[] = []
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      // remote-only: a personal or non-team url store is out of reach.
      if (this._remoteOnly && !this._remoteOnlyWalkAllows(entry.scope, scope)) continue
      // An explicit scope names its store exactly: the walk never
      // rates a row of a store that does not claim that scope.
      if (scope && entry.scope !== scope) continue
      const serverId = this._stripRemotePrefix(id, entry.scope)
      // Automatic feedback: a server that does not advertise
      // `feedback.source` is skipped before any engram lookup is spent on it.
      if (auto && !(await remoteAccepts(this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })))) continue
      if (entry.readonly === true) {
        const roDriver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        const roFound = await roDriver.getById(serverId)
        if (roFound && this._rowInStore(roFound, entry)) throw new Error('Engram is in a readonly store')
        continue
      }
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      // The team store's host may also hold personal rows under the same token:
      // act on a bare id only when its row there is in a team scope.
      if (this._remoteOnly && !(await this._remoteRowOwnedByTeam(driver, this._stripRemotePrefix(id, entry.scope)))) continue
      // OWNERSHIP is decided by `existsById`, not `getById`: `getById` returns
      // null on a timeout, 5xx or auth rejection as well as a genuine 404, so it
      // cannot tell "this store does not have it" from "could not ask". Deciding
      // which store owns an id is deciding whether to act.
      let owns: boolean
      try {
        // Bounded like the collision probe: a hanging store
        // costs seconds, not the driver's 30 s, per store.
        owns = await driver.existsById(serverId, { signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS) })
      } catch (err) {
        // Could not tell. Feedback's established policy is to proceed rather
        // than refuse — a mis-targeted rating is recoverable and rating is a
        // hot path — but the store is COUNTED, so the message below cannot
        // claim knowledge this walk does not have.
        unverifiedStores.push(entry.scope ?? entry.url!)
        logger.warning(
          `[plur] could not reach "${entry.scope ?? entry.url}" while looking for ${id} `
          + `(${(err as Error).message}) — it may hold this engram.`,
        )
        continue
      }
      if (!owns) continue
      const found = await driver.getById(serverId)
      // Another store's row on the same server is not this store's to rate.
      if (found && !this._rowInStore(found, entry)) continue
      if (found) {
        await driver.feedback(serverId, signal, remoteOpts)
        // Same reasoning as the local path: the remote already counted it.
        try {
          this._appendHistory({
            event: 'feedback_received',
            engram_id: id,
            timestamp: new Date().toISOString(),
            data: { signal, routed_to: 'remote', ...sourceData },
          })
        } catch (err) {
          logger.warning(
            `[plur] feedback on ${id} was applied remotely but its history record could not be ` +
            `written: ${(err as Error).message}. Do not retry — the signal is already counted.`,
          )
        }
        this._logInjectionOutcome(asGiven, signal, options?.source)
        return { warnings }
      }
    }

    // Search pack engrams by scanning pack directories
    await this._feedbackPack(id, signal, unverifiedStores, applyOpts)
    this._logInjectionOutcome(asGiven, signal, options?.source)
    return { warnings }
  },

  _logInjectionOutcome(engramId: string, signal: 'positive' | 'negative' | 'neutral', source?: FeedbackSource): void {
    if (signal === 'neutral') return
    try {
      const injectionId = this._lastInjectionByEngram.get(engramId)
        ?? findLatestInjectionFor(this.paths.root, engramId)?.injection_id
      if (!injectionId) return
      this._appendHistory({
        event: 'injection_outcome',
        engram_id: engramId,
        timestamp: new Date().toISOString(),
        data: { injection_id: injectionId, signal, ...(source === 'auto' ? { source } : {}) },
      })
    } catch { /* best-effort — outcome logging must never break feedback */ }
  },

  async saveMetaEngrams(metas: Engram[]): Promise<{ saved: number; skipped: number }> {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Saving meta-engrams (they are written to the personal store)')
    return await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const existingIds = new Set(engrams.map(e => e.id))
      let saved = 0
      let skipped = 0
      // Hard-tier tokens accepted earlier in this batch; listPinned cannot see
      // them until the batch is written.
      let pendingHard = 0
      for (const meta of metas) {
        if (existingIds.has(meta.id)) {
          skipped++
          continue
        }
        pendingHard += await this._assertHardTierFits(meta, pendingHard)
        // Guard each meta on the FULL content (statement + context
        // fields) at its scope before persist. Do NOT call _guardExplicitUpdate
        // (its warning text is the EXPLICIT-update path); inline the demotion
        // shape here so the message is meta-specific.
        const scope = meta.scope ?? 'global'
        const contextFields = this._engramContextFields(meta)
        const scanText = contextFields
          ? `${meta.statement}\n${JSON.stringify(contextFields)}`
          : meta.statement
        // HARD secret check — mirror learn()/learnRouted.
        if (!this.config.allow_secrets) {
          const secrets = detectSecrets(scanText)
          if (secrets.length > 0) {
            throw new Error(
              `Secret detected in meta-engram ${meta.id}: ${secrets[0].pattern}. ` +
              `Use config.allow_secrets to override.`,
            )
          }
        }
        // SOFT infra demotion — mirror the explicit-update / learnAsync paths.
        const hits = this._offendingHitsForScope(scanText, scope)
        if (hits.length > 0) {
          const patterns = [...new Set(hits.map(h => h.pattern))].join(', ')
          logger.warning(
            `[plur] sensitive content (${patterns}) held back from shared scope "${scope}" ` +
            `in meta-engram ${meta.id} — demoted to local/private so it is not written to a ` +
            `shared store. Re-scope deliberately if this is a false positive.`,
          )
          ;(meta as any).scope = 'local'
          ;(meta as any).visibility = 'private'
          ;(meta as any).structured_data = {
            ...((meta as any).structured_data ?? {}),
            _demoted: { from: scope, to: 'local', patterns },
          }
        }
        engrams.push(meta)
        saved++
      }
      if (saved > 0) {
        await this._writeEngrams(this.paths.engrams, engrams)
        await this._syncIndex()
      }
      return { saved, skipped }
    })
  },

  async updateEngram(updated: Engram): Promise<boolean> {
    return (await this._updateEngramReturning(updated)) !== null
  },

  async updateEngramAsync(updated: Engram): Promise<Engram | null> {
    return await this._updateEngramReturning(updated)
  },

  async _updateEngramReturning(updated: Engram): Promise<Engram | null> {
    this._assertWritable()
    await this._remoteOnlyRefuseLocalRow(updated.id, 'Updating')
    // Guards and routing below read the current config.
    this.reloadConfigIfChanged()
    // A namespaced id updates the one store it names: an
    // old-form id shared by several stores is resolved first, or refused.
    if (parseNamespacedId(updated.id, true)) {
      const resolved = await this._resolveNamespacedId(updated.id, 'update')
      if (resolved !== updated.id) updated = { ...updated, id: resolved }
    }
    // The scope-move twin check, BEFORE the lock: a live
    // probe must never hold the store lock.
    let scopeMoveChecked = false
    if (this._hasUrlStore() && typeof updated.scope === 'string' && this._isRemoteBackedScope(updated.scope)) {
      const pre = (await this._loadTargeted([updated.id])).find(e => e.id === updated.id)
      if (pre && this._isScopeMoveIntoRemote(pre.scope, updated.scope)) {
        // Only a positive "absent" from every store clears the move:
        // a hang or a rejected token is "cannot tell", and on
        // this path a wrong guess overwrites an unrelated local engram.
        const probes = await this._probeIdCollisions(updated.id)
        const present = probes.find(p => p.outcome === 'present')
        const unknown = probes.find(p => p.outcome !== 'absent' && p.outcome !== 'present')
        const twin = present
          ? `remote scope "${present.scope}" holds an engram with this id`
          : unknown
            ? `remote scope "${unknown.scope}" could not be checked for an engram with this id `
              + `(${unknown.outcome === 'auth_rejected' ? 'it rejected the token' : 'it could not be reached'}: ${unknown.detail ?? 'no answer'})`
            : this._idSeenRemotely(updated.id)
        if (twin) throw this._scopeMoveRefusal(updated, pre.scope, twin)
        scopeMoveChecked = true
      }
    }
    // Local primary first.
    const localResult = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read: resolving one engram by id.
      const engrams = await this._loadTargeted([updated.id])
      const idx = engrams.findIndex(e => e.id === updated.id)
      if (idx === -1) return null
      const recordBefore = `${engrams[idx].status ?? 'active'}:${computeRecordHash(engrams[idx])}`
      // A row still queued for a remote store that moves into a personal scope
      // takes the spelling a fresh write would (`_canonicalPersonalScope`, as
      // in learn), BEFORE the leak guard, so the guard scans the scope the
      // delivery is retargeted to.
      const storedRow = engrams[idx] as any
      if (storedRow.structured_data?._outbox && storedRow.status !== 'retired'
        && typeof updated.scope === 'string' && updated.scope !== storedRow.scope) {
        const canonical = this._canonicalPersonalScope(updated.scope)
        if (canonical !== updated.scope) updated = { ...updated, scope: canonical }
      }
      // Ambiguity guard. Ids are minted per store, so a team row the server
      // returned with a bare id (learnRouted's result, say) can share that id with
      // an unrelated local row, and local-first matching would write the team
      // content over it. Refused only on evidence of such a twin — checked before
      // the lock (live probe) or, for a row that appeared since, here without the
      // network. A plain scope move of a local engram with no twin goes through.
      if (!scopeMoveChecked && this._isScopeMoveIntoRemote(engrams[idx].scope, updated.scope)) {
        // No network under the lock: clear the move only when every store's
        // fresh cache positively answers "absent".
        const unchecked = (this.config.stores ?? []).find(e => !!e.url
          && this._remoteCacheAnswer(e, this._stripRemotePrefix(updated.id, e.scope)) !== 'absent')
        const twin = this._cachedTwinEvidence(updated.id)
          ?? (unchecked ? `remote scope "${unchecked.scope ?? unchecked.url}" could not be checked for an engram with this id` : null)
        if (twin) throw this._scopeMoveRefusal(updated, engrams[idx].scope, twin)
      }
      // Leak guard: local-resident → demote a sensitive update in place.
      // Scans context fields too, not just the statement.
      const demote = this._guardExplicitUpdate(updated.statement, updated.scope, false, this._engramContextFields(updated))
      // Stamp `updated_at` on the mutation path, not only on creation and
      // retirement; otherwise it equals `created_at` for edited engrams and reads
      // as authoritative.
      const toWrite = { ...(demote ? { ...updated, ...demote } : updated), updated_at: new Date().toISOString() }
      // A whole-engram update can set `pinned` and `pinned_tier` — a write path
      // that can produce a hard-tier engram, so it passes the same cap. Checked
      // before the queued-scope reconcile so a refused update has no side effects.
      await this._assertHardTierFits(toWrite)
      this._reconcileQueuedScope(engrams[idx], toWrite)
      const retiresNow = engrams[idx].status !== 'retired' && toWrite.status === 'retired'
      engrams[idx] = toWrite
      // Incremental write: only the updated engram row changed.
      await this._updateEngrams(engrams, [toWrite])
      await this._syncIndex()
      // Every removal is explicit: an update that retires a row is a removal and
      // leaves the same trace forget() does (e.g. `plur_validate_meta` retiring a
      // failing meta-engram). Nothing when the row was already retired or its
      // status did not change.
      if (retiresNow) {
        try {
          this._appendHistory({
            event: 'engram_retired',
            engram_id: toWrite.id,
            timestamp: toWrite.updated_at,
            data: { reason: null, via: 'update' },
          })
        } catch { /* history is an audit trail, never a gate on the write */ }
      } else if (`${toWrite.status ?? 'active'}:${computeRecordHash(toWrite)}` !== recordBefore) {
        // A content edit through PLUR is recorded, so `plur verify` can tell it
        // from an edit made behind PLUR's back. Ids only; an update that moves only
        // usage counters writes nothing.
        try {
          this._appendHistory({
            event: 'engram_updated',
            engram_id: toWrite.id,
            timestamp: toWrite.updated_at,
            data: { via: 'update' },
          })
        } catch { /* history is an audit trail, never a gate on the write */ }
      }
      return toWrite
    })
    if (localResult) return localResult

    // Remote routing: awaited and reported — never fire-and-forget (a failure must not
    // read as success, a rejection must not crash the server, a 404 is not `true`).
    // A NAMESPACED id names its store(s): only those are candidates and a refusal is
    // thrown as-is. A BARE id walks every store, returning null/false rather than a fake
    // success (set-pinned-remote.test.ts). Shared short prefixes are disambiguated on the
    // full store scope; an unmatched hint keeps `namedBy`.
    const writableRemotes = (this.config.stores ?? []).filter(e => !!e.url && e.readonly !== true &&
      // remote-only: team stores only.
      (!this._remoteOnly || this._isDeliverableTeamScope(e.scope)))
    let namedBy = writableRemotes.filter(e => this._stripRemotePrefix(updated.id, e.scope) !== updated.id)
    if (namedBy.length > 1) {
      const stamp = (updated as any)._storeScope as string | undefined
      const byStamp = stamp ? namedBy.filter(e => e.scope === stamp) : []
      const byScope = typeof updated.scope === 'string' ? namedBy.filter(e => isScopeWithin(updated.scope, e.scope)) : []
      if (byStamp.length > 0) namedBy = byStamp
      else if (byScope.length > 0) namedBy = byScope
    }
    // An id namespaced to a configured store that is not among the writable
    // url stores — a readonly store, or a path store — is not theirs to patch;
    // walking them all would send another store's row content to whichever
    // writable server answered for the stripped id.
    const ns = parseNamespacedId(updated.id, true)
    if (namedBy.length === 0 && ns
      && (this.config.stores ?? []).some(e => typeof e.scope === 'string' && storePrefix(e.scope) === ns.prefix)) {
      return null
    }
    // remote-only: a bare id is sent only to the
    // store(s) serving the row's own scope, never first to another team
    // server that merely might hold the id.
    const walk = namedBy.length > 0 || !this._activeBinding()
      ? (namedBy.length > 0 ? namedBy : writableRemotes)
      : (() => {
          // The one store the shared resolver names for the row's scope, never
          // a parent-scope server that merely contains it.
          const target = typeof updated.scope === 'string' ? resolveScopeTarget(updated.scope, this.config.stores ?? []) : null
          const named = target && target.kind === 'remote' && target.writable ? target.entry : undefined
          return named ? writableRemotes.filter(e => e.url === named.url && e.scope === named.scope) : []
        })()
    for (const entry of walk) {
      // Leak guard: remote-resident, explicit update → THROW on a
      // forbidden hit (no coherent demotion for a remote engram).
      // Scans context fields too, not just the statement.
      this._guardExplicitUpdate(updated.statement, entry.scope, true, this._engramContextFields(updated))
      const serverId = this._stripRemotePrefix(updated.id, entry.scope)
      const driver = this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
      // remote-only: the row the id names on this host must be in a team
      // scope; the host can also hold personal rows.
      if (this._activeBinding() && !(await this._remoteRowOwnedByTeam(driver, serverId))) continue
      // PATCH a focused subset — a full-engram PATCH would require strict
      // schema mirroring on the server. Send the fields most commonly mutated by
      // the callers (setPinned, promote, reportFailure).
      try {
        // Every removal is explicit and traced: a patch
        // that sets `retired` reads the previous status first, so the history
        // records a real transition only. `getById` answers null for both a
        // 404 and an unreachable store, so null or a throw is "unknown" — then
        // the event is still written, flagged, rather than dropped.
        let previous: { status?: string } | null | undefined
        if (updated.status === 'retired') {
          try { previous = await driver.getById(serverId) } catch { previous = null }
        }
        const patched = await driver.patch(serverId, {
          pinned: updated.pinned,
          status: updated.status,
          statement: updated.statement,
        })
        // `null` is a 404 — this remote does not hold it, so keep looking.
        if (patched) {
          if (updated.status === 'retired' && previous?.status !== 'retired') {
            try {
              this._appendHistory({
                event: 'engram_retired',
                engram_id: updated.id,
                timestamp: new Date().toISOString(),
                data: {
                  reason: null, via: 'update', routed_to: 'remote', scope: entry.scope,
                  ...(previous ? {} : { previous_status_unknown: true }),
                },
              })
            } catch { /* history is an audit trail, never a gate on the write */ }
          }
          return patched
        }
      } catch (err) {
        if (serverId !== updated.id) throw err
        continue
      }
    }
    return null
  },

  _reconcileQueuedScope(stored: Engram, toWrite: Engram): void {
    const storedSd = (stored as any).structured_data as Record<string, unknown> | undefined
    const sd: Record<string, unknown> = { ...(((toWrite as any).structured_data as Record<string, unknown> | undefined) ?? {}) }
    let changed = false
    if (storedSd && '_retireRemote' in storedSd) { sd._retireRemote = storedSd._retireRemote; changed = true }
    else if ('_retireRemote' in sd) { delete sd._retireRemote; changed = true }
    const pending = storedSd?._outbox as { target_url?: string; target_scope?: string } | undefined
    // A queued remote-only save keeps its queue entry through a same-scope
    // update: it is read from the STORED row, so a
    // caller's object without `_outbox` cannot turn it into a local row.
    if (pending && Plur._isRemoteOnlyQueued(stored) && toWrite.status !== 'active') throw this._queuedStaysRemote(stored)
    // No retarget, not even to another team scope.
    if (pending && Plur._isRemoteOnlyQueued(stored) && toWrite.scope !== stored.scope) throw this._queuedStaysRemote(stored)
    if (pending && Plur._isRemoteOnlyQueued(stored) && toWrite.scope === stored.scope) {
      sd._outbox = storedSd!._outbox
      changed = true
    }
    if (pending && stored.status !== 'retired' && toWrite.scope !== stored.scope) {
      changed = true
      const stores = this.config.stores ?? []
      const newScope = toWrite.scope
      // A personal scope goes where the ONE selected store is: a local store
      // sharing the identical scope keeps the row local, so its pending
      // delivery is cancelled rather than retargeted to the url.
      // One resolver: the retarget is the store a fresh write would use, and a
      // scope two servers claim refuses the whole update before anything is
      // saved, as learn does.
      const target = resolveScopeTarget(newScope, stores)
      if (target.kind === 'conflict') throw new ScopeConflictError(newScope, target.servers)
      const writable = target.kind === 'remote' && target.writable ? target.entry : undefined
      // A save queued from a remote-only folder keeps going to a team store:
      // never cancelled into a local row.
      // (A personal url store can be `writable` here: only a team
      // scope is a destination for it.)
      if (Plur._isRemoteOnlyQueued(stored) && (!writable || !this._isDeliverableTeamScope(newScope))) throw this._queuedStaysRemote(stored)
      const personalLocal = target.kind === 'local' && !!target.entry && newScope.toLowerCase().startsWith('user:')
      if (personalLocal) {
        delete sd._outbox
        logger.warning(
          `[plur] update of ${stored.id} moved it to "${newScope}", which a local store holds, and cancelled its `
          + `pending delivery to ${pending.target_url ?? '?'} (scope "${pending.target_scope ?? stored.scope}").`,
        )
      } else if (isLocalOnlyScope(newScope, stores)) {
        delete sd._outbox
        logger.warning(
          `[plur] update of ${stored.id} moved it to "${newScope}" and cancelled its pending delivery to `
          + `${pending.target_url ?? '?'} (scope "${pending.target_scope ?? stored.scope}") — like rescope (#848).`,
        )
      } else if (writable) {
        sd._outbox = { ...pending, target_url: writable.url, target_scope: newScope, attempt_count: 0, last_error: '' }
      } else {
        delete sd._outbox
        logger.warning(
          `[plur] update of ${stored.id} moved it to "${newScope}", which has no writable remote store — its pending `
          + `delivery to ${pending.target_url ?? '?'} (scope "${pending.target_scope ?? stored.scope}") was CANCELLED. `
          + `Rescope it to a store scope to deliver it.`,
        )
      }
    }
    if (changed) (toWrite as any).structured_data = Object.keys(sd).length > 0 ? sd : undefined
  },

  async setPinned(id: string, pinned: boolean, options?: { scope?: string }): Promise<Engram | null> {
    this._assertWritable()
    await this._remoteOnlyRefuseLocalRow(id, 'Pinning', options?.scope)
    // Which store holds it. Ids are minted per store, so a bare id can name
    // a local engram AND an unrelated remote one; pinning local-first without a
    // check could change the wrong engram silently.
    // `scope: "primary"` = the local row only; a url store's scope = that
    // store only; omitted = local first, refused when the id is ambiguous.
    const targetScope = options?.scope
    if (targetScope !== undefined && (typeof targetScope !== 'string' || targetScope.trim() === '')) {
      throw new TypeError('plur.setPinned: scope must be a non-empty string')
    }
    if (targetScope) this.reloadConfigIfChanged()
    // The resolver's entry over the stores a pin can write to: a readonly
    // store never receives the PATCH, so it does not compete, and a scope two
    // WRITABLE servers claim is refused before either is asked.
    const scopedEntry = targetScope && targetScope !== 'primary'
      ? this._pinTargetEntry(targetScope, `nothing was ${pinned ? 'pinned' : 'unpinned'}`)
      : undefined
    if (targetScope && targetScope !== 'primary' && !scopedEntry) {
      throw new Error(`Cannot pin in scope "${targetScope}": no writable url store is registered for it. Use scope "primary" for the local engram.`)
    }
    // A namespaced id pins in the one store it names —
    // never through another writable store that shares its old prefix.
    if (!targetScope) id = await this._resolveNamespacedId(id, pinned ? 'pin' : 'unpin')
    if (!targetScope && this._hasUrlStore()) {
      const pre = (await this._loadTargeted([id])).find(e => e.id === id)
      if (pre) {
        for (const p of await this._probeIdCollisions(id)) {
          if (p.outcome === 'present') {
            throw new Error(
              `Ambiguous engram ID "${id}": exists in both the local store and remote scope "${p.scope}", so it was `
              + `not ${pinned ? 'pinned' : 'unpinned'}. Pass scope: "primary" for the local engram, or the namespaced id `
              + `${namespaceEngramId(this._stripRemotePrefix(id, p.scope), p.scope)} (or scope: "${p.scope}") for the remote one.`,
            )
          }
          if (p.outcome === 'auth_rejected') {
            const evidence = this._idSeenRemotely(id)
            if (evidence) throw this._rejectedTokenRefusal(p, id, evidence, pinned ? 'pin' : 'unpin', `pass scope: "primary"`)
            logger.warning(`[plur] ${this._rejectedTokenWarning(p, id, pinned ? 'pinned' : 'unpinned')}`)
          }
          if (p.outcome === 'unreachable') {
            logger.warning(`[plur] remote scope "${p.scope}" could not be reached to rule out another engram with id ${id} `
              + `(${p.detail ?? 'no answer'}) — ${pinned ? 'pinning' : 'unpinning'} the LOCAL engram unverified.`)
          }
        }
      }
    }
    // Local primary first (skipped when a remote scope was named).
    const localResult = scopedEntry ? null : await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read: resolving one engram by id.
      const engrams = await this._loadTargeted([id])
      const idx = engrams.findIndex(e => e.id === id)
      if (idx === -1) return null
      const e = engrams[idx]
      // Pinning is a mutation, so it moves `updated_at`.
      const updated: Engram = {
        ...e,
        pinned: pinned === true ? true : undefined,
        updated_at: new Date().toISOString(),
      }
      // Pinned two-tier model: an unpin clears the tier and the priority with
      // the flag. They describe a pin; left behind, a later re-pin would
      // silently restore hard-tier membership without the cap ever being
      // consulted.
      if (pinned !== true) {
        delete (updated as { pinned_tier?: unknown }).pinned_tier
        delete (updated as { pinned_priority?: unknown }).pinned_priority
      }
      // A re-pin of an engram that still carries `pinned_tier: 'hard'` (written
      // before unpin cleared it, or by another path) is a hard-tier write.
      await this._assertHardTierFits(updated)
      engrams[idx] = updated
      // Incremental write: only the (un)pinned engram row changed.
      await this._updateEngrams(engrams, [updated])
      await this._syncIndex()
      return updated
    })
    if (localResult) return localResult
    if (targetScope === 'primary') return null

    let remotePatched: {
      patched: Engram; driver: RemoteStore; serverId: string; scope: string
      /** Whether the engram was pinned BEFORE this call; null when unknown. */
      priorPinned: boolean | null
    } | null = null
    // Remote routing. Strip the namespace prefix
    // before sending the server the unprefixed ID it knows about. Same
    // refusal rule as `_updateEngramReturning`: a namespaced id names ONE
    // store, so its refusal is thrown; a bare id keeps walking and reports
    // null rather than a success that did not happen.
    for (const entry of (scopedEntry ? [scopedEntry] : (this.config.stores ?? []))) {
      if (!entry.url || entry.readonly === true) continue
      // remote-only: a personal or non-team url store is out of reach.
      if (this._remoteOnly && !(scopedEntry ? this._isDeliverableTeamScope(entry.scope) : this._remoteOnlyWalkAllows(entry.scope))) continue
      const serverId = scopedEntry ? this._stripForScope(id, entry.scope) : this._stripRemotePrefix(id, entry.scope)
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      // The team store's host may also hold personal rows under the same token:
      // act on a bare id only when its row there is in a team scope.
      if (this._remoteOnly && !(await this._remoteRowOwnedByTeam(driver, this._stripRemotePrefix(id, entry.scope)))) continue
      try {
        // Awaited; the server's engram is returned and a refusal reaches the `catch`.
        // Send the BOOLEAN, including `false`: a PATCH omits `undefined`, so an unpin would
        // change nothing. Record the prior pin state first (cache, else one GET; pins only)
        // so a refused pin reverts correctly and re-pinning is never refused.
        // A bare id must be this store's row: a readonly store's row must not be pinned here.
        if (!scopedEntry && serverId === id) {
          const current = typeof driver.getById === 'function'
            ? await driver.getById(serverId).catch(() => null)
            : null
          if (current && !this._rowInStore(current, entry)) continue
        }
        let priorPinned: boolean | null = null
        if (pinned === true) {
          const cachedRow = ((driver as unknown as { cache?: { engrams?: Engram[] } | null }).cache?.engrams ?? [])
            .find(e => e.id === serverId)
          const prior = cachedRow ?? (typeof driver.getById === 'function' ? await driver.getById(serverId) : null)
          priorPinned = prior ? (prior as { pinned?: boolean }).pinned === true : null
        }
        const patched = await driver.patch(serverId, { pinned })
        if (!patched) continue
        remotePatched = { patched, driver, serverId, scope: entry.scope, priorPinned }
        break
      } catch (err) {
        if (serverId !== id || scopedEntry) throw err
        continue
      }
    }
    if (!remotePatched) return null
    // Pinned two-tier model: a remote re-pin can restore a hard tier the
    // engram still carries (a partial PATCH cannot clear it on unpin). Only
    // the server's answer says which tier the engram is in, so the cap is
    // checked on it — under the store lock, like every other hard-tier write
    // — and a pin that would overrun the cap is reverted to the state recorded
    // before the PATCH and refused. There is a window between the PATCH and
    // the revert. An engram that was already pinned is not checked: re-pinning
    // it cannot grow the tier. When the prior state is unknown (no cached row,
    // GET failed) the engram is treated as previously unpinned.
    const { patched, driver, serverId, scope, priorPinned } = remotePatched
    if (pinned === true && priorPinned !== true && isHardPinned(patched as never)) {
      try {
        await this._withStoreLock(this.paths.engrams, async () => {
          await this._assertHardTierFits({ ...patched, id: namespaceEngramId(serverId, scope) })
        })
      } catch (err) {
        // Surface a failed revert: swallowing it would report "refused" while
        // the engram stays pinned over the cap on the server.
        let revertError: string | null = null
        try {
          // Back to the recorded prior state. It is "not pinned" here: an
          // engram that was pinned before the call never reaches this check.
          const reverted = await driver.patch(serverId, { pinned: false })
          if (!reverted) revertError = 'the server no longer holds the engram (404)'
        } catch (e) {
          revertError = (e as Error).message
        }
        if (revertError) {
          throw new Error(
            `${(err as Error).message} The pin was applied on the remote store and could NOT be reverted ` +
            `(${revertError}); the engram ${serverId} is still pinned there. Unpin it explicitly.`,
          )
        }
        throw err
      }
    }
    return patched
  },

  async setPinnedAsync(id: string, pinned: boolean, options?: { scope?: string }): Promise<Engram | null> {
    return await this.setPinned(id, pinned, options)
  },

  async listPinned(): Promise<Engram[]> {
    const all = await this._readCorpus()
    return all.filter(e => (e as any).pinned === true && e.status === 'active')
  },

  hardTierCap(): number {
    return pinnedHardCap(
      this.config.injection_budget ?? 2000,
      this.config.injection?.pinned_hard_ratio ?? DEFAULT_PINNED_HARD_RATIO,
      this.config.injection?.pinned_ratio ?? 0.5,
    )
  },

  async _assertHardTierFits(candidate: Engram, pendingTokens = 0): Promise<number> {
    if (!isHardPinned(candidate as never)) return 0
    // A retired (or otherwise non-active) engram is not injected, so it is
    // outside the tier: editing or retiring it must never be refused because
    // the tier is full. listPinned() already excludes such rows from the total.
    if (candidate.status !== undefined && candidate.status !== 'active') return 0
    const cost = estimateTokens(candidate as never)
    const hard = (await this.listPinned()).filter(e => isHardPinned(e as never))
    const previous = hard.find(e => e.id === candidate.id)
    if (previous && cost <= estimateTokens(previous as never)) return cost
    const others = hard.filter(e => e.id !== candidate.id)
    const current = others.reduce((n, e) => n + estimateTokens(e as never), 0) + pendingTokens
    const cap = this.hardTierCap()
    if (current + cost > cap) {
      const list = others.map(e => `${e.id} (${estimateTokens(e as never)} tokens)`).join(', ')
      throw new Error(
        `Hard-tier pinned cap exceeded: the hard tier holds ${current} tokens, ` +
        `this engram costs ${cost}, and the cap is ${cap} ` +
        `(injection.pinned_hard_ratio of the pinned quota). ` +
        `Existing hard-tier engrams: [${list}]. ` +
        `Pin it in the soft tier instead, or unpin a hard-tier engram first.`,
      )
    }
    return cost
  },

  async pinnedQuota(candidateId?: string, options?: { scope?: string }): Promise<{
    quota: number
    used: number
    free: number
    count: number
    over: boolean
    /** Pinned engrams, most-expendable first — the unpin suggestion order. */
    entries: Array<{ id: string; statement: string; cost: number; net_feedback: number; last_accessed: string | null }>
    /** Set when `candidateId` names a not-yet-pinned engram: what pinning it would cost. */
    candidate?: { id: string; cost: number; would_be: number; fits: boolean }
  }> {
    const budget = this.config.injection_budget ?? 2000
    const ratio = this.config.injection?.pinned_ratio ?? 0.5
    const quota = Math.floor(budget * ratio)
    const pinned = await this.listPinned()

    const entries = pinned.map(e => {
      const fb = e.feedback_signals
      return {
        id: e.id,
        statement: e.statement,
        cost: estimateTokens(e as never),
        net_feedback: (fb?.positive ?? 0) - (fb?.negative ?? 0),
        last_accessed: e.activation?.last_accessed ?? null,
      }
    })

    // Ordered by COST, largest first — "what frees the most budget", which is
    // arithmetic. Deliberately NOT an expendability ranking: most engrams are
    // never rated, so a feedback-based sort collapses into noise and can propose
    // unpinning important rules.
    //
    // `net_feedback` and `last_accessed` are still reported per entry, because
    // they are real signals a human can weigh. They are just not a ranking.
    entries.sort((a, b) => b.cost - a.cost)

    const used = entries.reduce((n, e) => n + e.cost, 0)

    let candidate: { id: string; cost: number; would_be: number; fits: boolean } | undefined
    // setPinned refuses a scope two servers claim, so there is
    // no pin to cost — and no server is asked for the row.
    const quotaScope = options?.scope
    const quotaTarget = quotaScope && quotaScope !== 'primary'
      ? resolveScopeTarget(quotaScope, this._pinCandidateStores())
      : undefined
    // An explicit non-primary scope costs a candidate only where setPinned
    // would pin it: a writable url store the resolver selects.
    const pinnable = !quotaTarget || (quotaTarget.kind === 'remote' && quotaTarget.writable)
    if (candidateId && pinnable) {
      // Cost the engram the pin will actually change. A bare
      // id can name a local engram and an unrelated remote one; with a scope,
      // look where that scope says, as setPinned will.
      const scope = quotaScope
      // The store the pin WRITES to: setPinned takes the
      // resolver's writable entry for the scope, so cost that one's row.
      const entry = quotaTarget?.kind === 'remote' && quotaTarget.writable ? quotaTarget.entry : undefined
      // remote-only: only a deliverable team scope's store is asked.
      const bound = this._activeBinding()
      const e = bound && entry && !this._isDeliverableTeamScope(entry.scope)
        ? null
        : scope === 'primary'
        ? (await this._loadTargeted([candidateId])).find(r => r.id === candidateId) ?? null
        : entry
          ? await this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
            .getById(this._stripForScope(candidateId, entry.scope))
          : await this.getById(candidateId)
      // Already-pinned is a no-op re-pin, not a new commitment — it must not
      // be charged twice or it would refuse itself.
      if (e && (e as { pinned?: boolean }).pinned !== true) {
        const cost = estimateTokens(e as never)
        candidate = { id: e.id, cost, would_be: used + cost, fits: used + cost <= quota }
      }
    }

    return {
      quota, used, free: Math.max(0, quota - used),
      count: entries.length, over: used > quota, entries,
      ...(candidate ? { candidate } : {}),
    }
  },

  async repairContentHashes(opts: { apply?: boolean } = {}): Promise<{
    scanned: number
    stale: Array<{ id: string; statement: string }>
    missing: Array<{ id: string; statement: string }>
    unhashable: Array<{ id: string; statement: string }>
    repaired: number
  }> {
    const apply = opts.apply === true
    if (apply) this._assertWritable()
    return await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const stale: Array<{ id: string; statement: string }> = []
      const missing: Array<{ id: string; statement: string }> = []
      const unhashable: Array<{ id: string; statement: string }> = []
      const changed: Engram[] = []
      for (const e of engrams) {
        if (!e.statement) continue
        const current = (e as { content_hash?: string }).content_hash
        if (!isHashable(e.statement)) {
          unhashable.push({ id: e.id, statement: e.statement })
          continue
        }
        const correct = computeContentHash(e.statement)
        if (!current) missing.push({ id: e.id, statement: e.statement })
        else if (current !== correct) stale.push({ id: e.id, statement: e.statement })
        else continue
        if (apply) {
          ;(e as { content_hash?: string }).content_hash = correct
          changed.push(e)
        }
      }
      if (apply && changed.length > 0) {
        // `engrams` was loaded INSIDE this lock, so the fallback whole-corpus
        // write is of a current snapshot.
        await this._updateEngrams(engrams, changed)
        await this._syncIndex()
      }
      return { scanned: engrams.length, stale, missing, unhashable, repaired: changed.length }
    })
  },
}
