import * as fs from 'fs'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import yaml from 'js-yaml'
import { detectPlurStorage, type PlurPaths } from './storage.js'
import { IndexedStorage } from './storage-indexed.js'
import { loadConfig } from './config.js'
import { loadEngrams, saveEngrams, generateEngramId, loadAllPacks, storePrefix } from './engrams.js'
import { logger } from './logger.js'
import { searchEngrams } from './fts.js'
import { selectAndSpread, scoreEngramsPublic, formatWithLayer, assignLayer } from './inject.js'
import { reactivate, applyBatchDecay, type BatchDecayResult } from './decay.js'
import { captureEpisode, queryTimeline } from './episodes.js'
import { agenticSearch } from './agentic-search.js'
import { embeddingSearch, embeddingSearchWithScores, type SimilarityResult } from './embeddings.js'
import { hybridSearch, hybridSearchWithMeta, type HybridSearchResult } from './hybrid-search.js'
import { embedderStatus, resetEmbedder, setEmbeddingsEnabled, type EmbedderStatus } from './embeddings.js'
import { expandedSearch } from './query-expansion.js'
import { recallAuto, type AutoSearchResult } from './search-orchestrator.js'
import { autoSummary } from './summary.js'
import { installPack, uninstallPack, listPacks, exportPack, scanPrivacy, computePackHash, previewPack } from './packs.js'
// SP5 imports (deferred — vault-export, registry not yet merged)
// import { exportVault, type VaultExportOptions, type VaultExportResult } from './vault-export.js'
// import { fetchRegistry, discoverPacks, verifyPackIntegrity, DEFAULT_REGISTRY_URL, type PackRegistry, type RegistryPack } from './registry.js'
import { sync as gitSync, getSyncStatus, withLock, type SyncResult, type SyncStatus } from './sync.js'
import { detectSecrets } from './secrets.js'
import { appendHistory, readHistoryForEngram, generateEventId } from './history.js'
import { computeContentHash } from './content-hash.js'
import { RemoteStore } from './store/remote-store.js'
import type { Engram } from './schemas/engram.js'
import type { Episode } from './schemas/episode.js'
import type { PackManifest } from './schemas/pack.js'
import type { PlurConfig, StoreEntry } from './schemas/config.js'
import type {
  LearnContext,
  LearnAsyncContext,
  LearnAsyncResult,
  LearnBatchResult,
  DedupDecision,
  DedupConfig,
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
export { freshTailBoost } from './fresh-tail.js'
export { autoSummary, generateSummary, needsSummary } from './summary.js'
export { selectModel, selectModelForOperation, resolveOperationTier, type ModelTier, type LlmTierConfig } from './model-routing.js'
export { recallAuto, type AutoSearchResult, type SearchStrategy } from './search-orchestrator.js'
export { generateProfile, getProfileForInjection, loadProfileCache, saveProfileCache, markProfileDirty, profileNeedsRegeneration, type ProfileCache } from './profile.js'
export { formatLayer1, formatLayer2, formatLayer3, formatWithLayer, assignLayer, type InjectionLayer } from './inject.js'
export { appendHistory, readHistory, listHistoryMonths, readHistoryForEngram, generateEventId, type HistoryEvent } from './history.js'
export { applyBatchDecay, strengthToStatus, type BatchDecayResult, type DecayTransition, type BatchDecayOptions } from './decay.js'
export { computeContentHash, normalizeStatement } from './content-hash.js'
export { parseDedupResponse, buildDedupPrompt, buildBatchDedupPrompt } from './dedup.js'
export { runMigrations, rollbackMigrations, getSchemaVersion, setSchemaVersion, ALL_MIGRATIONS, CURRENT_SCHEMA_VERSION, type Migration, type MigrationResult } from './migrations/index.js'
export { detectSecrets } from './secrets.js'
export { detectPlurStorage, type PlurPaths } from './storage.js'
export { IndexedStorage } from './storage-indexed.js'
export { YamlStore, SqliteStore, createStore, migrateStore, type EngramStore, type StorageBackend, type StorageConfig } from './store/index.js'
export { withAsyncLock, asyncAtomicWrite } from './store/index.js'
export type { SimilarityResult } from './embeddings.js'
export type { SyncResult, SyncStatus } from './sync.js'
export { checkForUpdate, getCachedUpdateCheck, clearVersionCache, minorVersionsBehind, type VersionCheckResult } from './version-check.js'
export { CapabilityCanary, type Capability, type CanaryStatus } from './capability-canary.js'
export type { Engram, PreviousVersionRef } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PackManifest } from './schemas/pack.js'
export type { PreviewResult, RegistryEntry, PrivacyScanResult, PrivacyIssue } from './packs.js'
export type { PlurConfig, StoreEntry } from './schemas/config.js'
export type { ManifestSummary, PayloadDescriptor, Producer, Signer, CapsuleHeader, CapsulePreamble } from './schemas/capsule.js'
export {
  CAPSULE_MAGIC,
  CAPSULE_MAGIC_HEX,
  FORMAT_VERSION_V1,
  SUPPORTED_FORMAT_VERSIONS,
  CAPSULE_FLAGS,
  CAPSULE_FLAG_RESERVED_MASK,
  PREAMBLE_LEN,
  CAPSULE_SIZE_LIMITS,
  ED25519_SIG_LEN,
  ManifestSummarySchema,
  PayloadDescriptorSchema,
  ProducerSchema,
  SignerSchema,
  CapsuleHeaderSchema,
  parseCapsulePreamble,
  serializeCapsulePreamble,
  hasFlag,
} from './schemas/capsule.js'
export { writeCapsule, readCapsule, verifyCapsuleIntegrity } from './capsule.js'
export type { WriteCapsuleOptions, ReadCapsuleResult } from './capsule.js'
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
  locked_count?: number
  tension_count?: number
  versioned_engram_count?: number
  outbox_count?: number
}

/** Commitment level scoring multipliers for injection priority (Idea 6). */
export const COMMITMENT_MULTIPLIER: Record<string, number> = {
  locked: 1.0,
  decided: 0.9,
  leaning: 0.7,
  exploring: 0.5,
}

/** Map engram type to default cognitive level (Idea 5). */
const TYPE_TO_COGNITIVE: Record<string, string> = {
  behavioral: 'apply',
  terminological: 'remember',
  procedural: 'apply',
  architectural: 'evaluate',
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
  private _engramCache: Map<string, { mtime: bigint; engrams: Engram[] }> = new Map()
  private _llmFailureCount = 0
  private _llmDisabledUntil: number | null = null

  constructor(options?: { path?: string }) {
    this.paths = detectPlurStorage(options?.path)
    this.config = loadConfig(this.paths.config)
    // Auto-discover project stores from CWD (skips temp dirs for test safety)
    this.autoDiscoverStores()
    // Re-read config after potential store additions
    if (this.config.stores?.length !== loadConfig(this.paths.config).stores?.length) {
      this.config = loadConfig(this.paths.config)
    }
    if (this.config.index) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
    // Wire config-level embeddings opt-out into the embedder module. The env
    // var PLUR_DISABLE_EMBEDDINGS takes precedence at import time; this
    // honors an explicit config override too. Default (undefined or true)
    // leaves embeddings enabled.
    if (this.config.embeddings?.enabled === false) {
      setEmbeddingsEnabled(false, 'embeddings disabled in config.yaml (embeddings.enabled = false)')
    }
    // Auto-purge legacy tension false positives (#156). PR #138 removed all
    // conflict creation from the dedup prompt, so any remaining conflicts are
    // false positives from the old system. Run once, mark with a sentinel file.
    this._autoPurgeLegacyTensions()
  }

  private _autoPurgeLegacyTensions(): void {
    const sentinel = join(this.paths.root, '.tensions-purged')
    if (fs.existsSync(sentinel)) return
    try {
      const result = this.purgeTensions()
      if (result.purged_count > 0) {
        logger.info(`[plur] Auto-purged ${result.purged_count} legacy tension refs from ${result.engrams_modified} engrams across ${result.stores_cleaned} stores`)
      }
      fs.writeFileSync(sentinel, new Date().toISOString() + '\n', 'utf8')
    } catch {
      // Non-fatal — purge will retry next startup
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

    const all: Engram[] = [...primary]
    for (const store of stores) {
      const storeEngrams = store.url
        ? this._loadRemoteCached(store)
        : this._loadCached(store.path!)
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

    // Include pack engrams so they're searchable via recall
    const packs = loadAllPacks(this.paths.packs)
    for (const pack of packs) {
      for (const e of pack.engrams) {
        if (e.status !== 'active') continue
        const cloned = { ...e } as any
        cloned._pack = pack.manifest.name
        all.push(cloned)
      }
    }

    return all
  }

  /** Load engrams from a path with mtime-based caching */
  private _loadCached(path: string): Engram[] {
    let mtime: bigint
    try {
      mtime = fs.statSync(path, { bigint: true }).mtimeNs
    } catch {
      return []
    }
    const cached = this._engramCache.get(path)
    if (cached && cached.mtime === mtime) return cached.engrams
    const engrams = loadEngrams(path)
    this._engramCache.set(path, { mtime, engrams })
    return engrams
  }

  /**
   * Per-instance pool of RemoteStore drivers, keyed by url+scope.
   * RemoteStore holds its own internal TTL cache so repeated load()
   * within ttlMs returns the same array without a network call.
   *
   * Note `_loadAllEngrams` is sync but RemoteStore.load() is async.
   * We bridge that by returning whatever's in the driver's cache
   * synchronously and triggering a background refresh on cache miss.
   * The first call after server start returns [] for that store; the
   * call after the first refresh sees the data. For our pilot this
   * is acceptable — recall is expected to be tried more than once
   * in any real session.
   */
  private _remoteStores = new Map<string, RemoteStore>()
  private _loadRemoteCached(store: StoreEntry): Engram[] {
    const driver = this._getRemoteDriver({ url: store.url!, token: store.token, scope: store.scope })
    // Synchronously read whatever the driver currently has cached.
    // Trigger a refresh in the background; the next call sees fresh data.
    const cached = (driver as unknown as { cache: { engrams: Engram[] } | null }).cache
    void driver.load().catch(() => { /* errors logged inside RemoteStore */ })
    return cached?.engrams ?? []
  }

  /**
   * Write engrams to disk and invalidate the cache for that path.
   *
   * Why: `_loadCached` uses mtime-based invalidation, but on CI tmpfs
   * (ubuntu-latest runners) mtime resolution can be coarse enough that a
   * stat() taken before and after a write returns the same mtime. When that
   * happens the cache serves a pre-write snapshot and a subsequent `getById`
   * returns `undefined` for an engram that `learn()` just created. Explicit
   * invalidation on write removes the filesystem as a source of cache
   * freshness and closes the race. See issue #25.
   */
  private _writeEngrams(path: string, engrams: Engram[]): void {
    saveEngrams(path, engrams)
    this._engramCache.delete(path)
  }

  /** Get or create a RemoteStore driver for a store config entry. */
  private _getRemoteDriver(entry: { url: string; token?: string; scope: string }): RemoteStore {
    const key = `${entry.url}::${entry.scope}`
    let driver = this._remoteStores.get(key)
    if (!driver) {
      driver = new RemoteStore(entry.url, entry.token ?? '', entry.scope)
      this._remoteStores.set(key, driver)
    }
    return driver
  }

  /**
   * Resolve a remote store for a write scope. Returns the RemoteStore driver
   * if the engram's scope matches a registered remote entry, else null.
   *
   * Match rule (pilot scope): exact-match `entry.scope === engramScope`. We
   * intentionally don't do prefix-match yet — agents that want to write to a
   * narrower scope than they registered must explicitly register the narrower
   * scope. Keeps routing predictable and prevents accidental cross-team writes.
   */
  private _resolveRemoteStoreForScope(scope: string): RemoteStore | null {
    const stores = this.config.stores ?? []
    for (const entry of stores) {
      if (!entry.url) continue
      if (entry.readonly === true) continue
      if (entry.scope !== scope) continue
      return this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
    }
    return null
  }

  /** Find which store owns an engram by ID. For namespaced IDs, strips prefix to find in store. */
  private _findEngramStore(id: string): { path: string; readonly: boolean; originalId: string } | null {
    // Check primary first (uses mtime cache)
    const primaryEngrams = this._loadCached(this.paths.engrams)
    if (primaryEngrams.find(e => e.id === id)) {
      return { path: this.paths.engrams, readonly: false, originalId: id }
    }

    // Check stores — ID might be namespaced. Remote stores are skipped
    // here because remote IDs are not namespaced (the remote PLUR
    // Enterprise server assigns its own IDs); writes to remote stores
    // go through their own path.
    const stores = this.config.stores ?? []
    for (const store of stores) {
      if (!store.path) continue
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

  /** Content hash fast-path dedup. Scope-aware: same statement in a different scope is a promotion, not a duplicate. */
  private _hashDedup(statement: string, engrams: Engram[], scope?: string): Engram | null {
    const hash = computeContentHash(statement)
    for (const e of engrams) {
      if (e.status === 'active' && (e as any).content_hash === hash) {
        if (scope === undefined || e.scope === scope) return e
      }
    }
    return null
  }

  private _isLlmDedupAvailable(): boolean {
    if (this._llmDisabledUntil !== null) {
      if (Date.now() < this._llmDisabledUntil) return false
      this._llmDisabledUntil = null
      this._llmFailureCount = 0
    }
    return true
  }

  private _recordLlmFailure(): void {
    this._llmFailureCount++
    if (this._llmFailureCount >= 3) {
      this._llmDisabledUntil = Date.now() + 60 * 60 * 1000
      logger.warning('LLM dedup circuit breaker tripped — disabled for 1 hour')
    }
  }

  private _recordLlmSuccess(): void { this._llmFailureCount = 0 }

  /** Create engram with content hash + commitment + cognitive level.
   * Fast-path hash dedup returns existing on exact match.
   */
  learn(statement: string, context?: LearnContext): Engram {
    if (!this.config.allow_secrets) {
      const secrets = detectSecrets(statement)
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const allEngrams = this._loadAllEngrams()

      const scope = context?.scope ?? 'global'

      // Idea 29: Content hash fast-path dedup (scope-aware — issue #136)
      const hashMatch = this._hashDedup(statement, allEngrams, scope)
      if (hashMatch) return hashMatch

      const id = generateEngramId(allEngrams)
      const now = new Date().toISOString()
      const type = context?.type ?? 'behavioral'
      const cogLevel = TYPE_TO_COGNITIVE[type] ?? 'remember'
      const commitment = context?.commitment ?? 'leaning'

      const conflictIds: string[] = []

      // Auto-set memory_class based on type if not explicitly provided (SP2 Idea 3)
      const TYPE_TO_MEMORY_CLASS: Record<string, 'semantic' | 'episodic' | 'procedural' | 'metacognitive'> = {
        behavioral: 'semantic',
        terminological: 'semantic',
        procedural: 'procedural',
        architectural: 'semantic',
      }
      const engramType = context?.type ?? 'behavioral'
      const memoryClass = context?.memory_class ?? TYPE_TO_MEMORY_CLASS[engramType] ?? 'semantic'

      // Auto-link to session episode if provided (SP2 Idea 24)
      const episodeIds: string[] = []
      if (context?.session_episode_id) {
        episodeIds.push(context.session_episode_id)
      }

      const engram: Engram = {
        id,
        version: 2,
        status: 'active',
        consolidated: false,
        type,
        scope,
        visibility: context?.visibility ?? (context?.domain ? 'public' : 'private'),
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
        dual_coding: context?.dual_coding,
        polarity: null,
        content_hash: computeContentHash(statement),
        commitment,
        locked_at: commitment === 'locked' ? now : undefined,
        locked_reason: commitment === 'locked' ? context?.locked_reason : undefined,
        summary: autoSummary(statement, undefined),
        engram_version: 1,
        episode_ids: episodeIds ?? [],
        relations: conflictIds.length > 0 ? {
          broader: [],
          narrower: [],
          related: [],
          conflicts: conflictIds,
        } : undefined,
        pinned: context?.pinned === true ? true : undefined,
      }

      // Multi-store routing (issue #26 outbox pattern): if the engram's
      // scope matches a writable remote store, save locally with outbox
      // metadata first (durable from this point), then fire-and-forget the
      // remote push. On success the local copy is removed asynchronously;
      // on failure it stays in the outbox for retry at next session start
      // or plur_sync.
      const remoteDriver = this._resolveRemoteStoreForScope(scope)
      if (remoteDriver && context?.visibility === 'private') {
        // Private engrams stay local — sending to a shared remote contradicts
        // the "only I see this" semantics. See: https://github.com/plur-ai/plur/issues/90
        logger.warning(`[plur:learn] private engram not routed to remote (scope=${scope}), writing locally`)
      } else if (remoteDriver) {
        const storeEntry = (this.config.stores ?? []).find(s => s.url && s.scope === scope && !s.readonly)
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _outbox: {
            target_url: storeEntry!.url!,
            target_scope: scope,
            queued_at: now,
            last_attempt: now,
            attempt_count: 0,
            last_error: '',
          },
        }
        engrams.push(engram)
        this._writeEngrams(this.paths.engrams, engrams)
        this._syncIndex()

        // Fire-and-forget: attempt immediate push, clean up on success
        void (async () => {
          try {
            await remoteDriver.append(engram)
            // Success: remove outbox entry from local store
            withLock(this.paths.engrams, () => {
              const fresh = loadEngrams(this.paths.engrams)
              const idx = fresh.findIndex(e => e.id === engram.id)
              if (idx !== -1) {
                fresh.splice(idx, 1)
                this._writeEngrams(this.paths.engrams, fresh)
                this._syncIndex()
              }
            })
          } catch (err) {
            // Already saved locally with outbox metadata — will be retried
            logger.warning(`[plur:outbox] immediate push failed for ${engram.id}, queued for retry: ${(err as Error).message}`)
            withLock(this.paths.engrams, () => {
              const fresh = loadEngrams(this.paths.engrams)
              const target = fresh.find(e => e.id === engram.id) as any
              if (target?.structured_data?._outbox) {
                target.structured_data._outbox.last_error = (err as Error).message
                target.structured_data._outbox.attempt_count = 1
                this._writeEngrams(this.paths.engrams, fresh)
              }
            })
          }
        })()

        appendHistory(this.paths.root, {
          event: 'engram_created',
          engram_id: engram.id,
          timestamp: now,
          data: { type: engram.type, scope: engram.scope, source: engram.source, routed_to: 'remote', outbox: true },
        })
        return engram
      }

      engrams.push(engram)
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      appendHistory(this.paths.root, {
        event: 'engram_created',
        engram_id: engram.id,
        timestamp: now,
        data: { type: engram.type, scope: engram.scope, source: engram.source },
      })
      return engram
    })
  }

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
  async learnRouted(statement: string, context?: LearnContext): Promise<Engram> {
    if (!this.config.allow_secrets) {
      const secrets = detectSecrets(statement)
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    const scope = context?.scope ?? 'global'
    const remoteDriver = this._resolveRemoteStoreForScope(scope)
    if (!remoteDriver) {
      // Local route — sync learn() owns dedup, build, write, history.
      return this.learn(statement, context)
    }
    // Remote route — dedup against the merged local+cached-remote view,
    // then POST and merge the server-assigned ID into the local engram
    // representation we hand back to the caller. On failure, save to
    // local outbox for retry (issue #26).
    const allEngrams = this._loadAllEngrams()
    const hashMatch = this._hashDedup(statement, allEngrams, scope)
    if (hashMatch) return hashMatch
    const now = new Date().toISOString()
    const localPlaceholder = this._buildEngramShape(statement, scope, context, now)
    try {
      const { id: serverId } = await remoteDriver.appendAndGetServerId(localPlaceholder)
      const serverEngram: Engram = { ...localPlaceholder, id: serverId }
      appendHistory(this.paths.root, {
        event: 'engram_created',
        engram_id: serverId,
        timestamp: now,
        data: { type: serverEngram.type, scope: serverEngram.scope, source: serverEngram.source, routed_to: 'remote' },
      })
      return serverEngram
    } catch (err) {
      // Remote failed — save locally with outbox metadata for retry
      const storeEntry = (this.config.stores ?? []).find(s => s.url && s.scope === scope && !s.readonly)
      return withLock(this.paths.engrams, () => {
        const engrams = loadEngrams(this.paths.engrams)
        // Replace placeholder ID with a real local ID
        localPlaceholder.id = generateEngramId([...engrams, ...allEngrams])
        ;(localPlaceholder as any).structured_data = {
          ...((localPlaceholder as any).structured_data ?? {}),
          _outbox: {
            target_url: storeEntry!.url!,
            target_scope: scope,
            queued_at: now,
            last_attempt: now,
            attempt_count: 1,
            last_error: (err as Error).message,
          },
        }
        engrams.push(localPlaceholder)
        this._writeEngrams(this.paths.engrams, engrams)
        this._syncIndex()
        appendHistory(this.paths.root, {
          event: 'engram_created',
          engram_id: localPlaceholder.id,
          timestamp: now,
          data: { type: localPlaceholder.type, scope, source: localPlaceholder.source, routed_to: 'outbox', error: (err as Error).message },
        })
        logger.warning(`[plur:outbox] remote write failed for ${localPlaceholder.id}, queued for retry: ${(err as Error).message}`)
        return localPlaceholder
      })
    }
  }

  /**
   * Build an Engram object without persisting it. Used by learnRouted to
   * give callers a fully-shaped Engram with the server's ID after the
   * remote POST completes. Mirrors the construction in learn() but
   * doesn't acquire the lock or touch disk.
   */
  private _buildEngramShape(statement: string, scope: string, context: LearnContext | undefined, now: string): Engram {
    const type = context?.type ?? 'behavioral'
    const cogLevel = TYPE_TO_COGNITIVE[type] ?? 'remember'
    const TYPE_TO_MEMORY_CLASS: Record<string, 'semantic' | 'episodic' | 'procedural' | 'metacognitive'> = {
      behavioral: 'semantic',
      terminological: 'semantic',
      procedural: 'procedural',
      architectural: 'semantic',
    }
    const memoryClass = context?.memory_class ?? TYPE_TO_MEMORY_CLASS[type] ?? 'semantic'
    const commitment = context?.commitment ?? 'leaning'
    return {
      // Placeholder id — overwritten by the server's assigned id before return.
      // Any consumer that observes this id directly (rather than via learnRouted's
      // return value) is doing it wrong — log says so.
      id: '__pending__',
      version: 2,
      status: 'active',
      consolidated: false,
      type,
      scope,
      visibility: context?.visibility ?? (context?.domain ? 'public' : 'private'),
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
      dual_coding: context?.dual_coding,
      polarity: null,
      content_hash: computeContentHash(statement),
      commitment,
      locked_at: commitment === 'locked' ? now : undefined,
      locked_reason: commitment === 'locked' ? context?.locked_reason : undefined,
      summary: autoSummary(statement, undefined),
      engram_version: 1,
      episode_ids: context?.session_episode_id ? [context.session_episode_id] : [],
      pinned: context?.pinned === true ? true : undefined,
    }
  }

  /** Build deps for learn-async module. */
  private _learnAsyncDeps() {
    return {
      hashDedup: (statement: string, scope?: string) => this._hashDedup(statement, this._loadAllEngrams(), scope),
      recallHybrid: (query: string, options?: { limit?: number }) => this.recallHybrid(query, options),
      recall: (query: string, options?: { limit?: number }) => this.recall(query, options),
      learn: (statement: string, context?: LearnContext) => this.learn(statement, context),
      getById: (id: string) => this.getById(id),
      engramsPath: this.paths.engrams,
      rootPath: this.paths.root,
      dedupConfig: this.config.dedup ?? {},
      isLlmAvailable: () => this._isLlmDedupAvailable(),
      recordLlmSuccess: () => this._recordLlmSuccess(),
      recordLlmFailure: () => this._recordLlmFailure(),
      syncIndex: () => this._syncIndex(),
    }
  }

  /** Async learn with LLM-driven deduplication (Ideas 1+2+19). */
  async learnAsync(statement: string, context?: LearnAsyncContext): Promise<LearnAsyncResult> {
    const { learnAsync: learnAsyncImpl } = await import('./learn-async.js')
    return learnAsyncImpl(this._learnAsyncDeps(), statement, context)
  }

  /** Batch learn with LLM dedup. */
  async learnBatch(
    statements: Array<{ statement: string; context?: LearnAsyncContext }>,
    llm?: LlmFunction,
  ): Promise<LearnBatchResult> {
    const { learnBatch: learnBatchImpl } = await import('./learn-async.js')
    return learnBatchImpl(this._learnAsyncDeps(), statements, llm)
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

  /**
   * Hybrid search with diagnostic metadata — returns both the engrams and
   * whether embeddings actually contributed (mode: "hybrid" vs "hybrid-degraded").
   * Use this when you want to surface degraded-mode warnings to users.
   */
  async recallHybridWithMeta(
    query: string,
    options?: Omit<RecallOptions, 'mode' | 'llm'>,
  ): Promise<HybridSearchResult> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const result = await hybridSearchWithMeta(filtered, query, limit, this.paths.root)
    this._reactivateResults(result.engrams)
    return result
  }

  /** Inspect embedder availability without forcing a load. */
  embedderStatus(): EmbedderStatus {
    return embedderStatus()
  }

  /** Reset cached embedder failure state — next call will retry the model load. */
  resetEmbedder(): void {
    resetEmbedder()
  }

  /** Embedding search returning {engram, score}[] with cosine similarity scores. Async, no API calls. */
  async similaritySearch(
    query: string,
    options?: { limit?: number; scope?: string; domain?: string },
  ): Promise<SimilarityResult[]> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    return embeddingSearchWithScores(filtered, query, limit, this.paths.root)
  }

  /** Expanded search: LLM query expansion + hybrid search + RRF merge. Opt-in, requires LLM function. */
  async recallExpanded(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await expandedSearch(filtered, query, limit, options.llm, this.paths.root)
    this._reactivateResults(results)
    return results
  }

  async recallAutoSearch(query: string, options?: RecallOptions): Promise<AutoSearchResult> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const result = await recallAuto(filtered, query, limit, this.paths.root, options?.llm)
    this._reactivateResults(result.results)
    return result
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
      (e as any)._originalId || /^(ENG|ABS|META)-[A-Z]{3}-/.test(e.id)
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
        this._writeEngrams(this.paths.engrams, allEngrams)
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
    // Use actual cosine similarity scores as boosts so the 0.5 threshold in
    // selectAndSpread is meaningful. (Pre-0.9.4 used rank-based 1/(1+i*0.1)
    // which gave the top result boost=1.0 even when its cosine was 0.4 —
    // letting unrelated short sentences leak through once embeddings actually
    // started running.)
    let embeddingBoosts: Map<string, number> | undefined
    try {
      const engrams = this._loadAllEngrams().filter(e => e.status === 'active')
      const results: SimilarityResult[] = await embeddingSearchWithScores(
        engrams,
        task,
        engrams.length,
        this.paths.root,
      )
      if (results.length > 0) {
        embeddingBoosts = new Map()
        for (const r of results) {
          embeddingBoosts.set(r.engram.id, r.score)
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

    const directivesStr = formatWithLayer(result.directives, assignLayer('directives'))
    const constraintsStr = formatWithLayer(result.constraints, assignLayer('constraints'))
    const considerStr = formatWithLayer(result.consider, assignLayer('consider'))
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
  async feedback(id: string, signal: 'positive' | 'negative' | 'neutral'): Promise<void> {
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
        // Idea 6: Positive feedback promotes commitment level
        const e = engram as any
        if (e.commitment === 'exploring') e.commitment = 'leaning'
        else if (e.commitment === 'leaning') e.commitment = 'decided'
      } else if (signal === 'negative') {
        engram.activation.retrieval_strength = Math.max(0.0, engram.activation.retrieval_strength - 0.1)
      }

      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      appendHistory(this.paths.root, {
        event: 'feedback_received',
        engram_id: id,
        timestamp: new Date().toISOString(),
        data: { signal },
      })
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
        this._writeEngrams(storeInfo.path, storeEngrams)
        this._syncIndex()
        return
      }
    }

    // Check remote stores — the engram may live on an enterprise server.
    // See: https://github.com/plur-ai/plur/issues/85
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      if (entry.readonly === true) {
        const roDriver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        const roFound = await roDriver.getById(id)
        if (roFound) throw new Error('Engram is in a readonly store')
        continue
      }
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      const found = await driver.getById(id)
      if (found) {
        await driver.feedback(id, signal)
        appendHistory(this.paths.root, {
          event: 'feedback_received',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { signal, routed_to: 'remote' },
        })
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
        this._writeEngrams(this.paths.engrams, engrams)
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
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      return true
    })
  }

  /**
   * Toggle the always-load (pinned) flag for an engram.
   * Returns the updated engram on success, null if not found.
   */
  setPinned(id: string, pinned: boolean): Engram | null {
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const idx = engrams.findIndex(e => e.id === id)
      if (idx === -1) return null
      const e = engrams[idx]
      const updated: Engram = { ...e, pinned: pinned === true ? true : undefined }
      engrams[idx] = updated
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      return updated
    })
  }

  /** List engrams that have pinned: true. */
  listPinned(): Engram[] {
    const all = this._loadAllEngrams()
    return all.filter(e => (e as any).pinned === true && e.status === 'active')
  }

  /** Set engram status to 'retired'. Supports primary and store engrams. */
  async forget(id: string, reason?: string): Promise<void> {
    // Check primary first
    const foundInPrimary = withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false

      engram.status = 'retired'
      if (reason && !engram.rationale) {
        engram.rationale = `Retired: ${reason}`
      }

      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      appendHistory(this.paths.root, {
        event: 'engram_retired',
        engram_id: id,
        timestamp: new Date().toISOString(),
        data: { reason: reason ?? null },
      })
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
        this._writeEngrams(storeInfo.path, storeEngrams)
        this._syncIndex()
        return
      }
    }

    // Check remote stores — the engram may live on an enterprise server.
    // See: https://github.com/plur-ai/plur/issues/84
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      if (entry.readonly === true) {
        // Check if the engram exists here before throwing, so readonly
        // errors are specific ("cannot retire from readonly") not generic.
        const roDriver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        const roFound = await roDriver.getById(id)
        if (roFound) throw new Error('Cannot retire engram from readonly store')
        continue
      }
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      const found = await driver.getById(id)
      if (found) {
        const removed = await driver.remove(id)
        if (removed) {
          appendHistory(this.paths.root, {
            event: 'engram_retired',
            engram_id: id,
            timestamp: new Date().toISOString(),
            data: { reason: reason ?? null, routed_to: 'remote' },
          })
          return
        }
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
        this._writeEngrams(this.paths.engrams, active)
        this._syncIndex()
      }
      return { removed, remaining: active.length }
    })
  }

  /**
   * Apply ACT-R decay to all primary store engrams.
   * Scope-matched engrams are skipped, status transitions logged to history.
   * Modified engrams are saved back to the store.
   */
  batchDecay(options?: { contextScope?: string; lambda?: number; now?: Date }): BatchDecayResult {
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const { result, modified } = applyBatchDecay(engrams, this.paths.root, options)

      // Save modified engrams back (not the original unmodified list).
      // Only primary store engrams are decayed — store/pack engrams are maintained
      // by their respective store owners and are typically readonly.
      if (result.transitions.length > 0) {
        this._writeEngrams(this.paths.engrams, modified)
        this._syncIndex()
      }

      return result
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

  /** Preview a pack before installing — shows manifest, engrams, and security scan. */
  previewPack(source: string): ReturnType<typeof previewPack> {
    return previewPack(source)
  }

  /** Install a pack from a source path. Runs security scan (blocks on secrets), detects conflicts, records in registry. */
  installPack(source: string): ReturnType<typeof installPack> {
    const existing = this._loadAllEngrams()
    return installPack(this.paths.packs, source, existing)
  }

  /** Uninstall a pack by name. */
  uninstallPack(name: string): ReturnType<typeof uninstallPack> {
    return uninstallPack(this.paths.packs, name)
  }

  /** Export engrams as a shareable pack with privacy scanning and integrity hash. */
  exportPack(
    engrams: Engram[],
    outputDir: string,
    manifest: { name: string; version: string; description?: string; creator?: string },
  ): ReturnType<typeof exportPack> {
    return exportPack(engrams, outputDir, manifest)
  }

  /** List all installed packs (with integrity hashes). */
  listPacks(): ReturnType<typeof listPacks> {
    return listPacks(this.paths.packs)
  }

  // SP5 methods (deferred — vault-export, registry not yet merged)
  // exportToVault, discoverPacks, getRegistryUrl will be added when SP5 merges

  /** Get the PLUR storage root path. */
  getStorageRoot(): string {
    return this.paths.root
  }

  /** Sync engrams to git. Initializes repo on first call, commits + push/pull on subsequent calls. */
  sync(remote?: string): SyncResult {
    return gitSync(this.paths.root, remote)
  }

  /** Get git sync status without making changes. */
  syncStatus(): SyncStatus {
    return getSyncStatus(this.paths.root)
  }

  /** Count engrams pending remote sync (outbox entries). */
  outboxCount(): number {
    const engrams = this._loadCached(this.paths.engrams)
    return engrams.filter(e => (e as any).structured_data?._outbox).length
  }

  /**
   * Flush the outbox — retry pushing pending engrams to their target remote
   * stores. Called automatically on session_start and plur_sync.
   *
   * On success: removes the local copy (remote is source of truth).
   * On failure: updates attempt metadata for next retry.
   * After 7 days: includes warning in expired_warnings.
   */
  async flushOutbox(): Promise<{ flushed: number; failed: number; expired_warnings: string[] }> {
    const engrams = loadEngrams(this.paths.engrams)
    const pending = engrams.filter(e => (e as any).structured_data?._outbox)
    if (pending.length === 0) return { flushed: 0, failed: 0, expired_warnings: [] }

    let flushed = 0
    let failed = 0
    const expired_warnings: string[] = []
    const now = new Date()
    const TTL_MS = 7 * 24 * 60 * 60 * 1000

    for (const engram of pending) {
      const outbox = (engram as any).structured_data._outbox as {
        target_url: string; target_scope: string; queued_at: string
        last_attempt: string; attempt_count: number; last_error: string
      }

      // Check TTL warning
      const ageMs = now.getTime() - new Date(outbox.queued_at).getTime()
      if (ageMs > TTL_MS) {
        expired_warnings.push(
          `${engram.id} queued ${outbox.queued_at} (${Math.floor(ageMs / 86400000)}d ago) — consider manual resolution`
        )
      }

      // Resolve remote driver from current config (don't store tokens in outbox)
      const storeEntry = (this.config.stores ?? []).find(
        s => s.url && s.scope === outbox.target_scope && !s.readonly
      )
      if (!storeEntry) {
        expired_warnings.push(`${engram.id}: no matching remote store for scope ${outbox.target_scope}`)
        failed++
        continue
      }
      const driver = this._getRemoteDriver({ url: storeEntry.url!, token: storeEntry.token, scope: storeEntry.scope })

      // Build clean copy without outbox metadata for the remote
      const cleanEngram = { ...engram } as any
      const sd = { ...(cleanEngram.structured_data ?? {}) }
      delete sd._outbox
      if (Object.keys(sd).length === 0) {
        delete cleanEngram.structured_data
      } else {
        cleanEngram.structured_data = sd
      }

      try {
        await driver.appendAndGetServerId(cleanEngram)
        // Success: remove from local store
        const idx = engrams.findIndex(e => e.id === engram.id)
        if (idx !== -1) engrams.splice(idx, 1)
        flushed++
        appendHistory(this.paths.root, {
          event: 'engram_created',
          engram_id: engram.id,
          timestamp: now.toISOString(),
          data: { routed_to: 'remote', outbox_flush: true, scope: engram.scope },
        })
      } catch (err) {
        outbox.last_attempt = now.toISOString()
        outbox.attempt_count += 1
        outbox.last_error = (err as Error).message
        failed++
        logger.warning(`[plur:outbox] retry failed for ${engram.id}: ${(err as Error).message}`)
      }
    }

    // Write back changes (removals + updated outbox metadata)
    if (flushed > 0 || failed > 0) {
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
    }

    return { flushed, failed, expired_warnings }
  }

  /**
   * Promote an episode to an episodic engram (SP2 Idea 3).
   * Creates a new engram with memory_class='episodic' from an episode's summary.
   */
  episodeToEngram(episodeId: string, context?: Omit<LearnContext, 'memory_class'>): Engram {
    const episodes = queryTimeline(this.paths.episodes)
    const episode = episodes.find(e => e.id === episodeId)
    if (!episode) throw new Error(`Episode not found: ${episodeId}`)

    const engram = this.learn(episode.summary, {
      ...context,
      type: context?.type ?? 'behavioral',
      source: context?.source ?? `episode:${episodeId}`,
      memory_class: 'episodic',
      session_episode_id: episodeId,
    })

    appendHistory(this.paths.root, {
      event: 'engram_promoted',
      engram_id: engram.id,
      timestamp: new Date().toISOString(),
      data: { from_episode: episodeId },
    })

    return engram
  }

  /**
   * Get history events for a specific engram (SP2 Idea 7).
   * Returns all events across all months for the given engram ID.
   */
  getEngramHistory(engramId: string): import('./history.js').HistoryEvent[] {
    return readHistoryForEngram(this.paths.root, engramId)
  }

  /**
   * Report a failure for a procedural engram (SP2 Idea 18).
   * If LLM is provided, generates an improved procedure and updates the engram.
   * Without LLM, logs the failure without rewriting.
   * Returns the updated engram and the failure episode.
   */
  async reportFailure(
    engramId: string,
    failureContext: string,
    llm?: LlmFunction,
  ): Promise<{ engram: Engram; episode: Episode; evolved: boolean }> {
    const engram = this.getById(engramId)
    if (!engram) throw new Error(`Engram not found: ${engramId}`)

    // Only procedural engrams can evolve
    const memClass = (engram as any).knowledge_type?.memory_class
    if (memClass !== 'procedural' && engram.type !== 'procedural') {
      throw new Error(`Only procedural engrams can evolve. This engram has type=${engram.type}, memory_class=${memClass}`)
    }

    // Rate limiting: max 3 revisions per procedure per 24h
    const history = readHistoryForEngram(this.paths.root, engramId)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const recentEvolutions = history.filter(
      e => e.event === 'procedure_evolved' && e.timestamp > dayAgo
    )
    if (recentEvolutions.length >= 3) {
      throw new Error(`Rate limit: engram ${engramId} has been evolved ${recentEvolutions.length} times in the last 24h (max 3)`)
    }

    // Create failure episode
    const episode = this.capture(`Failure report for ${engramId}: ${failureContext}`, {
      tags: ['failure', 'procedure-evolution'],
    })

    // Log the failure event
    const failureEventId = generateEventId()
    appendHistory(this.paths.root, {
      event: 'failure_reported',
      engram_id: engramId,
      timestamp: new Date().toISOString(),
      data: { failure_context: failureContext, episode_id: episode.id, event_id: failureEventId },
    })

    // Try to evolve the procedure with LLM
    let evolved = false
    if (llm) {
      try {
        const prompt = `You are improving a procedural memory based on a failure report.

Current procedure: "${engram.statement}"
Failure report: "${failureContext}"
${recentEvolutions.length > 0 ? `\nPrevious revisions in last 24h: ${recentEvolutions.length}` : ''}

Generate an improved version of the procedure that prevents this failure. Return ONLY the improved procedure statement, nothing else.`

        const improved = await llm(prompt)
        if (improved && improved.trim().length > 0) {
          const eventId = generateEventId()
          const now = new Date().toISOString()

          // Update engram with new statement
          return withLock(this.paths.engrams, () => {
            const engrams = loadEngrams(this.paths.engrams)
            const idx = engrams.findIndex(e => e.id === engramId)
            if (idx === -1) throw new Error(`Engram not found in store: ${engramId}`)

            const raw = engrams[idx] as any
            const oldStatement = raw.statement
            const oldVersion = raw.engram_version ?? 1

            raw.statement = improved.trim()
            raw.engram_version = oldVersion + 1
            raw.previous_version_ref = { event_id: eventId, changed_at: now }
            if (!raw.episode_ids) raw.episode_ids = []
            raw.episode_ids.push(episode.id)

            this._writeEngrams(this.paths.engrams, engrams)
            this._syncIndex()

            appendHistory(this.paths.root, {
              event: 'procedure_evolved',
              engram_id: engramId,
              timestamp: now,
              data: {
                event_id: eventId,
                old_statement: oldStatement,
                new_statement: improved.trim(),
                old_version: oldVersion,
                new_version: oldVersion + 1,
                failure_context: failureContext,
                failure_episode_id: episode.id,
              },
            })

            evolved = true
            return { engram: engrams[idx], episode, evolved }
          })
        }
      } catch {
        // LLM failed — fallback: log without rewriting
      }
    }

    // Fallback: link failure episode to engram without rewriting
    withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const idx = engrams.findIndex(e => e.id === engramId)
      if (idx !== -1) {
        const raw = engrams[idx] as any
        if (!raw.episode_ids) raw.episode_ids = []
        raw.episode_ids.push(episode.id)
        this._writeEngrams(this.paths.engrams, engrams)
        this._syncIndex()
      }
    })

    const updated = this.getById(engramId)
    return { engram: updated ?? engram, episode, evolved }
  }

  /** Return system health info. */
  status(): StatusResult {
    const engrams = this._loadAllEngrams()
    const episodes = queryTimeline(this.paths.episodes)
    const packs = listPacks(this.paths.packs)

    const active = engrams.filter(e => e.status !== 'retired')
    const lockedCount = active.filter(e => (e as any).commitment === 'locked').length
    const tensionPairs = new Set<string>()
    for (const e of active) {
      if (!e.relations?.conflicts?.length) continue
      for (const cid of e.relations.conflicts) {
        tensionPairs.add([e.id, cid].sort().join(':'))
      }
    }

    // Count engrams with version > 1 (SP2 Idea 8)
    const versionedCount = engrams.filter(e => {
      const raw = e as any
      return (raw.engram_version ?? 1) > 1
    }).length

    return {
      engram_count: active.length,
      episode_count: episodes.length,
      pack_count: packs.length,
      storage_root: this.paths.root,
      config: this.config,
      locked_count: lockedCount,
      tension_count: tensionPairs.size,
      versioned_engram_count: versionedCount,
      outbox_count: this.outboxCount(),
    }
  }

  /**
   * Remove all conflict relations from every local engram.
   * Used after tension-detection redesign to clear accumulated false positives.
   */
  purgeTensions(): { purged_count: number; engrams_modified: number; stores_cleaned: number } {
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
        const engrams = this._loadCached(storePath)
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
          this._writeEngrams(storePath, engrams)
          storesCleaned++
        }
      } catch {
        // Store file missing or unreadable — skip
      }
    }
    return { purged_count: purgedCount, engrams_modified: modified, stores_cleaned: storesCleaned }
  }

  /**
   * Register an additional engram store.
   *
   * Two shapes — exactly one of `pathOrUrl` semantics applies:
   *   - filesystem (default): pass a path. `options.url` undefined.
   *   - remote (PLUR Enterprise / any compatible REST API):
   *     pass any string for the first arg (it goes into a slot we
   *     never read), set `options.url` + `options.token`.
   *
   * Backwards compatible: existing call sites that pass a filesystem
   * path keep working.
   */
  addStore(
    storePath: string,
    scope: string,
    options?: { shared?: boolean; readonly?: boolean; url?: string; token?: string },
  ): void {
    const config = loadConfig(this.paths.config)
    const isRemote = Boolean(options?.url)
    const dedupKey = isRemote ? options!.url : storePath
    const existing = config.stores?.find(s => (isRemote ? s.url === dedupKey : s.path === dedupKey))
    if (existing) return
    const newEntry: StoreEntry = isRemote
      ? {
          url:      options!.url!,
          token:    options!.token,
          scope,
          shared:   options?.shared   ?? true,    // remote stores are shared by definition
          readonly: options?.readonly ?? false,
        }
      : {
          path:     storePath,
          scope,
          shared:   options?.shared   ?? false,
          readonly: options?.readonly ?? false,
        }
    const stores = [...(config.stores ?? []), newEntry]
    let configData: Record<string, unknown> = {}
    try {
      const raw = fs.readFileSync(this.paths.config, 'utf8')
      if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
    } catch {}
    configData.stores = stores
    fs.writeFileSync(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }))
    this.config = loadConfig(this.paths.config)
  }

  /**
   * Auto-discover .plur/engrams.yaml in CWD and parent dirs (up to git root).
   * If found and not already registered, auto-register as a project store.
   * Returns list of newly discovered stores (empty if none found or all already known).
   */
  autoDiscoverStores(cwd?: string): Array<{ path: string; scope: string }> {
    const startDir = cwd || process.cwd()
    const discovered: Array<{ path: string; scope: string }> = []

    // Skip discovery if Plur storage is in a temp directory (test scenario)
    const tmpDir = tmpdir()
    if (this.paths.root.startsWith(tmpDir) || this.paths.root.startsWith('/tmp/')) {
      return discovered
    }

    const knownPaths = new Set((this.config.stores ?? []).map(s => s.path))
    // Also exclude the primary store directory
    const primaryDir = dirname(this.paths.engrams)

    let dir = startDir
    const visited = new Set<string>()

    while (dir && !visited.has(dir)) {
      visited.add(dir)
      const candidate = join(dir, '.plur', 'engrams.yaml')

      // Skip primary store
      if (join(dir, '.plur') === primaryDir) {
        dir = dirname(dir)
        continue
      }

      if (fs.existsSync(candidate) && !knownPaths.has(candidate)) {
        // Infer scope from directory name or git remote
        let scope = `project:${basename(dir)}`
        try {
          // Try .plur.yaml for explicit scope
          const plurYaml = join(dir, '.plur.yaml')
          if (fs.existsSync(plurYaml)) {
            const raw = yaml.load(fs.readFileSync(plurYaml, 'utf8')) as any
            if (raw?.scope) scope = raw.scope
          }
        } catch {}

        this.addStore(candidate, scope, { shared: true, readonly: false })
        discovered.push({ path: candidate, scope })
        knownPaths.add(candidate)
        logger.info(`Auto-discovered project store: ${candidate} (${scope})`)
      }

      // Stop at git root or filesystem root
      if (fs.existsSync(join(dir, '.git'))) break
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }

    return discovered
  }

  /** List all configured stores. */
  listStores(): Array<{
    path?: string; url?: string; scope: string; shared: boolean; readonly: boolean; engram_count: number
  }> {
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
      if (s.url) {
        try { count = this._loadRemoteCached(s).filter(e => e.status !== 'retired').length } catch {}
      } else if (s.path) {
        try { count = this._loadCached(s.path).filter(e => e.status !== 'retired').length } catch {}
      }
      return {
        path:     s.path,
        url:      s.url,
        scope:    s.scope,
        shared:   s.shared,
        readonly: s.readonly,
        engram_count: count,
      }
    })
    return [primary, ...additional]
  }
}
