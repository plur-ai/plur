import * as fs from 'fs'
import { Plur } from '../index.js'


import { CONSOLIDATE_CHANGE_KIND, CONSOLIDATE_QUEUE_FILE, CONSOLIDATE_QUEUE_KEEP_ENTRIES, CONSOLIDATE_QUEUE_MAX_BYTES, CONSOLIDATE_STATE_FILE, CONSOLIDATION_PLAN_KIND, ConsolidateApplyDisabledError, type ConsolidateApplyOptions, type ConsolidateApplyResult, type ConsolidatePlanOptions, ConsolidateTrialRequiredError, type ConsolidationItem, type ConsolidationPlan, PARAPHRASE_QUEUE_THRESHOLD, type PlanCluster, type StoreHealth, assertConsolidationPlan, blockKeyFor, buildConsolidationPrompt, candidatePairs, clusterProtectedReasons, completeLinkageClusters, mergeEngrams, mixedPolarity, newPlanId, nightlySeed, parseConsolidationResponse, polarityOf, referencesTo, refreshProgress, remapReferences, retireInto, seededSample, structuredBodyOf } from '../consolidate.js'
import { ChangeAlreadyUndoneError, ChangeConflictError, ChangeJournalError, ChangeJournalUnsupportedError, ChangeNotFoundError, type ChangeRecord, ChangeRedactedError, type ChangeRowSnapshot, type ChangeTx, type PendingChange, UNDO_BOOKKEEPING_FIELDS, type UndoChangeOptions, canonicalRow, carryIgnoredFields, findUndoConflicts, isRedactedRow, journalBegin, journalCommit, newChangeId, readChangeJournal, redactChangeJournal } from '../change-journal.js'
import { type Engram } from '../schemas/engram.js'
import { type LlmFunction } from '../types.js'
import { PinDeniedError, asPinRequested, buildPinRequest, isPinEscalation, isPinTransition, pinEscalationDenied } from '../pin-policy.js'
import { collapseLineTerminators } from '../sanitize.js'
import { computeContentHash } from '../content-hash.js'
import { detectSecrets } from '../secrets.js'
import { generateEngramId, parseNamespacedId } from '../engrams.js'
import { isRemoteOnlyQueued } from '../remote-only-rows.js'
import { join } from 'path'
import { atomicWrite } from '../atomic-write.js'
import { logger } from '../logger.js'
import { resolveConsolidateConfig, resolveLearnConfig } from '../schemas/config.js'
export interface ConsolidationMethods {
  /**
   * Start an undoable change of the primary store. Nothing happens until
   * `apply(fn)` runs, which takes the store lock, hands `fn` the current
   * corpus, journals full before-snapshots of every row `fn` stages, writes
   * them in one store write, and returns the {@link ChangeRecord}. A change
   * applies once.
   */
  beginChange(kind: string, meta?: Record<string, unknown>): PendingChange

  /**
   * Undo a journalled change: restore the before-snapshot of every row it
   * touched (remove rows it created, put back rows it removed, in place), in
   * one write under the store lock. Refuses with {@link ChangeConflictError},
   * writing nothing, when any of those rows no longer holds what the change
   * wrote. The undo is itself a change (kind `undo`, `meta.undoes`), returned
   * here, and can be undone in turn.
   */
  undoChange(changeId: string, options?: UndoChangeOptions): Promise<ChangeRecord>

  /**
   * Redact every change-journal snapshot of these rows (S5): the journal
   * keeps full row content for undo, so a row whose content is being let go
   * of — forgotten, compacted away, found to hold a secret — must not live on
   * there. Undo of a change that touched a redacted row then refuses. `forget`
   * and `compact` call this themselves. Returns how many snapshots changed.
   */
  redactChangeJournal(ids: readonly string[]): Promise<number>

  /** Every journalled change, oldest first. */
  listChanges(): ChangeRecord[]

  /** One journalled change, or null. */
  getChange(changeId: string): ChangeRecord | null

  /**
   * Why a primary-store row is not a consolidation candidate, or null when it
   * is: only active, current, locally owned rows are merged (D7). Drafts,
   * superseded and retired rows, pack and secondary-store rows, rows queued
   * for a team store and rows in a scope a team store serves are left alone.
   */
  /** @internal */
  _consolidationExclusion(e: Engram): string | null

  /** @internal */
  _readConsolidateState(): { last_nightly_at?: string; carry_ids?: string[] }

  /**
   * Every id queued by `learn` (near-paraphrases, D8). Entries stay queued
   * until a nightly plan that looked at them finishes
   * ({@link _finishNightlyPlan} removes them by id), so a plan that stopped
   * part-way loses none.
   */
  /** @internal */
  _readConsolidateQueue(): string[]

  /**
   * A nightly plan finished (every cluster decided): record it. Only now does
   * `last_nightly_at` move (to the plan's start, so rows changed while it ran
   * are looked at next time); member ids of clusters dropped by the
   * `nightly_max_changes` cap are carried to the next plan; and the queue
   * entries this plan read are removed by id, keeping ones queued meanwhile.
   */
  /** @internal */
  _finishNightlyPlan(plan: ConsolidationPlan): void

  /**
   * Append near-paraphrases of a just-written engram to the consolidation
   * queue (D8): same-scope neighbours at or above
   * {@link PARAPHRASE_QUEUE_THRESHOLD}. The write itself already happened and
   * is not changed; the next `plur consolidate --plan` (nightly) looks at
   * them. Best effort, never throws.
   */
  /** @internal */
  _queueParaphrases(id: string, scope: string, neighbours: ReadonlyArray<{ id: string; score: number; scope?: string }>): number

  /** Is write-time reinforcement on for this write (D8)? The config decides; the caller's default applies only when it is silent. */
  /** @internal */
  _reinforceExactEnabled(context?: { reinforce_exact_default?: boolean }): boolean

  /**
   * Plan a consolidation of the primary store (`plur consolidate --plan`).
   *
   * Finds clusters of near-copies (complete linkage at `consolidate.threshold`,
   * within one scope and, in group scopes, one author; R1, D7), drops clusters
   * that mix a prohibition with a directive, marks clusters holding a pinned,
   * locked or prohibition engram as needing the owner's approval, and asks the
   * host model (`options.llm`) per batch whether each cluster can be merged
   * and into which statement. Nothing in the store changes. The plan is
   * returned; `onProgress` sees it after every model batch so a caller can
   * save it, and `resumeFrom` continues one whose model pass stopped.
   */
  consolidatePlan(options?: ConsolidatePlanOptions): Promise<ConsolidationPlan>

  /** @internal */
  _buildConsolidationPlan(options: ConsolidatePlanOptions, now: Date): Promise<ConsolidationPlan>

  /** Ask the model about every pending cluster, in batches; stop at the first failed call (the plan stays resumable). */
  /** @internal */
  _decideClusters(plan: ConsolidationPlan, llm: LlmFunction, batchSize: number, onProgress?: (plan: ConsolidationPlan) => void | Promise<void>): Promise<void>

  /**
   * Apply a consolidation plan (`plur consolidate --apply <file> --yes`).
   *
   * Refuses unless `consolidate.apply_enabled` is true, and refuses an apply
   * of more than one cluster until one cluster of this plan has been applied
   * (the one-item trial, D7). Each merged cluster is one journalled change
   * (`consolidate.merge`), undone with `undoChange(change_id)`: the merged
   * engram is written (R2 invariants, {@link mergeEngrams}), the originals are
   * retired with `superseded_by` (never deleted), and other local rows that
   * referenced an original are pointed at the merged engram. A
   * `consolidated_into` history event is written for each original.
   *
   * A cluster is skipped, with the reason, when the model did not say MERGE,
   * when it holds a pinned, locked or prohibition engram the owner has not
   * approved in the file, when a member changed since the plan, or when the
   * merged statement would leak into its scope or flip its polarity.
   */
  consolidateApply(plan: ConsolidationPlan, options?: ConsolidateApplyOptions): Promise<ConsolidateApplyResult>

  /** @internal */
  _applyConsolidationCluster(plan: ConsolidationPlan, cluster: PlanCluster, statement: string, nowDate: Date): Promise<ConsolidateApplyResult['applied'][number] | { skip: 'drifted' | 'needs_approval'; detail?: string }>

  /**
   * Store health for `plur status` (overhaul W6): size, the sampled near-copy
   * share at 0.90 and 0.85, and the pin load against its share of the
   * injection budget. Read-only and model-free: the near-copy sample uses only
   * vectors already in the embedding cache (reported as `with_vector`), and
   * the sample is seeded (default: today's date) so two runs on one day agree.
   */
  storeHealth(options?: { sampleSize?: number; seed?: string; now?: Date }): Promise<StoreHealth>

  /**
   * The write-time reinforcement a `learn` reported (D8), or null. Set on the
   * engram object a `learn`/`learnRouted` returned when the write was an exact
   * normalised restatement that reinforced an existing engram.
   */
  reinforcementOf(engram: object): { decision: 'REINFORCE'; existing_id: string; existing_statement: string; swallowed: string } | null

  /** @internal */
  _assertChangeJournalSupported(): void

  /** @internal */
  _assertChangeRowLocal(row: Engram): void

  /** @internal */
  _applyChange(id: string, kind: string, meta: Record<string, unknown>, fn: (tx: ChangeTx & { put(engram: Engram, index?: number): void }) => void | Promise<void>): Promise<ChangeRecord>
}

export const consolidationMethods: ConsolidationMethods & ThisType<Plur> = {
  beginChange(kind: string, meta: Record<string, unknown> = {}): PendingChange {
    const id = newChangeId()
    let used = false
    return {
      id,
      kind,
      meta,
      apply: async (fn) => {
        if (used) throw new ChangeJournalError(`Change ${id} was already applied.`)
        used = true
        return await this._applyChange(id, kind, meta, fn)
      },
    }
  },

  async undoChange(changeId: string, options: UndoChangeOptions = {}): Promise<ChangeRecord> {
    const ignore = options.ignoreFields ?? UNDO_BOOKKEEPING_FIELDS
    const undoId = newChangeId()
    return await this._applyChange(undoId, 'undo', { undoes: changeId }, (tx) => {
      // Read under the lock, so a concurrent undo of the same change sees the first one's record.
      const record = readChangeJournal(this.paths.root).find(r => r.id === changeId)
      if (!record) throw new ChangeNotFoundError(changeId)
      if (record.undone_by) throw new ChangeAlreadyUndoneError(changeId, record.undone_by)
      const redacted = record.rows.filter(r => isRedactedRow(r.before) || isRedactedRow(r.after)).map(r => r.id)
      if (redacted.length > 0) throw new ChangeRedactedError(changeId, redacted)
      const current = new Map<string, Engram>()
      for (const row of record.rows) {
        const now = tx.get(row.id)
        if (now) current.set(row.id, now)
      }
      const conflicts = findUndoConflicts(record, current, ignore)
      if (conflicts.length > 0) throw new ChangeConflictError(changeId, conflicts)
      // Re-inserts go in ascending original position so each lands where it was.
      const rows = [...record.rows].sort((x, y) => (x.index ?? Infinity) - (y.index ?? Infinity))
      for (const row of rows) {
        if (row.before === null) { tx.remove(row.id); continue }
        const restored = structuredClone(row.before) as Record<string, unknown>
        const now = current.get(row.id) as Record<string, unknown> | undefined
        if (now) carryIgnoredFields(restored, now, (row.after ?? undefined) as Record<string, unknown> | undefined, ignore)
        tx.put(restored as Engram, row.index ?? undefined)
      }
    })
  },

  async redactChangeJournal(ids: readonly string[]): Promise<number> {
    this._assertWritable()
    // The journal holds personal rows in full: never touched from a remote-only folder.
    this._remoteOnlyRefuseLocalStore('Redacting the change journal (run it outside the remote-only folder)')
    if (ids.length === 0) return 0
    return await this._withStoreLock(this.paths.engrams, async () => redactChangeJournal(this.paths.root, ids))
  },

  listChanges(): ChangeRecord[] {
    // The journal holds personal rows in full: never read from a remote-only folder.
    this._remoteOnlyRefuseLocalStore('Reading the change journal (run it outside the remote-only folder)')
    return readChangeJournal(this.paths.root)
  },

  getChange(changeId: string): ChangeRecord | null {
    this._remoteOnlyRefuseLocalStore('Reading the change journal (run it outside the remote-only folder)')
    return readChangeJournal(this.paths.root).find(r => r.id === changeId) ?? null
  },

  _consolidationExclusion(e: Engram): string | null {
    if (e.status !== 'active') return 'inactive'
    if ((e.relations?.superseded_by?.length ?? 0) > 0) return 'superseded'
    if (e.commitment === 'draft') return 'draft'
    if (e.pack) return 'pack'
    if (parseNamespacedId(e.id) || (e as { _storeScope?: string })._storeScope !== undefined) return 'other_store'
    if ((e as { structured_data?: { _outbox?: unknown } }).structured_data?._outbox || isRemoteOnlyQueued(e)) return 'queued'
    if (typeof e.scope !== 'string' || this._isRemoteBackedScope(e.scope)) return 'team_scope'
    return null
  },

  _readConsolidateState(): { last_nightly_at?: string; carry_ids?: string[] } {
    try {
      return JSON.parse(fs.readFileSync(join(this.paths.root, CONSOLIDATE_STATE_FILE), 'utf8')) ?? {}
    } catch { return {} }
  },

  _readConsolidateQueue(): string[] {
    const text = readQueueTail(join(this.paths.root, CONSOLIDATE_QUEUE_FILE))
    if (text === null) return []
    const ids: string[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const q = JSON.parse(line) as { id?: string; neighbour_id?: string }
        if (q.id) ids.push(q.id)
        if (q.neighbour_id) ids.push(q.neighbour_id)
      } catch { /* skip a torn line */ }
    }
    return [...new Set(ids)]
  },

  _finishNightlyPlan(plan: ConsolidationPlan): void {
    if (plan.mode !== 'nightly' || !plan.nightly || !plan.progress.complete || this._readonly) return
    const root = this.paths.root
    try {
      atomicWrite(join(root, CONSOLIDATE_STATE_FILE), JSON.stringify({
        last_nightly_at: plan.created_at, last_seed: plan.seed, last_plan_id: plan.plan_id,
        carry_ids: plan.nightly.carried_ids ?? [],
      }, null, 2) + '\n', { mode: 0o600 })
    } catch (err) {
      // The next nightly run looks further back and re-reads the queue, so
      // nothing is lost, but the owner is told (H9).
      logger.warning(`[plur] consolidate: the nightly state could not be saved (${(err as Error).message}); the next nightly run will look further back`)
      return
    }
    const consumed = new Set(plan.nightly.queued_ids)
    if (consumed.size === 0) return
    const path = join(root, CONSOLIDATE_QUEUE_FILE)
    try {
      const text = readQueueTail(path)
      if (text === null) return
      const kept = text.split('\n').filter(line => {
        if (!line.trim()) return false
        try { return !consumed.has((JSON.parse(line) as { id?: string }).id ?? '') } catch { return false }
      })
      atomicWrite(path, kept.length > 0 ? kept.join('\n') + '\n' : '', { mode: 0o600 })
    } catch (err) {
      logger.warning(`[plur] consolidate: consumed paraphrase-queue entries could not be removed (${(err as Error).message}); they are looked at again next time`)
    }
  },

  _queueParaphrases(id: string, scope: string, neighbours: ReadonlyArray<{ id: string; score: number; scope?: string }>): number {
    const hits = neighbours.filter(n => n.id !== id && n.score >= PARAPHRASE_QUEUE_THRESHOLD && (n.scope === undefined || n.scope === scope))
    if (hits.length === 0) return 0
    try {
      if (this._remoteOnly) return 0
      const at = new Date().toISOString()
      const fresh = hits.map(n => JSON.stringify({ at, id, neighbour_id: n.id, score: Number(n.score.toFixed(4)), scope }))
      const path = join(this.paths.root, CONSOLIDATE_QUEUE_FILE)
      const add = fresh.join('\n') + '\n'
      let size = 0
      try { size = fs.statSync(path).size } catch { /* no queue yet */ }
      if (size + Buffer.byteLength(add) <= CONSOLIDATE_QUEUE_MAX_BYTES) {
        fs.appendFileSync(path, add, { encoding: 'utf8', mode: 0o600 })
      } else {
        // At the cap (H6): rewrite with one entry per pair, newest kept.
        atomicWrite(path, compactParaphraseQueue([...(readQueueTail(path) ?? '').split('\n'), ...fresh]), { mode: 0o600 })
      }
      return hits.length
    } catch { return 0 }
  },

  _reinforceExactEnabled(context?: { reinforce_exact_default?: boolean }): boolean {
    const configured = (this.config as { learn?: { reinforce_exact?: boolean } }).learn?.reinforce_exact
    if (typeof configured === 'boolean') return configured
    if (typeof context?.reinforce_exact_default === 'boolean') return context.reinforce_exact_default
    return resolveLearnConfig(this.config).reinforce_exact
  },

  async consolidatePlan(options: ConsolidatePlanOptions = {}): Promise<ConsolidationPlan> {
    this._remoteOnlyRefuseLocalStore('Planning a consolidation (run it outside the remote-only folder)')
    this.reloadConfigIfChanged()
    const now = options.now ?? new Date()
    let plan: ConsolidationPlan
    if (options.resumeFrom) {
      assertConsolidationPlan(options.resumeFrom)
      plan = structuredClone(options.resumeFrom)
    } else {
      plan = await this._buildConsolidationPlan(options, now)
    }
    if (options.llm) await this._decideClusters(plan, options.llm, options.batchSize ?? 8, options.onProgress)
    refreshProgress(plan)
    plan.updated_at = new Date().toISOString()
    this._finishNightlyPlan(plan)
    return plan
  },

  async _buildConsolidationPlan(options: ConsolidatePlanOptions, now: Date): Promise<ConsolidationPlan> {
    const cfg = resolveConsolidateConfig(this.config)
    const threshold = options.threshold ?? cfg.threshold
    const seed = options.seed ?? nightlySeed(now)
    const corpus = await this._primaryStore.load()
    const excluded: Record<string, number> = {}
    const eligible: Engram[] = []
    for (const e of corpus) {
      const why = this._consolidationExclusion(e)
      if (why) excluded[why] = (excluded[why] ?? 0) + 1
      else eligible.push(e)
    }
    const { engramVectors } = await import('../embeddings.js')
    const { vectors, missing } = await engramVectors(eligible, this.paths.root, { embedMissing: options.embedMissing ?? true })

    let focus: Set<string> | undefined
    let nightly: ConsolidationPlan['nightly']
    if (options.nightly) {
      const state = this._readConsolidateState()
      const since = state.last_nightly_at ?? null
      const changed = since
        ? eligible.filter(e => (e.updated_at ?? e.created_at ?? '') > since).map(e => e.id)
        : []
      const queued = this._readConsolidateQueue()
      const carried = (state.carry_ids ?? []).filter(id => typeof id === 'string')
      const sampled = seededSample(eligible.map(e => e.id).sort(), seed, options.sampleSize ?? 200)
      focus = new Set([...changed, ...queued, ...carried, ...sampled])
      nightly = { date: nightlySeed(now), changed_since: since, sampled_ids: sampled, queued_ids: queued, carried_in_ids: carried, max_changes: cfg.nightly_max_changes }
    }

    const byId = new Map(eligible.map(e => [e.id, e]))
    const items: ConsolidationItem[] = []
    for (const e of eligible) {
      const v = vectors.get(e.id)
      if (v) items.push({ id: e.id, block: blockKeyFor(e), v })
    }
    const pairs = candidatePairs(items, { threshold, seed, focus })
    const found = completeLinkageClusters(vectors, pairs, { threshold, maxSize: options.maxClusterSize ?? 8 })

    let mixed = 0
    let protectedCount = 0
    const clusters: PlanCluster[] = []
    for (const c of found.sort((x, y) => y.min_similarity - x.min_similarity)) {
      const members = c.members.map(id => byId.get(id)!).sort((x, y) => (x.id < y.id ? -1 : 1))
      if (mixedPolarity(members)) { mixed++; continue }
      const reasons = clusterProtectedReasons(members)
      if (reasons.length > 0) protectedCount++
      clusters.push({
        id: `K-${String(clusters.length + 1).padStart(4, '0')}`,
        scope: members[0].scope,
        block: blockKeyFor(members[0]),
        members: members.map(e => ({
          id: e.id,
          statement: e.statement,
          statement_hash: computeContentHash(e.statement),
          pinned: (e as { pinned?: boolean }).pinned === true,
          locked: e.commitment === 'locked',
          polarity: polarityOf(e),
          retrieval_strength: e.activation?.retrieval_strength ?? 0,
        })),
        min_similarity: Number(c.min_similarity.toFixed(4)),
        polarity: polarityOf(members[0]),
        protected_reasons: reasons,
        requires_owner_approval: reasons.length > 0,
        approved: false,
        decision: 'pending',
      })
    }
    const kept = nightly ? clusters.slice(0, nightly.max_changes) : clusters
    if (nightly) nightly.carried_ids = clusters.slice(kept.length).flatMap(c => c.members.map(m => m.id))

    const plan: ConsolidationPlan = {
      kind: CONSOLIDATION_PLAN_KIND,
      version: 1,
      plan_id: newPlanId(now, seed),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      mode: options.nightly ? 'nightly' : 'full',
      threshold,
      seed,
      seed_source: options.seed ? 'given' : 'date',
      ...(nightly ? { nightly } : {}),
      stats: {
        rows: corpus.length,
        eligible: eligible.length,
        excluded,
        without_vector: missing.length,
        candidate_pairs: pairs.length,
        clusters_found: found.length,
        mixed_polarity: mixed,
        protected: protectedCount,
      },
      clusters: kept,
      progress: { decided: 0, pending: kept.length, complete: kept.length === 0, model_calls: 0, model_errors: 0 },
    }
    return plan
  },

  async _decideClusters(
    plan: ConsolidationPlan, llm: LlmFunction, batchSize: number,
    onProgress?: (plan: ConsolidationPlan) => void | Promise<void>,
  ): Promise<void> {
    const pending = plan.clusters.filter(c => c.decision === 'pending')
    const size = Math.max(1, batchSize)
    // Rationale and structured body go to the model with the statement, so a
    // merged statement can keep what only a non-base member said.
    const rows = pending.length > 0 ? new Map((await this._primaryStore.load()).map(e => [e.id, e])) : new Map<string, Engram>()
    const promptMember = (m: { id: string; statement: string }) => {
      const row = rows.get(m.id)
      const rationale = typeof row?.rationale === 'string' && row.rationale.trim() ? row.rationale : undefined
      const body = row ? structuredBodyOf(row) : undefined
      return { id: m.id, statement: m.statement, ...(rationale ? { rationale } : {}), ...(body ? { body } : {}) }
    }
    for (let i = 0; i < pending.length; i += size) {
      const batch = pending.slice(i, i + size)
      let answer: string
      try {
        plan.progress.model_calls++
        answer = await llm(buildConsolidationPrompt(batch.map(c => ({ members: c.members.map(promptMember) }))))
      } catch (err) {
        plan.progress.model_errors++
        plan.progress.last_error = err instanceof Error ? err.message : String(err)
        refreshProgress(plan)
        await onProgress?.(plan)
        return
      }
      const parsed = parseConsolidationResponse(answer, batch.length)
      batch.forEach((c, j) => {
        const d = parsed[j]
        if (d.decision === 'merge') { c.decision = 'merge'; c.merged_statement = d.statement; c.reason = d.reason }
        else if (d.decision === 'split') { c.decision = 'split'; c.reason = d.reason }
      })
      refreshProgress(plan)
      plan.updated_at = new Date().toISOString()
      await onProgress?.(plan)
    }
  },

  async consolidateApply(plan: ConsolidationPlan, options: ConsolidateApplyOptions = {}): Promise<ConsolidateApplyResult> {
    this._remoteOnlyRefuseLocalStore('Applying a consolidation (run it outside the remote-only folder)')
    assertConsolidationPlan(plan)
    this.reloadConfigIfChanged()
    if (!resolveConsolidateConfig(this.config).apply_enabled) throw new ConsolidateApplyDisabledError()
    this._assertChangeJournalSupported()
    const appliedClusters = new Set(
      readChangeJournal(this.paths.root)
        .filter(r => r.kind === CONSOLIDATE_CHANGE_KIND && r.state === 'committed' && !r.undone_by && r.meta.plan_id === plan.plan_id)
        .map(r => String(r.meta.cluster_id)),
    )
    if (appliedClusters.size === 0 && options.limit !== 1) throw new ConsolidateTrialRequiredError(plan.plan_id)
    const limit = options.limit ?? Infinity
    const result: ConsolidateApplyResult = { plan_id: plan.plan_id, applied: [], skipped: [] }
    for (const cluster of plan.clusters) {
      const skip = (reason: ConsolidateApplyResult['skipped'][number]['reason'], detail?: string) =>
        result.skipped.push({ cluster_id: cluster.id, reason, ...(detail ? { detail } : {}) })
      if (appliedClusters.has(cluster.id)) { skip('already_applied'); continue }
      if (cluster.decision === 'split') { skip('split'); continue }
      if (cluster.decision !== 'merge' || !cluster.merged_statement?.trim()) { skip('not_decided'); continue }
      if (cluster.requires_owner_approval && cluster.approved !== true) { skip('needs_approval', cluster.protected_reasons.join(', ')); continue }
      if (result.applied.length >= limit) { skip('limit'); continue }
      // The plan file is editable: a statement is one line, as every write path makes it (S8).
      const statement = collapseLineTerminators(cluster.merged_statement).trim()
      if (polarityOf({ statement, polarity: null }) !== cluster.polarity) { skip('polarity_changed'); continue }
      if (detectSecrets(statement).length > 0 || this._offendingHitsForScope(statement, cluster.scope).length > 0) { skip('sensitive'); continue }
      if (this._isRemoteBackedScope(cluster.scope)) { skip('not_local', cluster.scope); continue }
      const outcome = await this._applyConsolidationCluster(plan, cluster, statement, options.now ?? new Date())
      if ('skip' in outcome) skip(outcome.skip, outcome.detail)
      else result.applied.push(outcome)
    }
    return result
  },

  async _applyConsolidationCluster(
    plan: ConsolidationPlan, cluster: PlanCluster, statement: string, nowDate: Date,
  ): Promise<ConsolidateApplyResult['applied'][number] | { skip: 'drifted' | 'needs_approval'; detail?: string }> {
    const now = nowDate.toISOString()
    const idsInUse = await this._idsInUse()
    const memberIds = cluster.members.map(m => m.id)
    const from = new Set(memberIds)
    let mergedId = ''
    const touched: string[] = []
    class Skip extends Error { constructor(readonly reason: 'drifted' | 'needs_approval', readonly detail: string) { super(detail) } }
    const change = this.beginChange(CONSOLIDATE_CHANGE_KIND, {
      plan_id: plan.plan_id, cluster_id: cluster.id, members: memberIds, merged_statement: statement,
    })
    let record: ChangeRecord
    try {
      record = await change.apply(tx => {
        const members: Engram[] = []
        for (const m of cluster.members) {
          const row = tx.get(m.id)
          if (!row) throw new Skip('drifted', `${m.id} is gone`)
          if (this._consolidationExclusion(row)) throw new Skip('drifted', `${m.id} is no longer an active, current, local engram`)
          if (row.scope !== cluster.scope) throw new Skip('drifted', `${m.id} moved to scope ${row.scope}`)
          if (computeContentHash(row.statement) !== m.statement_hash) throw new Skip('drifted', `${m.id} was edited since the plan`)
          members.push(row)
        }
        // One block, re-derived from the rows (S12): in a group scope every
        // member must still have one author — the planned one — so a plan
        // edited to add another author's row, or a row whose author changed,
        // never merges authors.
        const blocks = new Set(members.map(e => blockKeyFor(e)))
        if (blocks.size > 1 || (cluster.block !== undefined && !blocks.has(cluster.block))) {
          throw new Skip('drifted', cluster.scope.startsWith('group:')
            ? 'the members no longer share the planned author'
            : 'the members no longer share the planned block')
        }
        if (mixedPolarity(members)) throw new Skip('drifted', 'the members no longer share a polarity')
        if (clusterProtectedReasons(members).length > 0 && cluster.approved !== true) {
          throw new Skip('needs_approval', 'a member is pinned, locked or a prohibition, or a non-base member carries a body, rationale or dual coding')
        }
        const all = tx.all()
        mergedId = generateEngramId(all, idsInUse)
        const merged = mergeEngrams(members, { id: mergedId, statement, now, planId: plan.plan_id, clusterId: cluster.id })
        tx.put(merged)
        for (const e of members) tx.put(retireInto(e, mergedId, now))
        for (const row of all) {
          if (from.has(row.id) || row.id === mergedId) continue
          const remapped = remapReferences(row, from, mergedId)
          if (!remapped) continue
          // Only rows the journal can stage: local, not a pack, not a team scope.
          if (row.pack || parseNamespacedId(row.id) || this._isRemoteBackedScope(row.scope)) continue
          tx.put(remapped)
          touched.push(row.id)
        }
      })
    } catch (err) {
      if (err instanceof Skip) return { skip: err.reason, detail: err.detail }
      throw err
    }
    this._rememberMintedId(mergedId)
    for (const id of memberIds) {
      try {
        this._appendHistory({
          event: 'consolidated_into',
          engram_id: id,
          timestamp: now,
          data: { into: mergedId, change_id: record.id, plan_id: plan.plan_id, cluster_id: cluster.id },
          reason: 'store consolidation: merged near-copies into one engram',
        })
      } catch (err) {
        // History is an audit trail, not a gate on the write, but a gap in it is reported (H9).
        logger.warning(`[plur] consolidate: the consolidated_into history event for ${id} could not be written (${(err as Error).message})`)
      }
    }
    // Rows the journal could not stage (packs, team scopes, other stores)
    // keep pointing at the retired originals: say which, so the owner can
    // fix them where they live.
    const stillReferencing: Array<{ id: string; references: string[] }> = []
    try {
      for (const row of await this._loadAllEngrams()) {
        if (from.has(row.id) || row.id === mergedId) continue
        const refs = referencesTo(row, from)
        if (refs.length > 0) stillReferencing.push({ id: row.id, references: refs })
      }
    } catch { /* a report, never a gate on the applied change */ }
    return { cluster_id: cluster.id, change_id: record.id, merged_id: mergedId, retired: memberIds, touched, still_referencing: stillReferencing }
  },

  async storeHealth(options: { sampleSize?: number; seed?: string; now?: Date } = {}): Promise<StoreHealth> {
    this._remoteOnlyRefuseLocalStore('Reading store health (run it outside the remote-only folder)')
    const corpus = await this._primaryStore.load()
    const active = corpus.filter(e => e.status === 'active')
    const eligible = corpus.filter(e => !this._consolidationExclusion(e))
    const seed = options.seed ?? nightlySeed(options.now ?? new Date())
    let near_copy: StoreHealth['near_copy']
    const { engramVectors } = await import('../embeddings.js')
    const { vectors, embedder } = await engramVectors(eligible, this.paths.root, { embedMissing: false })
    if (!embedder) {
      near_copy = { available: false, reason: 'embeddings are off or the embedder is unavailable' }
    } else if (vectors.size < 2) {
      near_copy = { available: false, reason: 'the embedding cache holds no vectors for this store yet (run a recall or `plur consolidate --plan` first)' }
    } else {
      const withVector = eligible.filter(e => vectors.has(e.id))
      const byBlock = new Map<string, Engram[]>()
      for (const e of withVector) {
        const k = blockKeyFor(e)
        const list = byBlock.get(k)
        if (list) list.push(e)
        else byBlock.set(k, [e])
      }
      const sample = seededSample(withVector.map(e => e.id).sort(), seed, options.sampleSize ?? 100)
      const byId = new Map(withVector.map(e => [e.id, e]))
      let at90 = 0
      let at85 = 0
      for (const id of sample) {
        const e = byId.get(id)!
        const v = vectors.get(id)!
        let best = -1
        for (const o of byBlock.get(blockKeyFor(e)) ?? []) {
          if (o.id === id) continue
          const w = vectors.get(o.id)!
          let s = 0
          for (let d = 0; d < v.length; d++) s += v[d] * w[d]
          if (s > best) best = s
        }
        if (best >= 0.9) at90++
        if (best >= 0.85) at85++
      }
      near_copy = {
        available: true, seed, sample_size: sample.length, with_vector: withVector.length, eligible: eligible.length,
        share_090: sample.length ? Number((at90 / sample.length).toFixed(4)) : 0,
        share_085: sample.length ? Number((at85 / sample.length).toFixed(4)) : 0,
      }
    }
    const q = await this.pinnedQuota()
    return {
      rows: corpus.length,
      active: active.length,
      near_copy,
      pins: { count: q.count, tokens: q.used, share_tokens: q.quota, pinned_ratio: this.config.injection?.pinned_ratio ?? 0.5, over_share: q.used > q.quota },
    }
  },

  reinforcementOf(engram: object): { decision: 'REINFORCE'; existing_id: string; existing_statement: string; swallowed: string } | null {
    return this._reinforced.get(engram) ?? null
  },

  _assertChangeJournalSupported(): void {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Applying or undoing a journalled change (run it outside the remote-only folder)')
    if (this._basePrimaryStore.kind !== 'yaml') {
      throw new ChangeJournalUnsupportedError(
        `Undoable changes need the local YAML primary store; this instance uses "${this._basePrimaryStore.kind}".`,
      )
    }
  },

  _assertChangeRowLocal(row: Engram): void {
    if (!row || typeof row.id !== 'string' || !row.id) throw new ChangeJournalError('A change row needs an id.')
    if (parseNamespacedId(row.id)) {
      throw new ChangeJournalUnsupportedError(`${row.id} names a secondary or team store; changes act on the local primary store only.`)
    }
    if ((row as { pack?: unknown }).pack) {
      throw new ChangeJournalUnsupportedError(`${row.id} belongs to pack "${String((row as { pack?: unknown }).pack)}"; changes act on locally owned rows only.`)
    }
    if (typeof row.scope === 'string' && this._isRemoteBackedScope(row.scope)) {
      throw new ChangeJournalUnsupportedError(`${row.id} has scope "${row.scope}", which a team store serves; changes act on locally owned scopes only.`)
    }
  },

  async _applyChange(
    id: string,
    kind: string,
    meta: Record<string, unknown>,
    fn: (tx: ChangeTx & { put(engram: Engram, index?: number): void }) => void | Promise<void>,
  ): Promise<ChangeRecord> {
    this._assertChangeJournalSupported()
    this.reloadConfigIfChanged()
    return await this._withStoreLock(this.paths.engrams, async () => {
      // Authoritative read under the lock: the snapshots are exactly what this write replaces.
      const corpus = await this._primaryStore.load()
      const position = new Map<string, number>()
      corpus.forEach((e, i) => position.set(e.id, i))
      const staged = new Map<string, { row: Engram | null; index?: number }>()
      const order: string[] = []
      const currentRow = (rid: string): Engram | undefined => {
        const s = staged.get(rid)
        if (s) return s.row ?? undefined
        const i = position.get(rid)
        return i === undefined ? undefined : corpus[i]
      }
      const stage = (rid: string, row: Engram | null, index?: number) => {
        if (!staged.has(rid)) order.push(rid)
        staged.set(rid, { row, index })
      }
      const tx = {
        get: (rid: string) => {
          const r = currentRow(rid)
          return r ? structuredClone(r) : undefined
        },
        all: () => {
          const out = corpus.map(e => currentRow(e.id)).filter((e): e is Engram => !!e)
          for (const rid of order) if (!position.has(rid) && staged.get(rid)!.row) out.push(staged.get(rid)!.row!)
          return out.map(e => structuredClone(e))
        },
        put: (engram: Engram, index?: number) => {
          this._assertChangeRowLocal(engram)
          stage(engram.id, structuredClone(engram), index)
        },
        remove: (rid: string) => {
          if (currentRow(rid) === undefined) throw new ChangeJournalError(`Cannot remove ${rid}: no such row in the primary store.`)
          stage(rid, null)
        },
      }
      await fn(tx)

      // Agent pinning (overhaul D2): a staged row that turns into a pin
      // follows `pinning.agents` for the change's actor (`meta.actor`). An
      // undo restores its before-snapshot as it was and is not policed.
      if (kind !== 'undo') {
        const actor = meta.actor === 'owner' || meta.actor === 'agent' ? meta.actor : undefined
        for (const rid of order) {
          const s = staged.get(rid)!
          const i = position.get(rid)
          const prior = i === undefined ? null : corpus[i]
          // A stronger pin on an existing pin follows the policy too (H5).
          if (s.row && isPinEscalation(prior, s.row)) {
            const escalation = this._pinDecisionFor(actor)
            if (escalation !== 'allow') throw pinEscalationDenied(rid, `change:${kind}`, escalation)
          }
          if (!s.row || !isPinTransition(prior, s.row)) continue
          const decision = this._pinDecisionFor(actor)
          if (decision === 'deny') throw new PinDeniedError(rid, `change:${kind}`)
          if (decision === 'request') {
            s.row = asPinRequested(s.row, buildPinRequest(actor ?? this._defaultActor, `change:${kind}`, {
              tier: (s.row as { pinned_tier?: 'hard' | 'soft' }).pinned_tier,
              priority: (s.row as { pinned_priority?: number }).pinned_priority,
            }))
          }
        }
      }

      const at = new Date().toISOString()
      const rows: ChangeRowSnapshot[] = order.map(rid => {
        const i = position.get(rid)
        return {
          id: rid,
          index: i ?? staged.get(rid)!.index ?? null,
          before: i === undefined ? null : structuredClone(corpus[i]),
          after: staged.get(rid)!.row,
        }
      })
      // Rows that were absent before and are absent after (created then removed) touch nothing.
      const effective = rows.filter(r => r.before !== null || r.after !== null)

      // Build the new corpus: replace or drop in place, then insert rows that
      // were absent — at their requested position (an undo putting a removed
      // row back) or at the end (a create), in staging order.
      const next: Engram[] = []
      for (const e of corpus) {
        const s = staged.get(e.id)
        if (!s) next.push(e)
        else if (s.row) next.push(s.row)
      }
      const inserts = order.filter(rid => !position.has(rid) && staged.get(rid)!.row)
      const positioned = inserts.filter(rid => staged.get(rid)!.index !== undefined)
        .sort((x, y) => staged.get(x)!.index! - staged.get(y)!.index!)
      for (const rid of positioned) next.splice(Math.min(staged.get(rid)!.index!, next.length), 0, staged.get(rid)!.row!)
      for (const rid of inserts) if (staged.get(rid)!.index === undefined) next.push(staged.get(rid)!.row!)

      journalBegin(this.paths.root, { id, kind, meta, at, rows: effective })
      if (effective.length > 0) {
        const removes = effective.some(r => r.after === null)
        await this._writeEngrams(this.paths.engrams, next, { allowShrink: removes })
        await this._syncIndex()
      }
      // Record what is really stored now (the loader may normalise a row), so
      // undo compares against the disk, not against what was staged.
      const stored = new Map((await this._primaryStore.load()).map(e => [e.id, e]))
      const adjusted: Record<string, Engram | null> = {}
      for (const r of effective) {
        const now = stored.get(r.id) ?? null
        if (canonicalRow(now) !== canonicalRow(r.after)) { adjusted[r.id] = now; r.after = now }
      }
      journalCommit(this.paths.root, id, adjusted)
      // History is the audit trail, never a gate on the write.
      for (const r of effective) {
        // A row the change took to `retired` (consolidation retiring an
        // original) is a retirement, not an update.
        const retiredNow = r.after !== null && r.after.status === 'retired' && r.before?.status !== 'retired'
        try {
          this._appendHistory({
            event: r.before === null ? 'engram_created' : (r.after === null || retiredNow) ? 'engram_retired' : 'engram_updated',
            engram_id: r.id,
            timestamp: at,
            data: { via: kind === 'undo' ? 'change_undo' : 'change', change_id: id, kind, ...(r.after === null ? { removed: true } : {}) },
          })
        } catch { /* see above */ }
      }
      return { id, kind, meta, at, state: 'committed' as const, rows: effective }
    })
  },
}

/**
 * The last {@link CONSOLIDATE_QUEUE_MAX_BYTES} of the paraphrase queue, from
 * the first whole line; null when there is no queue (H6).
 */
function readQueueTail(path: string): string | null {
  let fd: number
  try { fd = fs.openSync(path, 'r') } catch { return null }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - CONSOLIDATE_QUEUE_MAX_BYTES)
    const buf = Buffer.alloc(size - start)
    let off = 0
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, start + off)
      if (n <= 0) break
      off += n
    }
    const text = buf.subarray(0, off).toString('utf8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1)
  } finally { fs.closeSync(fd) }
}

/** Queue lines deduped by pair (either order; the newest kept), oldest dropped past the keep limit (H6). */
function compactParaphraseQueue(lines: readonly string[]): string {
  const byPair = new Map<string, string>()
  for (const line of lines) {
    if (!line.trim()) continue
    let q: { id?: unknown; neighbour_id?: unknown }
    try { q = JSON.parse(line) } catch { continue }
    if (typeof q.id !== 'string') continue
    const nb = typeof q.neighbour_id === 'string' ? q.neighbour_id : ''
    const key = q.id < nb ? `${q.id}\u0000${nb}` : `${nb}\u0000${q.id}`
    byPair.delete(key)
    byPair.set(key, line)
  }
  const kept = [...byPair.values()].slice(-CONSOLIDATE_QUEUE_KEEP_ENTRIES)
  return kept.length > 0 ? kept.join('\n') + '\n' : ''
}
