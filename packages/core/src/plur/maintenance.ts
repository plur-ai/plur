import * as fs from 'fs'
import { getEmbedder, resolveEmbedderName } from '../embedders/index.js'
import { loadPack, matchLegacyPackId, packEngramId } from '../engrams.js'
import { captureEpisode, queryTimeline } from '../episodes.js'
import { applyFeedbackSignal, type FeedbackSource } from '../feedback.js'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import type { ExportOptions } from '../packs.js'
import { exportPack, installPack, listPacks, migratePackIntegrity, previewPack, uninstallPack } from '../packs.js'
import { isRemoteOnlyQueued } from '../remote-only-rows.js'
import type { Engram } from '../schemas/engram.js'
import type { Episode } from '../schemas/episode.js'
import { detectSecrets } from '../secrets.js'
import type { StorageAdapter } from '../storage-adapter.js'
import { asDerivedIndex, requiresIndexSync } from '../storage-adapter.js'
import { IndexedStorage } from '../storage-indexed.js'
import { PGLiteAdapter } from '../storage-pglite.js'
import type {
    CaptureContext,
    TimelineQuery
} from '../types.js'
import { INGEST_PATTERNS, isStoreTeardownError, PRIMARY_AUTO_EMBED_BATCH } from './helpers.js'
import { IndexSyncError, IngestCandidate, IngestOptions } from './types.js'

export interface MaintenanceMethods {
/** Remove retired engrams from storage. Returns count of removed and remaining. */
compact(): Promise<{ removed: number; remaining: number }>

/**
   * Rebuild the derived index from YAML source of truth.
   * Works for both backends: SQLite (legacy) and PGLite (ADR-0001).
   * Sync-shaped to preserve the existing public API; PGLite work is fired off
   * and the promise tracked on the instance so `await plur.reindexAsync()` is
   * available for code paths that need to block.
   */
reindex(): Promise<void>

/**
   * Async reindex that resolves when the index is fully rebuilt.
   * Equivalent to `plur sync --full`: drop the index and rebuild from YAML.
   */
reindexAsync(): Promise<void>

/**
   * Embed any active engrams missing a row in engram_embeddings and upsert them.
   * Runs after every syncFromYaml/reindex so learn()/learnAsync()/
   * sync() keep the PGLite vector index in step with YAML. Skips silently when
   * the embedder is unavailable (recall on those engrams degrades to the JSON
   * path until the next cycle) or when the active embedder dim differs from the
   * indexed column (run `plur sync --reembed --full` to migrate intentionally).
   */
/** @internal */
_autoEmbedNewEngrams(adapter: PGLiteAdapter): Promise<void>

/**
   * Kick (or coalesce into) the background primary-store auto-embed pass.
   * Fire-and-track: callers never await it — a write must not pay
   * embedding latency, and a semantic recall must not block on a backfill.
   * The pass is tracked on `_pgliteInitPromise` so `waitForIndex()` covers it
   * exactly like the PGLite background chains.
   */
/** @internal */
_kickPrimaryAutoEmbed(adapter: StorageAdapter): void

/**
   * Embed active engrams missing a row in the primary store's embedding table
   * — the Postgres-primary counterpart of `_autoEmbedNewEngrams`.
   *
   * Deliberately NOT that method: `_autoEmbedNewEngrams` loads the whole
   * corpus and probes `hasEmbedding` per id, which is fine for a local PGLite
   * index and too costly per write at the corpus size that selects
   * a server tier. This pass asks the store the set-based question instead —
   * `listEngramsMissingEmbeddings` is one anti-join per batch — so its cost
   * scales with the GAP, not with the corpus.
   *
   * Failure posture, in order:
   *   - embeddings disabled (PLUR_DISABLE_EMBEDDINGS / config): skip before
   *     touching the database, with a once-per-instance notice — the table
   *     staying empty is then a configuration choice, not a silent gap.
   *   - embedder dim ≠ the store's embedding column: skip (debug log), same
   *     as the PGLite pass — writing wrong-dim vectors is worse than none.
   *   - embedder unavailable mid-pass: stop quietly; the next write or
   *     semantic recall retries.
   *   - anything else: recorded via `lastIndexError()` and logged. Never
   *     thrown — a background embed must not be able to fail a write.
   */
/** @internal */
_autoEmbedPrimaryStore(adapter: StorageAdapter): Promise<void>

/** Record a background index failure for later surfacing. */
/** @internal */
_recordIndexError(op: IndexSyncError['op'], err: unknown): void

/**
   * Last background index failure, or null when the most recent pass
   * succeeded. The background chains (initial sync, syncFromYaml,
   * reindex, auto-embed) swallow rejections so waitForIndex() never throws;
   * this is the state-based surface for CLI/MCP callers. Also included in
   * status().index_error.
   */
lastIndexError(): IndexSyncError | null

/**
   * Sync the index after a write to the primary store.
   *
   * No-op when no index is active, and — via `requiresIndexSync` — when the
   * adapter declares `role: 'primary'`, because then the write already landed
   * in the backend that answers queries and there is no delta to apply.
   */
/** @internal */
_syncIndex(): Promise<void>

/** Block until any in-flight PGLite background sync completes. Useful in tests. */
waitForIndex(): Promise<void>

/** Search packs for an engram by ID and apply feedback, writing back to the pack's engrams.yaml. */
/**
   * @param unreachedStores stores the caller's remote walk could not probe, so
   *   the terminal "not found" can say so rather than claiming a search that
   *   did not run.
   */
/** @internal */
_feedbackPack(id: string, signal: 'positive' | 'negative' | 'neutral', unreachedStores?: string[], applyOpts?: { source?: FeedbackSource }): Promise<void>

/** Capture an episodic memory. */
capture(summary: string, context?: CaptureContext): Episode

/** Query the episode timeline. */
timeline(query?: TimelineQuery): Episode[]

/** Rule-based extraction of engram candidates from content. */
ingest(content: string, options?: IngestOptions): Promise<IngestCandidate[]>

/** Preview a pack before installing — shows manifest, engrams, and security scan. */
previewPack(source: string): ReturnType<typeof previewPack>

/**
   * Install a pack from a source path. Runs security scan (blocks on secrets
   * and on prompt-injection text unless opts.allowInjection), clamps host-
   * overriding fields (pinned / locked), detects conflicts, records in registry.
   */
installPack(source: string, opts?: { allowInjection?: boolean; allowModified?: boolean }): Promise<ReturnType<typeof installPack>>

/** Uninstall a pack by name. */
uninstallPack(name: string): ReturnType<typeof uninstallPack>

/**
   * Export engrams as a shareable pack with privacy scanning and integrity hash.
   *
   * Throws when no licence has been chosen — by the caller here, or once in
   * `provenance.default_license`. That is deliberate: see `exportPack`.
   */
exportPack(engrams: Engram[], outputDir: string, manifest: ExportOptions): ReturnType<typeof exportPack>

/** List all installed packs (with integrity hashes). */
listPacks(): ReturnType<typeof listPacks>

/**
   * Re-baseline installed packs' registry integrity from v1 to `sha256:v2:`
   * (ENGRAM-STANDARD-v1 §5.5), only for packs that still verify clean under v1.
   * `dryRun: true` reports without writing. See `migratePackIntegrity`.
   */
migratePackIntegrity(opts?: { dryRun?: boolean }): ReturnType<typeof migratePackIntegrity>

/** Get the PLUR storage root path. */
getStorageRoot(): string
}

export const maintenanceMethods: MaintenanceMethods & ThisType<Plur> = {
async compact(): Promise<{ removed: number; remaining: number }> {
    this._assertWritable()
    this._remoteOnlyRefuseLocalStore('Compacting the store (run it outside the remote-only folder)')
    return await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      // A retired row still carrying a queued "retire on remote"
      // entry is kept until the flush has retired the remote copy — removing
      // it would lose the only durable record of that pending DELETE.
      const active = engrams.filter(e => e.status !== 'retired' || !!(e as any).structured_data?._retireRemote)
      const removed = engrams.length - active.length
      if (removed > 0) {
        // Removing retired engrams IS this method, so the shrink guard is lifted.
        await this._writeEngrams(this.paths.engrams, active, { allowShrink: true })
        // Recorded like every other store change PLUR makes, so `plur verify`
        // can tell it from an edit behind PLUR's back. Ids only.
        // Every removed row, by identity — a retired row can share its id with
        // a kept one, and it must still be named.
        const kept = new Set(active)
        try {
          this._appendHistory({
            event: 'store_compacted',
            engram_id: '',
            timestamp: new Date().toISOString(),
            data: { engram_ids: [...new Set(engrams.filter(e => !kept.has(e)).map(e => e.id))] },
          })
        } catch { /* history is an audit trail, never a gate on the write */ }
        await this._syncIndex()
      }
      return { removed, remaining: active.length }
    })
  },

// There is deliberately no batch decay. Decay is a pure function of
// last_accessed and is computed at READ time (see inject.ts — decayedStrength
// on every candidate); reinforcement re-anchors last_accessed on access
// (_reactivateResults). Materializing decay back into the store would lower
// stored strength without advancing last_accessed, so read-time decay would
// double-count it, and it would rewrite the whole YAML store on a schedule.
// Archival of long-cold engrams, if wanted, should be an explicit,
// reversible, logged maintenance op.
async reindex(): Promise<void> {
    this._remoteOnlyRefuseLocalStore('Reindexing the store (run it outside the remote-only folder)')
    if (this.pgliteAdapter) {
      // Only a DERIVED index has anything to rebuild. A `role: 'primary'`
      // adapter IS the store of record — there is no external source to
      // rebuild from, so "reindex" is a no-op rather than an error.
      const adapter = asDerivedIndex(this.pgliteAdapter)
      if (!adapter) return
      // Fire-and-track. Callers that need to block use reindexAsync().
      this._lastIndexError = null // new pass — stale failures cleared on success
      this._pgliteInitPromise = adapter.reindex()
        .then(() => this._autoEmbedNewEngrams(adapter))
        .catch((err: unknown) => {
          this._recordIndexError('reindex', err)
          logger.warning(`[plur] PGLite reindex failed: ${(err as Error).message}`)
        })
      return
    }
    if (!this.indexedStorage) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
    await this.indexedStorage.reindex()
  },

async reindexAsync(): Promise<void> {
    this._remoteOnlyRefuseLocalStore('Reindexing the store (run it outside the remote-only folder)')
    if (this.pgliteAdapter) {
      const adapter = asDerivedIndex(this.pgliteAdapter)
      if (!adapter) return
      await adapter.reindex()
      await this._autoEmbedNewEngrams(adapter)
      return
    }
    if (!this.indexedStorage) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
    await this.indexedStorage.reindex()
  },

async _autoEmbedNewEngrams(adapter: PGLiteAdapter): Promise<void> {
    try {
      const { embed } = await import('../embeddings.js')
      const indexedDim = await adapter.getVectorColumnDim()
      if (indexedDim !== null && getEmbedder(resolveEmbedderName()).dim !== indexedDim) {
        logger.debug(`[plur] auto-embed skip: active embedder dim differs from indexed column (${indexedDim}). Run 'plur sync --reembed --full' to migrate.`)
        return
      }
      // A queued remote-only save is never embedded.
      const active = (await this._loadAllEngrams()).filter(e => e.status === 'active' && !(e as any)._originalId && !(e as any)._pack && !isRemoteOnlyQueued(e))
      if (active.length === 0) return
      const { engramSearchText, embeddingContentHash } = await import('../fts.js')
      for (const engram of active) {
        // Skip on "already embedded FROM THIS TEXT", not on "already has some
        // vector": a dedup UPDATE/MERGE can rewrite an engram, and its vector
        // must then be recomputed or semantic recall ranks it by the old text.
        const hash = embeddingContentHash(engram)
        if (await adapter.embeddingIsCurrent(engram.id, hash)) continue
        const vec = await embed(engramSearchText(engram))
        if (!vec) return // embedder unavailable — next cycle retries
        await adapter.upsertEmbedding(engram.id, vec, hash)
      }
    } catch (err) {
      this._recordIndexError('auto-embed', err)
      logger.warning(`[plur] auto-embed failed: ${(err as Error).message}`)
    }
  },

_kickPrimaryAutoEmbed(adapter: StorageAdapter): void {
    if (this._primaryEmbedPass) {
      // A pass is mid-flight. It re-queries the anti-join per batch, but a
      // write landing after its final query would be missed — request one
      // follow-up sweep instead of stacking a second concurrent pass.
      this._primaryEmbedRerun = true
      return
    }
    const pass = (async () => {
      do {
        this._primaryEmbedRerun = false
        await this._autoEmbedPrimaryStore(adapter) // never throws — errors land in lastIndexError()
      } while (this._primaryEmbedRerun)
    })().finally(() => {
      if (this._primaryEmbedPass === pass) this._primaryEmbedPass = null
    })
    this._primaryEmbedPass = pass
    this._pgliteInitPromise = pass
  },

async _autoEmbedPrimaryStore(adapter: StorageAdapter): Promise<void> {
    if (typeof adapter.listEngramsMissingEmbeddings !== 'function') return
    try {
      const { embed, embedderStatus } = await import('../embeddings.js')
      const status = embedderStatus()
      if (status.disabled) {
        if (!this._primaryEmbedDisabledNoticeDone) {
          this._primaryEmbedDisabledNoticeDone = true
          logger.info(
            `[plur] embeddings are disabled (${status.disabledReason}) — the primary store's embedding table `
            + `will not be populated and semantic recall stays on the non-vector fallback path.`,
          )
        }
        return
      }
      // Dim guard, mirroring _autoEmbedNewEngrams: an embedder/column
      // mismatch must skip, not persist wrong-shape vectors.
      const withDim = adapter as Partial<{ getVectorColumnDim(): Promise<number | null> }>
      const indexedDim = typeof withDim.getVectorColumnDim === 'function'
        ? await withDim.getVectorColumnDim()
        : null
      if (indexedDim !== null && getEmbedder(resolveEmbedderName()).dim !== indexedDim) {
        logger.debug(
          `[plur] primary-store auto-embed skip: active embedder dim differs from the store's embedding `
          + `column (${indexedDim}). Re-create the store's embedding column or switch PLUR_EMBEDDER to migrate.`,
        )
        return
      }
      const { engramSearchText, embeddingContentHash } = await import('../fts.js')
      // The loop's exit condition is "the store stops returning rows", and the
      // store's predicate includes a hash comparison. If the hash this side
      // writes ever stopped matching the one the store's SQL derives, every
      // batch would return the same rows and the pass would spin forever. The
      // two agree by construction (see `embeddingContentHash`), and this set
      // makes that a warning instead of a hang if they ever stop agreeing.
      const embeddedThisPass = new Set<string>()
      // A queued remote-only save is never embedded: it stays "missing", so it
      // is set aside, and a batch of only those ends the pass.
      const skippedRemoteOnly = new Set<string>()
      for (;;) {
        // Asked for the set-aside rows on top of a batch, so a run of queued
        // saves never hides the rows behind them.
        const want = PRIMARY_AUTO_EMBED_BATCH + skippedRemoteOnly.size
        const batch = await adapter.listEngramsMissingEmbeddings(want, { includeStale: true })
        if (batch.length === 0) return
        for (const e of batch) if (isRemoteOnlyQueued(e)) skippedRemoteOnly.add(e.id)
        const fresh = batch.filter(e => !embeddedThisPass.has(e.id) && !skippedRemoteOnly.has(e.id))
        if (fresh.length === 0 && batch.every(e => skippedRemoteOnly.has(e.id))) {
          if (batch.length < want) return
          continue
        }
        if (fresh.length === 0) {
          logger.warning(
            `[plur] primary-store auto-embed stopped: ${batch.length} engram(s) still report a stale `
            + `embedding after being re-embedded in this pass (first: ${batch[0].id}). The stored content `
            + `hash disagrees with the store's — semantic recall may be ranking stale text. Please report this.`,
          )
          return
        }
        for (const engram of fresh) {
          const hash = embeddingContentHash(engram)
          const vec = await embed(engramSearchText(engram))
          if (!vec) {
            // Embedder became unavailable mid-pass — stop; retried on the
            // next write or semantic recall. Debug, not warning: the embed
            // failure itself is already surfaced via embedderStatus().
            logger.debug('[plur] primary-store auto-embed paused: embedder unavailable.')
            return
          }
          await adapter.upsertEmbedding(engram.id, vec, hash)
          embeddedThisPass.add(engram.id)
        }
        // A full batch means the anti-join may hold more; a short one is the
        // tail. Progress is guaranteed: every upsert removes a row from the
        // next batch's answer, so this cannot loop on the same gap.
        if (batch.length < want) return
      }
    } catch (err) {
      // A store torn down mid-pass (close()/dropSchema() in a short-lived
      // process) is a cancellation, not a failure — stay quiet and do NOT
      // record it, or the stray warning outlives the process's real output.
      if (isStoreTeardownError(err)) {
        logger.debug('[plur] primary-store auto-embed stopped: the store was closed or dropped mid-pass.')
        return
      }
      this._recordIndexError('auto-embed', err)
      logger.warning(`[plur] primary-store auto-embed failed: ${(err as Error).message}`)
    }
  },

_recordIndexError(op: IndexSyncError['op'], err: unknown): void {
    this._lastIndexError = {
      op,
      message: (err as Error)?.message ?? String(err),
      at: new Date().toISOString(),
    }
  },

lastIndexError(): IndexSyncError | null {
    return this._lastIndexError
  },

async _syncIndex(): Promise<void> {
    if (this.pgliteAdapter) {
      // `IndexedStorage` below is unconditionally a derived index (it rebuilds
      // itself from YAML by construction), so only the adapter path needs the
      // role check.
      if (!requiresIndexSync(this.pgliteAdapter)) return
      // Synchronous-shaped path: kick off the sync, track the promise.
      // The store write already happened — this is the index catching up, then
      // auto-embed any new engrams so they're vector-searchable.
      const adapter = this.pgliteAdapter
      this._lastIndexError = null // new pass — stale failures cleared on success
      // remote-only: no embedding pass started from a bound operation.
      const bound = !!this._activeBinding()
      this._pgliteInitPromise = adapter.syncFromYaml()
        .then(() => bound ? undefined : this._autoEmbedNewEngrams(adapter))
        .catch((err: unknown) => {
          this._recordIndexError('sync-from-yaml', err)
          logger.warning(`[plur] PGLite syncFromYaml failed (YAML is still source of truth): ${(err as Error).message}`)
        })
      return
    }
    // Primary query store: the write already landed in the engine that
    // answers queries — no index delta — but its EMBEDDING has not. Kick the
    // background auto-embed pass so `engram_embeddings` tracks the corpus and
    // semantic recall gets to use the vector index instead of falling back to
    // the O(N) in-memory path. Fire-and-track: the write path never waits.
    const primary = this._primaryQueryAdapter()
    if (primary && typeof primary.listEngramsMissingEmbeddings === 'function') {
      this._lastIndexError = null // new pass — stale failures cleared on success
      // remote-only: no embedding pass started from a bound operation.
      if (!this._activeBinding()) this._afterStoreCommit(() => this._kickPrimaryAutoEmbed(primary))
      return
    }
    if (this.indexedStorage) {
      this.indexedStorage.syncFromYaml()
    }
  },

async waitForIndex(): Promise<void> {
    if (this._pgliteInitPromise) {
      await this._pgliteInitPromise
    }
  },

async _feedbackPack(id: string, signal: 'positive' | 'negative' | 'neutral', unreachedStores: string[] = [], applyOpts: { source?: FeedbackSource } = {}): Promise<void> {
    if (!fs.existsSync(this.paths.packs)) throw new Error(`Engram not found: ${id}`)

    // A pack id of the older form (from before the pack-id digest)
    // is rated as the one pack row it names; ambiguous, it names none.
    {
      const rows = this._loadInstalledPacks().flatMap(p => p.engrams.map(row => ({ row, pack: p.manifest.name })))
      const legacy = matchLegacyPackId(rows, id)
      if (legacy) id = legacy.id
    }

    for (const entry of fs.readdirSync(this.paths.packs)) {
      const packDir = `${this.paths.packs}/${entry}`
      if (!fs.statSync(packDir).isDirectory()) continue
      const engramsPath = `${packDir}/engrams.yaml`
      if (!fs.existsSync(engramsPath)) continue

      // Under the PACK file's own lock, load included. `save()` replaces the
      // whole pack file, and packs are shared by every agent on the machine,
      // so an unlocked read-modify-write would let two processes rating
      // different engrams in one pack drop each other's changes.
      //
      // Keyed on the pack's own path, so it cannot collide with the primary
      // store's lock; the caller holds none.
      const packStore = this._storeAt(engramsPath)
      const handled = await this._withStoreLock(engramsPath, async () => {
        const engrams = await packStore.load()
        // A pack row answers to its pack id ({@link packEngramId}), the id
        // every read path hands out. Its bare id still finds it: the caller
        // reaches here only after no store of mine held `id`.
        let packName: string | undefined
        try { packName = loadPack(packDir).manifest.name } catch { packName = undefined }
        const engram = engrams.find(e => packName !== undefined && packEngramId(e.id, packName) === id)
          ?? engrams.find(e => e.id === id)
        if (!engram) return false

        applyFeedbackSignal(engram, signal, undefined, applyOpts)

        await packStore.save(engrams)
        return true
      })
      if (handled) return
    }

    // "Not found" must not mean "did not look". If a store could not be
    // reached, say which — the caller can retry or pass an explicit scope, and
    // neither is actionable if the message claims a search that did not run.
    throw new Error(
      unreachedStores.length > 0
        ? `Engram not found: ${id} — but ${unreachedStores.length} store(s) could not be reached `
          + `(${unreachedStores.join(', ')}). This is "not found where I could look", not "does not exist". `
          + `Retry, or pass scope explicitly to target a store directly.`
        : `Engram not found: ${id}`,
    )
  },

capture(summary: string, context?: CaptureContext): Episode {
    // The timeline lives on this machine and can hold session content, so a
    // remote-only folder captures none.
    if (this._remoteOnly) throw this._remoteOnlyError('timeline')
    return captureEpisode(this.paths.episodes, summary, context)
  },

timeline(query?: TimelineQuery): Episode[] {
    // remote-only: the local timeline is personal session history.
    if (this._remoteOnly) return []
    return queryTimeline(this.paths.episodes, query)
  },

async ingest(content: string, options?: IngestOptions): Promise<IngestCandidate[]> {
    const candidates: IngestCandidate[] = []
    const seen = new Set<string>()

    for (const { re, type } of INGEST_PATTERNS) {
      re.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = re.exec(content)) !== null) {
        // Use the last meaningful capture group as the statement
        const captured = match.slice(1).filter(Boolean).join(' ').trim()
        if (!captured || captured.length < 5) continue
        if (seen.has(captured.toLowerCase())) continue
        if (!this.config.allow_secrets && detectSecrets(captured).length > 0) continue
        seen.add(captured.toLowerCase())
        candidates.push({
          statement: captured,
          type,
          source: options?.source,
        })
      }
    }

    // If not extract_only, save the candidates as actual engrams
    if (!options?.extract_only && candidates.length > 0) {
      // Sequential, not Promise.all: learn() serialises on the store lock
      // anyway, and a fan-out here would just queue behind itself while making
      // a partial failure harder to attribute to a candidate.
      for (const candidate of candidates) {
        await this.learn(candidate.statement, {
          type: candidate.type,
          // remote-only: no explicit scope, so it goes to the folder's team
          // scope; elsewhere `global`.
          scope: options?.scope ?? (this._remoteOnly ? undefined : 'global'),
          domain: options?.domain,
          source: candidate.source,
        })
      }
    }

    return candidates
  },

previewPack(source: string): ReturnType<typeof previewPack> {
    return previewPack(source)
  },

// `allowModified` lets a corrected pack be installed after a false-positive
// scan: correcting a pack moves the hash it shipped.
async installPack(source: string, opts?: { allowInjection?: boolean; allowModified?: boolean }): Promise<ReturnType<typeof installPack>> {
    const existing = await this._loadAllEngrams()
    return installPack(this.paths.packs, source, existing, opts)
  },

uninstallPack(name: string): ReturnType<typeof uninstallPack> {
    return uninstallPack(this.paths.packs, name)
  },

exportPack(engrams: Engram[], outputDir: string, manifest: ExportOptions): ReturnType<typeof exportPack> {
    this._remoteOnlyRefuseLocalStore('Exporting a pack')
    // A pack is a permanent copy: never of a queued remote-only save, bound or
    // not.
    const queuedRow = engrams.find(isRemoteOnlyQueued)
    if (queuedRow) throw this._queuedStaysRemote(queuedRow)
    const configured = (this.config as any)?.provenance?.default_license as string | undefined
    return exportPack(engrams, outputDir, manifest, configured)
  },

listPacks(): ReturnType<typeof listPacks> {
    return listPacks(this.paths.packs)
  },

migratePackIntegrity(opts: { dryRun?: boolean } = {}): ReturnType<typeof migratePackIntegrity> {
    return migratePackIntegrity(this.paths.packs, opts)
  },

getStorageRoot(): string {
    return this.paths.root
  },
}
