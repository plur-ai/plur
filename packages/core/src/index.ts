import { detectPlurStorage, type PlurPaths } from './storage.js'
import { loadConfig } from './config.js'
import { loadEngrams, saveEngrams, generateEngramId, loadAllPacks } from './engrams.js'
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
import { sync as gitSync, getSyncStatus, type SyncResult, type SyncStatus } from './sync.js'
import { detectSecrets } from './secrets.js'
import type { Engram } from './schemas/engram.js'
import type { Episode } from './schemas/episode.js'
import type { PackManifest } from './schemas/pack.js'
import type { PlurConfig } from './schemas/config.js'
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
export type { SyncResult, SyncStatus } from './sync.js'
export { checkForUpdate, getCachedUpdateCheck, clearVersionCache, type VersionCheckResult } from './version-check.js'
export type { Engram } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PackManifest } from './schemas/pack.js'
export type { PlurConfig } from './schemas/config.js'
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

  constructor(options?: { path?: string }) {
    this.paths = detectPlurStorage(options?.path)
    this.config = loadConfig(this.paths.config)
  }

  /** Create engram, detect conflicts, save. Returns the created engram. */
  learn(statement: string, context?: LearnContext): Engram {
    if (!this.config.allow_secrets) {
      const secrets = detectSecrets(statement)
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    const engrams = loadEngrams(this.paths.engrams)
    const id = generateEngramId(engrams)
    const scope = context?.scope ?? 'global'
    const now = new Date().toISOString()

    // Detect conflicts among active engrams in the same scope
    const conflictingEngrams = detectConflicts({ statement, scope }, engrams)
    const conflictIds = conflictingEngrams.map(e => e.id)

    const engram: Engram = {
      id,
      version: 2,
      status: 'active',
      consolidated: false,
      type: context?.type ?? 'behavioral',
      scope,
      visibility: 'private',
      statement,
      source: context?.source,
      domain: context?.domain,
      activation: {
        retrieval_strength: 0.7,
        storage_strength: 1.0,
        frequency: 0,
        last_accessed: now.slice(0, 10),
      },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [],
      associations: [],
      derivation_count: 1,
      tags: [],
      pack: null,
      abstract: null,
      derived_from: null,
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
    return engram
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

  /** List all active engrams, optionally filtered by scope/domain. No search — returns all matches. */
  list(options?: { scope?: string; domain?: string; min_strength?: number }): Engram[] {
    return this._filterEngrams(options)
  }

  /** Filter engrams by scope/domain/strength (shared by both modes) */
  private _filterEngrams(options?: RecallOptions): Engram[] {
    let engrams = loadEngrams(this.paths.engrams)
    engrams = engrams.filter(e => e.status === 'active')
    // Temporal validity: exclude expired or not-yet-valid engrams
    const today = new Date().toISOString().slice(0, 10)
    engrams = engrams.filter(e => {
      if (e.temporal?.valid_until && e.temporal.valid_until < today) return false
      if (e.temporal?.valid_from && e.temporal.valid_from > today) return false
      return true
    })
    if (options?.domain) {
      engrams = engrams.filter(e => e.domain?.startsWith(options.domain!))
    }
    if (options?.min_strength !== undefined) {
      engrams = engrams.filter(e => e.activation.retrieval_strength >= options.min_strength!)
    }
    if (options?.scope) {
      const scope = options.scope
      engrams = engrams.filter(e =>
        e.scope === 'global' || e.scope === scope || e.scope.startsWith(scope)
      )
    }
    return engrams
  }

  /** Reactivate accessed engrams and update co-access associations */
  private _reactivateResults(results: Engram[]): void {
    if (results.length === 0) return
    const allEngrams = loadEngrams(this.paths.engrams)
    const resultIds = new Set(results.map(e => e.id))
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

    if (modified) saveEngrams(this.paths.engrams, allEngrams)
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
      const engrams = loadEngrams(this.paths.engrams).filter(e => e.status === 'active')
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
    const engrams = loadEngrams(this.paths.engrams)
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

    return {
      directives: directivesStr,
      constraints: constraintsStr,
      consider: considerStr,
      count,
      tokens_used: tokensUsed,
    }
  }

  /** Update feedback_signals and adjust retrieval_strength. */
  feedback(id: string, signal: 'positive' | 'negative' | 'neutral'): void {
    const engrams = loadEngrams(this.paths.engrams)
    const engram = engrams.find(e => e.id === id)
    if (!engram) throw new Error(`Engram not found: ${id}`)

    if (!engram.feedback_signals) {
      engram.feedback_signals = { positive: 0, negative: 0, neutral: 0 }
    }
    engram.feedback_signals[signal] += 1

    // Adjust retrieval strength based on feedback
    if (signal === 'positive') {
      engram.activation.retrieval_strength = Math.min(1.0, engram.activation.retrieval_strength + 0.05)
    } else if (signal === 'negative') {
      engram.activation.retrieval_strength = Math.max(0.0, engram.activation.retrieval_strength - 0.1)
    }

    saveEngrams(this.paths.engrams, engrams)
  }

  /** Save extracted meta-engrams to the engram store. Skips IDs that already exist. */
  saveMetaEngrams(metas: Engram[]): { saved: number; skipped: number } {
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
    if (saved > 0) saveEngrams(this.paths.engrams, engrams)
    return { saved, skipped }
  }

  /** Update an existing engram in the store by ID. Returns true if found and updated. */
  updateEngram(updated: Engram): boolean {
    const engrams = loadEngrams(this.paths.engrams)
    const idx = engrams.findIndex(e => e.id === updated.id)
    if (idx === -1) return false
    engrams[idx] = updated
    saveEngrams(this.paths.engrams, engrams)
    return true
  }

  /** Set engram status to 'retired'. */
  forget(id: string, reason?: string): void {
    const engrams = loadEngrams(this.paths.engrams)
    const engram = engrams.find(e => e.id === id)
    if (!engram) throw new Error(`Engram not found: ${id}`)

    engram.status = 'retired'
    if (reason && !engram.rationale) {
      engram.rationale = `Retired: ${reason}`
    }

    saveEngrams(this.paths.engrams, engrams)
  }

  /** Remove retired engrams from storage. Returns count of removed and remaining. */
  compact(): { removed: number; remaining: number } {
    const engrams = loadEngrams(this.paths.engrams)
    const active = engrams.filter(e => e.status !== 'retired')
    const removed = engrams.length - active.length
    if (removed > 0) {
      saveEngrams(this.paths.engrams, active)
    }
    return { removed, remaining: active.length }
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
    const engrams = loadEngrams(this.paths.engrams)
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
}
