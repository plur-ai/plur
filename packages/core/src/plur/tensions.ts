import { resolve } from 'path'
import { namespaceEngramId } from '../engrams.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { isRemoteOnlyQueued } from '../remote-only-rows.js'
import type { Engram } from '../schemas/engram.js'
import type { TensionRecord, TensionStatus } from '../schemas/tension.js'
import { withLock } from '../sync.js'
import { categorizeTension, generateTensionId, loadTensions, loadTensionsWithQuarantine, saveTensions, tensionPairKey } from '../tension-store.js'
import type { TensionPair } from '../tensions.js'
import { type SecondarySupersede } from './types.js'

export interface TensionsMethods {
  /** List persisted tension records, optionally filtered by status. */
  listTensions(filter?: { status?: TensionStatus[] }): TensionRecord[]

  /**
   * Canonical pair keys of every recorded tension — the scan exclusion set.
   * Any recorded pair is excluded from future scans regardless of
   * status: dismissed/resolved pairs are suppressed, detected/confirmed
   * pairs are already adjudicated and must not re-pay the LLM judge.
   */
  suppressedTensionPairKeys(): string[]

  /**
   * Persist fresh scan detections as tension records. Pairs already
   * recorded (any status) are returned as-is and counted in existing_count —
   * a scan can never duplicate or resurrect a record. New records get a
   * T-YYYY-MMDD-NNN id, a v1 category (categorizeTension), status
   * 'detected', and emit the `contradiction_detected` history event.
   */
  recordTensions(pairs: TensionPair[]): Promise<{ records: TensionRecord[]; new_count: number; existing_count: number }>

  /** Locked mutation of a single tension record by id. */
  /** @internal */
  _mutateTension(id: string, mutate: (r: TensionRecord) => void): TensionRecord

  /** Mark a detected tension as a real conflict (detected → confirmed). */
  confirmTension(id: string): TensionRecord

  /**
   * Dismiss a tension as a false positive (detected|confirmed → dismissed).
   * The pair stays in the scan exclusion set, so it is never re-flagged.
   * Neither memory changes: a draft in the pair (a held-back proposal)
   * stays a draft — stored and searchable, never injected.
   */
  dismissTension(id: string): TensionRecord

  /**
   * Resolve a tension by picking the winning engram: the loser is retired
   * outright (decisive — NOT reference-count-decremented like forget()), the
   * record becomes status 'resolved' with resolved_by / resolved_at set. A
   * winner that is a draft (a statement proposed onto a locked memory waits
   * as a draft) becomes a normal memory with
   * commitment 'decided', so it is given to the agent from then on.
   */
  resolveTension(id: string, winnerId: string): Promise<{ record: TensionRecord; retired_id: string }>

  /**
   * Unconditional retirement for tension resolution. Unlike forget(), does
   * NOT decrement write_count — the user explicitly adjudicated this
   * engram as the losing side, so a multiply-learned loser must still be
   * retired.
   */
  /** @internal */
  _retireEngramForResolution(id: string, reason: string): Promise<boolean>

  /**
   * True when the engram participates in an unresolved (detected|confirmed)
   * persisted tension. Gates commitment escalation into 'locked':
   * contradicted knowledge must not lock.
   */
  hasUnresolvedTension(engramId: string): boolean

  /**
   * Injection warnings for persisted tensions (surface, don't adjudicate):
   * - confirmed tension: warn when EITHER side injects (the user vouched
   *   for the conflict being real; relying on one side blind is a hazard);
   * - detected tension: warn only when BOTH sides inject together.
   */
  /** @internal */
  _tensionWarningsFor(injectedIds: string[]): string[]

  /**
   * Resolved tension-scan defaults from config. Consumers (MCP
   * plur_tensions, CLI) merge explicit args over these.
   */
  getTensionsConfig(): { temporal_domains: string[]; snapshot_pairs: 'skip' | 'floor'; measured_under_pairs: 'skip' | 'floor'; temporal_discount: boolean }

  /**
   * Write the reverse `relations.superseded_by` edge on each supersede
   * target present in the (already-loaded, lock-held) local engram list
   * Unknown targets are skipped silently — the forward edge on the new
   * engram still records the intent. Mutates in place and RETURNS the
   * targets it actually changed: on the incremental write path the
   * new engram is appended on its own, so the caller must persist these
   * mutated rows explicitly via `_updateEngrams` — a whole-corpus fallback
   * save carries them implicitly, a targeted `append` does not.
   */
  /**
   * Write the reverse `superseded_by` edge on supersede targets that live in
   * a writable SECONDARY store, in that store, under its own lock (the
   * primary-only `_writeSupersededByEdges` does not reach them). Without it
   * the old memory keeps being injected beside its replacement.
   *
   * Called right before the new row is written, with the new row in hand and
   * not yet persisted, so anything decided here lands in the same write:
   *  - target locked meanwhile: the forward edge is dropped and the new
   *    row becomes a draft;
   *  - target gone or retired meanwhile: the forward edge becomes a link.
   * Returns an undo that removes the edges it wrote, for when the new row then
   * fails to write (a dangling edge would down-rank the target).
   */
  /** @internal */
  _landSecondarySupersedes(engram: Engram, targets: SecondarySupersede[]): Promise<() => Promise<void>>

  /**
   * How a row of THIS primary store is named from inside another store: its id namespaced under a scope derived from this primary's
   * location. Another store reads it as foreign (no row of its own, and no
   * configured store, answers to that prefix), so it can never name an
   * unrelated row there; this install resolves it back in `getById`.
   */
  /** @internal */
  _primaryQualifiedId(id: string): string

  /** @internal */
  _primaryRefScope(): string

  /** @internal */
  _writeSupersededByEdges(engrams: Engram[], targetIds: string[], newId: string): Engram[]

  /**
   * Remove all conflict relations from every local engram.
   * Clears accumulated false positives from older conflict detection.
   */
  purgeTensions(): Promise<{ purged_count: number; engrams_modified: number; stores_cleaned: number }>
}

export const tensionsMethods: TensionsMethods & ThisType<Plur> = {
  // ------------------------------------------------------------------
  // Tension lifecycle — persistence, confirm/dismiss/resolve.
  // ------------------------------------------------------------------
  listTensions(filter?: { status?: TensionStatus[] }): TensionRecord[] {
    // remote-only: tension records carry personal statements.
    if (this._remoteOnly) return []
    const records = loadTensions(this.paths.tensions)
    if (!filter?.status?.length) return records
    const wanted = new Set(filter.status)
    return records.filter(r => wanted.has(r.status))
  },

  suppressedTensionPairKeys(): string[] {
    return loadTensions(this.paths.tensions).map(r => tensionPairKey(r.engram_a, r.engram_b))
  },

  async recordTensions(pairs: TensionPair[]): Promise<{ records: TensionRecord[]; new_count: number; existing_count: number }> {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Recording tensions')
    if (pairs.length === 0) return { records: [], new_count: 0, existing_count: 0 }
    // A pair with a queued remote-only save is never recorded: the record would
    // keep its statement here.
    {
      const queuedIds = new Set((await this._basePrimaryStore.loadCached()).filter(isRemoteOnlyQueued).map(e => e.id))
      if (queuedIds.size > 0) pairs = pairs.filter(p => !queuedIds.has(p.id_a) && !queuedIds.has(p.id_b))
      if (pairs.length === 0) return { records: [], new_count: 0, existing_count: 0 }
    }
    const engramById = new Map((await this._loadAllEngrams()).map(e => [e.id, e]))
    return withLock(this.paths.tensions, () => {
      // Quarantined records ride along: `loadTensions` withholds schema-invalid
      // entries, and this function rewrites the WHOLE file, so saving only the
      // valid ones would permanently delete them on an unrelated scan.
      const { valid: all, quarantined } = loadTensionsWithQuarantine(this.paths.tensions)
      const byKey = new Map(all.map(r => [tensionPairKey(r.engram_a, r.engram_b), r]))
      const out: TensionRecord[] = []
      let newCount = 0
      let existingCount = 0
      const nowIso = new Date().toISOString()
      for (const pair of pairs) {
        const key = tensionPairKey(pair.id_a, pair.id_b)
        const prior = byKey.get(key)
        if (prior) {
          existingCount++
          out.push(prior)
          continue
        }
        const record: TensionRecord = {
          id: generateTensionId(all),
          engram_a: pair.id_a,
          engram_b: pair.id_b,
          statement_a: pair.statement_a,
          statement_b: pair.statement_b,
          confidence: pair.confidence,
          reason: pair.reason,
          detected_at: nowIso,
          status: 'detected',
          resolved_by: null,
          resolved_at: null,
          category: categorizeTension(
            pair.statement_a, pair.statement_b,
            engramById.get(pair.id_a), engramById.get(pair.id_b),
          ),
        }
        all.push(record)
        byKey.set(key, record)
        out.push(record)
        newCount++
        try {
          this._appendHistory({
            event: 'contradiction_detected',
            engram_id: pair.id_a,
            timestamp: nowIso,
            data: {
              tension_id: record.id,
              engram_b: pair.id_b,
              confidence: pair.confidence,
              reason: pair.reason,
              category: record.category,
            },
          })
        } catch { /* best-effort — history failure must not lose the record */ }
      }
      if (newCount > 0) saveTensions(this.paths.tensions, all, quarantined)
      return { records: out, new_count: newCount, existing_count: existingCount }
    })
  },

  _mutateTension(id: string, mutate: (r: TensionRecord) => void): TensionRecord {
    return withLock(this.paths.tensions, () => {
      // Quarantined records ride along — loadTensions withholds schema-invalid
      // entries, so saving without them would delete them on an unrelated
      // mutation.
      const { valid, quarantined } = loadTensionsWithQuarantine(this.paths.tensions)
      const record = valid.find(r => r.id === id)
      if (!record) throw new Error(`Tension ${id} not found`)
      mutate(record)
      saveTensions(this.paths.tensions, valid, quarantined)
      return record
    })
  },

  confirmTension(id: string): TensionRecord {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Changing a tension')
    return this._mutateTension(id, r => {
      if (r.status === 'resolved') throw new Error(`Tension ${id} is already resolved`)
      if (r.status === 'dismissed') throw new Error(`Tension ${id} is dismissed — re-scan cannot resurrect it; delete tensions.yaml entry manually if truly needed`)
      r.status = 'confirmed'
    })
  },

  dismissTension(id: string): TensionRecord {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Changing a tension')
    return this._mutateTension(id, r => {
      if (r.status === 'resolved') throw new Error(`Tension ${id} is already resolved`)
      r.status = 'dismissed'
    })
  },

  async resolveTension(id: string, winnerId: string): Promise<{ record: TensionRecord; retired_id: string }> {
    // Readonly: refuse BEFORE the claim below writes tensions.yaml.
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Resolving a tension')
    // CLAIM the resolution atomically before retiring anything. Without it, two
    // concurrent calls picking OPPOSITE winners could both read "unresolved"
    // and each retire the other's winner, leaving both engrams retired.
    //
    // Marking the record resolved inside the lock is what makes the claim
    // exclusive: the loser of the race sees status 'resolved' and throws
    // before touching an engram. Deliberately NOT nested inside the engram
    // lock — claim, then act, then roll back on failure — so this introduces no
    // lock-ordering dependency between the tension and engram locks.
    let loserId = ''
    let previous: Pick<TensionRecord, 'status' | 'resolved_by' | 'resolved_at'> | null = null
    const record = withLock(this.paths.tensions, () => {
      const { valid, quarantined } = loadTensionsWithQuarantine(this.paths.tensions)
      const r = valid.find(x => x.id === id)
      if (!r) throw new Error(`Tension ${id} not found`)
      if (r.status === 'resolved') throw new Error(`Tension ${id} is already resolved`)
      if (r.status === 'dismissed') throw new Error(`Tension ${id} is dismissed`)
      // The winner may be named by its current id while the tension was
      // recorded under the older id form.
      const winnerForms = this._idWithOldForms(winnerId)
      if (!winnerForms.has(r.engram_a) && !winnerForms.has(r.engram_b)) {
        throw new Error(`Winner ${winnerId} is not part of tension ${id} (${r.engram_a} vs ${r.engram_b})`)
      }
      loserId = winnerForms.has(r.engram_a) ? r.engram_b : r.engram_a
      previous = { status: r.status, resolved_by: r.resolved_by, resolved_at: r.resolved_at }
      r.status = 'resolved'
      r.resolved_by = winnerId
      r.resolved_at = new Date().toISOString()
      saveTensions(this.paths.tensions, valid, quarantined)
      return { ...r }
    })

    // A winner still waiting as a draft (a statement proposed onto a locked
    // memory is held back as a draft until the user decides) is what
    // the user just chose, so it becomes a normal memory that is given to the
    // agent. Promoted before the loser is retired so the user is never left
    // with neither memory given; undone below if the retirement fails.
    let promoted: Engram | null = null
    // Retire the loser. If that fails, release the claim so the operation can
    // be retried rather than leaving a resolved tension whose loser is alive.
    try {
      const winner = await this.getById(winnerId)
      if (winner && winner.commitment === 'draft' && winner.status === 'active') {
        if (!(await this.updateEngram({ ...winner, commitment: 'decided' }))) {
          throw new Error(`Cannot make the chosen memory ${winnerId} a normal memory (not found in a writable store)`)
        }
        promoted = winner
      }
      const retired = await this._retireEngramForResolution(loserId, `tension ${id} resolved in favor of ${winnerId}`)
      if (!retired) throw new Error(`Cannot retire losing engram ${loserId} (not found in a writable local store)`)
    } catch (err) {
      // Cast: TS cannot see that the closure above ran before this catch, so
      // it narrows `previous` to never.
      const prev = previous as Pick<TensionRecord, 'status' | 'resolved_by' | 'resolved_at'> | null
      if (promoted) {
        const p = promoted as Engram
        try {
          const now = await this.getById(p.id)
          if (now) await this.updateEngram({ ...now, commitment: 'draft' })
        } catch { /* best-effort, as the claim rollback below */ }
      }
      if (prev) {
        try {
          this._mutateTension(id, r => {
            r.status = prev.status
            r.resolved_by = prev.resolved_by
            r.resolved_at = prev.resolved_at
          })
        } catch { /* the rollback is best-effort; the original error is what matters */ }
      }
      throw err
    }
    return { record, retired_id: loserId }
  },

  async _retireEngramForResolution(id: string, reason: string): Promise<boolean> {
    id = await this._resolveNamespacedId(id, 'retire')
    const stamp = (engram: Engram): void => {
      engram.status = 'retired'
      engram.updated_at = new Date().toISOString()
      if (!engram.rationale) engram.rationale = `Retired: ${reason}`
    }
    const foundInPrimary = await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false
      // A save queued from a remote-only folder is delivered or forgotten,
      // never retired into a permanent local row.
      if (Plur._isRemoteOnlyQueued(engram)) throw this._queuedStaysRemote(engram)
      stamp(engram)
      await this._writeEngrams(this.paths.engrams, engrams)
      await this._syncIndex()
      this._appendHistory({
        event: 'engram_retired',
        engram_id: id,
        timestamp: new Date().toISOString(),
        data: { reason },
      })
      return true
    })
    if (foundInPrimary) return true

    // Secondary local stores (namespaced ids) — mirrors forget()'s branch.
    const storeInfo = await this._findEngramStore(id)
    if (storeInfo && storeInfo.path !== this.paths.engrams) {
      if (storeInfo.readonly) throw new Error('Cannot retire engram from readonly store')
      // Under the secondary store's own lock, load included — same reasoning as
      // `forget()`'s branch, which this one mirrors. Tension resolution retires
      // the losing engram, so an unlocked whole-file replace here could delete a
      // concurrent writer's engrams while resolving a contradiction between two
      // others.
      const handled = await this._withStoreLock(storeInfo.path, async () => {
        const storeEngrams = await this._storeAt(storeInfo.path).load()
        const engram = storeEngrams.find(e => e.id === storeInfo.originalId)
        if (!engram) return false
        stamp(engram)
        await this._writeEngrams(storeInfo.path, storeEngrams)
        await this._syncIndex()
        this._appendHistory({
          event: 'engram_retired',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { reason },
        })
        return true
      })
      if (handled) return true
    }
    return false
  },

  hasUnresolvedTension(engramId: string): boolean {
    try {
      // A tension recorded under the engram's older-form id still counts.
      const ids = this._idWithOldForms(engramId)
      return loadTensions(this.paths.tensions).some(r =>
        (r.status === 'detected' || r.status === 'confirmed')
        && (ids.has(r.engram_a) || ids.has(r.engram_b)))
    } catch (err) {
      // Fail CLOSED. `loadTensions` throws on an unreadable file precisely so
      // it is never read as empty; answering "no tension" here would let
      // contradicted knowledge escalate into 'locked' — the one outcome this
      // gate exists to stop.
      // Capping at 'decided' while the file is unreadable is recoverable; a
      // wrong lock is not. (A MISSING file still reads as no tensions.)
      logger.warning(
        `[plur:tensions] tensions file unreadable (${(err as Error).message}); `
        + `treating ${engramId} as possibly contradicted — lock escalation held back`,
      )
      return true
    }
  },

  _tensionWarningsFor(injectedIds: string[]): string[] {
    if (injectedIds.length === 0) return []
    try {
      const unresolved = loadTensions(this.paths.tensions)
        .filter(r => r.status === 'detected' || r.status === 'confirmed')
      if (unresolved.length === 0) return []
      // Each injected id with its older-form spelling, so a tension recorded
      // under the old form still warns.
      const injected = new Set(injectedIds.flatMap(i => [...this._idWithOldForms(i)]))
      const clip = (t: string) => (t.length > 80 ? `${t.slice(0, 77)}...` : t)
      const warnings: string[] = []
      for (const r of unresolved) {
        const aIn = injected.has(r.engram_a)
        const bIn = injected.has(r.engram_b)
        // remote-only: only when BOTH sides are in this
        // injection, so the warning never carries a statement the session
        // could not see — a personal one above all.
        const fires = r.status === 'confirmed' && !this._remoteOnly ? (aIn || bIn) : (aIn && bIn)
        if (!fires) continue
        warnings.push(
          `Tension ${r.id} (${r.status}, ${r.category}): "${clip(r.statement_a)}" [${r.engram_a}] contradicts "${clip(r.statement_b)}" [${r.engram_b}]. Consider resolving before relying on either.`,
        )
      }
      return warnings
    } catch {
      return [] // best-effort — a tension-store problem must never break injection
    }
  },

  getTensionsConfig(): { temporal_domains: string[]; snapshot_pairs: 'skip' | 'floor'; measured_under_pairs: 'skip' | 'floor'; temporal_discount: boolean } {
    const t = this.config.tensions ?? {}
    return {
      temporal_domains: t.temporal_domains ?? [],
      snapshot_pairs: t.snapshot_pairs ?? 'skip',
      measured_under_pairs: t.measured_under_pairs ?? 'skip',
      temporal_discount: t.temporal_discount ?? false,
    }
  },

  async _landSecondarySupersedes(engram: Engram, targets: SecondarySupersede[]): Promise<() => Promise<void>> {
    const written: SecondarySupersede[] = []
    // The edge names the replacement by a primary-qualified id,
    // never by its bare id — that one is only unique in THIS primary, and the
    // same day it is the id of an unrelated row in the target store.
    const edgeId = this._primaryQualifiedId(engram.id)
    for (const t of targets) {
      const outcome = await this._withStoreLock(t.path, async () => {
        const rows = await this._storeAt(t.path).load()
        const row = rows.find(e => e.id === t.originalId)
        if (!row || row.status !== 'active') return 'gone' as const
        if (row.commitment === 'locked') return 'locked' as const
        if (this._writeSupersededByEdges(rows, [t.originalId], edgeId).length > 0) {
          await this._writeEngrams(t.path, rows)
        }
        return 'landed' as const
      })
      if (outcome === 'landed') { written.push(t); continue }
      const rel = engram.relations
      if (rel) rel.supersedes = (rel.supersedes ?? []).filter(id => id !== t.id)
      if (outcome === 'locked') {
        engram.commitment = 'draft'
      } else if (rel) {
        rel.related = [...new Set([...(rel.related ?? []), t.id])]
      }
    }
    return async () => {
      for (const t of written) {
        try {
          await this._withStoreLock(t.path, async () => {
            const rows = await this._storeAt(t.path).load()
            const row = rows.find(e => e.id === t.originalId)
            if (!row?.relations?.superseded_by?.includes(edgeId)) return
            row.relations.superseded_by = row.relations.superseded_by.filter(id => id !== edgeId)
            await this._writeEngrams(t.path, rows)
          })
        } catch (err) {
          logger.warning(`could not remove the superseded_by edge ${t.id} -> ${engram.id} after the write failed: ${err}`)
        }
      }
    }
  },

  _primaryQualifiedId(id: string): string {
    return namespaceEngramId(id, this._primaryRefScope())
  },

  _primaryRefScope(): string {
    return `primary:${resolve(this.paths.engrams)}`
  },

  _writeSupersededByEdges(engrams: Engram[], targetIds: string[], newId: string): Engram[] {
    const mutated: Engram[] = []
    for (const targetId of targetIds) {
      const target = engrams.find(e => e.id === targetId)
      if (!target) continue
      target.relations = target.relations ?? {
        broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [],
      }
      target.relations.superseded_by = target.relations.superseded_by ?? []
      if (!target.relations.superseded_by.includes(newId)) {
        target.relations.superseded_by.push(newId)
        mutated.push(target)
      }
    }
    return mutated
  },

  async purgeTensions(): Promise<{ purged_count: number; engrams_modified: number; stores_cleaned: number }> {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Purging legacy tensions (it rewrites personal memories)')
    // Collect all filesystem store paths (primary + project-scoped + pack stores)
    const storePaths = new Set<string>()
    storePaths.add(this.paths.engrams)
    for (const store of this.config.stores ?? []) {
      if (store.path && !store.url) storePaths.add(store.path)
    }

    let purgedCount = 0
    let modified = 0
    let storesCleaned = 0
    for (const storePath of storePaths) {
      try {
        // Check WITHOUT the lock, then do the work under it.
        //
        // The write rewrites the entire store, so it must use the authoritative
        // `load()` under the lock, never a cached snapshot: this is started
        // un-awaited from the constructor and can overlap the caller's first
        // learn, which a stale read-modify-write would overwrite.
        //
        // The unlocked pre-check matters: this runs on EVERY `Plur`
        // construction and almost always finds nothing to purge. Taking the
        // store's exclusive lock to discover that would serialize every startup
        // behind it — and on a YAML store it would create a lock file in the
        // storage directory as a side effect of doing nothing. The lock is only
        // taken when there is a write to make, and the state is re-read
        // authoritatively inside it, so the pre-check being stale is harmless.
        const probe = await this._loadCached(storePath)
        if (!probe.some(e => (e.relations?.conflicts?.length ?? 0) > 0)) continue

        const cleaned = await this._withStoreLock(storePath, async () => {
          const engrams = await this._storeAt(storePath).load()
          let storeModified = 0
          for (const e of engrams) {
            const len = e.relations?.conflicts?.length ?? 0
            if (len > 0) {
              e.relations!.conflicts = []
              purgedCount += len
              modified++
              storeModified++
            }
          }
          if (storeModified > 0) {
            await this._writeEngrams(storePath, engrams)
            return true
          }
          return false
        })
        if (cleaned) storesCleaned++
      } catch {
        // Store file missing or unreadable — skip
      }
    }
    return { purged_count: purgedCount, engrams_modified: modified, stores_cleaned: storesCleaned }
  },
}
