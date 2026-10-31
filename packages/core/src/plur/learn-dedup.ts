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
   * append source, persist to primary store if that's where the engram lives.
   * Mutates the engram and (best-effort) writes back. See issue #107. */
/** @internal */
_recordDuplicate(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined, statement?: string): Promise<Engram>

/**
   * May a cross-scope hit (#176) absorb a write INTO `scope`? Not when `scope`
   * is backed by a writable remote store (R2-Integrations, applied by
   * R2-CoreA): the write is then an explicit egress to a team store, and
   * absorbing it into a local engram of another scope meant the team never
   * received it — no POST, nothing queued (replayed for learn() and
   * learnRouted()). The same-scope dedup still applies there.
   */
/** @internal */
_crossScopeRecurrenceApplies(scope: string): boolean

/** Find an active engram with the same content_hash but a DIFFERENT scope.
   * A hit indicates cross-context recurrence — the same knowledge is being
   * re-learned across scopes, which is evidence of universal applicability.
   * See issue #176. */
/** @internal */
_crossScopeRecurrenceDetect(statement: string, engrams: Engram[], currentScope: string): Engram | null

/**
   * #1268: a shared-scope save that matched an engram in another scope. The
   * match is credited as a recurrence (counted, a `validated_by` source,
   * commitment escalated by the ladder up to `recurrence.max_commitment`) and
   * the team copy is written anyway. Decision A1 (2026-09-29): this holds for
   * EVERY match — personal, global, or another team's engram — so a team save
   * always reaches its own team store. The user may then hold several engrams
   * with the same text; that is intended.
   */
/** @internal */
_isTeamValidation(scope: string, _hit: Engram): boolean

/** Decision A3 (2026-09-29): the ladder's ceiling, from `recurrence.max_commitment`. */
/** @internal */
_maxRecurrenceCommitment(): 'locked' | 'decided'

/**
   * One step up the commitment ladder (exploring → leaning → decided →
   * locked), never past `recurrence.max_commitment`, and never into `locked`
   * while `lockBlocked` (an unresolved tension, #181).
   */
/** @internal */
_stepCommitment(c: Engram['commitment'] | undefined, lockBlocked: boolean): Engram['commitment']

/**
   * #1268 guard: an engram bound for a remote team store — queued in the
   * outbox for one, served by one, or in a scope a url store is registered for
   * — must never be rewritten to `global` by the recurrence ladder. Otherwise
   * the outbox pushes `scope: global` into the team store.
   */
/** @internal */
_isTeamStoreBound(e: Engram): boolean

/**
   * #1268 copy-on-promote. `hit` is an engram the ladder would broaden to
   * global, but either it is bound for a team store (what is in a team store
   * stays there) or a global engram with the same text already exists. Leave
   * `hit` in its scope, store and file, and credit a `global` engram in the
   * LOCAL primary store instead — the existing twin if there is one, else a
   * copy created now.
   *
   * Decision A2 (2026-09-29, "both"): a team engram still QUEUED for its store
   * (an `_outbox` row in the primary store) also records the recurrence on
   * itself — count and source only; its scope, commitment and outbox entry
   * are kept — before the global copy is created or credited.
   *
   * The copy links back with `derived_from: <hit id>` (the existing lineage
   * field) and its first source carries `promoted_from: <hit scope>`.
   * Commitment is escalated as the ladder would, up to
   * `recurrence.max_commitment` (decision A3). The
   * copy is appended directly — never given an `_outbox` marker — and its
   * scope is `global`, which no team store serves, so it is never pushed.
   *
   * Carried from `hit`: statement, type, domain, tags, rationale, the validity
   * window (`valid_from`/`valid_until` — an expiring team engram must not yield
   * a copy that never expires), `knowledge_anchors` and `dual_coding` (content
   * that cites and explains the statement). NOT carried: `pinned` — a pin is
   * the owner's own injection-budget choice and is quota-gated, so a
   * teammate's pin must not spend it — and `relations`, whose edges name
   * team-store ids and whose `supersedes` edges have side effects; the copy's
   * one edge is `derived_from`.
   *
   * Uses the same id allocation and storage seams as `learn()`: on a store
   * with the write-path seams it asks the store for the id and never loads the
   * corpus (review finding 3).
   */
/** @internal */
_promoteTeamCopy(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined, twin: Engram | null): Promise<Engram>

/** The store capability set `learn()` delegates on (#828) — see there. */
/** @internal */
_canDelegateLearn(): boolean

/**
   * An active `global` engram in the primary store with `hit`'s text (#1268
   * review finding 2). Asked of the store when it has the seam, so this never
   * loads the corpus there; otherwise found in the corpus in hand.
   */
/** @internal */
_findGlobalTwin(hit: Engram, engrams: Engram[]): Promise<Engram | null>

/** Record a cross-scope recurrence: append source, increment counters,
   * escalate commitment, and broaden scope to 'global' once the threshold
   * is crossed — except for a row still queued for a remote store (`_outbox`),
   * whose scope is never changed (decision D3). Returns the (possibly
   * broadened) engram.
   *
   * Escalation ladder (graduated, not all-at-once):
   * - 1st cross-scope hit:   record source + recurrence_count++  (no scope/commitment change)
   * - 2nd+ cross-scope hit:  + broaden scope → 'global'
   *                          + escalate commitment one step (leaning → decided → locked)
   *
   * Locked engrams stop escalating (you can't promote past locked).
   *
   * See issue #176.
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
   * Deliberately NOT a reset. The previous implementation set the failure count
   * to zero, which under concurrent calls means one success cancels every
   * failure recorded by calls still in flight — the breaker then never trips
   * however badly the LLM is behaving. Successes now only fail to *add* to the
   * window; failures leave it by aging out.
   */
/** @internal */
_recordLlmSuccess(): void
}

export const learnDedupMethods: LearnDedupMethods & ThisType<Plur> = {
async _recordDuplicate(hit: Engram, engrams: Engram[], scope: string, context: LearnContext | undefined, statement = ''): Promise<Engram> {
    // Apply the increment to the row from the CALLER'S array, not to `hit`.
    //
    // `hit` is the match the caller found, and on the remote route that search
    // ran OUTSIDE the write lock — so by the time we are here it may be a stale
    // copy of a row another writer has since changed. Mutating `hit` and
    // splicing it in (`engrams[idx] = hit`, as this did) writes the pre-lock
    // snapshot over the fresh row and reverts that other change: a concurrent
    // `feedback` increment simply disappears, with both calls reporting success.
    //
    // Reading the current row out of `engrams` and incrementing THAT keeps the
    // read-modify-write inside the lock, where it belongs.
    const idx = engrams.findIndex(e => e.id === hit.id)
    const target = idx !== -1 ? engrams[idx] : hit

    // Use defaults for engrams migrated without these fields.
    // write_count was named reference_count before #866.
    const currentCount = target.write_count ?? 1
    const currentSources = (target as any).sources ?? []
    target.write_count = currentCount + 1
    ;(target as any).sources = [...currentSources, this._buildSourceEntry(scope, context)]
    // #852: an absorbed write left NO trace — no engram_created, no
    // recurrence_detected, nothing. That silence is why a misdirected
    // absorption could run for months without anyone seeing it, and it is the
    // difference between "a duplicate was counted" and "my memory vanished".
    // The caller is handed an engram it did not write; the log should say so.
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
      // Incremental write (#740): only the duplicate-counted engram changed.
      await this._updateEngrams(engrams, [target])
      await this._syncIndex()
    } else {
      // A hit in a WRITABLE secondary (path) store is persisted there, under
      // that store's lock with the load inside it (core-index#8, round 2).
      // forget() decrements write_count in secondary stores and cross-scope
      // recurrence persists its increment there; counting this increment only
      // in memory made the pair asymmetric — two writers, one forget, retired,
      // and the second writer's reference (#107) was gone. Packs, readonly
      // stores and other scopes' remote rows never reach here (Decision A:
      // they do not absorb a write); the writable remote of this very scope
      // is counted in memory only, as before (a remote retire is a whole
      // DELETE; the server owns its row).
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
    // Same guard as `_hashDedup` (#896): an unhashable statement would report
    // every other unhashable statement as the same fact recurring, and this
    // path ESCALATES on a hit — broadening scope to global and hardening
    // commitment. A false positive here is louder than a missed one.
    if (!isHashable(statement)) return null
    const hash = computeContentHash(statement)
    // #1268: for a SHARED write, a shared hit is preferred. Either way the hit
    // is only CREDITED — decision A1 (2026-09-29): a team save is never
    // absorbed, not even into another team's engram. See `_isTeamValidation`.
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
    // as `feedback.ts` `nextCommitment` (formal replay, field-report cluster 1).
    switch (c as string | undefined) {
      case undefined:   return 'leaning'
      case 'exploring': return 'leaning'
      case 'leaning':   return 'decided'
      case 'decided':   return lockBlocked || this._maxRecurrenceCommitment() === 'decided' ? 'decided' : 'locked'
      default:          return c   // 'locked', 'draft', and anything unknown: unchanged
    }
  },

_isTeamStoreBound(e: Engram): boolean {
    // Owner decision (2026-09-29): what is in a team store stays there. A team
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

    // A2: the queued team row records the recurrence on itself.
    const h = hit as any
    // Tension gate (#181) at every escalation site: an unresolved tension on
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

    // #1268 copy-on-promote (owner decision 2026-09-29): what is in a team
    // store stays there. When this hit would broaden a team-bound engram to
    // global, the team engram is left untouched and a global copy in the local
    // primary store takes the promotion instead.
    //
    // The same path handles a global twin (review finding 2): when a global
    // engram with the same text already exists, broadening `hit` in place
    // would make a second one. The existing global engram is credited instead
    // and `hit` is left where it is.
    if (((hit as any).recurrence_count ?? 0) + 1 >= 2 && isSharedScope(hit.scope)) {
      const twin = await this._findGlobalTwin(hit, engrams)
      if (twin || this._isTeamStoreBound(hit)) {
        return await this._promoteTeamCopy(hit, engrams, scope, context, twin)
      }
    }

    // Audit iter-4 fix (Critic + Data convergence): mutate ONCE on the canonical
    // writable target (primary or secondary store engram), then sync hit from
    // the post-mutation state. Eliminates:
    //   - Iter-3 holdover: primary path did `engrams[primaryIdx] = hit` (Zod-
    //     defaulted overwrite of raw stored object) while secondary mutated
    //     in place — asymmetric semantics + accumulated schema drift on primary.
    //   - Iter-4 Critic HIGH: double-mutation against two independent objects
    //     (hit + storeEngrams[sidx]) is correct today only because each call
    //     reads fresh from disk. Mutating once removes that implicit contract.
    //   - Iter-4 Critic LOW: locked_at timestamps diverged by µs between hit
    //     and stored. Single mutation → single timestamp.
    //
    // applyMutation is pure-ish: takes everything it needs as parameters,
    // returns the new recurrence count so callers don't need to read back via
    // unsafe cast.
    const sourceEntry: { scope: string; session_id: string | null; stored_at: string; validated_by?: string } =
      this._buildSourceEntry(scope, context)
    if (teamValidation) sourceEntry.validated_by = scope
    const lockTimestamp = new Date().toISOString()
    // #181 (audit #213 item 3): an engram in an unresolved persisted tension
    // must not escalate INTO 'locked' — contradicted knowledge freezing at
    // the top of the commitment ladder is exactly the failure #213 feared.
    // Escalation caps at 'decided' until the tension is resolved/dismissed.
    const lockBlockedByTension = this.hasUnresolvedTension(hit.id)
    const applyMutation = (e: Engram, source: typeof sourceEntry, lockedAt: string): number => {
      const newRecurrence = ((e as any).recurrence_count ?? 0) + 1
      ;(e as any).recurrence_count = newRecurrence
      e.write_count = (e.write_count ?? 1) + 1
      ;(e as any).sources = [...((e as any).sources ?? []), source]

      if (newRecurrence >= 2) {
        // Only promote SHARED scopes (project:*, space:*, etc.) to global —
        // personal-family scopes (local, user:*) stay within their family.
        // See issue #362 item (ii): personal-scope ceiling for cross-scope recurrence.
        //
        // Decision D3 "no-widen" (2026-09-26): never widen a row that still
        // carries `_outbox` — it is queued for a team store under its current
        // scope. #1268 extends the guard to every engram bound for a team store;
        // `_isTeamStoreBound` covers the `_outbox` case too.
        if (isSharedScope(e.scope) && !this._isTeamStoreBound(e)) e.scope = 'global'
        if (e.commitment !== 'locked') {
          // Forward-only ladder: exploring → leaning → decided → locked, capped
          // by `recurrence.max_commitment` (decision A3, 2026-09-29) — team
          // validations included.
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
    // Definite-assignment asserted: every branch below assigns both, but one of
    // those branches now runs inside the secondary store's lock callback, which
    // TypeScript cannot prove is invoked. The alternative — threading both
    // values out through the callback's return type — obscures the control flow
    // for no benefit, since the callback is awaited on the same line.
    let persistedTo!: PersistenceTarget
    let newRecurrence!: number

    if (primaryIdx !== -1) {
      // Primary store: mutate the engram in the loaded array (symmetric with
      // secondary path — both mutate the on-disk-bound object, not hit).
      const target = engrams[primaryIdx]
      newRecurrence = applyMutation(target, sourceEntry, lockTimestamp)
      // Incremental write (#740): only the recurrence-escalated engram changed.
      await this._updateEngrams(engrams, [target])
      await this._syncIndex()
      persistedTo = 'primary'
      // Audit iter-5 fix (Data finding 1): explicit identity guard makes the
      // self-assign no-op contract visible. When _loadAllEngrams and the primary
      // engrams array share references, target IS hit and syncing is redundant;
      // the guard documents the assumption without changing behavior today.
      if (target !== hit) syncHitFrom(target)
    } else {
      // primaryIdx already proved this isn't in primary; only check writability.
      const storeInfo = await this._findEngramStore(hit.id, (hit as any)._storeScope)
      if (storeInfo && !storeInfo.readonly) {
        // Under the SECONDARY store's own lock. This read-modify-write had none
        // at all, while the identical operation on the primary store took one:
        // two processes recording recurrence on the same team engram both
        // loaded, both mutated, and both wrote — and because `_writeEngrams`
        // replaces the whole file, whatever the other added in between was
        // deleted outright, not merely overwritten.
        await this._withStoreLock(storeInfo.path, async () => {
        const storeEngrams = await this._storeAt(storeInfo.path).load()
        const sidx = storeEngrams.findIndex(e => e.id === storeInfo.originalId)
        // Audit iter-5 defense (Critic low #3): _crossScopeRecurrenceDetect
        // filters status==='active' at the entry point, but a cross-process
        // race could retire the secondary-store copy between detection and
        // mutation. Treat retired-on-arrival the same as not-found.
        if (sidx !== -1 && storeEngrams[sidx].status === 'active') {
          newRecurrence = applyMutation(storeEngrams[sidx], sourceEntry, lockTimestamp)
          await this._writeEngrams(storeInfo.path, storeEngrams)
          await this._syncIndex()
          persistedTo = 'secondary'
          if (storeEngrams[sidx] !== hit) syncHitFrom(storeEngrams[sidx])
        } else {
          // Audit iter-5 fix (Data finding 3): index/store divergence is a
          // data-consistency defect, not a transient warning. logger.error so
          // it surfaces above default WARNING filters in production.
          //
          // Ternary order: the sidx === -1 arm fires first when sidx is
          // out-of-bounds, so storeEngrams[sidx].status in the else arm is
          // safe (only reached when sidx is a valid index but status != active).
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
        // Readonly or remote — apply to hit only. Since Decision A (owner,
        // 2026-09-27) learn()/learnRouted() never route such a hit here: a
        // pack / readonly / other-remote match gets a new row instead and a
        // history-only note (`_noteUnpersistableRecurrence`). Kept as the
        // defensive fallback for a hit whose store vanished meanwhile.
        newRecurrence = applyMutation(hit, sourceEntry, lockTimestamp)
        persistedTo = 'in-memory'
      }
    }

    // History event for observability.
    //
    // Iter-1 fix (Critic): only emit on material change (scope or commitment)
    // to avoid spam from already-global+locked engrams.
    //
    // Iter-3 fix (Data): include `persisted_to` so consumers can audit whether
    // the mutation actually landed on disk.
    //
    // Iter-4 fix (Data): ALSO emit when persistedTo='in-memory' even without a
    // material change. An in-memory-only mutation is observable divergence even
    // on the 1st cross-scope hit (counter incremented but stored remote/readonly
    // engram lags). The 'primary'/'secondary' no-change case still skips to
    // avoid spam — those mutations are durable so no observability gap exists.
    //
    // Iter-5 design note: in production with many readonly stores, a session
    // that hits N readonly engrams once each emits N history events (1 per
    // appendHistory file write). Consumers concerned about emission rate
    // should filter on data.persisted_to !== 'in-memory' or on material change
    // (data.previous_scope !== data.new_scope). Acceptable tradeoff because
    // the alternative — silent in-memory mutations — was the iter-3 Data
    // observability gap.
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
