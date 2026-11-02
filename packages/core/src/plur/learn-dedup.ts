import { computeContentHash, isHashable } from '../content-hash.js'
import { engramIdDatePrefix, generateEngramId } from '../engrams.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import type { Engram } from '../schemas/engram.js'
import { isScopeWithin, isSharedScope } from '../scope-util.js'
import type {
    LearnContext
} from '../types.js'
import { LLM_BREAKER_COOLDOWN_MS, LLM_BREAKER_THRESHOLD, LLM_BREAKER_WINDOW_MS } from './helpers.js'

export interface LearnDedupMethods {
  /** Apply a duplicate-write to an existing engram: increment write_count,
   * append source, persist to the store the engram lives in.
   * Mutates the engram and (best-effort) writes back. */
  /** @internal */
  _recordDuplicate(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined, statement?: string): Promise<Engram>

  /**
   * May a cross-scope hit absorb a write INTO `scope`? Not when `scope` is
   * backed by a writable remote store: the write is then an explicit egress to
   * a team store, and absorbing it into a local engram of another scope would
   * mean the team never receives it. The same-scope dedup still applies there.
   */
  /** @internal */
  _crossScopeRecurrenceApplies(scope: string): boolean

  /** Find an active engram with the same content_hash but a DIFFERENT scope.
   * A hit indicates cross-context recurrence — the same knowledge is being
   * re-learned across scopes, which is evidence of universal applicability. */
  /** @internal */
  _crossScopeRecurrenceDetect(statement: string, engrams: Engram[], currentScope: string): Engram | null

  /**
   * A shared-scope save that matched an engram in another scope. The match is
   * credited as a recurrence (counted, a `validated_by` source, commitment
   * escalated by the ladder up to `recurrence.max_commitment`) and the team
   * copy is written anyway. This holds for EVERY match — personal, global, or
   * another team's engram — so a team save always reaches its own team store.
   * The user may then hold several engrams with the same text; that is
   * intended.
   */
  /** @internal */
  _isTeamValidation(scope: string, _hit: Engram): boolean

  /** The ladder's ceiling, from `recurrence.max_commitment`. */
  /** @internal */
  _maxRecurrenceCommitment(): 'locked' | 'decided'

  /**
   * One step up the commitment ladder (exploring → leaning → decided →
   * locked), never past `recurrence.max_commitment`, and never into `locked`
   * while `lockBlocked` (an unresolved tension).
   */
  /** @internal */
  _stepCommitment(c: Engram['commitment'] | undefined, lockBlocked: boolean): Engram['commitment']

  /**
   * An engram bound for a remote team store — queued in the
   * outbox for one, served by one, or in a scope a url store is registered for
   * — must never be rewritten to `global` by the recurrence ladder. Otherwise
   * the outbox pushes `scope: global` into the team store.
   */
  /** @internal */
  _isTeamStoreBound(e: Engram): boolean

  /**
   * Copy-on-promote: `hit` would broaden to global but is bound for a team store (which keeps its content) or has a
   * global twin. Leave `hit` as is and credit a `global` engram in the LOCAL primary store — the twin, else a new copy.
   * - A team engram still queued (`_outbox`) also records the recurrence on itself (count and source only).
   * - The copy has `derived_from: <hit id>`, `promoted_from` on its first source, commitment escalated up to
   *   `recurrence.max_commitment`, no `_outbox` marker, scope `global` — so it is never pushed.
   * - Carried: statement, type, domain, tags, rationale, validity window, `knowledge_anchors`, `dual_coding`.
   *   NOT carried: `pinned` (owner's quota), `relations` (team ids). Uses `learn()`'s id/storage seams (no corpus load).
   */
  /** @internal */
  _promoteTeamCopy(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined, twin: Engram | null): Promise<Engram>

  /** The store capability set `learn()` delegates on — see there. */
  /** @internal */
  _canDelegateLearn(): boolean

  /**
   * An active `global` engram in the primary store with `hit`'s text. Asked
   * of the store when it has the seam, so this never
   * loads the corpus there; otherwise found in the corpus in hand.
   */
  /** @internal */
  _findGlobalTwin(hit: Engram, engrams: Engram[]): Promise<Engram | null>

  /** Record a cross-scope recurrence: append source, increment counters, escalate commitment, broaden scope.
   * - 1st cross-scope hit: record source + recurrence_count++ only.
   * - 2nd+: broaden scope to 'global' and escalate commitment one step (leaning → decided → locked; locked stops).
   * A row still queued for a remote store (`_outbox`) never changes scope. Returns the (possibly broadened) engram.
   */
  /** @internal */
  _recordCrossScopeRecurrence(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined): Promise<Engram>

  /** @internal */
  _isLlmDedupAvailable(): boolean

  /** @internal */
  _recordLlmFailure(): void

  /**
   * Record a successful LLM call.
   *
   * Deliberately NOT a reset: under concurrent calls a reset would let one
   * success cancel every failure recorded by calls still in flight, and the
   * breaker would never trip. Successes only fail to *add* to the window;
   * failures leave it by aging out.
   */
  /** @internal */
  _recordLlmSuccess(): void
}

export const learnDedupMethods: LearnDedupMethods & ThisType<Plur> = {
  async _recordDuplicate(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined, statement = ''): Promise<Engram> {
    // Apply the increment to the row from the CALLER'S array, not to `hit`.
    // On the remote route `hit` was found OUTSIDE the write lock and may be a
    // stale copy; writing it over the fresh row would revert a concurrent
    // change (e.g. a `feedback` increment). Incrementing the current row keeps
    // the read-modify-write inside the lock.
    const idx = engrams.findIndex(e => e.id === hit.id)
    const target = idx !== -1 ? engrams[idx] : hit

    // Use defaults for engrams migrated without these fields.
    // write_count was formerly named reference_count.
    const currentCount = target.write_count ?? 1
    const currentSources = (target as any).sources ?? []
    target.write_count = currentCount + 1
    ;(target as any).sources = [...currentSources, this._buildSourceEntry(scope, context)]
    // Record the absorption: the caller is handed an engram it did not write,
    // and without a trace a misdirected absorption is indistinguishable from
    // lost memory.
    try {
      this._appendHistory({
        event: 'engram_duplicate_absorbed',
        engram_id: target.id,
        timestamp: new Date().toISOString(),
        data: {
          matched_on: 'content_hash',
          write_count_after: target.write_count,
          scope,
          // Enough to spot a misdirected absorption without storing the
          // incoming statement verbatim.
          incoming_preview: statement.slice(0, 120),
        },
      })
    } catch { /* history is an audit trail, never a gate on the write */ }

    // Persist where the engram lives.
    if (idx !== -1) {
      // Incremental write: only the duplicate-counted engram changed.
      await this._updateEngrams(engrams, [target])
      await this._syncIndex()
    } else {
      // A hit in a WRITABLE secondary (path) store is persisted there, under
      // that store's lock with the load inside it. forget() decrements
      // write_count in secondary stores and cross-scope recurrence persists its
      // increment there, so counting this only in memory would let one forget
      // retire an engram two writers referenced. Packs, readonly stores and
      // other scopes' remote rows never reach here (they do not absorb a
      // write); the writable remote of this very scope is counted in memory
      // only (a remote retire is a whole DELETE; the server owns its row).
      // Lock order primary → secondary, same as `_recordCrossScopeRecurrence`.
      const storeInfo = await this._findEngramStore(hit.id, (hit as any)._storeScope)
      if (storeInfo && storeInfo.path !== this.paths.engrams && !storeInfo.readonly) {
        const sourceEntry = ((target as any).sources as unknown[]).at(-1)
        await this._withStoreLock(storeInfo.path, async () => {
          const storeEngrams = await this._storeAt(storeInfo.path).load()
          const row = storeEngrams.find(e => e.id === storeInfo.originalId)
          if (!row || row.status !== 'active') return
          row.write_count = (row.write_count ?? (row as any).reference_count ?? 1) + 1
          ;(row as any).sources = [...((row as any).sources ?? []), sourceEntry]
          await this._writeEngrams(storeInfo.path, storeEngrams)
          await this._syncIndex()
          // The caller gets the persisted count, not the pre-lock guess.
          target.write_count = row.write_count
          ;(target as any).sources = (row as any).sources
        })
      }
    }
    return target
  },

  _crossScopeRecurrenceApplies(scope: string): boolean {
    return !this._isRemoteWriteScope(scope)
  },

  _crossScopeRecurrenceDetect(statement: string, engrams: Engram[], currentScope: string): Engram | null {
    // Same guard as `_hashDedup`: an unhashable statement would report
    // every other unhashable statement as the same fact recurring, and this
    // path ESCALATES on a hit — broadening scope to global and hardening
    // commitment. A false positive here is louder than a missed one.
    if (!isHashable(statement)) return null
    const hash = computeContentHash(statement)
    // For a SHARED write, a shared hit is preferred. Either way the hit is
    // only CREDITED — a team save is never absorbed, not even into another
    // team's engram. See `_isTeamValidation`.
    const sharedWrite = isSharedScope(currentScope)
    let fallback: Engram | null = null
    for (const e of engrams) {
      if (e.status === 'active'
          && (e as any).content_hash === hash
          && e.scope !== currentScope) {
        if (!sharedWrite || isSharedScope(e.scope)) return e
        fallback ??= e
      }
    }
    return fallback
  },

  _isTeamValidation(scope: string, _hit: Engram): boolean {
    return isSharedScope(scope)
  },

  _maxRecurrenceCommitment(): 'locked' | 'decided' {
    return (this.config as any).recurrence?.max_commitment === 'decided' ? 'decided' : 'locked'
  },

  _stepCommitment(c: Engram['commitment'] | undefined, lockBlocked: boolean): Engram['commitment'] {
    // Only the four ladder rungs advance. `draft` (pending human approval) and
    // any unknown/extension value are not the ladder's to move — the same rule
    // as `feedback.ts` `nextCommitment`.
    switch (c as string | undefined) {
      case undefined:   return 'leaning'
      case 'exploring': return 'leaning'
      case 'leaning':   return 'decided'
      case 'decided':   return lockBlocked || this._maxRecurrenceCommitment() === 'decided' ? 'decided' : 'locked'
      default:          return c   // 'locked', 'draft', and anything unknown: unchanged
    }
  },

  _isTeamStoreBound(e: Engram): boolean {
    // What is in a team store stays there. A team
    // store is any url store or any `shared: true` file-path store; an engram
    // it serves, or one queued for it, keeps its scope. The ladder may still
    // credit it, and a personal/global copy can exist alongside.
    const a = e as any
    if (a.structured_data?._outbox) return true
    const teamStores = (this.config.stores ?? []).filter(s => !!s.url || s.shared === true)
    if (teamStores.some(s => isScopeWithin(e.scope, s.scope))) return true
    if (typeof a._storeScope === 'string' && teamStores.some(s => s.scope === a._storeScope)) return true
    return false
  },

  async _promoteTeamCopy(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined, twin: Engram | null): Promise<Engram> {
    const source = this._buildSourceEntry(scope, context)
    const lockedAt = new Date().toISOString()
    const step = (e: any, lockBlocked: boolean, count: number): void => {
      e.commitment = this._stepCommitment(e.commitment, lockBlocked)
      if (e.commitment === 'locked' && !e.locked_at) {
        e.locked_at = lockedAt
        e.locked_reason = `Auto-locked: cross-scope recurrence detected (${count}x)`
      }
    }

    // A queued team row records the recurrence on itself.
    const h = hit as any
    // Tension gate at every escalation site: an unresolved tension on
    // the SOURCE engram blocks the copy's — or the twin's — step into locked,
    // as it blocks the in-place promotion it replaces.
    const sourceTension = this.hasUnresolvedTension(hit.id)
      || (typeof h._originalId === 'string' && this.hasUnresolvedTension(h._originalId))
    let hitCount = h.recurrence_count ?? 0
    if (h.structured_data?._outbox) {
      let row = engrams.find(e => e.id === hit.id) as any
      if (!row && this._primaryStore.loadByIds) row = (await this._primaryStore.loadByIds([hit.id]))[0]
      if (row) {
        row.recurrence_count = (row.recurrence_count ?? 0) + 1
        row.write_count = (row.write_count ?? 1) + 1
        row.sources = [...(row.sources ?? []), source]
        hitCount = row.recurrence_count - 1
        await this._updateEngrams(engrams, [row as Engram])
      }
    }

    if (twin) {
      const e = twin as any
      e.recurrence_count = (e.recurrence_count ?? 0) + 1
      e.write_count = (e.write_count ?? 1) + 1
      e.sources = [...(e.sources ?? []), source]
      step(e, sourceTension || this.hasUnresolvedTension(twin.id), e.recurrence_count)
      await this._updateEngrams(engrams, [twin])
      await this._syncIndex()
      return twin
    }

    const now = new Date().toISOString()
    const ps = this._primaryStore
    const id = this._canDelegateLearn()
      ? await ps.nextEngramId!(engramIdDatePrefix())
      : generateEngramId(engrams, this._mintedTodayIds())
    this._rememberMintedId(id)
    const copy: Engram = {
      ...this._buildEngramShape(hit.statement, 'global', {
        scope: 'global',
        type: hit.type,
        domain: hit.domain,
        tags: hit.tags,
        rationale: h.rationale,
        knowledge_anchors: h.knowledge_anchors?.length ? h.knowledge_anchors : undefined,
        dual_coding: h.dual_coding,
        derived_from: hit.id,
        commitment: hit.commitment,
      } as LearnContext, now, {
        ...(h.temporal?.valid_from ? { valid_from: h.temporal.valid_from } : {}),
        ...(h.temporal?.valid_until ? { valid_until: h.temporal.valid_until } : {}),
      }, eid => this._ancestorsOf(engrams, eid), 'default'),
      id,
    }
    const c = copy as any
    c.recurrence_count = hitCount + 1
    c.write_count = (h.write_count ?? 1) + 1
    step(c, sourceTension, c.recurrence_count)
    c.sources = [
      { scope: hit.scope, session_id: null, stored_at: now, promoted_from: hit.scope },
      source,
    ]
    await this._appendEngram(engrams, copy)
    await this._syncIndex()
    this._appendHistory({
      event: 'engram_created',
      engram_id: id,
      timestamp: now,
      data: { type: copy.type, scope: 'global', source: copy.source, promoted_from: { engram_id: hit.id, scope: hit.scope } },
    })
    return copy
  },

  _canDelegateLearn(): boolean {
    const ps = this._primaryStore
    return Boolean(ps.findActiveByContentHash && ps.nextEngramId && ps.append && ps.updateMany && ps.loadByIds)
  },

  async _findGlobalTwin(hit: Engram, engrams: Engram[]): Promise<Engram | null> {
    if (!isHashable(hit.statement)) return null
    const hash = (hit as any).content_hash ?? computeContentHash(hit.statement)
    if (this._canDelegateLearn()) {
      return await this._primaryStore.findActiveByContentHash!(hash, 'global')
    }
    return engrams.find(e => e.status === 'active' && e.scope === 'global'
      && e.id !== hit.id && (e as any).content_hash === hash) ?? null
  },

  async _recordCrossScopeRecurrence(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined): Promise<Engram> {
    const previousScope = hit.scope
    const previousCommitment = hit.commitment
    const teamValidation = this._isTeamValidation(scope, hit)

    // Copy-on-promote: what is in a team store stays there. When this hit
    // would broaden a team-bound engram to global, the team engram is left
    // untouched and a global copy in the local primary store takes the
    // promotion instead.
    //
    // The same path handles a global twin: when a global engram with the same
    // text already exists, broadening `hit` in place would make a second one.
    // The existing global engram is credited instead and `hit` is left where
    // it is.
    if (((hit as any).recurrence_count ?? 0) + 1 >= 2 && isSharedScope(hit.scope)) {
      const twin = await this._findGlobalTwin(hit, engrams)
      if (twin || this._isTeamStoreBound(hit)) {
        return await this._promoteTeamCopy(hit, engrams, scope, context, twin)
      }
    }

    // Mutate ONCE on the canonical writable target (primary or secondary store
    // engram), then sync `hit` from the post-mutation state. One mutation keeps
    // the stored object and `hit` consistent (including a single locked_at
    // timestamp) and avoids overwriting the raw stored object with a
    // schema-defaulted copy.
    //
    // applyMutation takes everything it needs as parameters and returns the
    // new recurrence count, so callers don't need to read it back.
    const sourceEntry: { scope: string; session_id: string | null; stored_at: string; validated_by?: string } =
      this._buildSourceEntry(scope, context)
    if (teamValidation) sourceEntry.validated_by = scope
    const lockTimestamp = new Date().toISOString()
    // An engram in an unresolved persisted tension must not escalate INTO
    // 'locked': contradicted knowledge must not freeze at the top of the
    // commitment ladder. Escalation caps at 'decided' until the tension is
    // resolved/dismissed.
    const lockBlockedByTension = this.hasUnresolvedTension(hit.id)
    const applyMutation = (e: Engram, source: typeof sourceEntry, lockedAt: string): number => {
      const newRecurrence = ((e as any).recurrence_count ?? 0) + 1
      ;(e as any).recurrence_count = newRecurrence
      e.write_count = (e.write_count ?? 1) + 1
      ;(e as any).sources = [...((e as any).sources ?? []), source]

      if (newRecurrence >= 2) {
        // Only promote SHARED scopes (project:*, space:*, etc.) to global —
        // personal-family scopes (local, user:*) stay within their family.
        //
        // Never widen an engram bound for a team store (including a row that
        // still carries `_outbox`, queued under its current scope).
        if (isSharedScope(e.scope) && !this._isTeamStoreBound(e)) e.scope = 'global'
        if (e.commitment !== 'locked') {
          // Forward-only ladder: exploring → leaning → decided → locked, capped
          // by `recurrence.max_commitment` — team validations included.
          e.commitment = this._stepCommitment(e.commitment, lockBlockedByTension)
          if (lockBlockedByTension && e.commitment === 'decided') {
            logger.info(`[plur:tensions] lock escalation blocked for ${e.id} — unresolved tension (#181)`)
          }
          if (e.commitment === 'locked' && !e.locked_at) {
            e.locked_at = lockedAt
            e.locked_reason = `Auto-locked: cross-scope recurrence detected (${newRecurrence}x)`
          }
        }
      }
      return newRecurrence
    }

    // Helper: project the post-mutation fields from one engram onto another.
    // Bounded to the fields applyMutation touches — no risk of carrying
    // undefined into the target since applyMutation guarantees these are set.
    const syncHitFrom = (mutated: Engram): void => {
      hit.scope = mutated.scope
      hit.commitment = mutated.commitment
      ;(hit as any).recurrence_count = (mutated as any).recurrence_count
      hit.write_count = mutated.write_count
      ;(hit as any).sources = (mutated as any).sources
      ;(hit as any).structured_data = (mutated as any).structured_data
      if (mutated.locked_at !== undefined) hit.locked_at = mutated.locked_at
      if (mutated.locked_reason !== undefined) hit.locked_reason = mutated.locked_reason
    }

    type PersistenceTarget = 'primary' | 'secondary' | 'in-memory'
    const primaryIdx = engrams.findIndex(e => e.id === hit.id)
    // Definite-assignment asserted: every branch below assigns both, but one
    // runs inside the secondary store's lock callback, which TypeScript cannot
    // prove is invoked. The callback is awaited on the same line.
    let persistedTo!: PersistenceTarget
    let newRecurrence!: number

    if (primaryIdx !== -1) {
      // Primary store: mutate the engram in the loaded array (symmetric with
      // secondary path — both mutate the on-disk-bound object, not hit).
      const target = engrams[primaryIdx]
      newRecurrence = applyMutation(target, sourceEntry, lockTimestamp)
      // Incremental write: only the recurrence-escalated engram changed.
      await this._updateEngrams(engrams, [target])
      await this._syncIndex()
      persistedTo = 'primary'
      // When the primary engrams array shares references with `hit`, target IS
      // hit and syncing is redundant.
      if (target !== hit) syncHitFrom(target)
    } else {
      // primaryIdx already proved this isn't in primary; only check writability.
      const storeInfo = await this._findEngramStore(hit.id, (hit as any)._storeScope)
      if (storeInfo && !storeInfo.readonly) {
        // Under the SECONDARY store's own lock: `_writeEngrams` replaces the
        // whole file, so two unlocked writers recording recurrence on the same
        // team engram would delete each other's changes.
        await this._withStoreLock(storeInfo.path, async () => {
        const storeEngrams = await this._storeAt(storeInfo.path).load()
        const sidx = storeEngrams.findIndex(e => e.id === storeInfo.originalId)
        // A cross-process race could retire the secondary-store copy between
        // detection (which filters status==='active') and mutation. Treat
        // retired-on-arrival the same as not-found.
        if (sidx !== -1 && storeEngrams[sidx].status === 'active') {
          newRecurrence = applyMutation(storeEngrams[sidx], sourceEntry, lockTimestamp)
          await this._writeEngrams(storeInfo.path, storeEngrams)
          await this._syncIndex()
          persistedTo = 'secondary'
          if (storeEngrams[sidx] !== hit) syncHitFrom(storeEngrams[sidx])
        } else {
          // Index/store divergence is a data-consistency defect, not a
          // transient warning: logger.error so it surfaces above default
          // WARNING filters.
          //
          // The sidx === -1 arm is checked first, so storeEngrams[sidx] in the
          // other arm is a valid index.
          const reason = sidx === -1
            ? 'not found in store file'
            : `is ${storeEngrams[sidx].status} in store file (expected active)`
          logger.error(
            `[plur:recurrence] engram ${hit.id} (originalId=${storeInfo.originalId}) `
            + `${reason} at ${storeInfo.path} — mutation stayed in-memory only`,
          )
          newRecurrence = applyMutation(hit, sourceEntry, lockTimestamp)
          persistedTo = 'in-memory'
        }
        })
      } else {
        // Readonly or remote — apply to hit only. learn()/learnRouted() never
        // route such a hit here (a pack / readonly / other-remote match gets a
        // new row and a history-only note via `_noteUnpersistableRecurrence`);
        // this is the defensive fallback for a hit whose store vanished
        // meanwhile.
        newRecurrence = applyMutation(hit, sourceEntry, lockTimestamp)
        persistedTo = 'in-memory'
      }
    }

    // History event for observability. Emitted on a material change (scope or
    // commitment), or whenever the mutation stayed in memory only — that is
    // observable divergence between the counter and the stored engram even
    // without a material change. Durable no-change mutations are skipped to
    // avoid spam. `persisted_to` tells consumers whether the mutation landed
    // on disk; filter on it to limit volume from many readonly stores.
    const scopeChanged = hit.scope !== previousScope
    const commitmentChanged = hit.commitment !== previousCommitment
    if (scopeChanged || commitmentChanged || persistedTo === 'in-memory') {
      this._appendHistory({
        event: 'recurrence_detected',
        engram_id: hit.id,
        timestamp: lockTimestamp,
        data: {
          previous_scope: previousScope,
          new_scope: hit.scope,
          previous_commitment: previousCommitment ?? null,
          new_commitment: hit.commitment ?? null,
          recurrence_count: newRecurrence,
          from_scope: scope,
          persisted_to: persistedTo,
        },
      })
    }

    return hit
  },

  _isLlmDedupAvailable(): boolean {
    if (this._llmDisabledUntil !== null) {
      if (Date.now() < this._llmDisabledUntil) return false
      this._llmDisabledUntil = null
      this._llmFailures = []
    }
    return true
  },

  _recordLlmFailure(): void {
    const now = Date.now()
    // Age out failures older than the window, then count what is left. Purely
    // additive — nothing here erases a failure another in-flight call recorded.
    this._llmFailures = this._llmFailures.filter(t => now - t < LLM_BREAKER_WINDOW_MS)
    this._llmFailures.push(now)
    if (this._llmFailures.length >= LLM_BREAKER_THRESHOLD) {
      this._llmDisabledUntil = now + LLM_BREAKER_COOLDOWN_MS
      logger.warning('LLM dedup circuit breaker tripped — disabled for 1 hour')
    }
  },

  _recordLlmSuccess(): void {
    const now = Date.now()
    this._llmFailures = this._llmFailures.filter(t => now - t < LLM_BREAKER_WINDOW_MS)
  },
}
