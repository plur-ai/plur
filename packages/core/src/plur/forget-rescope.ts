import { randomUUID } from 'crypto'
import { computeContentHash } from '../content-hash.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { NEEDS_ACTION_STATUSES } from '../outbox-health.js'
import type { Engram } from '../schemas/engram.js'
import { assertScopeNamesATarget, isLocalOnlyScope } from '../scope-target.js'
import { isSharedScope } from '../scope-util.js'
import { safeOrigin } from '../store-expand.js'
import { resolveScopeTarget } from '../store-resolver.js'
import { normalizeEndpointUrl, RemoteStore } from '../store/remote-store.js'
import type { UploadLocalResult } from '../types.js'
import { REMOTE_PROBE_TIMEOUT_MS } from './helpers.js'
import { MutationOutcome, RescopeOptions, RescopeResult } from './types.js'

export interface ForgetRescopeMethods {
/** Set engram status to 'retired'. Supports primary and store engrams.
   *
   * options.force=true bypasses write_count and retires immediately,
   * regardless of how many sources reference the engram (#766). Use for
   * explicit user-facing forget (MCP plur_forget), where one call = full
   * retirement. The default decrement-until-zero behavior is for internal
   * dedup tracking (two agents learned the same fact; one forgets — the
   * other's reference should remain). */
forget(id: string, reason?: string, options?: { force?: boolean; scope?: string }): Promise<MutationOutcome>

/** Active primary-store rows eligible for an explicit upload proposal. */
listUploadCandidates(authorizedScopes: string[]): Promise<Array<{ id: string; scope: string; statement: string; proposed: string | null }>>

/** Queue selected primary rows through the existing guarded outbox path. */
uploadLocal(ids: string[], opts?: { dryRun?: boolean }): Promise<{ results: UploadLocalResult[] }>

/**
   * Move existing engram(s) to `targetScope` (#676) — the missing primitive
   * between `learn()` (whose content-hash dedup silently no-ops a re-emit
   * under a new scope) and candidate promotion (`plur_promote` ACTIVATES a
   * candidate — it never changes scope).
   *
   * Routing by target:
   *  - REMOTE-backed scope (a writable `stores:` url entry): push a copy via
   *    the routed write path (`appendAndGetServerId` — the server assigns the
   *    id; its own content-hash dedup is relied on, not fought), with
   *    provenance stamped in the copy's `source` field ("rescoped from <id>")
   *    and `structured_data._rescoped_from`. Then, unless `keep_local`,
   *    soft-retire the local source with a `superseded_by` link so it stops
   *    injecting; retired rows are invisible to `_hashDedup`, so the source's
   *    hash cannot resurrect it. Deliberately NO outbox fallback: an explicit
   *    move either lands or fails loud — on push failure the source stays
   *    untouched (atomic semantics, #676 constraint 2).
   *  - LOCAL-family target (`local`, `global`, `project:*`, or the scope of a
   *    configured path store): rewrite `scope` in place under the store lock —
   *    the same incremental update path as `updateEngram`'s local branch — so
   *    id, activation, feedback and history stay attached to the same row.
   *
   * Guards:
   *  - Target validation (#676 constraint 4): a scope that is neither
   *    local-family nor backed by a configured store fails EARLY with a
   *    structured error — never a silent success that strands the engram
   *    un-synced (the `group:plur-ai/engineering` typo case).
   *  - Authorization: the same client-side rule as the learnRouted write path —
   *    a readonly store entry is refused.
   *  - Sensitivity (mirrors `_guardExplicitUpdate`'s remote arm): a rescope to
   *    a shared/remote scope re-scans the FULL content (statement + context
   *    fields via `_engramContextFields`). An offending hit BLOCKS that id —
   *    an explicit move must fail loud, never silently demote.
   *  - Dedup on target (#676 constraint 5): an identical ACTIVE engram already
   *    at the target (content-hash AND scope match) is idempotent success —
   *    nothing pushed, and the source is still retired per `keep_local`, so
   *    re-running a partially-failed batch converges.
   *
   * Batch-first (#676 constraint 3): `idOrIds` accepts one id or an array;
   * outcomes are per-id and one failure never blocks the rest. `dry_run`
   * reports every decision without mutating anything, local or remote.
   */
rescope(idOrIds: string | string[], targetScope: string, options?: RescopeOptions): Promise<{ results: RescopeResult[]; success: boolean }>

/** One engram's rescope — see {@link rescope} for the contract. */
/** @internal */
_rescopeOne(id: string, target: string, route: 'remote' | 'local', remoteDriver: RemoteStore | null, opts: { dryRun: boolean; keepLocal: boolean }): Promise<RescopeResult>

/**
   * Soft-retire the local source of a successful rescope, with a
   * supersedes-style link to the copy now living at the target (#676).
   * UNCONDITIONAL retirement — deliberately NOT the reference-counted
   * `forget()` path: the engram did not lose one referent, it MOVED, so a
   * reference_count > 1 must not leave a still-active local duplicate
   * injecting alongside the team copy. Retired rows are excluded from
   * `_hashDedup` (the hash cannot resurrect the source) and from every
   * injection/list surface (status filters).
   */
/** @internal */
_retireRescopedSource(id: string, toScope: string, newId: string): Promise<boolean>
}

export const forgetRescopeMethods: ForgetRescopeMethods & ThisType<Plur> = {
async forget(id: string, reason?: string, options?: { force?: boolean; scope?: string }): Promise<MutationOutcome> {
    this._assertWritable()
    // remote-only (audit of #1521, B2): a save queued from a remote-only
    // folder is DELETED, not retired — a retired row would keep its content
    // on this machine. Any other row this store holds is refused while bound.
    {
      const queued = (await this._basePrimaryStore.loadCached()).find(e => e.id === id)
      // Deleted whatever local scope the caller names (re-audit of #1521,
      // B-3: a scoped forget used to RETIRE it, keeping its content here).
      const localForget = !options?.scope || !this._isRemoteBackedScope(options.scope) || options.scope === queued?.scope
      if (queued && Plur._isRemoteOnlyQueued(queued) && localForget) {
        await this._withStoreLock(this.paths.engrams, async () => {
          // The unguarded store: the row may belong to another remote-only
          // folder than the one this instance is bound to (if any).
          const fresh = await this._basePrimaryStore.load()
          const kept = fresh.filter(e => e.id !== id)
          if (kept.length === fresh.length) return
          await this._basePrimaryStore.save(kept, { allowShrink: true })
          await this._syncIndex()
        })
        this._appendHistory({
          event: 'engram_retired', engram_id: id, timestamp: new Date().toISOString(),
          // No reason text: it can quote the save (Codex round 11 on #1663).
          data: { deleted_queued_remote_only: true },
        })
        return { warnings: [] }
      }
      await this._remoteOnlyRefuseLocalRow(id, 'Forgetting', options?.scope)
    }
    const warnings: string[] = []

    // Scope-targeted routing (#831). Ids are minted PER STORE, so one bare id
    // can name several unrelated engrams. Resolving primary-first and retiring
    // whichever came back destroyed the wrong engram in real use: history for
    // ENG-2026-08-03-008 shows three creations across three scopes, and the
    // retire hit the 11:32 one when the caller meant the 19:15 one — reporting
    // success and echoing a statement the caller had never written.
    //
    // Same shape as the feedback disambiguation (#850): `scope` routes
    // directly, and an unqualified id that resolves in more than one place is
    // an error. `forget` is destructive, so refusing beats guessing by a wider
    // margin here than it does for feedback.
    const targetScope = options?.scope
    if (targetScope !== undefined && (typeof targetScope !== 'string' || targetScope.trim() === '')) {
      throw new TypeError('plur.forget: scope must be a non-empty string')
    }
    // Pick up out-of-process config edits (#307) so a store registered after
    // startup is a valid target without a restart — mirrors rescope(). Without
    // this, a stale in-memory config would make the validation below reject a
    // scope that is in fact configured (#864 is the same class of staleness).
    if (targetScope) this.reloadConfigIfChanged()
    if (targetScope && targetScope !== 'primary') {
      // The resolver's entry (#1633 row 34): exact match, and a scope two
      // servers claim is refused before either is asked to delete.
      const entry = this._scopedUrlEntry(targetScope, 'nothing was retired')
      if (entry) {
        if (entry.readonly === true) throw new Error('Cannot retire engram from readonly store')
        const serverId = this._stripForScope(id, entry.scope)
        const driver = this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
        const remoteEngram = await driver.getById(serverId)
        if (!remoteEngram) throw new Error(`Engram "${id}" not found in store "${targetScope}"`)
        const removed = await driver.remove(serverId)
        if (!removed) {
          throw new Error(
            `Engram ${id} exists in ${targetScope} but the server refused to retire it — it was NOT removed. `
            + `Check that the token has delete rights for that scope.`,
          )
        }
        this._appendHistory({
          event: 'engram_retired',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { reason: reason ?? null, routed_to: 'remote', scope: targetScope },
        })
        return { warnings }
      }
      // No URL-backed store carries this scope. Falling through blindly here
      // was a hole on the destructive path (#855 audit): because `targetScope`
      // is truthy, the `if (!targetScope)` ambiguity guard below is skipped —
      // so a MISTYPED scope silently disabled the guard and restored
      // first-match-wins on exactly the id the guard exists to refuse.
      // Verified: `group:tset` as a typo of `group:test` retired the local
      // engram, issued no remote DELETE, and reported success.
      //
      // So validate that the scope names something before trusting it as a
      // disambiguation signal. Same rule and same wording as rescope(), which
      // documents this as typo protection — a scope that reaches neither a
      // local family nor a configured store is a caller error, not a hint.
      assertScopeNamesATarget(
        targetScope, this.config.stores ?? [], 'retire from', 'retire the LOCAL engram',
      )
      // Past this point the scope names a local-family or non-URL store, so it
      // is a genuine disambiguation signal and the ambiguity guard is
      // deliberately skipped: the caller has already said which side they mean.
    }

    // A namespaced id retires in the one store it names (0.21.1 audit, H1):
    // an old-form id shared by several stores is resolved, or refused.
    if (!targetScope) id = await this._resolveNamespacedId(id, 'retire')

    // Check primary first.
    // Reference-counted retirement (#107): decrement write_count; only
    // physically retire when it reaches 0. forget() called N times on an
    // engram with write_count=N retires it; called fewer times, the
    // engram stays active with a lower count.
    // options.force=true overrides this: retires immediately (#766).
    // Collision probe OUTSIDE the store lock (0.21.1). Inside it, a hanging
    // remote held the lock every other writer needs for 30 s; now each probe
    // is bounded and no lock is held while it waits. Only for a bare id with
    // no scope that names a live local row — the case #831 guards.
    let probedOutsideLock = false
    // No url store, nothing to probe — and no extra read (#827 costs).
    if (!targetScope && this._hasUrlStore()) {
      const pre = (await this._loadTargeted([id])).find(e => e.id === id)
      if (pre && pre.status !== 'retired') {
        this._decideForgetProbes(id, await this._probeIdCollisions(id), warnings)
        probedOutsideLock = true
      }
    }
    const foundInPrimary = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): a miss still means "not in the primary store"
      // and still falls through to the secondary stores below.
      const engrams = await this._loadTargeted([id])
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false

      // Ambiguity guard (#831). Sits HERE, past the not-found return, so the
      // local hit is established by control flow — "ambiguous" means it resolves
      // in more than one place, and a remote-only id (including a namespaced one,
      // #86) is not ambiguous and must keep routing straight through. Matches the
      // placement in #851 rather than re-deriving the local hit with a second
      // targeted read, which is what an earlier version of this did.
      //
      // A COLD cache must not silently downgrade to first-match-wins (#855
      // audit): `_loadRemoteCached` is a synchronous peek with no fetch, and
      // nothing here warms it, so on a fresh process the guard simply did not
      // run and the #831 destroy-the-wrong-engram path was reachable unguarded.
      // Note the asymmetry that made this indefensible — a local MISS already
      // pays for a live `driver.getById` walk below, so the function was
      // willing to make the network call in the case where it matters less.
      //
      // So: peek first (free), and fall back to a bounded live lookup — one
      // getById per configured remote store — only when that store's cache is
      // cold. If the lookup cannot complete, refuse rather than guess; the
      // caller has an explicit escape hatch in scope: "primary", which skips
      // this block entirely and needs no network.
      // The collision probe (#831) now runs BEFORE this lock (0.21.1, below
      // `probedOutsideLock`). Only a row that appeared between that unlocked
      // check and this lock is probed here — bounded the same way.
      if (!targetScope && !probedOutsideLock && engram.status !== 'retired') {
        this._decideForgetProbes(id, await this._probeIdCollisions(id), warnings)
      }

      // Already retired — nothing to do (#855 audit). The MCP layer has an
      // `Already retired` short-circuit, but it depends on a prior getById
      // that an explicitly-scoped forget deliberately skips, so without this
      // a second scoped forget re-ran the whole retirement: it rewrote the
      // row and appended a SECOND `engram_retired` event for the same engram,
      // then reported success. History is the audit trail for a destructive
      // irreversible operation; it must not record a retirement that did not
      // happen. Idempotent here so the guarantee does not depend on which
      // caller reached us.
      if (engram.status === 'retired') return true

      // Audit iter-2 fix (Data): for legacy engrams created before #107
      // landed, `write_count` is missing (was `reference_count` before #866).
      // The parse-time migration in engrams.ts covers local YAML, but NOT rows
      // reshaped from a remote store — RemoteRowSchema is passthrough, so a
      // server row still carrying `reference_count` arrives with the old key
      // and no `write_count`. Read the old name before falling back to the
      // sources-length heuristic, or a remote engram silently loses its count.
      // Defaulting to 1 means the first forget() retires them even if they
      // have multiple sources. Infer from sources[] length when available so
      // legacy cross-store dups don't get prematurely retired.
      const currentCount = engram.write_count
        ?? (engram as any).reference_count
        ?? Math.max(1, ((engram as any).sources?.length ?? 1))
      // force:true retires immediately, bypassing the decrement (#766) — this
      // branch is on main and NOT on this branch's base, so taking the local
      // side here would silently revert it.
      const newCount = options?.force ? 0 : Math.max(0, currentCount - 1)
      engram.write_count = newCount

      if (newCount === 0) {
        engram.status = 'retired'
        engram.updated_at = new Date().toISOString()
        if (reason && !engram.rationale) {
          engram.rationale = `Retired: ${reason}`
        }
        // Cancel any pending outbox push — a retired engram must not be
        // resurrected on the remote by a queued flush (#766). Strip _outbox
        // now so flushOutbox() never attempts to push this engram.
        if ((engram as any).structured_data?._outbox) {
          const sd = { ...((engram as any).structured_data as Record<string, unknown>) }
          delete sd._outbox
          ;(engram as any).structured_data = Object.keys(sd).length > 0 ? sd : undefined
        }
      }

      // Incremental write (#740): retirement is a status flip on one row —
      // the engram is soft-retired in place, never deleted, so this is an
      // update, not a removal.
      await this._updateEngrams(engrams, [engram])
      await this._syncIndex()
      this._appendHistory({
        event: newCount === 0 ? 'engram_retired' : 'engram_decremented',
        engram_id: id,
        timestamp: new Date().toISOString(),
        data: {
          reason: reason ?? null,
          write_count_before: currentCount,
          write_count_after: newCount,
        },
      })
      return true
    })

    if (foundInPrimary) return { warnings }

    // Check stores for namespaced IDs.
    // Audit iter-1 fix (Taleb): apply same write-count decrement as
    // primary store. The original implementation retired secondary-store
    // engrams unconditionally on the first forget() call regardless of
    // write_count — asymmetric with primary-store behavior and breaks
    // the #107 contract for cross-store engrams.
    const storeInfo = await this._findEngramStore(id)
    if (storeInfo && storeInfo.path !== this.paths.engrams) {
      if (storeInfo.readonly) {
        throw new Error('Cannot retire engram from readonly store')
      }
      // Under the SECONDARY store's own lock, with the load INSIDE it.
      //
      // This was the last unlocked read-modify-write on a secondary store — the
      // same defect already fixed in `feedback` and `_recordCrossScopeRecurrence`,
      // missed here. `_writeEngrams` replaces the whole file, so two processes
      // retiring different engrams in one team store did not merely lose a
      // decrement: whichever wrote second deleted every engram the other had
      // added in between.
      //
      // The load has to be inside the lock too. Loading first and locking only
      // the write leaves the same race, just narrower.
      //
      // Keyed on `storeInfo.path`, which the guard above proves is not
      // `this.paths.engrams`, so this cannot deadlock against a primary lock.
      const handled = await this._withStoreLock(storeInfo.path, async () => {
        const storeEngrams = await this._storeAt(storeInfo.path).load()
        const engram = storeEngrams.find(e => e.id === storeInfo.originalId)
        if (!engram) return false
        // Same legacy-engram migration as primary path (audit iter-2, Data).
        const currentCount = engram.write_count
          ?? (engram as any).reference_count
          ?? Math.max(1, ((engram as any).sources?.length ?? 1))
        // force:true retires immediately (#766) — see the note above.
        const newCount = options?.force ? 0 : Math.max(0, currentCount - 1)
        engram.write_count = newCount

        if (newCount === 0) {
          engram.status = 'retired'
          engram.updated_at = new Date().toISOString()
          if (reason && !engram.rationale) {
            engram.rationale = `Retired: ${reason}`
          }
        }

        await this._writeEngrams(storeInfo.path, storeEngrams)
        await this._syncIndex()
        this._appendHistory({
          event: newCount === 0 ? 'engram_retired' : 'engram_decremented',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: {
            reason: reason ?? null,
            write_count_before: currentCount,
            write_count_after: newCount,
            routed_to: 'secondary-store',
          },
        })
        return true
      })
      // Not found in the secondary store — fall through to the remote search.
      if (handled) return { warnings }
    }

    // Check remote stores — the engram may live on an enterprise server.
    // See: https://github.com/plur-ai/plur/issues/84
    //
    // An explicit LOCAL-family scope is a local-only request (#831). Falling
    // through to the remote walk here retires a remote engram the caller just
    // said they did not mean — the exact wrong-target retire this guard exists
    // to prevent, arrived at from the opposite direction.
    //
    // This used to check `targetScope === 'primary'` alone, so the other three
    // targets the error message above advertises — `local`, `global`,
    // `project:*` — passed the validation as legitimate and then issued a
    // remote DELETE, reporting success. Measured on the 2026-08-13 panel: 1
    // remote DELETE each for global/local/project:foo, 0 for primary. The
    // predicate is shared with `feedback` now precisely so the two cannot
    // drift again — the drift was the bug (#855).
    // Decision E4 (amended by O5, #1633): stores are passed, so a `project:*`
    // scope a URL store claims EXACTLY (the resolver) is NOT local-only and
    // reaches it; one a store only contains stays local, as its writes do.
    // An explicit scope the resolver keeps local (a path store, or the local
    // store a personal scope selects) is local too (gate of #1667).
    if (targetScope && (isLocalOnlyScope(targetScope, this.config.stores ?? [])
      || resolveScopeTarget(targetScope, this.config.stores ?? []).kind === 'local')) {
      throw new Error(
        `Engram not found in the local store: ${id} (scope: "${targetScope}"). `
        + `That scope names a local target, so no remote store was searched. `
        + `Omit scope to search everywhere, or pass the remote scope to target it directly.`,
      )
    }

    // Strip store prefix before querying remote. See: #86
    let refusedBy: string | null = null
    /** Stores this walk could not reach — so "not found" cannot claim absence
     *  it never verified (#907). Recorded, NOT thrown on: the existing
     *  contract (`forget handles remote server error gracefully`, #84) is that
     *  a degraded fleet must not stop a retire, and that is worth keeping. */
    const unreachedStores: string[] = []
    // Deferred throw for unreachable stores whose prefix matched the id (#1126).
    // storePrefix() is a lossy 3-char derivation — two distinct scopes can produce
    // the same prefix, so a prefix match does not prove this store is the unique
    // owner. Throwing immediately aborts the walk and prevents a later reachable
    // store (same prefix, actual owner) from retiring the engram. Record and defer:
    // fire only after the walk completes without a retirement.
    let pendingUnreachableError: string | null = null
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      // remote-only: a personal or non-team url store is out of reach (re-audit 3, R3-4).
      if (this._remoteOnly && !this._remoteOnlyWalkAllows(entry.scope, options?.scope)) continue
      // An explicit scope names its store exactly (#1633): the walk never
      // retires a row of a store that does not claim that scope.
      if (targetScope && entry.scope !== targetScope) continue
      const serverId = this._stripRemotePrefix(id, entry.scope)
      if (entry.readonly === true) {
        // Check if the engram exists here before throwing, so readonly
        // errors are specific ("cannot retire from readonly") not generic.
        const roDriver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        const roFound = await roDriver.getById(serverId)
        if (roFound && this._rowInStore(roFound, entry)) throw new Error('Cannot retire engram from readonly store')
        continue
      }
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      // The team store's host may also hold personal rows under the same token:
      // act on a bare id only when its row there is in a team scope (R3-4).
      if (this._remoteOnly && !(await this._remoteRowOwnedByTeam(driver, this._stripRemotePrefix(id, entry.scope)))) continue
      // Tri-state (#907). `getById` alone cannot distinguish "this store does
      // not have it" from "this store did not answer", so an unreachable
      // remote was walked past and the engram reported as simply not found —
      // absence the walk never verified, which is #831's harm by another route.
      //
      // For bare IDs the walk CONTINUES on `unknown`: `forget handles remote
      // server error gracefully` (#84) asserts a degraded fleet does not stop
      // a retire — availability is worth keeping for the ambiguous case. What
      // changes is only that the store is recorded so the terminal message
      // stops claiming knowledge it does not have. Same resolution `feedback`
      // already uses.
      //
      // For namespaced IDs (ENG-GPL-...) the prefix was stripped above, so this
      // store likely is the intended target — but storePrefix() is lossy, so
      // two scopes can share a prefix (#1126). Throwing immediately here aborts
      // the walk before a later reachable store (same prefix, actual owner) gets
      // a chance to retire the engram. Defer instead: record the error and
      // continue; fire it only once the walk completes without a retirement.
      // Optional capability: a driver without `probeById` (an injected stub, a
      // third-party implementation) keeps the previous two-state behaviour
      // rather than crashing. Absence of the capability is not a reason to
      // fail a retire.
      const ownership: 'owned' | 'absent' | 'unknown' = driver.probeById
        // Bounded like the collision probe (#1532 review F2).
        ? await driver.probeById(serverId, { signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS) })
        : ((await driver.getById(serverId)) ? 'owned' : 'absent')
      if (ownership === 'unknown') {
        const isNamespaced = id !== serverId
        if (isNamespaced) {
          // Record and continue — do not throw yet (#1126). If a subsequent
          // store retires the engram, this error is silently discarded.
          pendingUnreachableError = (
            `Cannot reach "${entry.scope ?? entry.url}" to retire "${id}" — `
            + `the token may be expired or the server unavailable. `
            + `Retry once access is restored, or pass scope: "${entry.scope ?? entry.url}" to target this store directly.`
          )
          continue
        }
        unreachedStores.push(entry.scope ?? entry.url!)
        logger.warning(
          `[plur] could not reach "${entry.scope ?? entry.url}" while looking for ${id} — `
          + `it may hold this engram.`,
        )
        continue
      }
      if (ownership === 'absent') continue
      const found = await driver.getById(serverId)
      // Another store's row on the same server is not this store's to retire.
      if (found && !this._rowInStore(found, entry)) continue
      // remote-only: a team store's host can also hold personal rows under the
      // same token; only a row in a team scope is retired from the folder
      // (re-audit 3 of #1521, R3-4).
      if (found && this._remoteOnly && !this._isDeliverableTeamScope(found.scope)) continue
      if (found) {
        const removed = await driver.remove(serverId)
        if (removed) {
          this._appendHistory({
            event: 'engram_retired',
            engram_id: id,
            timestamp: new Date().toISOString(),
            data: { reason: reason ?? null, routed_to: 'remote' },
          })
          return { warnings }
        }
        // Found it, and the server declined to remove it. Remember where, so
        // the error below can say what actually happened.
        refusedBy = entry.scope ?? 'a remote store'
      }
    }

    // Namespaced-id unreachable: fire now that the walk is complete and nothing
    // was retired (#1126). Sits above "Engram not found" because "cannot reach"
    // is actionable — the engram may exist — while "not found" falsely claims
    // absence. Sits below `refusedBy` because a refused DELETE proves presence.
    if (pendingUnreachableError) throw new Error(pendingUnreachableError)

    // A refused DELETE is not a missing engram and must not be reported as one.
    // Both used to fall through to "Engram not found", so a user whose token
    // lacked delete rights was told their engram did not exist — they stop
    // looking, and it is still there.
    if (refusedBy) {
      throw new Error(
        `Engram ${id} exists in ${refusedBy} but the server refused to retire it — it was NOT removed. `
        + `Check that the token has delete rights for that scope.`,
      )
    }
    // Still "Engram not found" — the existing contract and its test both
    // depend on that phrase — but never a bare claim of absence when a store
    // could not be reached (#907).
    throw new Error(
      unreachedStores.length > 0
        ? `Engram not found: ${id} — but ${unreachedStores.length} store(s) could not be reached `
          + `(${unreachedStores.join(', ')}). This is "not found where I could look", not `
          + `"does not exist". Retry, or pass scope explicitly to target a store directly.`
        : `Engram not found: ${id}`,
    )
  },

async listUploadCandidates(authorizedScopes: string[]): Promise<Array<{ id: string; scope: string; statement: string; proposed: string | null }>> {
    this._remoteOnlyRefuseLocalStore('Listing local upload candidates')
    const authorized = new Set(authorizedScopes)
    return (await this._loadCached(this.paths.engrams))
      .filter(row => row.status === 'active' && !(row as any).server_id && !(row as any)._fromRemoteStore && !Plur._isRemoteOnlyQueued(row))
      .map(row => ({ id: row.id, scope: row.scope, statement: row.statement, proposed: authorized.has(row.scope) ? row.scope : null }))
  },

async uploadLocal(ids: string[], opts?: { dryRun?: boolean }): Promise<{ results: UploadLocalResult[] }> {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Uploading local memories')
    const results = new Map<string, UploadLocalResult>(), selected = new Set<string>()
    for (const id of new Set(ids)) {
      try {
        await this._withStoreLock(this.paths.engrams, async () => {
          this.reloadConfigIfChanged()
          const corpus = await this._primaryStore.load(), row = corpus.find(e => e.id === id)
          if (!row || row.status !== 'active' || Plur._isRemoteOnlyQueued(row)) throw new Error('No active local upload candidate with this id')
          if ((row as any).server_id) {
            results.set(id, { id, outcome: 'already_on_server', new_id: (row as any).server_id }); return
          }
          const entry = this._remoteWriteEntry(row.scope)
          if (!entry) throw new Error('This memory has no unambiguous writable server destination')
          const sd = { ...((row as any).structured_data ?? {}) }, pending = sd._outbox
          if (pending && (pending.target_scope !== row.scope || normalizeEndpointUrl(pending.target_url) !== normalizeEndpointUrl(entry.url!))) {
            throw new Error('This memory is queued for a different destination; resolve its queue first')
          }
          const fields = this._engramContextFields(row)
          const hits = this._offendingHitsForScope(fields ? `${row.statement}\n${JSON.stringify(fields)}` : row.statement, row.scope)
          if (hits.length) {
            results.set(id, { id, outcome: 'demoted_secret', ...(opts?.dryRun ? { dry_run: true as const } : {}) })
            if (!opts?.dryRun) {
              sd._demoted = { from: row.scope, to: 'local', patterns: [...new Set(hits.map(h => h.pattern))] }
              delete sd._outbox; row.scope = 'local'; row.visibility = 'private'; (row as any).structured_data = sd
              await this._updateEngrams(corpus, [row]); await this._syncIndex()
            }
            return
          }
          if (opts?.dryRun) { results.set(id, { id, outcome: 'sent', dry_run: true }); return }
          sd._outbox = pending ?? { target_url: entry.url!, target_scope: row.scope, queued_at: new Date().toISOString(),
            last_attempt: '', attempt_count: 0, last_error: '', idempotency_key: randomUUID() }
          ;(row as any).structured_data = sd
          await this._updateEngrams(corpus, [row]); selected.add(id)
        })
      } catch {
        results.set(id, { id, outcome: 'failed', error: 'Could not prepare this memory; check the local store and its writable server destination' })
      }
    }
    if (selected.size) {
      let remaining: Engram[]
      try {
        await this._runOutboxFlush({ force: true }, { ids: selected, results })
        remaining = await this._primaryStore.load()
      }
      catch {
        // A server may have accepted a row before local merge-back failed.
        // Retain its receipt id and report the incomplete operation honestly.
        for (const id of selected) results.set(id, { ...results.get(id), id, outcome: 'failed',
          error: 'Upload could not finish local bookkeeping; inspect the outbox before retrying' })
        return { results: [...new Set(ids)].map(id => results.get(id)!) }
      }
      for (const id of selected) {
        const row = remaining.find(e => e.id === id), sd = (row as any)?.structured_data
        if (results.has(id)) {
          if (row) results.set(id, { ...results.get(id)!, outcome: 'failed',
            error: 'The local memory changed during delivery; its accepted server copy is being reconciled through the outbox' })
          continue
        }
        if (sd?._demoted && !sd._outbox) results.set(id, { id, outcome: 'demoted_secret' })
        else if (sd?._outbox) results.set(id, { id, outcome: NEEDS_ACTION_STATUSES.has(sd._outbox.last_status) ? 'failed' : 'queued' })
        else results.set(id, { id, outcome: 'failed', error: 'Delivery was not confirmed; the local row changed during upload' })
      }
    }
    return { results: [...new Set(ids)].map(id => results.get(id)!) }
  },

async rescope(idOrIds: string | string[], targetScope: string, options?: RescopeOptions): Promise<{ results: RescopeResult[]; success: boolean }> {
    // Public mutator (#731): both routes mutate — the remote push retires the
    // local source, the local route rewrites scope in place — so gate before
    // any routing, like every other mutator.
    this._assertWritable()
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds]
    if (ids.length === 0) throw new TypeError('plur.rescope: provide at least one engram id')
    if (typeof targetScope !== 'string' || targetScope.trim() === '') {
      throw new TypeError('plur.rescope: target scope must be a non-empty string')
    }
    const target = targetScope.trim()
    // Pick up out-of-process config edits (#307) so a store registered after
    // startup is a valid target without a restart — mirrors _resolveUnscopedScope.
    this.reloadConfigIfChanged()
    // remote-only (audit of #1521, B2). Bound: only team rows move, and only
    // to a team scope the user can write. Bound or not: a save queued from a
    // remote-only folder is delivered or forgotten, never moved (a move
    // retires or rewrites a local row, which would keep a copy here).
    {
      const primary = await this._loadCached(this.paths.engrams)
      for (const id of ids) {
        const row = primary.find(e => e.id === id)
        if (row && Plur._isRemoteOnlyQueued(row)) throw this._queuedStaysRemote(row)
        if (this._remoteOnly && row) throw this._remoteOnlyError('local-row', target, 'Rescoping')
      }
      if (this._remoteOnly && (!isSharedScope(target) || !this._isRemoteWriteScope(target))) {
        throw this._remoteOnlyError(isSharedScope(target) ? 'local-only-scope' : 'personal-scope', target)
      }
    }

    // --- Resolve the target route ONCE, before touching any engram, so an
    // invalid target fails the whole batch early (#676 constraint 4). ---
    const remoteDriver = this._resolveRemoteStoreForScope(target)
    const storeEntry = (this.config.stores ?? []).find(s => s.scope === target)
    // Case-SENSITIVE on purpose, unlike `isSharedScope`'s case-folded prefix
    // test (formal run 2026-09-26, kept after review). This is typo protection
    // on an explicit move: the target is written verbatim as the row's scope
    // (never normalised), and every reader matches scopes exactly — `global`
    // in the inject/recall filters, `isScopeWithin`, the store `scope ===`
    // lookups. Folding here would accept `Global` or `Project:app` as
    // local-family and strand the row under a scope no filter recognises as
    // global, while `isSharedScope` classes `Project:app` as SHARED. Refusing
    // it with the "check for typos" error below is the fail-loud outcome.
    const isLocalFamily = target === 'local' || target === 'global' || target.startsWith('project:')
    let route: 'remote' | 'local'
    if (remoteDriver) {
      route = 'remote'
    } else if (storeEntry?.url && storeEntry.readonly === true) {
      // Authorization: same rule the learnRouted write path applies — a
      // readonly entry never receives writes. Refuse rather than leave the
      // engram stranded somewhere it can never sync from.
      throw new Error(
        `Cannot rescope to "${target}": the configured store for that scope is readonly for this client. `
        + `Ask for write access or pick another scope.`,
      )
    } else if (isLocalFamily || storeEntry) {
      route = 'local'
    } else {
      const configured = (this.config.stores ?? []).map(s => s.scope)
      throw new Error(
        `Cannot rescope to "${target}": no configured store matches that scope. `
        + `Valid targets: local, global, project:*`
        + (configured.length ? `, or a configured store scope (${configured.join(', ')})` : '')
        + `. Check for typos — an unmatched shared scope would never reach a team store (#676).`,
      )
    }

    const opts = { dryRun: options?.dry_run === true, keepLocal: options?.keep_local === true }
    const results: RescopeResult[] = []
    for (const id of ids) {
      results.push(await this._rescopeOne(id, target, route, remoteDriver, opts))
    }
    return { results, success: results.every(r => r.status !== 'error') }
  },

async _rescopeOne(id: string, target: string, route: 'remote' | 'local', remoteDriver: RemoteStore | null, opts: { dryRun: boolean; keepLocal: boolean }): Promise<RescopeResult> {
    const action = route === 'remote' ? ('remote_push' as const) : ('local_rewrite' as const)
    // The source must live in the local primary store: that is where stranded
    // wrong-scope engrams sit (#676), and the only place this client can
    // atomically retire from. A namespaced secondary/remote row gets a pointed
    // error instead of a half-move.
    const engrams = await this._loadCached(this.paths.engrams)
    const source = engrams.find(e => e.id === id)
    if (!source) {
      const elsewhere = await this.getById(id)
      return {
        id, status: 'error', action,
        error: elsewhere
          ? `Engram ${id} lives in a secondary/remote store (scope ${elsewhere.scope}) — rescope supports engrams in the local primary store`
          : `Engram not found: ${id}`,
      }
    }
    if (source.status === 'retired') {
      return { id, status: 'error', action, from_scope: source.scope, error: `Cannot rescope retired engram ${id}` }
    }
    if (source.scope === target) {
      return { id, status: 'noop', action, from_scope: source.scope, to_scope: target, new_id: id }
    }

    // Sensitivity guard: a target where content can leave the machine or be
    // read by others re-scans the FULL content (statement + context fields —
    // the same surface as _guardExplicitUpdate, LOW-2 #353). Explicit rescope
    // BLOCKS on a hit — no silent demote.
    const ctx = this._engramContextFields(source)
    const scanText = ctx ? `${source.statement}\n${JSON.stringify(ctx)}` : source.statement
    const offending = this._offendingHitsForScope(scanText, target)
    if (offending.length > 0) {
      const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
      return {
        id, status: 'error', action, from_scope: source.scope, to_scope: target,
        error: `Blocked: sensitive content (${patterns}) must not reach shared scope "${target}". `
          + `Remove the sensitive material (or allow the category via the scope's sensitivity policy) and retry.`,
      }
    }

    // Dedup on target (#676 constraint 5): identical content already AT the
    // target scope is idempotent success — never a duplicate. _loadAllEngrams
    // sees the primary store plus the cached remote view; for a cold remote
    // cache the server's own content-hash dedup is the backstop.
    const hash = (source as any).content_hash ?? computeContentHash(source.statement)
    const all = await this._loadAllEngrams()
    // A url store's cached row counts only when a write to `target` goes to
    // that url store. When the choice for a personal scope is local, the
    // local copy is kept, as in learn's duplicate check (#1515 re-audit 4, L-B).
    const remoteCounts = this._isRemoteWriteScope(target)
    const existing = all.find(e =>
      e.id !== id && e.status === 'active' && (e as any).content_hash === hash && e.scope === target
      && ((e as any)._fromRemoteStore !== true || remoteCounts))
    if (existing) {
      const targetId = ((existing as any)._originalId as string | undefined) ?? existing.id
      // The server id handed back is now this machine's knowledge of a server
      // engram (#1532 re-audit 2, S6): record it, or a later 401 forget of an
      // unrelated local engram with that bare id is not refused.
      if ((existing as any)._fromRemoteStore === true) this._noteSeenOnServer([{ id: targetId, scope: target }])
      const retire = route === 'local' || !opts.keepLocal
      if (!opts.dryRun && retire) {
        await this._retireRescopedSource(id, target, targetId)
      }
      return {
        id, status: 'deduped', action, from_scope: source.scope, to_scope: target,
        new_id: targetId,
        ...(route === 'remote' ? { kept_local: opts.keepLocal } : {}),
        ...(opts.dryRun ? { dry_run: true } : {}),
      }
    }

    if (opts.dryRun) {
      // #848: a dry run has to disclose the queued delivery too, or it does not
      // describe what the real call would do.
      const pendingOutbox = route === 'local'
        ? ((source as any).structured_data?._outbox as { target_url?: string; target_scope?: string } | undefined)
        : undefined
      return {
        id, status: 'rescoped', action, from_scope: source.scope, to_scope: target,
        ...(route === 'remote' ? { kept_local: opts.keepLocal } : { new_id: id }),
        ...(pendingOutbox?.target_url
          ? { cancelled_outbox: {
              target_url: pendingOutbox.target_url,
              target_scope: pendingOutbox.target_scope ?? source.scope,
            } }
          : {}),
        dry_run: true,
      }
    }

    const now = new Date().toISOString()
    if (route === 'remote') {
      // Build the pushed copy: scope rewritten, provenance in `source` (rides
      // the wire — see appendAndGetServerId) and in structured_data, with
      // PLUR-internal bookkeeping keys (_outbox, _routed, …) stripped.
      const provenance = `rescoped from ${id} (${source.scope})`
      const copy: Engram = {
        ...source,
        scope: target,
        source: source.source ? `${source.source} — ${provenance}` : provenance,
      }
      const sd = (source as any).structured_data
      const cleanSd = sd && typeof sd === 'object' && !Array.isArray(sd)
        ? Object.fromEntries(Object.entries(sd as Record<string, unknown>).filter(([k]) => !k.startsWith('_')))
        : {}
      ;(copy as any).structured_data = {
        ...cleanSd,
        _rescoped_from: { id, scope: source.scope, at: now },
      }
      let serverId: string
      try {
        ;({ id: serverId } = await remoteDriver!.appendAndGetServerId(copy))
        if (serverId) this._noteSeenOnServer([{ id: serverId, scope: target }])
      } catch (err) {
        // Atomic semantics (#676 constraint 2): the push did not land, so the
        // source stays exactly as it was. Deliberately NO outbox fallback — an
        // explicit move reports failure instead of becoming a maybe-later.
        const msg = (err as Error).message
        const authHint = /\b40[13]\b/.test(msg)
          ? ' The store token was refused (401/403) — re-authenticate and retry.'
          : ''
        return {
          id, status: 'error', action, from_scope: source.scope, to_scope: target,
          error: `Remote push failed — source engram left untouched: ${msg}.${authHint}`,
        }
      }
      if (!opts.keepLocal) {
        // The push LANDED: from here a failure must be reported per id with the
        // server id, not thrown. Throwing aborted the rest of the batch and hid
        // that a copy now exists at the target, so a retry pushed it again
        // (formal WritePath, candidate 6).
        try {
          await this._retireRescopedSource(id, target, serverId)
        } catch (err) {
          return {
            id, status: 'error', action, from_scope: source.scope, to_scope: target, new_id: serverId,
            kept_local: opts.keepLocal,
            error: `Pushed to "${target}" as ${serverId}, but the local source could not be retired: `
              + `${(err as Error).message}. Both copies are now active — retire ${id} (plur forget) `
              + `rather than re-running the rescope, which would push a second copy.`,
          }
        }
      }
      this._appendHistory({
        event: 'engram_rescoped',
        engram_id: id,
        timestamp: now,
        data: { from_scope: source.scope, to_scope: target, new_id: serverId, routed_to: 'remote', kept_local: opts.keepLocal },
      })
      return {
        id, status: 'rescoped', action, from_scope: source.scope, to_scope: target,
        new_id: serverId, kept_local: opts.keepLocal,
      }
    }

    // Local route: rewrite scope IN PLACE under the store lock — the same
    // incremental update path as updateEngram's local branch. Id, activation,
    // feedback, relations and history all stay attached to the same row.
    let cancelledOutbox: { target_url: string; target_scope: string } | undefined
    const rewritten = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const fresh = await this._loadTargeted([id])
      const t = fresh.find(e => e.id === id)
      if (!t || t.status === 'retired') return false
      const from = t.scope
      t.scope = target
      const tsd = (t as any).structured_data
      const nextSd: Record<string, unknown> = {
        ...(tsd && typeof tsd === 'object' && !Array.isArray(tsd) ? tsd : {}),
        _rescoped: { from_scope: from, at: now },
      }
      // #848: CANCEL any pending delivery to the store we are moving away from.
      //
      // A failed remote write leaves `_outbox` naming the original url + scope.
      // Rewriting the scope and leaving that entry queued meant the engram was
      // delivered to the old store whenever it came back — silently reverting
      // the rescope, arbitrarily later, with hand-editing engrams.yaml as the
      // only reliable fix. The window is unbounded, because the queue only
      // flushes when the store recovers.
      //
      // Dropping is correct on THIS branch specifically: `route === 'local'`
      // means the target matched no URL-backed store, so the user has said the
      // engram does not belong in a shared store at all. (A target that maps to
      // a different remote takes the `remote` branch, which builds a fresh copy
      // with the bookkeeping keys stripped and retires the source — and
      // flushOutbox already skips retired rows, so that path is not exposed.)
      const ob = nextSd._outbox as { target_url?: string; target_scope?: string } | undefined
      if (ob?.target_url) {
        cancelledOutbox = { target_url: ob.target_url, target_scope: ob.target_scope ?? from }
        delete nextSd._outbox
      }
      ;(t as any).structured_data = nextSd
      // Incremental write (#740): only the rescoped row changed.
      await this._updateEngrams(fresh, [t])
      await this._syncIndex()
      return true
    })
    if (!rewritten) {
      return {
        id, status: 'error', action, from_scope: source.scope, to_scope: target,
        error: `Engram ${id} changed underneath the rescope (retired or removed concurrently) — nothing written`,
      }
    }
    this._appendHistory({
      event: 'engram_rescoped',
      engram_id: id,
      timestamp: now,
      data: {
        from_scope: source.scope, to_scope: target, new_id: id, routed_to: 'local',
        ...(cancelledOutbox ? { cancelled_outbox: cancelledOutbox } : {}),
      },
    })
    if (cancelledOutbox) {
      logger.warning(
        `[plur] rescope of ${id} cancelled a pending delivery to ${safeOrigin(cancelledOutbox.target_url)} ` +
        `(scope "${cancelledOutbox.target_scope}"). That queued write would have re-delivered the engram to the ` +
        `store it was moved away from once the host recovered (#848).`,
      )
    }
    return {
      id, status: 'rescoped', action, from_scope: source.scope, to_scope: target, new_id: id,
      ...(cancelledOutbox ? { cancelled_outbox: cancelledOutbox } : {}),
    }
  },

async _retireRescopedSource(id: string, toScope: string, newId: string): Promise<boolean> {
    const now = new Date().toISOString()
    const retired = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const fresh = await this._loadTargeted([id])
      const t = fresh.find(e => e.id === id)
      // Gone (compacted) or already retired by a concurrent forget while the
      // push was in flight: nothing to retire here, and history must not
      // record a retirement that did not happen (#855).
      if (!t || t.status === 'retired') return false
      t.status = 'retired'
      t.updated_at = new Date().toISOString()
      if (!t.rationale) t.rationale = `Retired: rescoped to ${toScope} as ${newId}`
      const rel = t.relations ?? { broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [] }
      rel.superseded_by = rel.superseded_by ?? []
      if (!rel.superseded_by.includes(newId)) rel.superseded_by.push(newId)
      t.relations = rel
      const tsd = (t as any).structured_data
      ;(t as any).structured_data = {
        ...(tsd && typeof tsd === 'object' && !Array.isArray(tsd) ? tsd : {}),
        _rescoped: { to_scope: toScope, to_id: newId, at: now },
      }
      // Incremental write (#740): only the retired source row changed.
      await this._updateEngrams(fresh, [t])
      await this._syncIndex()
      return true
    })
    if (!retired) return false
    this._appendHistory({
      event: 'engram_retired',
      engram_id: id,
      timestamp: now,
      data: { reason: `rescoped to ${toScope}`, rescoped_to: newId, routed_to: 'rescope' },
    })
    return true
  },
}
