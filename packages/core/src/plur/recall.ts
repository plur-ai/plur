import { agenticSearch } from '../agentic-search.js'
import { reactivate } from '../decay.js'
import { embedderStatus, embeddingSearch, embeddingSearchWithScores, resetEmbedder, semanticModelState, type EmbedderStatus, type SimilarityResult } from '../embeddings.js'
import { legacyStorePrefix, matchLegacyPackId, packEngramId, parseNamespacedId, storePrefix } from '../engrams.js'
import { extendCorpusStats, ftsTokenize, searchEngrams } from '../fts.js'
import { applyReranker, hybridSearchWithMeta, rrfMergeEngrams as pgliteRrfMerge, type HybridSearchResult, type RerankOptions } from '../hybrid-search.js'
import { Plur } from '../index.js'
import { applyIntentRouting, classifyQuery, isIntentRoutingDisabled, isQueryRewriteDisabled, rewriteLexicalQuery, routeForIntent, type IntentRoutingProfile, type QueryIntent } from '../intent/index.js'
import { logger } from '../logger.js'
import { expandedSearch } from '../query-expansion.js'
import { withoutRemoteOnlyQueued } from '../remote-only-rows.js'
import {
    RECALL_BOOKKEEPING_LOCK_WAIT_MS, settleBy,
    type RecallRemoteReport
} from '../remote-recall.js'
import { isRerankerEvalStale, loadRerankerEvalCache, logRerankerEvalAdvisory, runRerankerSelfEval, saveRerankerEvalResult, type RerankerEvalResult } from '../reranker-eval.js'
import { checkRerankerFit, type FitCheckResult } from '../rerankers/fit-check.js'
import { _resetRerankerCache, getReranker, isRerankerOff, rerankerStatus, resetRerankerStatus, resolveRerankerName, type RerankerName, type RerankerRuntimeStatus } from '../rerankers/index.js'
import { _resetCrossEncoderCaches } from '../rerankers/transformers-cross-encoder.js'
import type { Engram } from '../schemas/engram.js'
import { isScopeWithin, makeVisibilityPredicate, scopeAllowFilter } from '../scope-util.js'
import { recallAuto, type AutoSearchResult } from '../search-orchestrator.js'
import type { StorageAdapter } from '../storage-adapter.js'
import { type AsyncLockOptions } from '../store/async-lock.js'
import { emitMissSignal } from '../telemetry-miss-signal.js'
import type { DegradedReason, LlmFunction, RecallOptions } from '../types.js'
import { isCurrentlyValid } from '../validity.js'
import { GET_BY_IDS_REMOTE_CAP, PUSHDOWN_MAX_ROUNDS, PUSHDOWN_OVERFETCH, rrfScoreOf } from './helpers.js'

export interface RecallMethods {
  /**
   * Search engrams, filter by scope/domain/strength, reactivate accessed.
   * Supports two modes:
   *   - 'fast' (default): BM25 keyword search, instant, no API calls
   *   - 'agentic': LLM-assisted semantic search, higher accuracy, requires llm function
   */
  /** Search engrams using fast BM25 keyword matching over the local corpus,
   *  merged with the live server-authoritative remote leg when a
   *  configured remote host is implicated by the current project/work.
   *  `remote: false` (internal callers) or PLUR_REMOTE_RECALL=off keeps it
   *  fully local. */
  recall(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]>

  /**
   * {@link recall}, plus what happened on THIS call: the remote leg's
   * state per host (`remote`), and whether the results are complete. Returns
   * within the recall deadline (`deadline_ms`, default
   * {@link DEFAULT_RECALL_DEADLINE_MS}) whatever the server or a store-lock
   * holder does.
   */
  recallWithMeta(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<{ engrams: Engram[]; remote: RecallRemoteReport; results_complete: boolean; local_complete?: boolean }>

  /**
   * The primary store, when it can also answer queries itself (`role: 'primary'`,
   * ADR-0005), so a search can be pushed into it. Never returns a `role: 'index'`
   * adapter: that would bypass the index sync bookkeeping. Returns null for the
   * default YAML store, which loads and ranks in memory.
   */
  /** @internal */
  _primaryQueryAdapter(): StorageAdapter | null

  /** Search engrams using LLM-assisted semantic filtering. Async, requires llm function. */
  recallAsync(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]>

  /** Search engrams using local embeddings. Async, no API calls. Routes through PGLite/pgvector when active or a Postgres primary store's vector index, with optional intent routing + cross-encoder rerank. */
  recallSemantic(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]>

  /** Hybrid search: BM25 + embeddings merged via Reciprocal Rank Fusion. Async, no API calls. Delegates to recallHybridWithMeta so it gets intent/rerank/PGLite routing too. */
  recallHybrid(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]>

  /**
   * Hybrid search with diagnostic metadata — returns both the engrams and
   * whether embeddings actually contributed (mode: "hybrid" vs "hybrid-degraded").
   * Use this when you want to surface degraded-mode warnings to users.
   */
  recallHybridWithMeta(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<HybridSearchResult>

  /** Resolve the cross-encoder rerank options for a call. */
  /** @internal */
  _resolveRerankOptions(rerank?: boolean): Promise<RerankOptions | undefined>

  /**
   * Reranker-enable path advisory: when this store's cached self-eval
   * says the resolved reranker is net-negative HERE, warn once per instance.
   * Never disables anything — the loud-once log is the whole intervention.
   */
  /** @internal */
  _maybeLogRerankerEvalAdvisory(rerankerName: string): Promise<void>

  /**
   * Run the per-store reranker self-eval gate: sample this store's own
   * engrams, synthesize probe queries from their statements, and compare the
   * cross-encoder's ordering against RRF-only. Returns the cached verdict when
   * fresh (same reranker, within the staleness bound, store size stable)
   * unless `force` is set. The result is persisted to `.reranker-eval.json`
   * in the store root and surfaced by plur_doctor + the enable-path advisory.
   */
  rerankerSelfEval(options?: {
    /** Reranker to evaluate. Default: the PLUR_RERANKER-resolved adapter. */
    reranker?: RerankerName
    /** Max probes to sample (default 20). */
    sample?: number
    /** PRNG seed (default 1337). */
    seed?: number
    /** Re-run even when a fresh cached verdict exists. */
    force?: boolean
  }): Promise<{ result: RerankerEvalResult; cached: boolean }>

  /**
   * Read this store's cached reranker self-eval verdict without
   * running anything. Returns null when the store has never been evaluated
   * for the given (or env-resolved) reranker.
   */
  rerankerEvalStatus(rerankerName?: string): Promise<{ result: RerankerEvalResult; stale: boolean } | null>

  /**
   * Probe whether the configured reranker produces useful signal on this
   * store's engrams. Scores same-domain vs cross-domain pairs and
   * returns a separability measure — callers use it to decide whether to
   * enable the reranker by default.
   *
   * @param opts.sampleSize  Max engrams to sample (default 100).
   * @param opts.rerankerName  Which reranker to probe (default: PLUR_RERANKER).
   */
  checkRerankerFit(opts?: { sampleSize?: number; rerankerName?: string }): Promise<FitCheckResult>

  /** Resolve the query-intent routing profile for a call. undefined = no routing (general). */
  /** @internal */
  _resolveIntentProfile(query: string, intentOverride?: QueryIntent): { intent: QueryIntent; profile: IntentRoutingProfile } | undefined

  /**
   * PGLite/pgvector hybrid recall. Routes the vector portion through
   * the persistent pgvector index, intersects hits against the YAML-rooted
   * `filtered` set (the yaml-as-truth defense — a DB-only row can't surface),
   * RRF-fuses with BM25, then applies the optional rerank. Falls back to the
   * JSON-cache hybrid path on cold-start / embedder-unavailable / PGLite error.
   */
  /** @internal */
  _pgliteHybridRecall(query: string, limit: number, filtered: Engram[], rerank?: RerankOptions, restrict?: Pick<RecallOptions, 'scope' | 'scopes'>): Promise<HybridSearchResult>

  /**
   * PGLite/pgvector semantic recall. Vector search via pgvector,
   * intersected with the YAML-rooted `filtered` set. Falls back to the JSON
   * cache on cold-start / embedder-unavailable / PGLite error.
   */
  /** @internal */
  _pgliteSemanticRecall(query: string, limit: number, filtered: Engram[], restrict?: Pick<RecallOptions, 'scope' | 'scopes'>): Promise<Engram[]>

  /**
   * Semantic recall pushed into a primary query store's vector index (mirrors
   * `recall()`'s BM25 pushdown): scope/scopes/visibilityGrants go INTO the k-NN
   * query; residual filters run here; secondary-store and pack engrams are
   * scored in memory and merged by the same clamped cosine metric.
   * Completeness gate: while ANY active engram lacks an embedding, fall back to
   * the in-memory path and kick the backfill (stale embeddings do not trip it).
   */
  /** @internal */
  _primarySemanticRecall(adapter: StorageAdapter, query: string, limit: number, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]>

  /** Inspect embedder availability without forcing a load. */
  embedderStatus(): EmbedderStatus

  /** Reset cached embedder failure state — next call will retry the model load. */
  resetEmbedder(): void

  /**
   * Inspect reranker runtime state — engaged/failed counters and the
   * last failure with its classification (corrupt-cache vs unavailable).
   * Lets doctor/recall surface "reranking requested but not happening".
   */
  rerankerStatus(): RerankerRuntimeStatus

  /**
   * Reset cached reranker state — adapter cache, load-pipeline cache,
   * and the runtime failure tracker. The next rerank call retries the model
   * load from scratch (e.g. after purging a corrupt HF cache).
   */
  resetReranker(): void

  /** Embedding search returning {engram, score}[] with cosine similarity scores. Async, no API calls. */
  similaritySearch(query: string, options?: { limit?: number; scope?: string; domain?: string }): Promise<SimilarityResult[]>

  /** Expanded search: LLM query expansion + hybrid search + RRF merge. Opt-in, requires LLM function. */
  recallExpanded(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]>

  recallAutoSearch(query: string, options?: RecallOptions): Promise<AutoSearchResult>

  /** Get a single engram by ID, regardless of status. Searches primary + all stores. */
  getById(id: string): Promise<Engram | null>

  /**
   * The pack row an id of the EARLIER pack-id form names (before pack names
   * not in slug form got a digest: `ENG-X-pack-release-rules` for the pack
   * `Release Rules`, now `ENG-X-pack-release-rules--<digest>`). Such ids were
   * handed out in lookups, relations and receipts. Reached only when no loaded
   * row carries `id` exactly, and only when exactly one pack row answers to it
   * ({@link matchLegacyPackId}); an id two packs shared names neither.
   */
  /** @internal */
  _matchLegacyPackId(engrams: Engram[], id: string): Engram | null

  /**
   * The pack row a pack's OWN id names, for ids handed out before pack rows
   * got their pack ids (e.g. `ENG-PFR-001`). Reached only when no loaded row
   * carries `id` exactly, so an id one of my memories holds — active or
   * forgotten — never leads to a pack row. Only when exactly one pack
   * row carries it.
   */
  /** @internal */
  _matchPackOriginalId(engrams: Engram[], id: string): Engram | null

  /**
   * The one loaded row an id in the legacy three-letter store form names, or
   * null. Only a dated server-form id qualifies (a pack id such as
   * `ENG-PFR-001` is not one), and only when exactly one loaded store row
   * answers to it: the old prefix was shared by every team store of an org,
   * so two rows can answer to one old id, and then it names neither.
   */
  /** @internal */
  _matchOldFormId(engrams: Engram[], id: string): Engram | null

  /**
   * Get several engrams by ID: primary store by key first, then one full walk
   * over stores and packs for the rest. Missing ids are absent from the result.
   * With `remoteCapability`, ids still missing are fetched by id from url stores
   * that advertise that capability and whose namespace prefix the id carries:
   * one GET per id, in parallel, at most {@link GET_BY_IDS_REMOTE_CAP} per store.
   * Without the option nothing is fetched remotely.
   */
  getByIds(ids: string[], options?: { remoteCapability?: string }): Promise<Engram[]>

  /** @internal */
  _fetchRemoteByIds(ids: string[], capability: string): Promise<Engram[]>

  /** List all active engrams, optionally filtered by scope/domain. No search — returns all matches. */
  list(options?: { scope?: string; scopes?: string[]; domain?: string; min_strength?: number; include_expired?: boolean }): Promise<Engram[]>

  /**
   * Resolve once the work the constructor kicked off has finished.
   *
   * A constructor cannot await, so one-time migrations start in the background.
   * With an async store they may still be running, and a caller that depends
   * on the migration having run (a test, a first read after upgrade) needs
   * somewhere to wait.
   *
   * Cheap and idempotent: it is the same settled promise on every call.
   */
  ready(): Promise<void>

  /** Filter engrams by scope/domain/strength (shared by both modes) */
  /**
   * Predicates a store CANNOT answer (temporal validity, `min_strength`),
   * applied after a pushdown narrows. Shared with `_filterEngrams` on purpose,
   * so the pushdown branch cannot disagree with `list()`.
   */
  /** @internal */
  _applyResidualFilters(engrams: Engram[], options?: RecallOptions & { include_expired?: boolean }): Engram[]

  /**
   * Mounted-scope visibility grants: the deduplicated scopes of every
   * `config.yaml` `stores:` entry (path and url). Mounting a store with your own
   * token is the consent act (see `makeVisibilityPredicate` in scope-util.ts).
   * Visibility-only: these MUST NEVER be folded into `options.scopes`, which is
   * the authorization decision; grants never widen it.
   */
  /** @internal */
  _grantedScopes(): string[]

  /**
   * Candidates for the hybrid path, narrowed by the store only when that is
   * provably equivalent, otherwise the full filtered corpus. Narrows only when
   * the adapter reports `exhausted` (the rows are everything for that filter),
   * so ranking is identical to ranking the full corpus. All filters (status,
   * scope, scopes, visibilityGrants, domain) are passed through; if that parity
   * ever breaks, this must revert to `_filterEngrams` rather than narrow.
   */
  /** @internal */
  _hybridCandidates(query: string, options?: RecallOptions & { include_expired?: boolean }): Promise<Engram[]>

  /** @internal */
  _filterEngrams(options?: RecallOptions & { include_expired?: boolean }): Promise<Engram[]>

  /**
   * The post-recall freshness bookkeeping, held to the recall's deadline: a read
   * must not queue behind a writer. The lock is tried for
   * {@link RECALL_BOOKKEEPING_LOCK_WAIT_MS}; if not taken, the refresh is skipped
   * (the next recall does it). Once held, the reply waits for the write only
   * until the deadline; past that it finishes in the background.
   */
  /** @internal */
  _reactivateWithinDeadline(results: Engram[], deadlineAt: number): Promise<void>

  /**
   * Run a bookkeeping write under the store lock, held to `deadlineAt` — the
   * same rules as {@link _reactivateWithinDeadline}:
   * the lock wait is at most {@link RECALL_BOOKKEEPING_LOCK_WAIT_MS} and never
   * longer than the time left; with no time left the write is skipped; past
   * the deadline it is abandoned (a lock that comes later is released at once,
   * and `tooLate()` lets a running write stop before it writes). Without a
   * deadline it waits for the lock as every writer does.
   */
  /** @internal */
  _bookkeepingWithinDeadline(deadlineAt: number | undefined, body: (tooLate: () => boolean) => Promise<void>): Promise<void>

  /** Reactivate accessed engrams and update co-access associations.
   *  `lockWaitMs`: give up — skip the refresh — when the store lock is
   *  not taken within that time. Unset: wait as every writer does. */
  /** @internal */
  _reactivateResults(results: Engram[], opts?: { lockWaitMs?: number; deadlineAt?: number; cancel?: { abandoned: boolean } }): Promise<void>
}

export const recallMethods: RecallMethods & ThisType<Plur> = {
  async recall(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    return (await this.recallWithMeta(query, options)).engrams
  },

  async recallWithMeta(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<{ engrams: Engram[]; remote: RecallRemoteReport; results_complete: boolean; local_complete?: boolean }> {
    const deadlineAt = this._recallDeadlineAt(options)
    const limit = options?.limit ?? 20

    // Start the remote leg BEFORE the local pipeline so the effective
    // added latency is max(0, remote − local), not remote + local.
    const remotePromise = this._startRemoteRecall(query, options, deadlineAt)

    const localLeg = async (): Promise<Engram[]> => {

      // Push the search into the store when it can answer it, instead of loading
      // the corpus. Scope, domain and the permitted-scope allow-list go INTO the
      // query so `limit` is not spent on rows the caller may not see.
      // The pushdown is a NARROWING step: temporal validity, `min_strength`,
      // `config.stores` engrams and pack engrams are still applied here, and
      // `limit` is applied last so an expired row does not consume a slot.
      // remote-only: the primary store is never queried, so no pushdown.
      const adapter = this._remoteOnly ? null : this._primaryQueryAdapter()
      if (adapter) {
        const pushdownFilter = {
          status: 'active' as const,
          scope: options?.scope,
          scopes: options?.scopes,
          // Mounted-scope visibility grants go INTO the pushdown so
          // `limit` counts granted team rows too. Visibility-only — widens the
          // `scope` clause, never the `scopes` authorization clause.
          visibilityGrants: this._grantedScopes(),
          domain: options?.domain,
        }
        // Widen and retry rather than trust a fixed multiplier: residual filters
        // drop rows after the LIMIT, so if filtering consumed the page AND the
        // adapter returned a full (truncated) page, widen and ask again.
        // Bounded, because each round is a real query.
        let narrowed: Engram[] = []
        let surviving: Engram[] = []
        let fetch = Math.max(limit * PUSHDOWN_OVERFETCH, limit)
        for (let round = 0; round < PUSHDOWN_MAX_ROUNDS; round++) {
          // Prefer the exhaustion-aware call when the adapter offers one.
          //
          // `narrowed.length < fetch` is the only exhaustion signal core can
          // derive, and it is wrong for an adapter whose prefilter cannot rank:
          // PostgresAdapter computes and scores the FULL candidate set and slices
          // to `limit`, so a full page means "your slice was full", not "there is
          // more" — the loop would re-run an identical query to take a longer
          // slice of an answer already computed.
          let exhausted = false
          if (adapter.searchBM25Exhaustive) {
            const res = await adapter.searchBM25Exhaustive(query, { ...pushdownFilter, limit: fetch })
            narrowed = res.rows
            exhausted = res.exhausted
          } else {
            narrowed = await adapter.searchBM25(query, { ...pushdownFilter, limit: fetch })
          }
          surviving = this._applyResidualFilters(narrowed, options)
          // Enough survivors, the adapter says there is no more, or the page came
          // back short (the inferred signal, kept for adapters without the hook).
          if (surviving.length >= limit || exhausted || narrowed.length < fetch) break
          fetch *= PUSHDOWN_OVERFETCH
        }

        const outsiders = await this._engramsOutsidePrimaryStore(options)
        const extra = this._applyResidualFilters(outsiders, options)
        let results: Engram[]
        if (extra.length > 0) {
          // Rank the union TOGETHER: appended, the best team engram would never
          // appear whenever the primary store holds `limit` matches.
          // Score with the UNION's statistics (`extendCorpusStats` folds the
          // outsiders in); primary-only stats would price a term absent from the
          // primary corpus as maximally rare. Fold the PRE-residual outsiders, to
          // match the primary side's stats (post-scope, pre-residual).
          const queryTokens = ftsTokenize(query)
          const primaryStats = adapter.corpusStats
            ? await adapter.corpusStats(queryTokens, pushdownFilter)
            : undefined
          const stats = primaryStats
            ? extendCorpusStats(primaryStats, queryTokens, outsiders)
            : undefined
          results = searchEngrams([...surviving, ...extra], query, limit, stats)
        } else {
          results = surviving.slice(0, limit)
        }
        return results
      }

      const filtered = await this._filterEngrams(options)
      return searchEngrams(filtered, query, limit)
    }

    // The local search is bounded by the same deadline. Past it the
    // reply carries what the remote leg returned and says the local part is
    // missing; the abandoned search finishes (read-only) in the background.
    const local = await settleBy(localLeg(), deadlineAt)
    if (local.done && local.error !== undefined) throw local.error
    const localComplete = local.done
    const { engrams: merged, remote } = await this._mergeRemoteRecall(
      local.done ? (local.value ?? []) : [], remotePromise, options, limit, deadlineAt)
    await this._reactivateWithinDeadline(merged, deadlineAt)
    return {
      engrams: merged,
      remote,
      results_complete: localComplete && (remote.state === 'ok' || remote.state === 'not_dialed'),
      ...(localComplete ? {} : { local_complete: false }),
    }
  },

  _primaryQueryAdapter(): StorageAdapter | null {
    const s = this._primaryStore as unknown as Partial<StorageAdapter>
    if (s?.role === 'primary' && typeof s.searchBM25 === 'function') return s as StorageAdapter
    return null
  },

  async recallAsync(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]> {
    // remote-only: no model sees the query or the team's text.
    if (this._activeBinding()) return await this.recall(query, options)
    const filtered = await this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await agenticSearch(filtered, query, limit, options.llm)
    await this._reactivateResults(results)
    return results
  },

  async recallSemantic(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const limit = options?.limit ?? 20
    // remote-only: no reranker model either.
    const rerank = this._remoteOnly ? null : await this._resolveRerankOptions(options?.rerank)
    const intent = this._resolveIntentProfile(query, options?.intentOverride)
    // Two over-fetch sources stack: intent routing wants headroom for its
    // re-rank, the reranker wants topK candidates. Take the larger; truncate
    // back to `limit` after both stages.
    const intentFetch = intent ? Math.max(limit * 2, limit + 10) : limit
    const rerankFetch = rerank ? Math.max(limit, rerank.topK ?? 50) : limit
    const fetchLimit = Math.max(intentFetch, rerankFetch)
    let results: Engram[]
    const primaryAdapter = this._primaryQueryAdapter()
    if (this._remoteOnly) {
      // remote-only: rank the read corpus in memory by keyword. The index and
      // the primary adapter hold the personal store, and no embedder is used
      // here: a cloud one would receive the query and team text, a local one
      // keeps their vectors in this machine's cache.
      const filtered = await this._filterEngrams(options)
      results = searchEngrams(filtered, isQueryRewriteDisabled() ? query : rewriteLexicalQuery(query), fetchLimit)
    } else if (this.pgliteAdapter) {
      const filtered = await this._filterEngrams(options)
      results = await this._pgliteSemanticRecall(query, fetchLimit, filtered, options)
    } else if (primaryAdapter) {
      results = await this._primarySemanticRecall(primaryAdapter, query, fetchLimit, options)
    } else {
      const filtered = await this._filterEngrams(options)
      results = await embeddingSearch(filtered, query, fetchLimit, this.paths.root)
    }
    if (intent) {
      results = applyIntentRouting(results, intent.profile).slice(0, fetchLimit)
    }
    if (rerank) {
      const reranked = await applyReranker(results, query, rerank)
      results = reranked.engrams.slice(0, limit)
    } else {
      results = results.slice(0, limit)
    }
    await this._reactivateResults(results)
    return results
  },

  async recallHybrid(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const limit = options?.limit ?? 20
    const result = await this.recallHybridWithMeta(query, options)
    if (result.engrams.length === 0 && result.local_complete === false) {
      // A bare array cannot say it is incomplete; the log can.
      logger.warning('[plur] recall: the local search did not load its candidates within the recall deadline — this empty result is incomplete, not "no matches".')
    }
    return result.engrams.slice(0, limit)
  },

  async recallHybridWithMeta(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<HybridSearchResult> {
    const deadlineAt = this._recallDeadlineAt(options)
    // Remote leg starts BEFORE the local pipeline (added latency =
    // max(0, remote − local)); merged below via RRF.
    const remotePromise = this._startRemoteRecall(query, options, deadlineAt)
    const limit = options?.limit ?? 20
    // Stops the abandoned local search's remaining work — the embeddings
    // cache save in particular — once the deadline has passed.
    const localAbort = new AbortController()
    // What the local leg has so far, so the deadline never
    // empties it — the candidates once loaded, and the fused ranking once the
    // embedding leg is done (only the reranker can still be late then).
    let candidates: Engram[] | undefined
    let fused: HybridSearchResult | undefined
    /** Why the semantic leg was skipped this call, when it was. */
    let semanticSkipped: string | null = null
    const searchOpts = { signal: localAbort.signal, deadlineAt, onFused: (r: HybridSearchResult) => { fused = r } }
    const keywordOnly = (cands: Engram[], reason: DegradedReason): HybridSearchResult => ({
      engrams: searchEngrams(cands, isQueryRewriteDisabled() ? query : rewriteLexicalQuery(query), limit),
      mode: 'hybrid-degraded',
      embedderError: Plur.DEGRADED_MESSAGES[reason],
      degraded_reason: reason,
      topScore: null,
      reranked: 0,
    })
    const localLeg = async (): Promise<HybridSearchResult> => {
      // Narrowed by the store when provably equivalent, else the full read.
      const filtered = await this._hybridCandidates(query, options)
      candidates = filtered
      // remote-only: keyword ranking only, no embedder (see recallSemantic).
      if (this._remoteOnly) {
        return { engrams: searchEngrams(filtered, isQueryRewriteDisabled() ? query : rewriteLexicalQuery(query), limit), mode: 'bm25-only', embedderError: null, topScore: null, reranked: 0 }
      }
      // A recall never downloads the model: when it is not
      // on disk, answer by keyword and say how to get it (`plur doctor`).
      if (await semanticModelState() === 'missing') {
        semanticSkipped = 'embedding_model_missing'
        return keywordOnly(filtered, 'embedding_model_missing')
      }
      const rerank = await this._resolveRerankOptions(options?.rerank)
      const intent = this._resolveIntentProfile(query, options?.intentOverride)
      // When intent routing is on we over-fetch from the hybrid call WITHOUT the
      // reranker, apply intent routing, then run the reranker on the routed set.
      // When intent is off the hybrid call handles reranking inline so the
      // PGLite and JSON paths stay symmetric.
      const intentLimit = intent ? Math.max(limit * 2, limit + 10) : limit
      // remote-only: the PGLite index mirrors the personal store; rank in memory.
      const pglite = this._remoteOnly ? null : this.pgliteAdapter
      let result: HybridSearchResult
      if (intent) {
        result = pglite
          ? await this._pgliteHybridRecall(query, intentLimit, filtered, undefined, options)
          : await hybridSearchWithMeta(filtered, query, intentLimit, this.paths.root, undefined, searchOpts)
        let routed = applyIntentRouting(result.engrams, intent.profile)
        let rerankedCount = result.reranked
        if (rerank) {
          const reranked = await applyReranker(routed, query, rerank)
          routed = reranked.engrams
          rerankedCount = reranked.count
        }
        result = { ...result, engrams: routed.slice(0, limit), reranked: rerankedCount }
      } else if (pglite) {
        result = await this._pgliteHybridRecall(query, limit, filtered, rerank, options)
      } else {
        result = await hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank, searchOpts)
      }
      return result
    }
    // The local pipeline (store load, embedder, reranker) is bounded by
    // the same deadline. Past it the reply carries the remote rows and says
    // the local part is missing; the abandoned search finishes in the background.
    const local = await settleBy(localLeg(), deadlineAt)
    // Past the deadline: keep what the local leg already has — the fused
    // ranking if only the reranker was late, else keyword results over the
    // loaded candidates. Only when even the candidates were not loaded in time
    // is the local part empty, and the reply says so (`local_complete: false`).
    let lateFallback: HybridSearchResult | undefined
    if (!local.done) {
      localAbort.abort()
      if (fused) lateFallback = { ...fused, embedderError: fused.embedderError ?? Plur.DEGRADED_MESSAGES.reranker_deadline, degraded_reason: 'reranker_deadline' }
      else if (candidates) lateFallback = keywordOnly(candidates, 'semantic_deadline')
    }
    if (local.done && local.error !== undefined) throw local.error
    if (!local.done || semanticSkipped !== null) this._maybeFillEmbeddingCache()
    const localComplete = local.done && semanticSkipped === null
    let result: HybridSearchResult = local.done
      ? local.value!
      : lateFallback ?? { engrams: [], mode: 'bm25-only', embedderError: null, topScore: null, reranked: 0 }
    // Fold the server leg in (RRF) before reactivation so displaced
    // local rows are not reactivated and server rows rank on merged order.
    const mergedLegs = await this._mergeRemoteRecall(result.engrams, remotePromise, options, limit, deadlineAt)
    result = {
      ...result,
      engrams: mergedLegs.engrams,
      remote: mergedLegs.remote,
      results_complete: localComplete && (mergedLegs.remote.state === 'ok' || mergedLegs.remote.state === 'not_dialed'),
      ...(local.done || lateFallback ? {} : { local_complete: false }),
    }
    // Belt-and-suspenders: all inner paths apply slice(0, limit) before
    // returning, but recallHybridWithMeta is called directly by the MCP layer
    // and lacks the outer guard that recallHybrid() adds. Note
    // _mergeRemoteRecall only slices when the remote leg returned rows — on the
    // common local-only path it returns the local result unsliced. Enforce here
    // so no over-fetch floor (Math.max(N, 50) for reranker/aggregation paths)
    // can leak through to callers.
    if (result.engrams.length > limit) {
      result = { ...result, engrams: result.engrams.slice(0, limit) }
    }
    await this._reactivateWithinDeadline(result.engrams, deadlineAt)
    // A zero-result or low-top-score recall is a demand signal. Emit an
    // anonymized, content-free miss-signal (query fingerprint + scope/domain +
    // timestamp; never the raw query). Opt-in/default-off and fire-and-forget —
    // never disturbs the recall path. Both backends report the RRF fusion top
    // score, so they classify the same way.
    //
    // One retrieval leg (embeddings off by choice, or the embedder failed —
    // `mode` is not 'hybrid'): the threshold (0.025) sits between 1/61 and
    // 2/61 and is calibrated for TWO legs, so every non-empty one-leg recall
    // would read as `low_score`. Offer only `no_results` then: a weak one-leg
    // top hit is not evidence of a miss.
    const oneLeg = result.mode !== 'hybrid'
    if (!(oneLeg && result.engrams.length > 0)) {
      void emitMissSignal({
        query,
        scope: options?.scope,
        domain: options?.domain,
        resultCount: result.engrams.length,
        topScore: result.topScore ?? null,
      }).catch(() => {})
    }
    return result
  },

  async _resolveRerankOptions(rerank?: boolean): Promise<RerankOptions | undefined> {
    if (rerank === false) return undefined
    if (rerank === true) {
      // Explicit opt-in: if PLUR_RERANKER is off (the default), upgrade to
      // bge-reranker-v2-m3 for this call only so opt-in actually does something.
      const envName = resolveRerankerName()
      const name = envName === 'off' ? 'bge-reranker-v2-m3' : envName
      this._reranker = getReranker(name)
      await this._maybeLogRerankerEvalAdvisory(name)
      return { reranker: this._reranker }
    }
    // Implicit: follow the env. Off → undefined so the stage is skipped.
    const envName = resolveRerankerName()
    if (envName === 'off') return undefined
    if (!this._reranker || isRerankerOff(this._reranker)) {
      this._reranker = getReranker(envName)
    }
    await this._maybeLogRerankerEvalAdvisory(envName)
    return { reranker: this._reranker }
  },

  async _maybeLogRerankerEvalAdvisory(rerankerName: string): Promise<void> {
    if (this._rerankerEvalAdvisoryDone) return
    this._rerankerEvalAdvisoryDone = true
    try {
      logRerankerEvalAdvisory(this.paths.root, rerankerName, (await this._filterEngrams()).length)
    } catch { /* advisory must never break recall */ }
  },

  async rerankerSelfEval(options?: {
    /** Reranker to evaluate. Default: the PLUR_RERANKER-resolved adapter. */
    reranker?: RerankerName
    /** Max probes to sample (default 20). */
    sample?: number
    /** PRNG seed (default 1337). */
    seed?: number
    /** Re-run even when a fresh cached verdict exists. */
    force?: boolean
  }): Promise<{ result: RerankerEvalResult; cached: boolean }> {
    // remote-only: the evaluation runs the models over the corpus.
    if (this._activeBinding()) throw this._remoteOnlyError('local-store', undefined, 'Evaluating the reranker')
    const name = options?.reranker ?? resolveRerankerName()
    if (name === 'off') {
      throw new Error(
        'No reranker configured — set PLUR_RERANKER (or pass { reranker }) to run the per-store self-eval.',
      )
    }
    const engrams = await this._filterEngrams()
    if (!options?.force) {
      const cached = loadRerankerEvalCache(this.paths.root)[name]
      if (cached && !isRerankerEvalStale(cached, engrams.length)) {
        return { result: cached, cached: true }
      }
    }
    const adapter = getReranker(name)
    const result = await runRerankerSelfEval(engrams, adapter, {
      sample: options?.sample,
      seed: options?.seed,
      storagePath: this.paths.root,
    })
    saveRerankerEvalResult(this.paths.root, result)
    return { result, cached: false }
  },

  async rerankerEvalStatus(rerankerName?: string): Promise<{ result: RerankerEvalResult; stale: boolean } | null> {
    const name = rerankerName ?? resolveRerankerName()
    if (name === 'off') return null
    const cached = loadRerankerEvalCache(this.paths.root)[name]
    if (!cached) return null
    return { result: cached, stale: isRerankerEvalStale(cached, (await this._filterEngrams()).length) }
  },

  async checkRerankerFit(opts?: { sampleSize?: number; rerankerName?: string }): Promise<FitCheckResult> {
    const name = (opts?.rerankerName as RerankerName | undefined) ?? resolveRerankerName()
    const adapter = getReranker(name === 'off' ? undefined : name)
    const engrams = (await this.list()).map(e => ({ statement: e.statement, domain: e.domain }))
    return checkRerankerFit(engrams, adapter, { sampleSize: opts?.sampleSize })
  },

  _resolveIntentProfile(query: string, intentOverride?: QueryIntent): { intent: QueryIntent; profile: IntentRoutingProfile } | undefined {
    if (isIntentRoutingDisabled()) return undefined
    const intent: QueryIntent = intentOverride ?? classifyQuery(query).intent
    if (intent === 'general') return undefined
    return { intent, profile: routeForIntent(intent) }
  },

  async _pgliteHybridRecall(query: string, limit: number, filtered: Engram[], rerank?: RerankOptions, restrict?: Pick<RecallOptions, 'scope' | 'scopes'>): Promise<HybridSearchResult> {
    if (!this.pgliteAdapter) {
      return hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank)
    }
    if (filtered.length === 0) {
      return { engrams: [], mode: 'hybrid', embedderError: null, topScore: null, reranked: 0 }
    }
    const { embed } = await import('../embeddings.js')
    const queryVec = await embed(query, 'query')
    const status = embedderStatus()
    if (!queryVec) {
      return hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank)
    }
    const wantReranker = rerank?.reranker && !isRerankerOff(rerank.reranker)
    const embLimit = Math.min(filtered.length, wantReranker ? Math.max(limit * 3, 50) : limit * 2)
    let pgHits: Engram[] = []
    try {
    // The scope restriction goes INTO the k-NN query, not onto its results:
    // otherwise `limit` is spent on rows the caller may not see and a narrowly
    // scoped principal silently gets far fewer results. `scope` and mounted-scope
    // visibilityGrants go in too, so granted team engrams surface via the vector
    // leg. Same filter shape searchBM25/loadFiltered get.
      const hits = await this.pgliteAdapter.searchVector(queryVec, embLimit, {
        scopes: restrict?.scopes,
        scope: restrict?.scope,
        visibilityGrants: this._grantedScopes(),
      })
      const allowed = new Map<string, Engram>(filtered.map(e => [e.id, e]))
      pgHits = hits.map(h => allowed.get(h.engram.id)).filter((e): e is Engram => !!e)
    } catch (err) {
      logger.warning(`[plur] PGLite searchVector failed in hybrid: ${(err as Error).message}.`)
      return hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank)
    }
    if (pgHits.length === 0) {
      return hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank)
    }
    const bm25Limit = Math.min(filtered.length, wantReranker ? Math.max(limit * 3, 50) : limit * 3)
    // The lexical leg gets the deterministic rewrite, same
    // as the YAML-path hybridSearchWithMeta. Vector leg + reranker keep the
    // original query.
    const lexicalQuery = isQueryRewriteDisabled() ? query : rewriteLexicalQuery(query)
    const bm25Results = searchEngrams(filtered, lexicalQuery, bm25Limit)
    const merged = pgliteRrfMerge([bm25Results, pgHits])
    // Report the top candidate's RRF fusion score, captured BEFORE the rerank
    // exactly as hybridSearchWithMeta does, so the miss-signal classifies a
    // PGLite recall the same way as a YAML one (classifyMiss reads
    // null-with-results as `no_results`). Same k (60) and the same two lists
    // the merge just fused.
    const topScore = merged.length > 0 ? rrfScoreOf(merged[0].id, [bm25Results, pgHits]) : null
    const reranked = await applyReranker(merged, query, rerank)
    const mode: HybridSearchResult['mode'] = status.disabled ? 'bm25-only' : 'hybrid'
    return { engrams: reranked.engrams.slice(0, limit), mode, embedderError: null, topScore, reranked: reranked.count }
  },

  async _pgliteSemanticRecall(query: string, limit: number, filtered: Engram[], restrict?: Pick<RecallOptions, 'scope' | 'scopes'>): Promise<Engram[]> {
    if (!this.pgliteAdapter) return []
    const { embed } = await import('../embeddings.js')
    const queryVec = await embed(query, 'query')
    if (!queryVec) {
      return embeddingSearch(filtered, query, limit, this.paths.root)
    }
    try {
    // The scope restriction goes INTO the k-NN query, not onto its results:
    // otherwise `limit` is spent on rows the caller may not see and a narrowly
    // scoped principal silently gets far fewer results. `scope` and mounted-scope
    // visibilityGrants go in too, so granted team engrams surface via the vector
    // leg. Same filter shape searchBM25/loadFiltered get.
      const hits = await this.pgliteAdapter.searchVector(queryVec, Math.max(limit * 3, 50), {
        scopes: restrict?.scopes,
        scope: restrict?.scope,
        visibilityGrants: this._grantedScopes(),
      })
      if (hits.length === 0) {
        return embeddingSearch(filtered, query, limit, this.paths.root)
      }
      const allowed = new Map<string, Engram>(filtered.map(e => [e.id, e]))
      const results: Engram[] = []
      for (const hit of hits) {
        const allowedEngram = allowed.get(hit.engram.id)
        if (allowedEngram) results.push(allowedEngram)
        if (results.length >= limit) break
      }
      return results
    } catch (err) {
      logger.warning(`[plur] PGLite searchVector failed: ${(err as Error).message}. Falling back to JSON cache.`)
      return embeddingSearch(filtered, query, limit, this.paths.root)
    }
  },

  async _primarySemanticRecall(adapter: StorageAdapter, query: string, limit: number, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const fallback = async () =>
      embeddingSearch(await this._filterEngrams(options), query, limit, this.paths.root)
    const { embed } = await import('../embeddings.js')
    const queryVec = await embed(query, 'query')
    // Embedder disabled or unavailable: the in-memory degraded path —
    // embeddingSearch reports [] without an embedder, never throws.
    if (!queryVec) return fallback()
    try {
      if (typeof adapter.listEngramsMissingEmbeddings === 'function') {
        const gap = await adapter.listEngramsMissingEmbeddings(1)
        if (gap.length > 0) {
          this._afterStoreCommit(() => this._kickPrimaryAutoEmbed(adapter))
          return fallback()
        }
      }
      const hits = await adapter.searchVector(queryVec, Math.max(limit * 3, 50), {
        scopes: options?.scopes,
        scope: options?.scope,
        visibilityGrants: this._grantedScopes(),
      })
      const surviving = new Set(this._applyResidualFilters(hits.map(h => h.engram), options).map(e => e.id))
      const primaryScored: SimilarityResult[] = hits
        .filter(h => surviving.has(h.engram.id))
        .map(h => ({ engram: h.engram, score: Math.max(0, Math.min(1, h.score)) }))
      const outsiders = this._applyResidualFilters(await this._engramsOutsidePrimaryStore(options), options)
      const outsiderScored = outsiders.length > 0
        ? await embeddingSearchWithScores(outsiders, query, limit, this.paths.root)
        : []
      return [...primaryScored, ...outsiderScored]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(s => s.engram)
    } catch (err) {
      logger.warning(
        `[plur] primary-store searchVector failed: ${(err as Error).message}. Falling back to in-memory semantic recall.`,
      )
      return fallback()
    }
  },

  embedderStatus(): EmbedderStatus {
    return embedderStatus()
  },

  resetEmbedder(): void {
    resetEmbedder()
  },

  rerankerStatus(): RerankerRuntimeStatus {
    return rerankerStatus()
  },

  resetReranker(): void {
    _resetRerankerCache()
    _resetCrossEncoderCaches()
    resetRerankerStatus()
    this._reranker = null
  },

  async similaritySearch(query: string, options?: { limit?: number; scope?: string; domain?: string }): Promise<SimilarityResult[]> {
    // remote-only: no embedder, so no similarity scores.
    if (this._activeBinding()) return []
    const filtered = await this._filterEngrams(options)
    const limit = options?.limit ?? 20
    return embeddingSearchWithScores(filtered, query, limit, this.paths.root)
  },

  async recallExpanded(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]> {
    // remote-only: no model and no embedder.
    if (this._activeBinding()) return await this.recall(query, options)
    const filtered = await this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await expandedSearch(filtered, query, limit, options.llm, this.paths.root)
    await this._reactivateResults(results)
    return results
  },

  async recallAutoSearch(query: string, options?: RecallOptions): Promise<AutoSearchResult> {
    // remote-only: keyword search only, no model and no embedder.
    if (this._activeBinding()) return { results: await this.recall(query, options), strategy_used: 'bm25' }
    const filtered = await this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const result = await recallAuto(filtered, query, limit, this.paths.root, options?.llm)
    await this._reactivateResults(result.results)
    return result
  },

  async getById(id: string): Promise<Engram | null> {
    // remote-only: personal rows are not found.
    const engrams = this._remoteOnly ? await this._remoteOnlyVisible() : await this._loadAllEngrams()
    const exact = engrams.find(e => e.id === id)
    if (exact) return exact
    // A reference another store holds to one of my primary rows. The same
    // visibility as the bare id: none in remote-only mode, and a save queued
    // from a remote-only folder is never returned.
    const ns = parseNamespacedId(id)
    if (ns && !this._remoteOnly && ns.prefix === storePrefix(this._primaryRefScope())) {
      const own = withoutRemoteOnlyQueued(await this._loadCached(this.paths.engrams)).find(e => e.id === ns.bare)
      if (own) return own
    }
    const byPackOriginal = this._matchPackOriginalId(engrams, id)
    if (byPackOriginal) return byPackOriginal
    const byLegacyPackId = this._matchLegacyPackId(engrams, id)
    if (byLegacyPackId) return byLegacyPackId
    return this._matchOldFormId(engrams, id)
  },

  _matchLegacyPackId(engrams: Engram[], id: string): Engram | null {
    const rows: Array<{ row: Engram; pack: string }> = []
    for (const e of engrams) {
      const pack = (e as { _pack?: unknown })._pack
      if (typeof pack === 'string') rows.push({ row: e, pack })
      else if (e.id === id) return null
    }
    return matchLegacyPackId(rows, id)
  },

  _matchPackOriginalId(engrams: Engram[], id: string): Engram | null {
    const matches = engrams.filter(e => {
      const pack = (e as { _pack?: unknown })._pack
      return typeof pack === 'string' && e.id === packEngramId(id, pack)
    })
    return matches.length === 1 ? matches[0] : null
  },

  _matchOldFormId(engrams: Engram[], id: string): Engram | null {
    // An id in the legacy three-letter store form still finds its engram — but
    // only when exactly one loaded row carries it. The legacy prefix is shared
    // by every team store of an org, so two rows can answer to one old id;
    // then it names neither.
    const ns = parseNamespacedId(id)
    if (!ns) return null
    const matches = engrams.filter(e => {
      const stored = (e as { _storeScope?: unknown })._storeScope
      const scope = typeof stored === 'string' ? stored : e.scope
      const row = parseNamespacedId(e.id, true)
      return row !== null && typeof scope === 'string' && row.prefix === storePrefix(scope)
        && legacyStorePrefix(scope) === ns.prefix && row.bare === ns.bare
    })
    return matches.length === 1 ? matches[0] : null
  },

  async getByIds(ids: string[], options?: { remoteCapability?: string }): Promise<Engram[]> {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (wanted.length === 0) return []
    if (this._remoteOnly) {
      // remote-only: team rows, packs and queued saves only.
      const visible = (await this._remoteOnlyVisible()).filter(e => wanted.includes(e.id))
      const seen = new Set(visible.map(e => e.id))
      const missing = wanted.filter(id => !seen.has(id))
      const remote = options?.remoteCapability && missing.length > 0 && !this._remoteOnly.blocked
        ? await this._fetchRemoteByIds(missing, options.remoteCapability)
        : []
      return [...visible, ...remote]
    }
    // Unbound, a queued remote-only save is not returned.
    const primary = withoutRemoteOnlyQueued((await this._loadTargeted(wanted)).filter(e => wanted.includes(e.id)))
    const found = new Set(primary.map(e => e.id))
    let missing = wanted.filter(id => !found.has(id))
    if (missing.length === 0) return primary
    const all = await this._loadAllEngrams()
    const rest = all.filter(e => missing.includes(e.id))
    for (const e of rest) found.add(e.id)
    missing = missing.filter(id => !found.has(id))
    // Older injection records hold legacy-form team ids; the row is
    // handed back under the id asked for, as the remote leg below does.
    for (const id of missing) {
      const m = this._matchOldFormId(all, id)
      if (m) { rest.push({ ...m, id }); found.add(id) }
    }
    // A pack id of the earlier form (saved in a relation or a receipt) finds
    // its pack row, handed back under its current pack id.
    missing = missing.filter(id => !found.has(id))
    for (const id of missing) {
      const m = this._matchLegacyPackId(all, id)
      if (!m) continue
      found.add(id)
      if (!primary.some(e => e.id === m.id) && !rest.some(e => e.id === m.id)) rest.push(m)
    }
    missing = missing.filter(id => !found.has(id))
    const remote = options?.remoteCapability && missing.length > 0
      ? await this._fetchRemoteByIds(missing, options.remoteCapability)
      : []
    return [...primary, ...rest, ...remote]
  },

  async _fetchRemoteByIds(ids: string[], capability: string): Promise<Engram[]> {
    const out: Engram[] = []
    const taken = new Set<string>()
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      // remote-only: only the folder's own team store.
      if (this._remoteOnly && (entry.scope !== this._remoteOnly.scope || !this._isDeliverableTeamScope(entry.scope))) continue
      const prefixRe = new RegExp(`^(ENG|ABS|META)-${storePrefix(entry.scope)}-`)
      // A legacy-form id names this store only when no other url
      // store shares its old prefix; then its bare form is asked for.
      const oldPrefix = legacyStorePrefix(entry.scope)
      const oldIsMine = (this.config.stores ?? []).filter(e => !!e.url && legacyStorePrefix(e.scope) === oldPrefix).length === 1
      const serverIdOf = (id: string): string | null => {
        if (prefixRe.test(id)) return this._stripRemotePrefix(id, entry.scope)
        const old = oldIsMine ? parseNamespacedId(id) : null
        return old && old.prefix === oldPrefix ? old.bare : null
      }
      const mine = ids.filter(id => !taken.has(id) && serverIdOf(id) !== null).slice(0, GET_BY_IDS_REMOTE_CAP)
      if (mine.length === 0) continue
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      if (!(await driver.hasCapability(capability))) continue
      const rows = await Promise.all(mine.map(async id => {
        const row = await driver.getById(serverIdOf(id)!)
        return row ? { id, row } : null
      }))
      for (const hit of rows) {
        if (!hit) continue
        // remote-only: a personal row on the team host is not this folder's.
        if (this._remoteOnly && hit.row.scope !== 'global' && !(this._isDeliverableTeamScope(hit.row.scope) && isScopeWithin(hit.row.scope, entry.scope))) continue
        taken.add(hit.id)
        const cloned = { ...hit.row } as Engram & { _originalId?: string; _storeScope?: string }
        cloned._originalId = hit.row.id
        cloned._storeScope = entry.scope
        if (cloned.scope === 'global') cloned.scope = entry.scope
        cloned.id = hit.id
        out.push(cloned)
      }
    }
    return out
  },

  async list(options?: { scope?: string; scopes?: string[]; domain?: string; min_strength?: number; include_expired?: boolean }): Promise<Engram[]> {
    return await this._filterEngrams(options)
  },

  async ready(): Promise<void> {
    await this._readyPromise
  },

  _applyResidualFilters(engrams: Engram[], options?: RecallOptions & { include_expired?: boolean }): Engram[] {
    // A query adapter's rows never include a queued remote-only save.
    let out = withoutRemoteOnlyQueued(engrams)
    if (!options?.include_expired) {
      // Instants compared as instants, not lexically: a lexical compare would
      // read `valid_until: 2026-09-07T01:00:00Z` as still valid at noon that
      // day.
      const nowMs = Date.now()
      out = out.filter(e => isCurrentlyValid(e.temporal, nowMs))
    }
    if (options?.min_strength !== undefined) {
      out = out.filter(e => e.activation.retrieval_strength >= options.min_strength!)
    }
    return out
  },

  _grantedScopes(): string[] {
    return [...new Set((this.config.stores ?? []).map(s => s.scope))]
  },

  async _hybridCandidates(query: string, options?: RecallOptions & { include_expired?: boolean }): Promise<Engram[]> {
    const adapter = this._remoteOnly ? null : this._primaryQueryAdapter()
    if (adapter?.searchBM25Exhaustive) {
      try {
        const narrowed = await adapter.searchBM25Exhaustive(query, {
          limit: (options?.limit ?? 20) * PUSHDOWN_OVERFETCH,
          status: 'active',
          ...(options?.scope !== undefined ? { scope: options.scope } : {}),
          ...(options?.scopes !== undefined ? { scopes: options.scopes } : {}),
          ...(options?.domain !== undefined ? { domain: options.domain } : {}),
          visibilityGrants: this._grantedScopes(),
        })
        if (narrowed.exhausted) return withoutRemoteOnlyQueued(narrowed.rows)
      } catch {
        // A pushdown failure must never fail a recall — fall back to the
        // in-memory read.
      }
    }
    return await this._filterEngrams(options)
  },

  async _filterEngrams(options?: RecallOptions & { include_expired?: boolean }): Promise<Engram[]> {
    let engrams: Engram[]
    if (this.indexedStorage && !this._remoteOnly) {
      engrams = await this.indexedStorage.loadFiltered({
        status: 'active',
        scope: options?.scope,
        scopes: options?.scopes,
        // Mounted-scope visibility grants — widen the `scope`
        // VISIBILITY clause only; a no-op without `scope`, and never touches
        // the `scopes` authorization pushdown above.
        visibilityGrants: this._grantedScopes(),
        domain: options?.domain,
      })
    } else {
      const adapter = this._remoteOnly ? null : this._primaryQueryAdapter()
      if (adapter && typeof adapter.loadFiltered === 'function' && !this.pgliteAdapter) {
        // Primary-store adapter (e.g. Postgres): one scoped server-side query
        // replaces a full table read on every recallHybrid call.
        // - `typeof loadFiltered` is load-bearing: a store can qualify with only
        //   the query surface and must take the fallback read below.
        // - `!pgliteAdapter` cannot be false here by construction (tier
        //   selection), but is kept: PGLite needs the full corpus, so this branch
        //   would silently narrow it. Pinned by `filter-engrams-primary-pushdown.test.ts`.
        // Temporal validity and min_strength are applied below;
        // _engramsOutsidePrimaryStore filters packs and remote secondary stores.
        const primaryRows = await adapter.loadFiltered({
          status: 'active',
          scope: options?.scope,
          scopes: options?.scopes,
          visibilityGrants: this._grantedScopes(),
          domain: options?.domain,
        })
        const outsiders = await this._engramsOutsidePrimaryStore(options)
        engrams = [...primaryRows, ...outsiders]
      } else {
      // PGLite path (or no-index path): read from YAML so this code stays
      // synchronous. PGLite is currently used for vector/Cypher queries
      // and remains in sync via _syncIndex on every write — but the
      // filtered relational path here goes through the YAML cache for
      // sync semantics. _loadAllEngrams reads through a mtime-based cache,
      // so the cost is comparable. remote-only: the read corpus (team store
      // rows + packs), never the personal store.
      engrams = await this._readCorpus()
      engrams = engrams.filter(e => e.status === 'active')
      if (options?.scopes !== undefined) {
        // Permitted-scope allow-list. The in-memory twin of the SQL
        // `scope = ANY($n)` pushdown, so the YAML path can never be the one
        // read path that silently ignores an authorization filter. EXACT
        // membership; `[]` matches nothing — see scopeAllowFilter.
        const allowed = scopeAllowFilter(options.scopes)
        engrams = engrams.filter(e => allowed(e.scope))
      }
      if (options?.domain) {
        engrams = engrams.filter(e => e.domain?.startsWith(options.domain!))
      }
      if (options?.scope) {
        // Read-side scope filter — the ONE shared visibility
        // predicate. Segment-aware containment keeps the `startsWith` arm so
        // an explicit personal scope like `user:alice` still catches
        // sub-scopes (e.g. `user:alice:notes`). `isPersonalScope` passes ALL
        // personal-family scopes (local, global, user:*, agent:*), not just
        // global — so a project-scope recall sees personal engrams. Mounted
        // store scopes pass the same way. Asymmetry: an explicit
        // `global` recall therefore includes all personal-family engrams —
        // wider than `global` inject, which is targeted to global-only (see
        // inject.ts INJECT_GLOBAL_IS_TARGETED).
        const visible = makeVisibilityPredicate(options.scope, this._grantedScopes())
        engrams = engrams.filter(e => visible(e.scope))
      }
      }
    }
    // Temporal validity: exclude expired or not-yet-valid engrams.
    // `include_expired` opts out — callers that need dedup-identity parity
    // with learn()'s content-hash gate (which ignores temporal validity,
    // e.g. the migration import engine) must see the full active set.
    if (!options?.include_expired) {
      // One evaluator, shared with _applyResidualFilters and injection.
      const nowMs = Date.now()
      engrams = engrams.filter(e => isCurrentlyValid(e.temporal, nowMs))
    }
    if (options?.min_strength !== undefined) {
      engrams = engrams.filter(e => e.activation.retrieval_strength >= options.min_strength!)
    }
    // Unbound, a queued remote-only save is never a result.
    return withoutRemoteOnlyQueued(engrams)
  },

  async _reactivateWithinDeadline(results: Engram[], deadlineAt: number): Promise<void> {
    // The lock wait is bounded by the time left, so the lock
    // is never taken after the reply; with no time left the refresh is skipped.
    const remaining = deadlineAt - Date.now()
    if (!(remaining > 0)) return
    const cancel = { abandoned: false }
    const work = this._reactivateResults(results, {
      lockWaitMs: Math.min(RECALL_BOOKKEEPING_LOCK_WAIT_MS, remaining), deadlineAt, cancel,
    }).catch(err => {
      logger.debug(`[plur:recall] activation refresh skipped: ${(err as Error).message}`)
    })
    const waited = await settleBy(work, deadlineAt)
    // Past the deadline the refresh is abandoned: a lock that comes later is
    // released at once, and a refresh already running stops before its write.
    if (!waited.done) cancel.abandoned = true
  },

  async _bookkeepingWithinDeadline(deadlineAt: number | undefined, body: (tooLate: () => boolean) => Promise<void>): Promise<void> {
    if (deadlineAt === undefined || !Number.isFinite(deadlineAt)) {
      await this._withStoreLock(this.paths.engrams, () => body(() => false))
      return
    }
    const remaining = deadlineAt - Date.now()
    if (!(remaining > 0)) return
    let abandoned = false
    const tooLate = (): boolean => abandoned || Date.now() >= deadlineAt
    const locked = this._withStoreLock(this.paths.engrams, async () => {
      if (tooLate()) return
      await body(tooLate)
    }, { acquireTimeout: Math.min(RECALL_BOOKKEEPING_LOCK_WAIT_MS, remaining), baseDelay: 25 })
    const waited = await settleBy(locked, deadlineAt)
    if (!waited.done) {
      abandoned = true
      locked.catch(() => { /* the abandoned waiter's give-up is expected */ })
      return
    }
    if (waited.error !== undefined) throw waited.error
  },

  async _reactivateResults(results: Engram[], opts?: { lockWaitMs?: number; deadlineAt?: number; cancel?: { abandoned: boolean } }): Promise<void> {
    // Read-only instance: SKIP the activation refresh, silently. Recall is a
    // read and must succeed on a read-only engine; the write it piggybacks
    // (retrieval_strength / last_accessed / frequency / co-access edges) is
    // freshness bookkeeping, not the answer. Refusing the whole recall because
    // the bookkeeping is forbidden would make the read wrong, so the results are returned as-is
    // and the refresh is deferred to the next writable instance that recalls
    // them. Returning before the lock also keeps a pure read from creating
    // `.lock` files.
    if (this._readonly) return
    if (results.length === 0) return
    // remote-only: results are team-store and pack rows; the personal store
    // is neither read nor touched here.
    if (this._remoteOnly) return
    // Filter out store engrams — they're managed by their source.
    // Via YAML path: store engrams have _originalId. Via SQLite path: namespaced IDs (ENG-XX-...).
    const isStoreEngram = (e: Engram) =>
      (e as any)._originalId || /^(ENG|ABS|META)-[A-Z]{3}(?:[A-Z]{8})?-/.test(e.id)
    const primaryResults = results.filter(e => !isStoreEngram(e))
    if (primaryResults.length === 0) return
    // Bounded lock wait. The file-lock wait gives up by itself at
    // `acquireTimeout`; a wait in the in-process queue, or on a store's own
    // exclusive access, is cut by `abandoned`: when the lock finally comes,
    // the refresh is skipped and the lock released at once.
    let acquired = false
    let abandoned = false
    const lockOptions: AsyncLockOptions | undefined = opts?.lockWaitMs !== undefined
      ? { acquireTimeout: opts.lockWaitMs, baseDelay: 25 }
      : undefined
    /** The reply has gone (or is going) out: no write behind its back. */
    const tooLate = (): boolean => abandoned || opts?.cancel?.abandoned === true
      || (opts?.deadlineAt !== undefined && Date.now() >= opts.deadlineAt)
    const locked = this._withStoreLock(this.paths.engrams, async () => {
      acquired = true
      if (tooLate()) return
      const resultIds = new Set(primaryResults.map(e => e.id))
      // Read only the engrams this recall touched, when the store can.
      // Everything below is keyed by id — the reactivation targets `resultIds`
      // and the co-access edges only ever look up sources drawn from the
      // results — so materialising the corpus was pure overhead. Re-read under
      // the lock rather than reusing the search results, so two concurrent
      // recalls cannot both increment from the same stale counter.
      const store = this._storeAt(this.paths.engrams)
      // `loadByIds` and `updateMany` are used as a PAIR, and the pair is what
      // makes the optimisation safe.
      //
      // Both are optional on `PrimaryStore`. Taking the targeted READ without
      // the targeted WRITE is catastrophic: `loadByIds` returns only the
      // recalled handful, and the fallback below hands that subset to
      // `_writeEngrams`, which is a FULL REPLACE — so a store implementing
      // `loadByIds` alone (a perfectly reasonable thing to implement first)
      // would delete its entire corpus except the current page of results, on
      // an ordinary read.
      const canTarget = Boolean(store.loadByIds && store.updateMany)
      const allEngrams = canTarget
        ? await store.loadByIds!([...resultIds])
        : await this._primaryStore.load()
      const today = new Date().toISOString().slice(0, 10)
      // WHICH engrams changed, not merely whether any did. A recall touches a
      // handful of rows; tracking them lets a store that supports targeted
      // updates write only those instead of the whole corpus, under the global
      // write lock, on every read.
      const touched = new Map<string, Engram>()

      // Reactivate accessed engrams.
      //
      // TRAFFIC and QUALITY are separate signals here. `frequency` counts
      // retrievals and `last_accessed` carries recency — which is what decay
      // actually keys on, so a frequently-recalled engram still resists decay.
      // `retrieval_strength` is deliberately NOT touched: it moves only on
      // deliberate feedback, otherwise retrieval traffic would outvote quality
      // feedback and saturate it within a few recalls.
      for (const e of allEngrams) {
        if (resultIds.has(e.id)) {
          e.activation.retrieval_strength = reactivate(e.activation.retrieval_strength)
          e.activation.last_accessed = today
          e.activation.frequency += 1
          touched.set(e.id, e)
        }
      }

      // Co-access edge updates: only for top half of results, min 2
      if (results.length >= 2 && (this.config.injection?.co_access !== false)) {
        const topHalf = results.slice(0, Math.max(2, Math.ceil(results.length / 2)))
        const topIds = topHalf.map(e => e.id)

        for (const sourceId of topIds) {
          const source = allEngrams.find(e => e.id === sourceId)
          if (!source) continue
          // Normalise before use. `associations` has a schema default, but a row
          // that reaches here WITHOUT going through the schema — one written by
          // an older version, a migration, or any tool that talks to the table
          // directly — has no such guarantee, and `undefined.find(...)` takes
          // down the whole recall. Reads should not be able to crash on a row
          // they merely passed over.
          if (!Array.isArray(source.associations)) source.associations = []

          for (const targetId of topIds) {
            if (targetId === sourceId) continue

            const existing = source.associations.find(
              a => a.type === 'co_accessed' && a.target === targetId
            )

            if (existing) {
              existing.strength = Math.min(0.95, existing.strength + 0.05)
              existing.updated_at = today
              touched.set(source.id, source)
            } else {
              const coAccessCount = source.associations.filter(a => a.type === 'co_accessed').length
              if (coAccessCount < 5) {
                source.associations.push({
                  target_type: 'engram',
                  target: targetId,
                  type: 'co_accessed',
                  strength: 0.3,
                  updated_at: today,
                })
                touched.set(source.id, source)
              }
            }
          }
        }
      }

      if (touched.size === 0) return
      if (tooLate()) return

      if (canTarget) {
        // Targeted: rewrites the handful of rows a recall actually touched.
        await store.updateMany!([...touched.values()])
      } else {
        // A single-file store has no cheaper option — the whole file is
        // rewritten either way.
        await this._writeEngrams(this.paths.engrams, allEngrams)
      }
      await this._syncIndex()
    }, lockOptions)
    if (opts?.lockWaitMs === undefined) return await locked
    const waited = await settleBy(locked, Date.now() + opts.lockWaitMs)
    if (!waited.done && !acquired) {
      // Not taken in time: skip. If the lock comes later, the callback above
      // returns at once instead of writing behind the reply's back.
      abandoned = true
      locked.catch(() => { /* the abandoned waiter's give-up is expected */ })
      return
    }
    // Taken (or settled): the refresh runs to its end — the caller decides
    // how long the reply waits for it.
    await locked
  },
}
