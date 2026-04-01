import * as fs from 'fs'
import yaml from 'js-yaml'
import { detectPlurStorage, type PlurPaths } from './storage.js'
import { IndexedStorage } from './storage-indexed.js'
import { loadConfig } from './config.js'
import { loadEngrams, saveEngrams, generateEngramId, loadAllPacks, storePrefix } from './engrams.js'
import { logger } from './logger.js'
import { searchEngrams } from './fts.js'
import { selectAndSpread, scoreEngramsPublic } from './inject.js'
import { reactivate } from './decay.js'
import { captureEpisode, queryTimeline } from './episodes.js'
import { detectConflicts } from './conflict.js'
import { agenticSearch } from './agentic-search.js'
import { embeddingSearch } from './embeddings.js'
import { hybridSearch } from './hybrid-search.js'
import { expandedSearch } from './query-expansion.js'
import { installPack, listPacks, exportPack } from './packs.js'
import { sync as gitSync, getSyncStatus, withLock, type SyncResult, type SyncStatus } from './sync.js'
import { detectSecrets } from './secrets.js'
import type { Engram } from './schemas/engram.js'
import type { Episode } from './schemas/episode.js'
import type { PackManifest } from './schemas/pack.js'
import type { PlurConfig, StoreEntry } from './schemas/config.js'
import type {
  LearnContext,
  RecallOptions,
  InjectOptions,
  InjectionResult,
  CaptureContext,
  TimelineQuery,
  LlmFunction,
} from './types.js'

export * from './meta/index.js'
export { classifyPolarity } from './polarity.js'
export { computeConfidence, computeMetaConfidence, confidenceBand } from './confidence.js'
export { SessionBreadcrumbs } from './session-state.js'
export { generateGuardrails } from './guardrails.js'
export type { MetaField, StructuralTemplate, EvidenceEntry, MetaConfidence, DomainCoverage, HierarchyPosition, Falsification } from './schemas/meta-engram.js'
export { MetaFieldSchema, StructuralTemplateSchema, EvidenceEntrySchema, MetaConfidenceSchema, DomainCoverageSchema, HierarchyPositionSchema, FalsificationSchema } from './schemas/meta-engram.js'
export { engramSearchText } from './fts.js'
export { detectSecrets } from './secrets.js'
export { detectPlurStorage, type PlurPaths } from './storage.js'
export { IndexedStorage } from './storage-indexed.js'
export type { SyncResult, SyncStatus } from './sync.js'
export { checkForUpdate, getCachedUpdateCheck, clearVersionCache, type VersionCheckResult } from './version-check.js'
export type { Engram } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PackManifest } from './schemas/pack.js'
export type { PlurConfig, StoreEntry } from './schemas/config.js'
export * from './types.js'

export interface IngestOptions {
  source?: string
  extract_only?: boolean
  scope?: string
  domain?: string
}

export interface IngestCandidate {
  statement: string
  type: 'behavioral' | 'architectural' | 'procedural'
  source?: string
}

export interface StatusResult {
  engram_count: number
  episode_count: number
  pack_count: number
  storage_root: string
  config: PlurConfig
}

const INGEST_PATTERNS = [
  { re: /(?:we decided|the decision is|agreed to)\s+(.+?)\.?$/gim, type: 'architectural' as const },
  { re: /(?:always|never|must|should)\s+(.+?)\.?$/gim, type: 'behavioral' as const },
  { re: /(?:the convention is|the rule is|the pattern is)\s+(.+?)\.?$/gim, type: 'procedural' as const },
  { re: /(?:use|prefer)\s+(\w+)\s+(?:for|over|instead of)\s+(.+?)\.?$/gim, type: 'behavioral' as const },
  { re: /(?:important|note|remember):\s*(.+?)\.?$/gim, type: 'behavioral' as const },
]

export class Plur {
  private paths: PlurPaths
  private config: PlurConfig
  private indexedStorage: IndexedStorage | null = null
  private _engramCache: Map<string, { mtime: number; engrams: Engram[] }> = new Map()

  constructor(options?: { path?: string }) {
    this.paths = detectPlurStorage(options?.path)
    this.config = loadConfig(this.paths.config)
    if (this.config.index) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
  }

  /**
   * Load engrams from primary store + all configured stores, with mtime-based caching.
   * Store engram IDs get namespaced: ENG-2026-0401-001 → ENG-DF-2026-0401-001.
   * Primary engrams are returned unchanged.
   */
  private _loadAllEngrams(): Engram[] {
    const primary = this._loadCached(this.paths.engrams)
    const stores = this.config.stores ?? []
    if (stores.length === 0) return primary

    const all: Engram[] = [...primary]
    for (const store of stores) {
      const storeEngrams = this._loadCached(store.path)
      const prefix = storePrefix(store.scope)
      for (const e of storeEngrams) {
        // Phase 4: Scope validation
        if (e.scope !== 'global' && e.scope !== store.scope && !e.scope.startsWith(store.scope)) {
          logger.debug(`Skipping engram ${e.id} from store ${store.scope}: scope mismatch (${e.scope})`)
          continue
        }

        const cloned = { ...e } as any
        // Narrow global scope to store scope
        if (cloned.scope === 'global') {
          cloned.scope = store.scope
        }
        // Namespace the ID to avoid collisions
        const originalId = cloned.id
        cloned.id = cloned.id.replace(/^(ENG|ABS|META)-/, `$1-${prefix}-`)
        cloned._originalId = originalId
        cloned._storeScope = store.scope
        all.push(cloned)
      }
    }
    return all
  }

  /** Load engrams from a path with mtime-based caching */
  private _loadCached(path: string): Engram[] {
    let mtime = 0
    try {
      mtime = fs.statSync(path).mtimeMs
    } catch {
      return []
    }
    const cached = this._engramCache.get(path)
    if (cached && cached.mtime === mtime) return cached.engrams
    const engrams = loadEngrams(path)
    this._engramCache.set(path, { mtime, engrams })
    return engrams
  }

  /** Find which store owns an engram by ID. For namespaced IDs, strips prefix to find in store. */
  private _findEngramStore(id: string): { path: string; readonly: boolean; originalId: string } | null {
    // Check primary first (uses mtime cache)
    const primaryEngrams = this._loadCached(this.paths.engrams)
    if (primaryEngrams.find(e => e.id === id)) {
      return { path: this.paths.engrams, readonly: false, originalId: id }
    }

    // Check stores — ID might be namespaced
    const stores = this.config.stores ?? []
    for (const store of stores) {
      const prefix = storePrefix(store.scope)
      const nsPattern = new RegExp(`^(ENG|ABS|META)-${prefix}-`)
      if (nsPattern.test(id)) {
        // Strip the namespace prefix to get the original ID
        const originalId = id.replace(nsPattern, '$1-')
        const storeEngrams = this._loadCached(store.path)
        if (storeEngrams.find(e => e.id === originalId)) {
          return { path: store.path, readonly: store.readonly ?? false, originalId }
        }
      }
    }

    return null
  }

  /** Create engram, detect conflicts, save. Returns the created engram. */
  learn(statement: string, context?: LearnContext): Engram {
    if (!this.config.allow_secrets) {
      const secrets = detectSecrets(statement)
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      // Use all engrams (including stores) for ID generation to avoid conflicts
      const allEngrams = this._loadAllEngrams()
      const id = generateEngramId(allEngrams)
      const scope = context?.scope ?? 'global'
      const now = new Date().toISOString()

      // Detect conflicts among active engrams in the same scope (including stores)
      const conflictingEngrams = detectConflicts({ statement, scope }, allEngrams)
      const conflictIds = conflictingEngrams.map(e => e.id)

      const engram: Engram = {
        id,
        version: 2,
        status: 'active',
        consolidated: false,
        type: context?.type ?? 'behavioral',
        scope,
        visibility: context?.visibility ?? 'private',
        statement,
        rationale: context?.rationale,
        source: context?.source,
        domain: context?.domain,
        activation: {
          retrieval_strength: 0.7,
          storage_strength: 1.0,
          frequency: 0,
          last_accessed: now.slice(0, 10),
        },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 },
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
        dual_coding: context?.dual_coding,
        polarity: null,
        relations: conflictIds.length > 0 ? {
          broader: [],
          narrower: [],
          related: [],
          conflicts: conflictIds,
        } : undefined,
      }

      engrams.push(engram)
      saveEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      return engram
    })
  }

  /**
   * Search engrams, filter by scope/domain/strength, reactivate accessed.
   * Supports two modes:
   *   - 'fast' (default): BM25 keyword search, instant, no API calls
   *   - 'agentic': LLM-assisted semantic search, higher accuracy, requires llm function
   */
  /** Search engrams using fast BM25 keyword matching. Sync, no API calls. */
  recall(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Engram[] {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = searchEngrams(filtered, query, limit)
    this._reactivateResults(results)
    return results
  }

  /** Search engrams using LLM-assisted semantic filtering. Async, requires llm function. */
  async recallAsync(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await agenticSearch(filtered, query, limit, options.llm)
    this._reactivateResults(results)
    return results
  }

  /** Search engrams using local embeddings (transformers.js). Async, no API calls. */
  async recallSemantic(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await embeddingSearch(filtered, query, limit, this.paths.root)
    this._reactivateResults(results)
    return results
  }

  /** Hybrid search: BM25 + embeddings merged via Reciprocal Rank Fusion. Async, no API calls. */
  async recallHybrid(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await hybridSearch(filtered, query, limit, this.paths.root)
    this._reactivateResults(results)
    return results
  }

  /** Expanded search: LLM query expansion + hybrid search + RRF merge. Opt-in, requires LLM function. */
  async recallExpanded(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await expandedSearch(filtered, query, limit, options.llm, this.paths.root)
    this._reactivateResults(results)
    return results
  }

  /** Get a single engram by ID, regardless of status. Searches primary + all stores. */
  getById(id: string): Engram | null {
    const engrams = this._loadAllEngrams()
    return engrams.find(e => e.id === id) ?? null
  }

  /** List all active engrams, optionally filtered by scope/domain. No search — returns all matches. */
  list(options?: { scope?: string; domain?: string; min_strength?: number }): Engram[] {
    return this._filterEngrams(options)
  }

  /** Filter engrams by scope/domain/strength (shared by both modes) */
  private _filterEngrams(options?: RecallOptions): Engram[] {
    let engrams: Engram[]
    if (this.indexedStorage) {
      engrams = this.indexedStorage.loadFiltered({
        status: 'active',
        scope: options?.scope,
        domain: options?.domain,
      })
    } else {
      engrams = this._loadAllEngrams()
      engrams = engrams.filter(e => e.status === 'active')
      if (options?.domain) {
        engrams = engrams.filter(e => e.domain?.startsWith(options.domain!))
      }
      if (options?.scope) {
        const scope = options.scope
        engrams = engrams.filter(e =>
          e.scope === 'global' || e.scope === scope || e.scope.startsWith(scope)
        )
      }
    }
    // Temporal validity: exclude expired or not-yet-valid engrams
    const today = new Date().toISOString().slice(0, 10)
    engrams = engrams.filter(e => {
      if (e.temporal?.valid_until && e.temporal.valid_until < today) return false
      if (e.temporal?.valid_from && e.temporal.valid_from > today) return false
      return true
    })
    if (options?.min_strength !== undefined) {
      engrams = engrams.filter(e => e.activation.retrieval_strength >= options.min_strength!)
    }
    return engrams
  }

  /** Reactivate accessed engrams and update co-access associations */
  private _reactivateResults(results: Engram[]): void {
    if (results.length === 0) return
    // Filter out store engrams — they're managed by their source.
    // Via YAML path: store engrams have _originalId. Via SQLite path: namespaced IDs (ENG-XX-...).
    const isStoreEngram = (e: Engram) =>
      (e as any)._originalId || /^(ENG|ABS|META)-[A-Z]{2}-/.test(e.id)
    const primaryResults = results.filter(e => !isStoreEngram(e))
    if (primaryResults.length === 0) return
    withLock(this.paths.engrams, () => {
      const allEngrams = loadEngrams(this.paths.engrams)
      const resultIds = new Set(primaryResults.map(e => e.id))
      const today = new Date().toISOString().slice(0, 10)
      let modified = false

      // Reactivate accessed engrams
      for (const e of allEngrams) {
        if (resultIds.has(e.id)) {
          e.activation.retrieval_strength = reactivate(e.activation.retrieval_strength)
          e.activation.last_accessed = today
          e.activation.frequency += 1
          modified = true
        }
      }

      // Co-access edge updates: only for top half of results, min 2
      if (results.length >= 2 && (this.config.injection?.co_access !== false)) {
        const topHalf = results.slice(0, Math.max(2, Math.ceil(results.length / 2)))
        const topIds = topHalf.map(e => e.id)

        for (const sourceId of topIds) {
          const source = allEngrams.find(e => e.id === sourceId)
          if (!source) continue

          for (const targetId of topIds) {
            if (targetId === sourceId) continue

            const existing = source.associations.find(
              a => a.type === 'co_accessed' && a.target === targetId
            )

            if (existing) {
              existing.strength = Math.min(0.95, existing.strength + 0.05)
              existing.updated_at = today
              modified = true
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
                modified = true
              }
            }
          }
        }
      }

      if (modified) {
        saveEngrams(this.paths.engrams, allEngrams)
        this._syncIndex()
      }
    })
  }

  /** Scored injection within token budget (BM25 only). Returns formatted strings. */
  inject(task: string, options?: InjectOptions): InjectionResult {
    return this._formatInjection(task, options)
  }

  /** Scored injection with embedding boost when available. Falls back to BM25 if embeddings not installed. */
  async injectHybrid(task: string, options?: InjectOptions): Promise<InjectionResult> {
    // Try to get embedding similarities for all active engrams
    let embeddingBoosts: Map<string, number> | undefined
    try {
      const engrams = this._loadAllEngrams().filter(e => e.status === 'active')
      const results = await embeddingSearch(engrams, task, engrams.length, this.paths.root)
      if (results.length > 0) {
        // Build boost map: rank-based scoring (top result gets 1.0, decays)
        embeddingBoosts = new Map()
        for (let i = 0; i < results.length; i++) {
          embeddingBoosts.set(results[i].id, 1.0 / (1 + i * 0.1))
        }
      }
    } catch {
      // Embeddings unavailable — continue without boosts
    }
    return this._formatInjection(task, options, embeddingBoosts)
  }

  private _formatInjection(task: string, options?: InjectOptions, embeddingBoosts?: Map<string, number>): InjectionResult {
    const engrams = this._loadAllEngrams()
    const packs = loadAllPacks(this.paths.packs)
    const budget = options?.budget ?? this.config.injection_budget ?? 2000

    const result = selectAndSpread(
      {
        prompt: task,
        scope: options?.scope,
        maxTokens: budget,
      },
      engrams,
      packs,
      {
        spread_cap: this.config.injection?.spread_cap,
        spread_budget: this.config.injection?.spread_budget,
      },
      embeddingBoosts,
    )

    const formatEngrams = (wires: typeof result.directives): string => {
      if (wires.length === 0) return ''
      return wires.map(e => `[${e.id}] ${e.statement}`).join('\n')
    }

    const directivesStr = formatEngrams(result.directives)
    const constraintsStr = formatEngrams(result.constraints)
    const considerStr = formatEngrams(result.consider)
    const count = result.directives.length + result.constraints.length + result.consider.length
    const tokensUsed = result.tokens_used.directives + result.tokens_used.consider

    const injected_ids = [
      ...result.directives.map(e => e.id),
      ...result.constraints.map(e => e.id),
      ...result.consider.map(e => e.id),
    ]

    return {
      directives: directivesStr,
      constraints: constraintsStr,
      consider: considerStr,
      count,
      tokens_used: tokensUsed,
      injected_ids,
    }
  }

  /** Update feedback_signals and adjust retrieval_strength. Searches primary, stores, then packs. */
  feedback(id: string, signal: 'positive' | 'negative' | 'neutral'): void {
    // Try primary engrams first
    const found = withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false

      if (!engram.feedback_signals) {
        engram.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
      }
      engram.feedback_signals[signal] += 1

      if (signal === 'positive') {
        engram.activation.retrieval_strength = Math.min(1.0, engram.activation.retrieval_strength + 0.05)
      } else if (signal === 'negative') {
        engram.activation.retrieval_strength = Math.max(0.0, engram.activation.retrieval_strength - 0.1)
      }

      saveEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      return true
    })

    if (found) return

    // Try configured stores (namespaced IDs)
    const storeInfo = this._findEngramStore(id)
    if (storeInfo && storeInfo.path !== this.paths.engrams) {
      if (storeInfo.readonly) {
        throw new Error('Engram is in a readonly store')
      }
      // Must load fresh (not cached) since we're about to mutate and write back
      const storeEngrams = loadEngrams(storeInfo.path)
      const engram = storeEngrams.find(e => e.id === storeInfo.originalId)
      if (engram) {
        if (!engram.feedback_signals) {
          engram.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
        }
        engram.feedback_signals[signal] += 1
        if (signal === 'positive') {
          engram.activation.retrieval_strength = Math.min(1.0, engram.activation.retrieval_strength + 0.05)
        } else if (signal === 'negative') {
          engram.activation.retrieval_strength = Math.max(0.0, engram.activation.retrieval_strength - 0.1)
        }
        saveEngrams(storeInfo.path, storeEngrams)
        // Invalidate cache for this store since we just wrote to it
        this._engramCache.delete(storeInfo.path)
        this._syncIndex()
        return
      }
    }

    // Search pack engrams by scanning pack directories
    this._feedbackPack(id, signal)
  }

  /** Save extracted meta-engrams to the engram store. Skips IDs that already exist. */
  saveMetaEngrams(metas: Engram[]): { saved: number; skipped: number } {
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const existingIds = new Set(engrams.map(e => e.id))
      let saved = 0
      let skipped = 0
      for (const meta of metas) {
        if (existingIds.has(meta.id)) {
          skipped++
        } else {
          engrams.push(meta)
          saved++
        }
      }
      if (saved > 0) {
        saveEngrams(this.paths.engrams, engrams)
        this._syncIndex()
      }
      return { saved, skipped }
    })
  }

  /** Update an existing engram in the store by ID. Returns true if found and updated. */
  updateEngram(updated: Engram): boolean {
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const idx = engrams.findIndex(e => e.id === updated.id)
      if (idx === -1) return false
      engrams[idx] = updated
      saveEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      return true
    })
  }

  /** Set engram status to 'retired'. Supports primary and store engrams. */
  forget(id: string, reason?: string): void {
    // Check primary first
    const foundInPrimary = withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false

      engram.status = 'retired'
      if (reason && !engram.rationale) {
        engram.rationale = `Retired: ${reason}`
      }

      saveEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      return true
    })

    if (foundInPrimary) return

    // Check stores for namespaced IDs
    const storeInfo = this._findEngramStore(id)
    if (storeInfo && storeInfo.path !== this.paths.engrams) {
      if (storeInfo.readonly) {
        throw new Error('Cannot retire engram from readonly store')
      }
      const storeEngrams = loadEngrams(storeInfo.path)
      const engram = storeEngrams.find(e => e.id === storeInfo.originalId)
      if (engram) {
        engram.status = 'retired'
        if (reason && !engram.rationale) {
          engram.rationale = `Retired: ${reason}`
        }
        saveEngrams(storeInfo.path, storeEngrams)
        this._engramCache.delete(storeInfo.path)
        this._syncIndex()
        return
      }
    }

    throw new Error(`Engram not found: ${id}`)
  }

  /** Remove retired engrams from storage. Returns count of removed and remaining. */
  compact(): { removed: number; remaining: number } {
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const active = engrams.filter(e => e.status !== 'retired')
      const removed = engrams.length - active.length
      if (removed > 0) {
        saveEngrams(this.paths.engrams, active)
        this._syncIndex()
      }
      return { removed, remaining: active.length }
    })
  }

  /** Rebuild SQLite index from YAML source of truth. Only works when index: true. */
  reindex(): void {
    if (!this.indexedStorage) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
    this.indexedStorage.reindex()
  }

  /** Sync SQLite index after YAML write (no-op if index disabled) */
  private _syncIndex(): void {
    if (this.indexedStorage) {
      this.indexedStorage.syncFromYaml()
    }
  }

  /** Search packs for an engram by ID and apply feedback, writing back to the pack's engrams.yaml. */
  private _feedbackPack(id: string, signal: 'positive' | 'negative' | 'neutral'): void {
    if (!fs.existsSync(this.paths.packs)) throw new Error(`Engram not found: ${id}`)

    for (const entry of fs.readdirSync(this.paths.packs)) {
      const packDir = `${this.paths.packs}/${entry}`
      if (!fs.statSync(packDir).isDirectory()) continue
      const engramsPath = `${packDir}/engrams.yaml`
      if (!fs.existsSync(engramsPath)) continue

      const engrams = loadEngrams(engramsPath)
      const engram = engrams.find(e => e.id === id)
      if (!engram) continue

      if (!engram.feedback_signals) {
        engram.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
      }
      engram.feedback_signals[signal] += 1

      if (signal === 'positive') {
        engram.activation.retrieval_strength = Math.min(1.0, engram.activation.retrieval_strength + 0.05)
      } else if (signal === 'negative') {
        engram.activation.retrieval_strength = Math.max(0.0, engram.activation.retrieval_strength - 0.1)
      }

      saveEngrams(engramsPath, engrams)
      return
    }

    throw new Error(`Engram not found: ${id}`)
  }

  /** Capture an episodic memory. */
  capture(summary: string, context?: CaptureContext): Episode {
    return captureEpisode(this.paths.episodes, summary, context)
  }

  /** Query the episode timeline. */
  timeline(query?: TimelineQuery): Episode[] {
    return queryTimeline(this.paths.episodes, query)
  }

  /** Rule-based extraction of engram candidates from content. */
  ingest(content: string, options?: IngestOptions): IngestCandidate[] {
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
      for (const candidate of candidates) {
        this.learn(candidate.statement, {
          type: candidate.type,
          scope: options?.scope ?? 'global',
          domain: options?.domain,
          source: candidate.source,
        })
      }
    }

    return candidates
  }

  /** Install a pack from a source path. */
  installPack(source: string): { installed: number; name: string } {
    return installPack(this.paths.packs, source)
  }

  /** Export engrams as a shareable pack. */
  exportPack(
    engrams: Engram[],
    outputDir: string,
    manifest: { name: string; version: string; description?: string; creator?: string },
  ): { path: string; engram_count: number } {
    return exportPack(engrams, outputDir, manifest)
  }

  /** List all installed packs. */
  listPacks(): ReturnType<typeof listPacks> {
    return listPacks(this.paths.packs)
  }

  /** Sync engrams to git. Initializes repo on first call, commits + push/pull on subsequent calls. */
  sync(remote?: string): SyncResult {
    return gitSync(this.paths.root, remote)
  }

  /** Get git sync status without making changes. */
  syncStatus(): SyncStatus {
    return getSyncStatus(this.paths.root)
  }

  /** Return system health info. */
  status(): StatusResult {
    const engrams = this._loadAllEngrams()
    const episodes = queryTimeline(this.paths.episodes)
    const packs = listPacks(this.paths.packs)

    return {
      engram_count: engrams.filter(e => e.status !== 'retired').length,
      episode_count: episodes.length,
      pack_count: packs.length,
      storage_root: this.paths.root,
      config: this.config,
    }
  }

  /** Register an additional engram store. */
  addStore(storePath: string, scope: string, options?: { shared?: boolean; readonly?: boolean }): void {
    const config = loadConfig(this.paths.config)
    const existing = config.stores?.find(s => s.path === storePath)
    if (existing) return // Already registered
    const stores = [...(config.stores ?? []), {
      path: storePath,
      scope,
      shared: options?.shared ?? false,
      readonly: options?.readonly ?? false,
    }]
    // Write updated config
    let configData: Record<string, unknown> = {}
    try {
      const raw = fs.readFileSync(this.paths.config, 'utf8')
      if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
    } catch {}
    configData.stores = stores
    fs.writeFileSync(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }))
    // Reload config
    this.config = loadConfig(this.paths.config)
  }

  /** List all configured stores. */
  listStores(): Array<{ path: string; scope: string; shared: boolean; readonly: boolean; engram_count: number }> {
    const stores = this.config.stores ?? []
    // Always include the primary store
    const primary = {
      path: this.paths.engrams,
      scope: 'global',
      shared: false,
      readonly: false,
      engram_count: this._loadCached(this.paths.engrams).filter(e => e.status !== 'retired').length,
    }
    const additional = stores.map(s => {
      let count = 0
      try { count = this._loadCached(s.path).filter(e => e.status !== 'retired').length } catch {}
      return { ...s, engram_count: count }
    })
    return [primary, ...additional]
  }
}
