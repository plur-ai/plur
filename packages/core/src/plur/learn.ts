import type { LearnAsyncDeps } from '../learn-async.js'
import { randomUUID } from 'crypto'
import { computeContentHash } from '../content-hash.js'
import { engramIdDatePrefix, generateEngramId, namespaceEngramId } from '../engrams.js'
import { buildTemporal, resolveValidity, type ResolvedValidity } from '../expiry.js'
import { searchTextFrom } from '../fts.js'
import { type GitScopeOutcome } from '../git-origin.js'
import { Plur } from '../index.js'
import { isHardPinned } from '../inject.js'
import { logger } from '../logger.js'
import { classifyOutboxFailure } from '../outbox-health.js'
import {
    tokenHealthKey
} from '../remote-recall.js'
import { formatSaveDestination } from '../save-destination.js'
import type { Engram } from '../schemas/engram.js'
import { type ScopeSource } from '../scope-routing.js'
import { isSharedScope } from '../scope-util.js'
import type { SecretMatch } from '../secrets.js'
import { resolveScopeTarget, urlGroupsForScope } from '../store-resolver.js'
import { normalizeEndpointUrl, RemoteAbortedError, RemoteHttpError, RemoteStore, TOKEN_ENV_UNSET_RE, tokenEnvUnsetMessage } from '../store/remote-store.js'
import { autoSummary } from '../summary.js'
import type { TensionPair } from '../tensions.js'
import type {
    LearnAsyncContext,
    LearnAsyncResult,
    LearnBatchResult,
    LearnContext,
    LlmFunction
} from '../types.js'
import { buildAttribution, buildProvenanceBlock, DEFAULT_REMOTE_WRITE_TIMEOUT_MS, relatedIds, TYPE_TO_COGNITIVE, TYPE_TO_MEMORY_CLASS } from './helpers.js'
import { type LearnDelivery, type LearnRoutedOptions, type OutboxReasonCode, type SecondarySupersede } from './types.js'

export interface LearnMethods {
  learn(statement: string, context?: LearnContext): Promise<Engram>

  /**
   * Async learn that returns the canonical engram — server-assigned ID
   * for remote-routed writes, locally-built engram for local writes.
   *
   * Use this from async callers (MCP handlers, OpenClaw plugins, etc.)
   * when the user later needs to reference the engram by ID (forget,
   * feedback, history). The sync `learn()` returns a local-placeholder
   * ID for remote-routed writes — the actual server engram has a
   * different ID, so feedback/forget against the placeholder fails.
   *
   * Local writes: just delegates to sync learn(). Same dedup, same
   * history append, same return shape.
   *
   * Remote writes: bypasses local YAML entirely. POSTs to the remote's
   * /api/v1/engrams, awaits the server's response, and returns an
   * Engram with the server-assigned id. Throws on remote failure
   * (caller knows the write didn't land — better UX than a fire-and-
   * forget that pretends success and leaves the user with a phantom ID).
   */
  /**
   * Report the closest existing engrams to a statement — REPORTING ONLY.
   *
   * `plur_learn` goes through {@link learnRouted} → sync `learn()`, which has
   * only exact content-hash dedup; `learnAsync` (and therefore the similarity
   * pass) is reachable solely from `plur_learn_batch`.
   *
   * This gives that path the same observation the batch path gets, without
   * giving either the power to suppress a write. Never throws: similarity is an
   * optimisation, and a reporting failure must not affect a write that has
   * already happened.
   *
   * @param excludeId engram to omit — pass the just-written id so it does not
   *                  match itself at 1.0.
   */
  nearDuplicates(statement: string, context?: LearnContext, excludeId?: string): Promise<{ mode: 'cosine' | 'hash-only'; near_duplicates?: Array<{ id: string; score: number }> }>

  learnRouted(statement: string, context?: LearnContext, options?: LearnRoutedOptions): Promise<Engram>

  /**
   * The commit half of `learnRouted`'s remote route: POST, or on failure save
   * locally with an outbox marker. `lockHeld` says whether the caller already
   * holds the primary store lock (a hard-tier write does, so its admission
   * check and its fallback save observe one state); the lock is not reentrant,
   * so the fallback takes it only when the caller does not.
   */
  /** @internal */
  _commitRemoteRouted(localPlaceholder: Engram, remoteDriver: RemoteStore, scope: string, now: string, allEngrams: Engram[], unpersistableHit: Engram | null, lockHeld: boolean, remoteTimeoutMs?: number, attemptedTokenFp?: string): Promise<Engram>

  /**
   * Where a learn result went, and a warning when that is not where a reader
   * would assume.
   *
   * A write to a shared scope (`group:`, `project:`, `org:` …) with no writable
   * url store registered for exactly that scope falls through to the local
   * primary store. That is deliberate — nothing is auto-routed into a shared
   * store — but silently, a team save could sit on one machine indefinitely
   * while the caller was told only `ADD`. This reports it.
   *
   * Pure: reads the returned engram and the store config, never the network,
   * and changes nothing about where anything was written. Pass the object
   * `learn()` / `learnRouted()` returned; a copy loses the `remote` evidence.
   *
   * `requestedScope`: the scope the caller asked for. When the save
   * came back as an engram in a DIFFERENT scope — recorded as a recurrence on
   * another team's engram, or on a `global` one — nothing was written to the
   * requested shared scope, so the result is `local` for that scope and the
   * warning names the requested scope, not the one it landed in. A sensitive-
   * content demotion is excluded: it already carries its own warning.
   */
  deliveryOf(engram: Engram, requestedScope?: string, folder?: GitScopeOutcome | null): { destination: string; delivery: LearnDelivery; warning?: string; reason?: string; reason_code?: OutboxReasonCode; host?: string; }

  /** @internal */
  _deliveryDetails(engram: Engram, requestedScope?: string): {
    delivery: LearnDelivery
    warning?: string
    /** Only for `outbox`: why it was queued, in plain words, with what to do. */
    reason?: string
    reason_code?: OutboxReasonCode
    /** Only for `remote`: the server that holds it — the normalized endpoint
     *  (no userinfo), as recall's `remote.hosts[].host` names it. Absent when
     *  this process cannot tell. */
    host?: string
  }

  /**
   * The id shape the READ paths hand back for an engram.
   *
   * A store's engrams are namespaced with `ENG-{storePrefix(scope)}-` on load,
   * so `recall` returns `ENG-GPL-2026-08-13-025` where the write path returned
   * the server's own `ENG-2026-08-13-025`. Core keeps returning the server id
   * from `learnRouted` — that is the id the remote actually holds, and callers
   * that talk to the store need it — but a surface that reports an id back to a
   * caller alongside `recall` results should report the form `recall` uses, or
   * a caller recording what it just wrote ends up holding a shape no read path
   * produced.
   *
   * Returns the id unchanged when the scope is not backed by a REMOTE store:
   * a locally-written engram keeps a local id, and the read paths hand that one
   * back as it is. This mirrors `_isRemoteBackedScope`'s exact-scope rule, so
   * the two agree on which writes leave the machine.
   */
  /**
   * Why an outbox engram was queued, from the failure recorded on it.
   * Pure: reads `_outbox`, never the network. Uses the outbox classifier so
   * this line, `plur outbox` and `plur doctor` agree on the cause.
   */
  /** @internal */
  _outboxReason(engram: Engram): { reason: string; reason_code: OutboxReasonCode }

  readIdFor(engram: { id: string; scope: string }): string

  /**
   * THE engram constructor — the one place the shape of a new engram is
   * written down.
   *
   * Builds without persisting: `learn()` spreads the result and sets the id it
   * minted; `learnRouted()` posts it to the remote, which assigns the id, and
   * on failure mints a local id for the outbox copy. Neither acquires the
   * lock nor touches disk here. `validity` is taken from callers that
   * already resolved it — learn() fails fast on a malformed window before
   * taking the lock — and derived otherwise.
   */
  /** @internal */
  _buildEngramShape(statement: string, scope: string, context: LearnContext | undefined, now: string, validity?: ResolvedValidity, ancestorsOf?: (id: string) => string[], scopeSource?: ScopeSource): Engram

  /** Build deps for learn-async module. */
  /** @internal */
  _learnAsyncDeps(): Promise<LearnAsyncDeps>

  /** @internal */
  _learnAsyncDepsAll(): Promise<LearnAsyncDeps>

  /** Async learn with LLM-driven deduplication. */
  learnAsync(statement: string, context?: LearnAsyncContext): Promise<LearnAsyncResult>

  /** Batch learn with LLM dedup. LLM calls are capped (default 50) to bound bulk-import cost. */
  learnBatch(statements: Array<{ statement: string; context?: LearnAsyncContext }>, llm?: LlmFunction, opts?: { maxLlmCalls?: number }): Promise<LearnBatchResult>
}

export const learnMethods: LearnMethods & ThisType<Plur> = {
  async learn(statement: string, context?: LearnContext): Promise<Engram> {
    this._assertWritable()
    statement = this._validateLearnInput('learn', statement, context)
    const guarded = await this._guardSensitiveScope(statement, context)
    this._refuseScopeConflict(guarded.scope)
    context = guarded.context
    // Resolve the validity window up-front (pure) so malformed
    // valid_from/valid_until fail fast — even when the write would dedup
    // into an existing engram below.
    const validity = resolveValidity(statement, context)

    return await this._withStoreLock(this.paths.engrams, async () => {
      const scope = guarded.scope
      const ps = this._primaryStore
      // Can the store answer BOTH derived facts `learn()` needs — "is this
      // statement already here in this scope" and "what is the next id" —
      // without the corpus, AND take every write `learn()` performs as a
      // targeted row operation?
      //
      // It is a capability SET, not a pair, and every member is load-bearing.
      // The derive seams are jointly required because each of the two facts is
      // otherwise read off the SAME materialised corpus — delegating one still
      // pays the full load for the other. The write seams are required because
      // every fallback below (`_appendEngram`, `_updateEngrams`,
      // `_writeSupersededByEdges`) takes "the corpus in hand" and, absent a
      // row-level write, turns it into a whole-corpus `save()`. Taking the
      // targeted READ without the targeted WRITE would hand a stand-in array
      // of one or two rows to a FULL REPLACE, deleting the corpus — the reason
      // `_reactivateResults` checks its pair rather than each half.
      // remote-only: never the store's own content-hash lookup, which would
      // answer from personal rows in the team scope.
      const canDelegate = this._learnCanDelegate() && !this._remoteOnly
      // The primary corpus, or an empty stand-in when nothing below will read
      // or rewrite it. Safe ONLY under `canDelegate` — see above.
      const engrams = canDelegate ? [] : await ps.load()
      // Secondary stores and packs are NOT the primary corpus. They are small,
      // separately loaded, and no seam speaks for them, so they are scanned in
      // memory in both modes; only the primary half moves into the store.
      const allEngrams = this._remoteOnly
        ? await this._writeDedupCorpus(scope)
        : canDelegate
          ? await this._loadSecondaryAndPacks()
          : await this._loadAllEngrams()

      // Content hash fast-path dedup (scope-aware). On dedup hit, mutate:
      // increment write_count, append source.
      //
      // The store is asked first, matching the corpus order it replaces
      // (`_loadAllEngrams` puts primary rows ahead of secondary ones, so a
      // primary match wins).
      // Unhashable statements skip the store lookup entirely — the
      // delegated query has the same collapse the in-memory scan does, and
      // this is the branch a Postgres/PGLite install takes.
      const { primaryHashMatch, hashMatch, foreign: sameScopeForeign } =
        await this._learnHashMatch(statement, scope, canDelegate, allEngrams)
      if (hashMatch) {
        // `hashMatch` is a row the writer can persist (primary, a
        // writable secondary store, or the writable remote of this very
        // scope); a pack / readonly / other-remote match never gets here.
        // The store-served hit is a freshly-read row under this same lock, so
        // it is the corpus in hand for exactly one row.
        const corpusInHand = primaryHashMatch ? [primaryHashMatch] : engrams
        return await this._recordDuplicate(hashMatch, corpusInHand, scope, context, statement)
      }

      // Cross-scope recurrence — same statement, different scope.
      // Treated as evidence of universal applicability: graduates the
      // existing engram toward 'global' + 'locked' commitment instead of
      // creating a new scope-bound duplicate.
      //
      // Under `canDelegate` this sees secondary stores and packs but NOT the
      // primary store, and that is deliberate rather than an oversight of the
      // seam: `findActiveByContentHash` is scope-bound by contract precisely so
      // it cannot disclose another scope's engram, which is the same query
      // cross-scope recurrence needs. A store that opts into the seam is one
      // where scopes are a permission boundary, and broadening one scope's
      // engram to `global` because another scope learned the same sentence is
      // what such a store must not do. So the primary half is skipped, the new
      // statement becomes its own engram, and a deployment that wants
      // graduation declines the seam and keeps the corpus scan.
      // See `PrimaryStore.findActiveByContentHash`.
      //
      // Only a hit the writer can persist graduates; one held in a
      // pack, a readonly store or another scope's remote cache does not absorb
      // the write — it falls through to a new row and is noted in history.
      const cross = await this._crossScopeMatch(statement, allEngrams, scope)
      // `engrams` is empty under delegation, so `_recordCrossScopeRecurrence`
      // takes its secondary-store branch — which is where every match it can
      // still see actually lives.
      if (cross.hit && !this._isTeamValidation(scope, cross.hit)) {
        return await this._recordCrossScopeRecurrence(cross.hit, engrams, scope, context)
      }
      // A shared save credits the engram it matched — personal, global or
      // another team's — and then falls through to write its
      // own team copy below.
      if (cross.hit) await this._recordCrossScopeRecurrence(cross.hit, engrams, scope, context)
      const unpersistableHit = sameScopeForeign ?? cross.foreign

      // A supersede proposed by the duplicate checker never lands on a memory
      // that is locked — checked here, under the store lock, so a lock taken
      // after the checker read the target still wins. The caller sees the
      // dropped target missing from `relations.supersedes` and sends the pair
      // to review instead.
      //
      // When a target is locked the new memory is saved as a DRAFT in this
      // same write, so it is never deliverable, not between this write and the
      // caller's review step, and not after a crash at that boundary.
      //
      // Each target is checked in the store that holds it. A target in a
      // writable secondary store keeps the supersede, and its reverse edge is
      // written in that store (`_landSecondarySupersedes`, right before the new
      // row is written). A target whose store cannot take the reverse edge
      // (readonly store, pack, remote cache) is not superseded at all: nothing
      // there would suppress it, so the new memory is linked to it instead.
      let secondarySupersedes: SecondarySupersede[] = []
      if (context?.supersedes_unless_locked && context.supersedes?.length) {
        const wanted = context.supersedes
        const primaryRows = canDelegate ? await ps.loadByIds!(wanted) : engrams
        const keep: string[] = []
        const linkOnly: string[] = []
        let lockedSeen = false
        for (const t of wanted) {
          const p = primaryRows.find(e => e.id === t)
          if (p) {
            if (p.commitment === 'locked') lockedSeen = true
            else keep.push(t)
            continue
          }
          const seen = allEngrams.find(e => e.id === t) as (Engram & { _storeScope?: string; _pack?: string }) | undefined
          const info = seen && !seen._pack && typeof seen._storeScope === 'string'
            ? await this._findEngramStore(t, seen._storeScope)
            : null
          if (info && info.path !== this.paths.engrams) {
            // The target's own store, read fresh rather than from the cache.
            const row = (await this._storeAt(info.path).load()).find(e => e.id === info.originalId)
            if (row?.commitment === 'locked') { lockedSeen = true; continue }
            if (row && row.status === 'active' && !info.readonly && !this._readonly) {
              keep.push(t)
              secondarySupersedes.push({ id: t, path: info.path, originalId: info.originalId })
              continue
            }
          } else if (seen?.commitment === 'locked') {
            lockedSeen = true
            continue
          }
          linkOnly.push(t)
        }
        if (keep.length !== wanted.length) {
          context = {
            ...context,
            supersedes: keep,
            ...(linkOnly.length ? { related: [...new Set([...(context.related ?? []), ...linkOnly])] } : {}),
            ...(lockedSeen ? { commitment: 'draft' as const } : {}),
          }
        }
      }

      const id = canDelegate
        ? await ps.nextEngramId!(engramIdDatePrefix())
        // remote-only: `allEngrams` leaves out most of the primary store, whose
        // ids a queued (outbox) row must still not collide with.
        : generateEngramId([...engrams, ...allEngrams], await this._idsInUse())
      // Claim it in-process immediately. The history record is written
      // later and best-effort; without this, two writes in the same tick — or
      // one whose history append fails — could both take the same suffix.
      this._rememberMintedId(id)
      const now = new Date().toISOString()
      // One constructor for every write path: `_buildEngramShape` is what the
      // remote route posts, so a field added there is a field added here.
      const engram: Engram = {
        ...this._buildEngramShape(statement, scope, context, now, validity, id => this._ancestorsOf(engrams, id), guarded.scopeSource),
        id,
      }
      // Hard-tier cap: AFTER dedup (a re-learn that folds into an existing
      // engram creates no row and must not be charged), on the engram as it
      // will be committed, and inside the lock the write commits under.
      await this._assertHardTierFits(engram)

      // supersedes is a graph edge, not a temporality enum — write the reverse
      // superseded_by edge on each target found in the local primary store
      // (best-effort; targets living in other stores are not patched). The
      // tension scanner skips supersedes-linked pairs: an intentional update is
      // not a contradiction. The mutated targets are collected so the
      // incremental write path below can persist them explicitly — on a store
      // with `append`, writing only the new engram would silently drop these
      // back-edges.
      //
      // Under delegation `engrams` is empty, so the targets are fetched by id.
      // Dropping the back-edges instead would fail quietly:
      // `supersedes` would still be recorded on the new engram and the reverse
      // edge would simply never appear, which reads as data corruption rather
      // than as a disabled feature.
      const supersededTargets = context?.supersedes?.length
        ? this._writeSupersededByEdges(
            canDelegate ? await ps.loadByIds!(context.supersedes) : engrams,
            context.supersedes,
            id,
          )
        : []

      // Stamp the demotion marker so the plur_learn MCP
      // response can tell the agent its engram was held back from the shared scope
      // it asked for. Set only on a direct learn() whose own guard demoted.
      if (guarded.demotion) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _demoted: guarded.demotion,
        }
      }

      // Stamp the auto-route marker so the plur_learn MCP
      // response can tell the agent its genuinely-unscoped write was routed to a
      // covers-matched scope by suggestScope (not chosen by the caller).
      // Mirrors _demoted; both can be present when an auto-routed shared scope
      // was then demoted for sensitive content.
      if (guarded.routed) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _routed: guarded.routed,
        }
      }
      // A shared scope matched and was refused. Stamped the same
      // way and only when present, so a caller can report what did NOT happen.
      if (guarded.refusedShared) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _routeRefused: guarded.refusedShared,
        }
      }

      // Multi-store routing (outbox pattern): if the engram's
      // scope matches a writable remote store, save locally with outbox
      // metadata first (durable from this point), then fire-and-forget the
      // remote push. On success the local copy is removed asynchronously;
      // on failure it stays in the outbox for retry at next session start
      // or plur_sync.
      const remoteDriver = this._resolveRemoteStoreForScope(scope)
      if (remoteDriver && context?.visibility === 'private') {
        // Private engrams stay local — sending to a shared remote contradicts
        // the "only I see this" semantics.
        logger.warning(`[plur:learn] private engram not routed to remote (scope=${scope}), writing locally`)
      } else if (remoteDriver) {
        // Defensive lookup, for config drift between resolver-time and
        // outbox-time. The target is the resolver's own writable entry, so it
        // is the server the router dialled, never merely the first one listed.
        const storeEntry = this._remoteWriteEntry(scope)
        const attemptedTokenFp = storeEntry?.token ? tokenHealthKey(storeEntry.token) : undefined
        // Idempotency key for this write: random, minted
        // once, persisted on the outbox entry, never derived from an id.
        const pushKey = randomUUID()
        if (!storeEntry) {
          // Resolver gave us a driver (probably readonly), but we can't queue
          // an outbox entry without a writable target. Skip outbox; the
          // remote driver call below will surface the readonly error.
          logger.warning(`[plur:learn] remote driver resolved for scope=${scope} but no writable entry — skipping outbox`)
        } else {
          ;(engram as any).structured_data = {
            ...((engram as any).structured_data ?? {}),
            _outbox: {
              target_url: storeEntry.url!,
              target_scope: scope,
              queued_at: now,
              last_attempt: now,
              attempt_count: 0,
              last_error: '',
              // One key per logical write, reused by every retry of it.
              idempotency_key: pushKey,
              // A save from a remote-only folder may only be delivered or
              // deleted, never made a local row.
              ...(this._remoteOnly ? { remote_only: true, remote_only_folder: this._remoteOnly.folder } : {}),
            },
          }
        }
        // Incremental write: append the new engram; on a store without
        // `append` this saves the corpus in hand, which already carries the
        // superseded_by back-edges — so the second write below is skipped.
        // Reverse edges in secondary stores, re-checked under that
        // store's lock; undone if the new row cannot be written.
        const undoSecondary = await this._landSecondarySupersedes(engram, secondarySupersedes)
        try { await this._appendEngram(engrams, engram) } catch (err) { await undoSecondary(); throw err }
        if (this._primaryStore.append) {
          await this._updateEngrams(engrams, supersededTargets)
        }
        await this._syncIndex()

        // Fire-and-forget: attempt immediate push, clean up on success.
        //
        // The push and the local bookkeeping are caught SEPARATELY: a failure
        // while removing the local copy after the remote accepted the engram
        // must not be recorded as a failed push, or the outbox retries it and
        // the remote ends up with a duplicate. "The write did not land" and
        // "the write landed but I could not tidy up" must not share a handler.
        //
        // The trailing `.catch()` is load-bearing: the error path below itself
        // awaits a store write, and if THAT throws the IIFE's promise rejects
        // with nothing attached — an unhandled rejection, which terminates the
        // process on modern Node. A background task must not be able to take
        // the host down.
        // Started only once the local write has committed. A
        // transactional primary store would otherwise hand this task the
        // write's own connection, which is gone by the time it runs. A
        // rolled-back write never launches it, so nothing is marked in flight.
        this._afterStoreCommit(() => {
          this._outboxInFlight.add(engram.id)
          void (async () => {
            // One pusher per entry: a flush that started
            // between the local write and this push must not POST it too.
            if (this._claimOutboxEntry(engram.id, () => pushKey).status === 'busy') return
            let pushed = false
            // Keep the id the server assigned — if a forget/rescope
            // cancels the delivery while this POST is on the wire, the accepted
            // remote copy is queued for retirement by that id.
            let serverId: string | undefined
            try {
              ;({ id: serverId } = await remoteDriver.appendAndGetServerId(engram, { idempotencyKey: pushKey }))
              this._noteSeenOnServer([{ id: serverId, scope: engram.scope }])
              pushed = true
              this._noteRemoteWriteSucceeded(remoteDriver.endpointUrl)
            } catch (err) {
              // The POST did not land. The in-flight claim is still held, and is
              // released only by the `finally` below, AFTER this bookkeeping
              // write: released before it, another writer could
              // take the row in the gap and put its own POST on the wire.
              // Already saved locally with outbox metadata — will be retried.
              logger.warning(`[plur:outbox] immediate push failed for ${engram.id}, queued for retry: ${(err as Error).message}`)
              await this._withStoreLock(this.paths.engrams, async () => {
                // Targeted read: only this engram's outbox bookkeeping.
                const fresh = await this._loadTargeted([engram.id])
                const target = fresh.find(e => e.id === engram.id) as any
                if (target?.structured_data?._outbox) {
                  target.structured_data._outbox.last_error = (err as Error).message
                  target.structured_data._outbox.attempt_count = 1
                  // The status, when the remote gave one — it is what
                  // tells a refusal from a blip.
                  if (err instanceof RemoteHttpError) target.structured_data._outbox.last_status = err.status
                  target.structured_data._outbox.last_token_fp = attemptedTokenFp
                }
                if (target?.structured_data?._outbox) {
                  // Incremental write: only the outbox bookkeeping changed.
                  await this._updateEngrams(fresh, [target as Engram])
                }
              })
              this._releaseOutboxClaim(engram.id)
              return
            }

            if (!pushed) return
            // Remote has it. Remove the local copy — and if this fails, say so
            // rather than re-queueing something already accepted.
            try {
              await this._withStoreLock(this.paths.engrams, async () => {
                // NOT `_loadTargeted`: this REMOVES a row, and the only
                // removal primitive `PrimaryStore` has is a whole-corpus save of
                // the array without it. A one-row targeted read here would be a
                // full replace by an empty array — the corpus, deleted. It stays
                // a full load until there is a `remove`/`deleteMany` seam.
                const fresh = await this._primaryStore.load()
                const idx = fresh.findIndex(e => e.id === engram.id)
                // Hand off only a row that is STILL queued FOR THIS STORE. A
                // forget() or a local rescope that landed while the POST was in
                // flight cancelled the delivery; an update or a rescope to
                // another store RETARGETED it — the row still carries `_outbox`,
                // but for a store that has not received it. Deleting the row in
                // either case loses a decision; keep it and say so.
                const pushedTarget = storeEntry ? { url: storeEntry.url!, scope } : undefined
                if (idx !== -1 && !Plur._stillQueuedFor(fresh[idx], pushedTarget)) {
                  const retargeted = Plur._stillQueued(fresh[idx])
                  // Queue a durable "retire on remote" entry for the
                  // copy the remote just accepted; flushOutbox() retries it (and,
                  // for a retargeted row, before it delivers to the new store).
                  const queuedRetire = serverId
                    ? Plur._queueRetireRemote(fresh[idx], {
                        target_url: pushedTarget?.url ?? '',
                        target_scope: scope,
                        server_id: serverId,
                      }, new Date().toISOString())
                    : false
                  if (queuedRetire) await this._updateEngrams(fresh, [fresh[idx]])
                  logger.warning(
                    `[plur:outbox] ${engram.id} reached the remote${serverId ? ` as ${serverId}` : ''} after its delivery `
                    + (retargeted
                      ? `was retargeted to another store during the push. The local record stays queued for the new store`
                      : `was cancelled locally (forget/rescope during the push). The local record is kept`)
                    + (queuedRetire
                      ? `; the old copy is queued for retirement and the next flush retires it.`
                      : `; the remote copy must be retired there.`),
                  )
                  return
                }
                if (idx !== -1) {
                  fresh.splice(idx, 1)
                  // Deliberate removal: the remote accepted this engram, so the
                  // local copy is redundant by design (passes the shrink guard).
                  await this._writeEngrams(this.paths.engrams, fresh, { allowShrink: true })
                  await this._syncIndex()
                }
              })
            } catch (err) {
              // Retried by the next flush with the same key: a
              // key-honouring server collapses it; one that ignores keys may
              // hold one duplicate.
              logger.warning(
                `[plur:outbox] ${engram.id} was accepted by the remote but its local copy could not be removed: `
                + `${(err as Error).message}. The next flush will retry it with the same idempotency key.`,
              )
            } finally {
              this._releaseOutboxClaim(engram.id)
            }
          })().catch(err => {
            logger.warning(`[plur:outbox] background push for ${engram.id} failed unexpectedly: ${(err as Error).message}`)
          }).finally(() => { this._outboxInFlight.delete(engram.id) })
        })

        this._appendHistory({
          event: 'engram_created',
          engram_id: engram.id,
          timestamp: now,
          data: { type: engram.type, scope: engram.scope, source: engram.source, routed_to: 'remote', outbox: true },
        })
        if (unpersistableHit) await this._noteUnpersistableRecurrence(unpersistableHit, scope, engram.id)
        this._maybeWriteProvenance(engram.id)
        return engram
      }

      // Incremental write: same shape as the outbox path above — append
      // the new engram, then persist superseded_by back-edges when the append
      // was targeted (a fallback save already wrote them with the corpus).
      // Reverse edges in secondary stores, re-checked under that
      // store's lock; undone if the new row cannot be written.
      const undoSecondary = await this._landSecondarySupersedes(engram, secondarySupersedes)
      try { await this._appendEngram(engrams, engram) } catch (err) { await undoSecondary(); throw err }
      if (this._primaryStore.append) {
        await this._updateEngrams(engrams, supersededTargets)
      }
      await this._syncIndex()
      this._appendHistory({
        event: 'engram_created',
        engram_id: engram.id,
        timestamp: now,
        data: { type: engram.type, scope: engram.scope, source: engram.source },
      })
      if (unpersistableHit) await this._noteUnpersistableRecurrence(unpersistableHit, scope, engram.id)
      this._maybeWriteProvenance(engram.id)
      return engram
    })
  },

  async nearDuplicates(statement: string, context?: LearnContext, excludeId?: string): Promise<{ mode: 'cosine' | 'hash-only'; near_duplicates?: Array<{ id: string; score: number }> }> {
    // Respect the existing dedup switches. This costs a bounded recall plus one
    // query embedding on every learn, which is a real addition to a hot path —
    // so `dedup.enabled: false` or `mode: 'off'` must turn it off, exactly as
    // they turn off the batch path's similarity pass. Reporting is worth paying
    // for by default; it should not be unavoidable.
    const dedupCfg = this.config.dedup ?? {}
    if (dedupCfg.enabled === false || dedupCfg.mode === 'off') return { mode: 'hash-only' }
    // remote-only: no embedder (see recallSemantic).
    if (this._activeBinding()) return { mode: 'hash-only' }
    try {
      let candidates: Engram[] = []
      try {
        candidates = await this.recall(statement, { limit: 6 })
      } catch { candidates = [] }
      candidates = candidates.filter(c => c.status === 'active' && c.id !== excludeId)
      // Mirror the batch path's scope-awareness.
      if (context?.scope) candidates = candidates.filter(c => c.scope === context.scope)
      if (candidates.length === 0) return { mode: 'hash-only' }

      const query = searchTextFrom({
        statement,
        domain: context?.domain,
        tags: context?.tags,
        rationale: context?.rationale,
        source: context?.source,
        dual_coding: context?.dual_coding as never,
        knowledge_anchors: context?.knowledge_anchors as never,
      })
      const { embeddingSearchWithScores } = await import('../embeddings.js')
      // Dynamic, matching how learn-async is loaded elsewhere in this class —
      // and imported rather than re-declared so both write paths observe at the
      // same floor and the recorded distribution stays comparable.
      const { NEAR_DUPLICATE_OBSERVATION_FLOOR } = await import('../learn-async.js')
      const scored = await embeddingSearchWithScores(candidates, query, candidates.length, this.paths.root)
      if (scored.length === 0) return { mode: 'hash-only' }

      // Carry the neighbour's own text, not just its id. Reporting id+score
      // alone makes "read the neighbour first" an extra tool call, which tends
      // not to get made.
      const ranked = scored
        .map(s => ({
          id: s.engram.id,
          score: s.score,
          statement: s.engram.statement.length > 240
            ? `${s.engram.statement.slice(0, 240)}…`
            : s.engram.statement,
        }))
        .sort((a, b) => b.score - a.score)
      const top = ranked[0]
      if (top.score >= NEAR_DUPLICATE_OBSERVATION_FLOOR) {
        try {
          this._appendHistory({
            event: 'dedup_near_duplicate',
            engram_id: top.id,
            timestamp: new Date().toISOString(),
            data: {
              statement: statement.slice(0, 200),
              top_score: Number(top.score.toFixed(4)),
              scope: context?.scope ?? null,
              incoming_has_domain: Boolean(context?.domain),
              incoming_has_rationale: Boolean(context?.rationale),
              path: 'learn',
            },
          })
        } catch { /* observation only */ }
      }
      return { mode: 'cosine', near_duplicates: ranked.slice(0, 3) }
    } catch (err) {
      logger.warning(`near-duplicate reporting unavailable: ${err}`)
      return { mode: 'hash-only' }
    }
  },

  async learnRouted(statement: string, context?: LearnContext, options?: LearnRoutedOptions): Promise<Engram> {
    // The caller's deadline for the server leg ONLY. Local work (load, dedup,
    // write, index) is never raced: a slow local save is a success. A server
    // that does not answer inside the deadline takes the outbox fallback, so
    // the engram is always stored somewhere.
    const remoteTimeoutMs = options?.remoteTimeoutMs ?? DEFAULT_REMOTE_WRITE_TIMEOUT_MS
    if (!(Number.isFinite(remoteTimeoutMs) && remoteTimeoutMs > 0)) {
      throw new TypeError('plur.learnRouted: remoteTimeoutMs must be a positive number of milliseconds')
    }
    this._assertWritable()
    statement = this._validateLearnInput('learnRouted', statement, context)
    const guarded = await this._guardSensitiveScope(statement, context)
    const scope = guarded.scope
    this._refuseScopeConflict(scope)
    context = guarded.context
    // Fail fast on malformed valid_from/valid_until (pure validation),
    // mirroring learn() — before dedup can short-circuit the write.
    resolveValidity(statement, context)
    const remoteDriver = this._resolveRemoteStoreForScope(scope)
    const attemptedToken = this._remoteWriteEntry(scope)?.token
    const attemptedTokenFp = attemptedToken ? tokenHealthKey(attemptedToken) : undefined
    // An engram the caller explicitly marked private does not go to a remote
    // store, whichever method was called. Take the local route and let
    // learn() apply its private-engram branch.
    if (!remoteDriver || context?.visibility === 'private') {
      // Local route — sync learn() owns dedup, build, write, history. learn()'s
      // own guard sees the already-demoted (local) context and no-ops, so the
      // demotion marker is stamped here for the learnRouted-demoted case.
      const engram = await this.learn(statement, context)
      if (guarded.demotion) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _demoted: guarded.demotion,
        }
      }
      // Mirror the demotion re-stamp for the auto-route marker,
      // so an unscoped local-routed write surfaces its routing decision even if
      // the inner learn() took a dedup/recurrence path that didn't stamp it.
      if (guarded.routed) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _routed: guarded.routed,
        }
      }
      // A shared scope matched and was refused. Stamped the same
      // way and only when present, so a caller can report what did NOT happen.
      if (guarded.refusedShared) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _routeRefused: guarded.refusedShared,
        }
      }
      return engram
    }
    // Remote route — dedup against the merged local+cached-remote view,
    // then POST and merge the server-assigned ID into the local engram
    // representation we hand back to the caller. On failure, save to
    // local outbox for retry.
    const allEngrams = await this._writeDedupCorpus(scope)
    // A same-scope match only in a pack or a readonly store does
    // not absorb the write; it is POSTed and the match noted in history.
    const { hit: hashMatch, foreign: unpersistableHit } = await this._firstPersistableHit(
      allEngrams, this._hashDedupPredicate(statement, scope), scope,
    )
    if (hashMatch) {
      // Mutate + persist if local; otherwise return mutated (best-effort)
      return await this._withStoreLock(this.paths.engrams, async () => {
        const engrams = await this._primaryStore.load()
        return await this._recordDuplicate(hashMatch, engrams, scope, context, statement)
      })
    }
    // Cross-scope recurrence does NOT absorb here: this is the remote
    // route, and an explicit write to a team store must reach it
    // (`_crossScopeRecurrenceApplies`). Only the same-scope match above
    // absorbs a write. A cross-scope hit is still CREDITED.
    const { hit: crossMatch } = await this._crossScopeMatch(statement, allEngrams, scope, { creditOnly: true })
    if (crossMatch) {
      // Decided BEFORE the recurrence is recorded, exactly as learn() does —
      // recording can broaden `crossMatch` to global, and reading the flag
      // afterwards would turn an absorbed save into a second team write.
      const teamValidation = this._isTeamValidation(scope, crossMatch)
      const credited = await this._withStoreLock(this.paths.engrams, async () => {
        const engrams = await this._primaryStore.load()
        return await this._recordCrossScopeRecurrence(crossMatch, engrams, scope, context)
      })
      // A team validation of a non-shared engram does not stand in for the
      // team write — fall through and POST the team copy. Nor does any
      // cross-scope hit for a remote write scope (see above).
      if (!teamValidation && this._crossScopeRecurrenceApplies(scope)) return credited
    }
    const now = new Date().toISOString()
    const localPlaceholder = this._buildEngramShape(statement, scope, context, now, undefined, undefined, guarded.scopeSource)
    // Stamp the auto-route marker on the remote-routed shape so
    // the decision survives onto the server engram and into the MCP response.
    if (guarded.routed) {
      ;(localPlaceholder as any).structured_data = {
        ...((localPlaceholder as any).structured_data ?? {}),
        _routed: guarded.routed,
      }
    }
    if (guarded.refusedShared) {
      ;(localPlaceholder as any).structured_data = {
        ...((localPlaceholder as any).structured_data ?? {}),
        _routeRefused: guarded.refusedShared,
      }
    }
    // Hard-tier cap on the remote route. The engram is built here and POSTed,
    // so this is a write path that produces a hard-tier engram exactly like
    // learn() — and so is the local fallback below. Both run under ONE hold of
    // the store lock, taken only for a hard-tier write so ordinary remote
    // writes keep their lock-free POST. The cost is estimated with an id of
    // the longest shape either outcome can carry (the server's id, or a local
    // one), since neither is known until after the POST.
    if (isHardPinned(localPlaceholder as never)) {
      return await this._withStoreLock(this.paths.engrams, async () => {
        await this._assertHardTierFits({ ...localPlaceholder, id: 'ENG-XXXXXX-0000-00-00-000' })
        return await this._commitRemoteRouted(localPlaceholder, remoteDriver, scope, now, allEngrams, unpersistableHit, true, remoteTimeoutMs, attemptedTokenFp)
      })
    }
    return await this._commitRemoteRouted(localPlaceholder, remoteDriver, scope, now, allEngrams, unpersistableHit, false, remoteTimeoutMs, attemptedTokenFp)
  },

  async _commitRemoteRouted(localPlaceholder: Engram, remoteDriver: RemoteStore, scope: string, now: string, allEngrams: Engram[], unpersistableHit: Engram | null, lockHeld: boolean, remoteTimeoutMs?: number, attemptedTokenFp?: string): Promise<Engram> {
    let serverEngram: Engram
    // Idempotency key for this write. The placeholder's id
    // is `__pending__` on EVERY direct write, so it can never be the key: a
    // server honouring the contract would collapse them all into the first.
    const writeKey = randomUUID()
    try {
      // AbortSignal.timeout is unref'd: it never keeps a one-shot CLI alive.
      const signal = remoteTimeoutMs !== undefined ? AbortSignal.timeout(remoteTimeoutMs) : undefined
      try {
        const { id: serverId } = await remoteDriver.appendAndGetServerId(localPlaceholder, { idempotencyKey: writeKey, signal })
        serverEngram = { ...localPlaceholder, id: serverId }
        this._noteSeenOnServer([{ id: serverId, scope }])
        this._noteRemoteWriteSucceeded(remoteDriver.endpointUrl)
      } catch (inner) {
        // Say what happened in words a person can act on: the caller's
        // deadline passed with no answer. Recorded as the outbox's last_error.
        if (inner instanceof RemoteAbortedError && remoteTimeoutMs !== undefined) {
          throw new Error(`the server did not answer within ${remoteTimeoutMs}ms (unreachable or not responding)`)
        }
        throw inner
      }
    } catch (err) {
      // Remote failed — save locally with outbox metadata for retry.
      // Defensive lookup; the catch is the graceful-fallback path that must
      // never throw. If no writable entry matches the scope (e.g. readonly
      // remote), we still save the local engram but omit the outbox marker —
      // the retry path will skip it. The resolver's writable entry; never throws.
      const storeEntry = this._remoteWriteEntry(scope)
      const saveFallback = async () => {
        const engrams = await this._primaryStore.load()
        localPlaceholder.id = generateEngramId([...engrams, ...allEngrams], await this._idsInUse())
        this._rememberMintedId(localPlaceholder.id)
        if (storeEntry) {
          ;(localPlaceholder as any).structured_data = {
            ...((localPlaceholder as any).structured_data ?? {}),
            _outbox: {
              target_url: storeEntry.url!,
              target_scope: scope,
              queued_at: now,
              last_attempt: now,
              attempt_count: 1,
              last_token_fp: attemptedTokenFp,
              last_error: (err as Error).message,
              // The same key the failed attempt carried: if that POST did land
              // (a timeout after the server stored it), the retry is collapsed.
              idempotency_key: writeKey,
              ...(this._remoteOnly ? { remote_only: true, remote_only_folder: this._remoteOnly.folder } : {}),
              // Recorded so the outbox can be classified without
              // parsing the message.
              ...(err instanceof RemoteHttpError ? { last_status: err.status } : {}),
              // Flag auth failures distinctly so the queue isn't read as a
              // transient network blip — a 401/403 means the token needs reauth,
              // and surfacing it (session_start/doctor) is the actionable signal.
              auth_failed: /\b40[13]\b/.test((err as Error).message),
            },
          }
        } else {
          logger.warning(`[plur:learnRouted] no writable store for scope=${scope} — saving locally without outbox marker`)
        }
        // Incremental write: the fallback engram is new by construction
        // (its id was just minted above).
        await this._appendEngram(engrams, localPlaceholder)
        await this._syncIndex()
        this._appendHistory({
          event: 'engram_created',
          engram_id: localPlaceholder.id,
          timestamp: now,
          data: { type: localPlaceholder.type, scope, source: localPlaceholder.source, routed_to: 'outbox', error: (err as Error).message },
        })
        if (unpersistableHit) await this._noteUnpersistableRecurrence(unpersistableHit, scope, localPlaceholder.id)
        this._maybeWriteProvenance(localPlaceholder.id, localPlaceholder)
        logger.warning(`[plur:outbox] remote write failed for ${localPlaceholder.id}, queued for retry: ${(err as Error).message}`)
        return localPlaceholder
      }
      return lockHeld ? await saveFallback() : await this._withStoreLock(this.paths.engrams, saveFallback)
    }

    // History is appended OUTSIDE the try that guards the remote write: a
    // history failure (EACCES, disk full) after the server persisted the
    // engram must not be caught as a REMOTE failure, or the fallback creates a
    // second local engram plus an outbox entry and the next flush duplicates
    // it remotely. A bookkeeping write must never be able to undo, or appear
    // to undo, a commit that succeeded.
    try {
      this._appendHistory({
        event: 'engram_created',
        engram_id: serverEngram.id,
        timestamp: now,
        data: { type: serverEngram.type, scope: serverEngram.scope, source: serverEngram.source, routed_to: 'remote' },
      })
      if (unpersistableHit) await this._noteUnpersistableRecurrence(unpersistableHit, scope, serverEngram.id)
      this._maybeWriteProvenance(serverEngram.id)
    } catch (err) {
      logger.warning(
        `[plur] engram ${serverEngram.id} was stored remotely but its history record could not be ` +
        `written: ${(err as Error).message}. The engram is safe; the local audit trail is incomplete.`,
      )
    }
    this._remoteDelivered.add(serverEngram)
    this._heldBy.set(serverEngram, remoteDriver.endpointUrl)
    return serverEngram
  },

  deliveryOf(engram: Engram, requestedScope?: string, folder?: GitScopeOutcome | null): { destination: string; delivery: LearnDelivery; warning?: string; reason?: string; reason_code?: OutboxReasonCode; host?: string; } {
    const delivered = this._deliveryDetails(engram, requestedScope)
    const target = resolveScopeTarget(engram.scope, this.config.stores ?? [])
    const ctx = Plur._lockBinding.getStore()
    const git = requestedScope !== undefined ? null
      : folder === undefined ? (ctx?.plur === this ? ctx.git : this._boundGit) : folder
    const demoted = (engram as any).structured_data?._demoted as { from: string } | undefined
    const mismatch = requestedScope && requestedScope !== engram.scope && isSharedScope(requestedScope)
      && !(engram as any).structured_data?._demoted
    const localReason = demoted
      ? `sensitive content was kept private instead of being sent to ${demoted.from}`
      : mismatch ? `recorded on an existing memory in ${engram.scope}; nothing was sent to ${requestedScope}`
      : isSharedScope(engram.scope) && urlGroupsForScope(engram.scope, this.config.stores ?? []).length > 0
        ? `this save was not sent to the store for ${engram.scope}` : undefined
    return { ...delivered, destination: formatSaveDestination({
      delivery: delivered.delivery, scope: engram.scope, server: delivered.host,
      shared: isSharedScope(engram.scope), folder: git,
      unauthorizedOn: target.kind === 'unauthorized' ? target.server : undefined,
      queuedReason: delivered.reason, localReason,
    }) }
  },

  _deliveryDetails(engram: Engram, requestedScope?: string): {
    delivery: LearnDelivery
    warning?: string
    /** Only for `outbox`: why it was queued, in plain words, with what to do. */
    reason?: string
    reason_code?: OutboxReasonCode
    /** Only for `remote`: the server that holds it — the normalized endpoint
     *  (no userinfo), as recall's `remote.hosts[].host` names it. Absent when
     *  this process cannot tell. */
    host?: string
  } {
    const e = engram as any
    const stores = this.config.stores ?? []
    if (requestedScope && requestedScope !== engram.scope && isSharedScope(requestedScope)
        && !e.structured_data?._demoted) {
      return {
        delivery: 'local',
        warning: `You saved to shared scope "${requestedScope}", but this matched an existing engram in ` +
          `"${engram.scope}" and was recorded on it as a recurrence. Nothing was written to ` +
          `"${requestedScope}" or sent to its store, so that team will not see it.`,
      }
    }
    let delivery: LearnDelivery
    if (this._remoteDelivered.has(engram)) delivery = 'remote'
    else if (e.structured_data?._outbox) delivery = 'outbox'
    else if (typeof e._storeScope === 'string') {
      // A dedup/recurrence hit on a row read from a secondary store: it lives
      // wherever the store that SERVED it lives. Classified by the loader's
      // `_fromRemoteStore` marker, never by the scope's first store entry — a
      // url store and a path store can share one scope.
      delivery = e._fromRemoteStore === true ? 'remote' : 'local'
    } else delivery = 'local'
    if (delivery === 'outbox') return { delivery, ...this._outboxReason(engram) }
    if (delivery === 'remote') {
      const held = this._heldBy.get(engram)
      return held ? { delivery, host: normalizeEndpointUrl(held) } : { delivery }
    }
    if (!isSharedScope(engram.scope)) return { delivery }

    const scope = engram.scope
    const target = resolveScopeTarget(scope, stores)
    if (target.kind === 'unauthorized') {
      return {
        delivery,
        warning: `Scope "${scope}" is not granted to you on ${target.server}; this engram was saved on this machine only.`,
      }
    }
    const urlStores = urlGroupsForScope(scope, stores).flat()
    let why: string
    // `visibility` defaults to 'private' on every engram, so it cannot tell an
    // explicitly private write apart here; the store config can.
    if (urlStores.length > 0 && urlStores.every(s => s.readonly === true)) {
      why = 'the store registered for it is read-only, so this engram was saved on this machine only'
    } else if (urlStores.length > 0) {
      why = 'this engram was not sent to the store registered for it (an explicitly private write, or a match ' +
        'with a copy already saved on this machine)'
    } else {
      why = 'no remote store is registered for exactly that scope, so this engram was saved on this machine only'
    }
    return {
      delivery,
      warning: `Scope "${scope}" is shared, but ${why}. No one else will see it. ` +
        `To share this scope, register a writable store for "${scope}" ` +
        `(plur_stores_add with url, token and scope "${scope}", or a url store in ~/.plur/config.yaml). ` +
        `Engrams already saved here are not moved automatically.`,
    }
  },

  _outboxReason(engram: Engram): { reason: string; reason_code: OutboxReasonCode } {
    const ob = (engram as any).structured_data?._outbox as
      { target_scope?: string; last_status?: number; last_error?: string; auth_failed?: boolean } | undefined
    const scope = ob?.target_scope ?? engram.scope
    const v = classifyOutboxFailure({
      last_status: ob?.last_status, last_error: ob?.last_error, scope,
      has_store: (this.config.stores ?? []).some(s => !!s.url && s.scope === scope && s.readonly !== true),
    })
    const status = ob?.last_status
    const queued = `Saved on this machine and queued for ${scope}`
    const unsetVar = TOKEN_ENV_UNSET_RE.exec(ob?.last_error ?? '')?.[1]
    if (unsetVar) {
      return {
        reason_code: 'token_env_unset',
        reason: `${queued}: ${tokenEnvUnsetMessage(unsetVar, scope)}; then run \`plur outbox --flush\`.`,
      }
    }
    if (v.state === 'needs_action' && (status === 401 || status === 403 || ob?.auth_failed === true)) {
      return {
        reason_code: 'auth_rejected',
        reason: `${queued}: the store rejected the token${status ? ` (HTTP ${status})` : ''} — it is expired, revoked or lacks write access. ` +
          `Check it with \`plur login --status\`, refresh the token for ${scope} in config.yaml, then run \`plur outbox --flush\`.`,
      }
    }
    if (v.state === 'needs_action' && v.reason?.startsWith('no writable store')) {
      return { reason_code: 'no_store', reason: `${queued}: ${v.reason}. ${v.next_step ?? ''}`.trim() }
    }
    if (v.state === 'needs_action' || (typeof status === 'number' && status >= 400)) {
      return {
        reason_code: 'server_error',
        reason: `${queued}: ${v.reason ?? `the store answered HTTP ${status}`}.${v.next_step ? ` Next: ${v.next_step}.` : ' It is retried on the next session start or `plur outbox --flush`.'}`,
      }
    }
    return {
      reason_code: 'unreachable',
      reason: `${queued}: the server is unreachable (${ob?.last_error ?? 'no answer'}). ` +
        `It is retried on the next session start or \`plur outbox --flush\`.`,
    }
  },

  readIdFor(engram: { id: string; scope: string }): string {
    // Only a scope a server actually holds: a conflict or an ungranted scope
    // keeps its engram on this machine, under its local id.
    if (resolveScopeTarget(engram.scope, this.config.stores ?? []).kind !== 'remote') return engram.id
    return namespaceEngramId(engram.id, engram.scope)
  },

  _buildEngramShape(statement: string, scope: string, context: LearnContext | undefined, now: string, validity: ResolvedValidity = resolveValidity(statement, context), ancestorsOf: (id: string) => string[] = () => [], scopeSource: ScopeSource = context?.scope != null ? 'explicit' : 'default'): Engram {
    const type = context?.type ?? 'behavioral'
    const cogLevel = TYPE_TO_COGNITIVE[type] ?? 'remember'
    const memoryClass = context?.memory_class ?? TYPE_TO_MEMORY_CLASS[type] ?? 'semantic'
    const commitment = context?.commitment ?? 'leaning'
    const shape: Engram = {
      // Placeholder id — learn() overwrites it with the id it minted and
      // learnRouted with the server's assigned id before anything observes it.
      id: '__pending__',
      version: 2,
      status: 'active',
      consolidated: false,
      type,
      scope,
      // Default visibility to 'private'. This constructor serves the PRIMARY
      // production write path (plur_learn / CLI both go through learnRouted),
      // where `visibility` is never supplied and `domain` usually is; deriving
      // 'public' from `domain` would ship ordinary learns as public.
      visibility: context?.visibility ?? 'private',
      statement,
      rationale: context?.rationale,
      source: context?.source,
      domain: context?.domain,
      temporal: buildTemporal(validity, now),
      activation: {
        retrieval_strength: 0.7,
        storage_strength: 1.0,
        frequency: 0,
        last_accessed: now.slice(0, 10),
      },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_type: { memory_class: memoryClass, cognitive_level: cogLevel as any },
      knowledge_anchors: (context?.knowledge_anchors ?? []).map(a => ({
        path: a.path,
        relevance: (a.relevance as 'primary' | 'supporting' | 'example') ?? 'supporting',
        snippet: a.snippet,
      })),
      associations: [],
      derivation_count: 1,
      tags: context?.tags ?? [],
      pack: null,
      abstract: context?.abstract ?? null,
      derived_from: context?.derived_from ?? null,
      // Who is answerable and what kind of claim this is.
      // Both absent when the caller supplied nothing: a missing agent is
      // honest, a guessed one is not.
      attribution: buildAttribution(context, this._configuredIdentity()),
      claim_class: context?.claim_class,
      provenance: buildProvenanceBlock(context, ancestorsOf),
      dual_coding: context?.dual_coding,
      polarity: null,
      content_hash: computeContentHash(statement),
      commitment,
      locked_at: commitment === 'locked' ? now : undefined,
      locked_reason: commitment === 'locked' ? context?.locked_reason : undefined,
      created_at: now,
      updated_at: now,
      write_count: 1,
      injection_count: 0,
      sources: [this._buildSourceEntry(scope, context)],
      recurrence_count: 0,
      summary: autoSummary(statement, undefined),
      engram_version: 1,
      episode_ids: context?.session_episode_id ? [context.session_episode_id] : [],
      // The forward supersedes edge travels with the remote-routed shape.
      // The reverse superseded_by edge on remote targets is NOT patched
      // (best-effort — see LearnContext.supersedes docs).
      // `related`: batch learning links an item to the memory the
      // duplicate checker said it resembles, instead of overwriting that memory.
      // Forward edge only; the target is not modified.
      // A single id passed as a plain string (an untyped caller) is one id, not
      // a list of characters.
      relations: ((context?.supersedes?.length ?? 0) > 0 || relatedIds(context?.related).length > 0) ? {
        broader: [], narrower: [], related: relatedIds(context?.related), conflicts: [],
        supersedes: [...(context?.supersedes ?? [])], superseded_by: [],
      } : undefined,
      pinned: context?.pinned === true ? true : undefined,
      pinned_tier: context?.pin_tier,
      pinned_priority: context?.pinned_priority,
      // Measurement context — present only when the caller supplies it.
      measured_under: this._validatedMeasuredUnder(context),
    }
    // Echo marker for extracted expiry — mirrors the learn() stamping so the
    // remote-routed MCP response can confirm the parse too.
    //
    // The routing-decision marker is stamped here rather than by each caller:
    // both write paths run through this constructor, so they agree by
    // construction (test/write-path-consolidation.test.ts and
    // test/leak-surface.test.ts hold this).
    //
    // Unlike every other marker it is unconditional: "the caller named it" is
    // as much an answer as "the router guessed it", and a field present on only
    // some writes cannot be read as an answer on the rest.
    ;(shape as any).structured_data = {
      ...(validity.extracted
        ? { _expiry_extracted: { valid_until: validity.extracted.valid_until, phrase: validity.extracted.phrase } }
        : {}),
      _scopeSource: scopeSource,
    }
    return shape
  },

  async _learnAsyncDeps(): Promise<LearnAsyncDeps> {
    const remoteOnly = !!this._remoteOnly
    const deps = await this._learnAsyncDepsAll()
    if (!remoteOnly) return deps
    // remote-only: no LLM UPDATE/MERGE decisions and no
    // similarity pass. Those rewrite rows by id and record statements in the
    // local history; here every item is a hash-checked ADD sent to the team.
    return { ...deps, isLlmAvailable: () => false, similarityScores: undefined }
  },

  async _learnAsyncDepsAll(): Promise<LearnAsyncDeps> {
    return {
      // Only a hit the writer can persist is a NOOP; a pack /
      // readonly / other-remote match falls through to learn(), which stores
      // the write and notes the match in history.
      hashDedup: async (statement: string, scope?: string) => (await this._firstPersistableHit(
        await this._writeDedupCorpus(scope ?? ''), this._hashDedupPredicate(statement, scope), scope,
      )).hit,
      // remote:false — dedup queries are DERIVED FROM STATEMENTS. With the
      // remote leg on, every plur_learn would fire statement-derived POSTs to
      // all hosts, and a namespaced remote row could silently suppress a local
      // write as a "dedup match". Dedup is a local decision.
      //
      // These results are the LLM/cosine candidates learnAsync may
      // NOOP/UPDATE/MERGE into, so only rows the writer can persist are
      // offered. A pack / readonly / other-scope remote-cache row is dropped; with nothing left the write is an
      // ADD through learn(), which notes an exact match in history only.
      // learnAsync keeps only candidates in the requested scope, so each row
      // is judged against its own scope (== the writer's when one is given).
      recallHybrid: async (query: string, options?: { limit?: number }) =>
        this._persistableCandidates(await this.recallHybrid(query, { ...options, remote: false })),
      recall: async (query: string, options?: { limit?: number }) =>
        this._persistableCandidates(await this.recall(query, { ...options, remote: false })),
      learn: (statement: string, context?: LearnContext) => this.learn(statement, context),
      // learnBatch uses this instead of `learn` so remote-scope writes
      // await the server push and return the server-assigned id. See LearnAsyncDeps.learnRouted.
      learnRouted: (statement: string, context?: LearnContext) => this.learnRouted(statement, context),
      getById: (id: string) => this.getById(id),
      store: this._primaryStore,
      engramsPath: this.paths.engrams,
      rootPath: this.paths.root,
      dedupConfig: this.config.dedup ?? {},
      // Local similarity for the no-LLM dedup path. Scores the already
      // fetched candidates rather than the corpus, and reuses the embedding
      // cache, so this costs one query embedding and no API call. Returns []
      // when the embedder is unavailable, which the caller reads as
      // "similarity did not run" rather than "nothing was similar".
      similarityScores: async (statement: string, candidates: Engram[]) => {
        if (candidates.length === 0) return []
        const { embeddingSearchWithScores } = await import('../embeddings.js')
        const scored = await embeddingSearchWithScores(
          candidates,
          statement,
          candidates.length,
          this.paths.root,
        )
        return scored.map(s => ({ id: s.engram.id, score: s.score }))
      },
      isLlmAvailable: () => this._isLlmDedupAvailable(),
      recordLlmSuccess: () => this._recordLlmSuccess(),
      recordLlmFailure: () => this._recordLlmFailure(),
      syncIndex: () => this._syncIndex(),
      offendingHitsForScope: (statement: string, scope: string) => this._offendingHitsForScope(statement, scope),
      sendsToServer: (scope: string) => this._resolveRemoteStoreForScope(scope) !== null,
      // An UPDATE onto a locked memory waits in the review queue the
      // user already resolves (tension records, plur_tensions).
      openReview: async (pair: TensionPair) => (await this.recordTensions([pair])).records[0]?.id,
      holdAsDraft: async (id: string) => {
        const e = await this.getById(id)
        if (e && e.commitment !== 'draft') await this.updateEngram({ ...e, commitment: 'draft' })
      },
    }
  },

  async learnAsync(statement: string, context?: LearnAsyncContext): Promise<LearnAsyncResult> {
    this._assertWritable()
    // remote-only: fill/refuse the scope up front, so the LLM dedup pass only
    // ever compares against (and merges into) the folder's team scope.
    if (this._remoteOnly) context = this._remoteOnlyContext(context)
    const { learnAsync: learnAsyncImpl } = await import('../learn-async.js')
    return learnAsyncImpl(await this._learnAsyncDeps(), statement, this._canonicalLearnContext(context))
  },

  async learnBatch(statements: Array<{ statement: string; context?: LearnAsyncContext }>, llm?: LlmFunction, opts?: { maxLlmCalls?: number }): Promise<LearnBatchResult> {
    this._assertWritable()
    // remote-only: every item is checked BEFORE any is written, so a refused
    // item never leaves the batch half-applied.
    if (this._remoteOnly) statements = statements.map(s => ({ ...s, context: this._remoteOnlyContext(s.context) }))
    const { learnBatch: learnBatchImpl } = await import('../learn-async.js')
    return learnBatchImpl(
      await this._learnAsyncDeps(),
      statements.map(s => ({ ...s, context: this._canonicalLearnContext(s.context) })),
      llm,
      opts,
    )
  },
}
