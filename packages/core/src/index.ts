import * as fs from 'fs'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import yaml from 'js-yaml'
import { detectPlurStorage, type PlurPaths } from './storage.js'
import { IndexedStorage } from './storage-indexed.js'
import { PGLiteAdapter } from './storage-pglite.js'
import { loadConfig } from './config.js'
import { loadEngrams, saveEngrams, generateEngramId, loadAllPacks, storePrefix } from './engrams.js'
import { logger } from './logger.js'
import { searchEngrams } from './fts.js'
import { selectAndSpread, scoreEngramsPublic, formatWithLayer, assignLayer } from './inject.js'
import { reactivate } from './decay.js'
import { captureEpisode, queryTimeline } from './episodes.js'
import { agenticSearch } from './agentic-search.js'
import { embeddingSearch, embeddingSearchWithScores, type SimilarityResult } from './embeddings.js'
import { hybridSearch, hybridSearchWithMeta, applyReranker, rrfMergeEngrams as pgliteRrfMerge, type HybridSearchResult, type RerankOptions } from './hybrid-search.js'
import { getReranker, resolveRerankerName, isRerankerOff, rerankerStatus, resetRerankerStatus, _resetRerankerCache, checkRerankerFit, type RerankerAdapter, type RerankerRuntimeStatus, type RerankerName, type FitCheckResult } from './rerankers/index.js'
import { runRerankerSelfEval, loadRerankerEvalCache, saveRerankerEvalResult, isRerankerEvalStale, logRerankerEvalAdvisory, type RerankerEvalResult } from './reranker-eval.js'
import { _resetBgeRerankerCache } from './rerankers/bge-reranker-v2-m3.js'
import { _resetMsMarcoMiniLmCache } from './rerankers/ms-marco-minilm-l6.js'
import { classifyQuery, routeForIntent, applyIntentRouting, isIntentRoutingDisabled, isEntityDomain, rewriteLexicalQuery, isQueryRewriteDisabled, type QueryIntent, type IntentRoutingProfile } from './intent/index.js'
import { getEmbedder, resolveEmbedderName } from './embedders/index.js'
import { emitMissSignal } from './telemetry-miss-signal.js'
import { embedderStatus, resetEmbedder, setEmbeddingsEnabled, type EmbedderStatus } from './embeddings.js'
import { expandedSearch } from './query-expansion.js'
import { recallAuto, type AutoSearchResult } from './search-orchestrator.js'
import { autoSummary } from './summary.js'
import { installPack, uninstallPack, listPacks, exportPack, scanPrivacy, computePackHash, previewPack } from './packs.js'
// SP5 imports (deferred — vault-export, registry not yet merged)
// import { exportVault, type VaultExportOptions, type VaultExportResult } from './vault-export.js'
// import { fetchRegistry, discoverPacks, verifyPackIntegrity, DEFAULT_REGISTRY_URL, type PackRegistry, type RegistryPack } from './registry.js'
import { sync as gitSync, getSyncStatus, withLock, type SyncResult, type SyncStatus, type SyncRemoteType } from './sync.js'
import { detectSecrets, detectSensitive, sensitivityCategory, SCAN_TRUNCATED } from './secrets.js'
import type { SecretMatch } from './secrets.js'
import { SENSITIVITY_CATEGORIES, type ScopeMetadata, type SensitivityCategory } from './schemas/scope-metadata.js'
import { rankScopes, SCOPE_MATCH_THRESHOLD, type ScopeSignals, type ScopeCandidate } from './scope-routing.js'
import { appendHistory, readHistoryForEngram, generateEventId, generateInjectionId, computeQueryHash, findLatestInjectionFor, countInjectionEvents, type InjectionEventCounts } from './history.js'
import { computeContentHash } from './content-hash.js'
import { loadTensions, saveTensions, generateTensionId, tensionPairKey, categorizeTension } from './tension-store.js'
import type { TensionRecord, TensionStatus } from './schemas/tension.js'
import type { TensionPair } from './tensions.js'
import { engramDate } from './tensions.js'
import { resolveValidity, buildTemporal } from './expiry.js'
import { decodeJwtExpiry } from './jwt.js'
import { RemoteStore, normalizeEndpointUrl } from './store/remote-store.js'
import { isSharedScope, isPersonalScope, isScopeWithin } from './scope-util.js'
import type { Engram } from './schemas/engram.js'
import type { Episode } from './schemas/episode.js'
import type { PackManifest } from './schemas/pack.js'
import type { PlurConfig, StoreEntry, ScopeRoutingConfig } from './schemas/config.js'
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
export { findProjectConfigPath, readProjectConfig, type ProjectConfig } from './project-config.js'
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
export { appendHistory, readHistory, listHistoryMonths, readHistoryForEngram, generateEventId, generateInjectionId, computeQueryHash, findLatestInjectionFor, countInjectionEvents, readCoInjections, type HistoryEvent, type InjectionEventCounts, type InjectionSource, type CoInjectionData, type CoInjectionEvent, type CoInjectionReadResult } from './history.js'
export { computeReceipt } from './receipt.js'
export type { Receipt, ReceiptInput, ReceiptTopEntry } from './receipt.js'
import type { Receipt } from './receipt.js'
import { gatherReceipt } from './receipt-io.js'
export { computeContentHash, normalizeStatement } from './content-hash.js'
export { parseDedupResponse, buildDedupPrompt, buildBatchDedupPrompt } from './dedup.js'
export { runMigrations, rollbackMigrations, getSchemaVersion, setSchemaVersion, ALL_MIGRATIONS, CURRENT_SCHEMA_VERSION, type Migration, type MigrationResult } from './migrations/index.js'
export { detectSecrets, detectSensitive, sensitivityCategory } from './secrets.js'
export { ScopeMetadataSchema, ScopeSensitivitySchema, SENSITIVITY_CATEGORIES, type ScopeMetadata, type ScopeSensitivity, type SensitivityCategory } from './schemas/scope-metadata.js'
export { rankScopes, SCOPE_MATCH_THRESHOLD, WEIGHT_TAG, SUGGEST_DISPLAY_MIN_CONFIDENCE, type ScopeSignals, type ScopeCandidate, type RankScopesOptions } from './scope-routing.js'

// Scope-family predicates live in the leaf module `scope-util.ts` to break a
// module cycle: `inject.ts` (imported by index.ts) needs `isPersonalScope`, and
// importing it from here would form index → inject → index. They are imported
// above for internal use and re-exported here so the public `@plur-ai/core` API
// (`isSharedScope`, `isPersonalScope`, `SHARED_SCOPE_PREFIXES`) is unchanged.
export { isSharedScope, isPersonalScope, SHARED_SCOPE_PREFIXES } from './scope-util.js'
export { detectPlurStorage, type PlurPaths } from './storage.js'
export { IndexedStorage } from './storage-indexed.js'
export { PGLiteAdapter, type PGLiteAdapterOptions, type VectorPrecision } from './storage-pglite.js'
export type { StorageAdapter, StorageFilter, VectorSearchHit } from './storage-adapter.js'
export { YamlStore, SqliteStore, createStore, migrateStore, type EngramStore, type StorageBackend, type StorageConfig } from './store/index.js'
export { withAsyncLock, asyncAtomicWrite } from './store/index.js'
// Embedding primitive — public so alternative store backends can compute
// vectors identically to core's hybrid search (same model + EMBED_DIM). The
// model identity and EMBED_DIM are a stable contract; changing them is breaking
// for any consumer that persists vectors. See embeddings.ts.
export { embed, EMBED_DIM, activeEmbedderDim, embedderStatus, cosineSimilarity, type EmbedderStatus } from './embeddings.js'
export { EMBEDDER_NAMES, DEFAULT_EMBEDDER, resolveEmbedderName, type EmbedderName, type EmbedderAdapter } from './embedders/index.js'
// Reranker surface (#220/#341) — factory + runtime status so MCP/CLI can
// probe reranker health (plur_doctor) and surface non-engagement on recall.
// _setCachedReranker/_resetRerankerCache are test seams for exercising
// failure paths without downloading the real ~300 MB model.
export {
  getReranker, isRerankerOff, resolveRerankerName, RERANKER_NAMES, DEFAULT_RERANKER,
  rerankerStatus, resetRerankerStatus, classifyRerankerFailure, hfCacheDirName,
  _resetRerankerCache, _setCachedReranker,
  checkRerankerFit,
  type RerankerName, type RerankerRuntimeStatus, type RerankerFailureKind, type FitCheckResult, type FitCheckEngram,
} from './rerankers/index.js'
export type { RerankerAdapter } from './rerankers/types.js'
// Per-store reranker eval gate (#451) — the self-check that must pass before
// anyone flips reranking on by default for a store. Advisory only.
export {
  synthesizeProbeQuery, runRerankerSelfEval,
  rerankerEvalCachePath, loadRerankerEvalCache, saveRerankerEvalResult,
  isRerankerEvalStale, rerankerEvalAdvisory,
  RERANKER_EVAL_STALENESS_MS, RERANKER_EVAL_COUNT_DRIFT, RERANKER_EVAL_MIN_PROBES,
  RERANKER_EVAL_HARM_THRESHOLD, RERANKER_EVAL_BENEFIT_THRESHOLD,
  type RerankerEvalResult, type RerankerEvalVerdict, type RerankerEvalOptions,
} from './reranker-eval.js'
export type { SimilarityResult } from './embeddings.js'
export type { SyncResult, SyncStatus, SyncRemoteType } from './sync.js'
export { checkForUpdate, getCachedUpdateCheck, clearVersionCache, minorVersionsBehind, type VersionCheckResult } from './version-check.js'
export { scanForTensions, getCandidatePairs, scopesOverlap, domainSegmentsOverlap, subjectsOverlap, statementOverlap, buildContradictionPrompt, parseContradictionResponse, buildBatchContradictionPrompt, parseBatchContradictionResponse, engramDate, daysApart, inTemporalDomain, temporalDiscountFactor, SNAPSHOT_CONFIDENCE_CAP, type ContradictionVerdict, type TensionPair, type TensionScanResult, type TensionScanOptions, type TemporalGateOptions, type CandidatePairOptions, type JudgeStatement } from './tensions.js'
// Tension lifecycle persistence (#181)
export { loadTensions, saveTensions, generateTensionId, tensionPairKey, categorizeTension } from './tension-store.js'
export { TensionRecordSchema, TensionStatusSchema, TensionCategorySchema, type TensionRecord, type TensionStatus, type TensionCategory } from './schemas/tension.js'
// Migration importers (issue #441) — `plur import --from <source> --path <file>`.
export {
  importFrom, runImport, getImportSource, listImportSources, IMPORT_SOURCES,
  parseGenericContent, parseCsv, parseMem0Content, parseGpEngramDb,
  normalizeImportType, normalizeTimestamp, normalizeConfidence, normalizeTags,
  type ImportRecord, type ImportSource, type ImportInput, type ImportEngramType,
  type FieldMapping, type MappableField, type ImportRecordResult, type MigrationReport,
  type RunImportOptions, type ImportFromOptions,
} from './importers/index.js'
export { CapabilityCanary, type Capability, type CanaryStatus } from './capability-canary.js'
export type { Engram, PreviousVersionRef } from './schemas/engram.js'
export { ExtractionProvenanceSchema, getExtractionProvenance, type ExtractionProvenance } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PackManifest } from './schemas/pack.js'
export type { PreviewResult, RegistryEntry, PrivacyScanResult, PrivacyIssue } from './packs.js'
export type { PlurConfig, StoreEntry, ScopeRoutingConfig } from './schemas/config.js'
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

// Opt-in, content-free telemetry. Exported so wrappers (@plur-ai/mcp,
// @plur-ai/claw) reuse one implementation instead of vendoring copies.
export { resolveTelemetry, isTelemetryEnabled, type TelemetryState, type TelemetrySource, type TelemetryResolution } from './telemetry.js'
export { recordEvent, getCounters, resetCounters, readOrCreateInstallId, type CounterEvent, type CounterSnapshot, type CountersOpts } from './telemetry-counters.js'
export { flushIfNeeded, registerFlushOnExit, buildHeartbeatPayload, sendHeartbeat, type HeartbeatPayload, type FlushOpts } from './telemetry-flush.js'
// Failed-recall miss-signal — feeds the WS5 demand flywheel (opt-in, content-free).
export {
  emitMissSignal,
  classifyMiss,
  fingerprintQuery,
  buildMissSignalPayload,
  DEFAULT_MISS_SCORE_THRESHOLD,
  type MissReason,
  type MissSignalInput,
  type MissSignalOpts,
  type MissSignalPayload,
} from './telemetry-miss-signal.js'

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

/**
 * Last failure of a background index operation (#272). The PGLite index
 * refresh (and the auto-embed/reembed pass that rides on it) runs in a
 * fire-and-forget promise whose .catch used to swallow the error entirely —
 * a failed refresh reported "Sync: ok". Recorded and exposed via
 * `lastIndexError()` / `status().index_error` so CLI and MCP callers can
 * surface it. Cleared when the next background pass succeeds.
 */
export interface IndexSyncError {
  /** Which background operation failed. */
  op: 'initial-sync' | 'sync-from-yaml' | 'reindex' | 'auto-embed'
  message: string
  /** ISO timestamp of when the failure was recorded. */
  at: string
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
  /** Present when the most recent background index pass failed (#272). */
  index_error?: IndexSyncError
  /** Injection-provenance event/label counts (#452) — feeds #202's volume gate. */
  history_events?: InjectionEventCounts
}

/**
 * Per-URL result of scope discovery against an enterprise server's `/api/v1/me`
 * (#292). `unregistered` is the actionable set: scopes the token is authorized
 * for but that aren't yet in local config.
 */
/**
 * One row of `listStores` / `listStoresAsync`. The primary local store plus
 * each configured `stores` entry. `description`/`covers` are present only when
 * the entry declares self-describing scope metadata (#345) — additive, so
 * existing consumers that read only path/url/scope/.../engram_count are
 * unaffected.
 */
export interface StoreSummary {
  path?: string
  url?: string
  scope: string
  shared: boolean
  readonly: boolean
  engram_count: number
  /** Self-describing scope description (#345), when the entry declares it. */
  description?: string
  /** Topics/domains this scope covers (#345), when the entry declares it. */
  covers?: string[]
}

export interface RemoteScopeDiscovery {
  url: string
  /** True when `/me` responded; false on network error, 401, etc. */
  ok: boolean
  username?: string
  org_id?: string
  role?: string
  /** All scopes the token is authorized for (from `/me`). Empty when `ok` is false. */
  authorized: string[]
  /** Scopes already registered in local config for this URL. */
  registered: string[]
  /** Authorized minus registered minus dismissed (#647) — the scopes a user could still add. */
  unregistered: string[]
  /**
   * Server-authoritative scope metadata (#345 D2) for the authorized scopes,
   * when the remote serves it via `/api/v1/me` (`scope_metadata`). Each entry
   * is a validated {@link ScopeMetadata}. Empty when the server is older /
   * declares no metadata — discovery still works, just without descriptions.
   */
  metadata: ScopeMetadata[]
  /** Present when `ok` is false. */
  error?: string
}

/**
 * Health of one configured remote endpoint (#295). Combines a live `/me`
 * probe with a local JWT-expiry read so callers can distinguish "auth
 * expired" (actionable: reauth) from "unreachable" (network), and warn
 * before a token expires rather than after.
 */
export interface RemoteHealth {
  url: string
  /** Scopes registered locally for this URL (for the report). */
  scopes: string[]
  /** 'ok' = /me succeeded; 'auth_expired' = 401/403 or JWT exp passed; 'unreachable' = network/timeout/5xx. */
  status: 'ok' | 'auth_expired' | 'unreachable'
  /** True only for status 'ok'. */
  ok: boolean
  /** Human-readable reason when not ok. */
  reason?: string
  /** From the token's JWT `exp` claim, if decodable (opaque keys → null). */
  tokenExpiresAt?: string
  /** Whole days until token expiry (negative if past), or null if unknown. */
  tokenExpiresInDays?: number | null
}

/** Outcome of registering discovered scopes for one URL (#292). */
export interface RegisterDiscoveredResult {
  url: string
  ok: boolean
  added: string[]
  already_registered: string[]
  /** Scopes refused auto-registration: personal-family scopes a `/me` returned
   *  (#382), scopes whose addStore threw (#397), and dismissed scopes the batch
   *  path respects (scope-audit 2026-07-24). */
  skipped: string[]
  error?: string
}

/**
 * Sanitize a remote-served `forbid` list to the known SENSITIVITY_CATEGORIES
 * (scope-audit 2026-07-24). Belt-and-braces behind the /me schema validation:
 * persistScopeMetadata may receive discoveries built by other callers (tests,
 * future code paths), and a `forbid` that sanitizes to EMPTY would be maximal
 * loosening — so empty falls to the safe default, mirroring
 * ScopeSensitivitySchema's preprocess. See the trust rule on
 * {@link Plur.persistScopeMetadata}.
 */
function sanitizeForbidCategories(forbid: readonly string[]): SensitivityCategory[] {
  const kept = forbid.filter((c): c is SensitivityCategory =>
    (SENSITIVITY_CATEGORIES as readonly string[]).includes(c))
  return kept.length ? [...new Set(kept)] : [...SENSITIVITY_CATEGORIES]
}

/**
 * Key-order-insensitive JSON for VALUE-equality comparison (scope-audit
 * 2026-07-24). persistScopeMetadata's change-detector compares "what will be
 * persisted" against the loaded entry; a plain JSON.stringify is key-order
 * sensitive, and object spreads vs a zod re-parse can order the same keys
 * differently — which would report a phantom "change" forever (the exact
 * rewrite-every-session_start loop the detector exists to prevent). Arrays
 * keep their order (element order is meaningful for covers/forbid).
 */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_key, val) =>
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val)
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
  /**
   * PGLite adapter (ADR-0001, Sprint 0 PR 2). Opt-in via
   * PLUR_BACKEND=pglite env var or `backend: pglite` in config.yaml.
   * When active, runs in parallel to the YAML write path: every YAML
   * mutation triggers syncFromYaml on the PGLite index. The YAML file
   * remains the source of truth — see yaml-truth-rebuild and
   * yaml-truth-traceability tests for the invariant.
   */
  private pgliteAdapter: PGLiteAdapter | null = null
  private _pgliteInitPromise: Promise<void> | null = null
  /**
   * Last background index failure (#272). Set by the .catch of the
   * fire-and-forget index chains (initial sync, syncFromYaml, reindex,
   * auto-embed); reset when a new chain is kicked off so a completed
   * successful pass leaves it null. Read via lastIndexError()/status().
   */
  private _lastIndexError: IndexSyncError | null = null
  private _engramCache: Map<string, { mtime: bigint; engrams: Engram[] }> = new Map()
  /**
   * engram_id → injection_id of the most recent co_injection that included it
   * (#452). Fast path for linking plur_feedback verdicts to their injection
   * event; findLatestInjectionFor covers the cross-process case.
   */
  private _lastInjectionByEngram: Map<string, string> = new Map()
  private _llmFailureCount = 0
  private _llmDisabledUntil: number | null = null
  private _sessionScope: string | null = null
  /**
   * Cross-encoder reranker adapter (#220). Resolved lazily on first recall with
   * `rerank: true`. Defaults to the "off" sentinel when PLUR_RERANKER is unset,
   * so existing call sites pay zero cost until they opt in.
   */
  private _reranker: RerankerAdapter | null = null
  /**
   * Per-store reranker eval gate advisory (#451) — logged at most once per
   * instance when the enable path resolves a reranker whose cached self-eval
   * verdict is 'harmful'. Advisory only: reranking is never auto-disabled.
   */
  private _rerankerEvalAdvisoryDone = false
  /** mtime (ms) of config.yaml at last load — drives reloadConfigIfChanged (#307). */
  private configMtimeMs = 0

  constructor(options?: { path?: string }) {
    this.paths = detectPlurStorage(options?.path)
    this.config = loadConfig(this.paths.config)
    // Auto-discover project stores from CWD (skips temp dirs for test safety)
    this.autoDiscoverStores()
    // Re-read config after potential store additions
    if (this.config.stores?.length !== loadConfig(this.paths.config).stores?.length) {
      this.config = loadConfig(this.paths.config)
    }
    this.configMtimeMs = this.statConfigMtime()
    const backend = this._resolveBackend()
    if (backend === 'pglite') {
      // PGLite path. Keep SQLite indexedStorage null so we don't double-index.
      // vector.precision (#223): unset = keep the store's existing column
      // type; 'halfvec' opts in to fp16 storage (lazy in-place migration).
      this.pgliteAdapter = new PGLiteAdapter(this.paths.engrams, this.paths.pglite, {
        // #335: size the vector column from the ACTIVE embedder (PLUR_EMBEDDER),
        // not the 384 default constant — bge-base/embedding-gemma are 768,
        // openai-3-large is 3072. Metadata-only: adapters construct lazily,
        // no model load happens here. Existing stores keep their on-disk
        // column (ensureColumnPrecision reads reality); mismatches surface
        // via the doctor dim-check + the upsert-time guard.
        vectorDim: getEmbedder(resolveEmbedderName()).dim,
        precision: this.config.vector?.precision,
      })
      // Initial sync runs in the background — YAML is already authoritative,
      // so reads served from the YAML fallthrough remain correct while the
      // index warms up.
      this._pgliteInitPromise = this.pgliteAdapter.syncFromYaml().catch((err: unknown) => {
        this._recordIndexError('initial-sync', err)
        logger.warning(`[plur] PGLite initial sync failed: ${(err as Error).message}. Run 'plur sync --full' to rebuild.`)
      })
    } else if (this.config.index) {
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

  /**
   * Resolve the active index backend. Order:
   *   1. PLUR_BACKEND env var (pglite|sqlite)
   *   2. config.yaml `backend` field
   *   3. default: sqlite (historical)
   */
  private _resolveBackend(): 'sqlite' | 'pglite' {
    const env = process.env.PLUR_BACKEND
    if (env === 'pglite' || env === 'sqlite') return env
    const fromConfig = (this.config as { backend?: string }).backend
    if (fromConfig === 'pglite' || fromConfig === 'sqlite') return fromConfig
    return 'sqlite'
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
        // Phase 4: Scope validation. Segment-aware (#383): a sibling that is a
        // mere string-prefix of the store scope (group:plur/eng-private under a
        // group:plur/eng store) must NOT load.
        if (e.scope !== 'global' && !isScopeWithin(e.scope, store.scope)) {
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
    // #394: include the token in the cache key so a ROTATED token produces a FRESH
    // driver instead of one still holding the old (now-401) token + its stale cache.
    // On rotation, drop any prior driver for the same url::scope so the old token
    // can't keep serving and the map doesn't grow unbounded across rotations.
    const baseKey = `${entry.url}::${entry.scope}`
    const key = `${baseKey}::${entry.token ?? ''}`
    let driver = this._remoteStores.get(key)
    if (!driver) {
      for (const k of this._remoteStores.keys()) {
        if (k !== key && k.startsWith(baseKey + '::')) this._remoteStores.delete(k)
      }
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

  /**
   * True when `scope` is backed by a REMOTE store — i.e. a `stores` entry with a
   * `url` (data leaves this machine) whose scope exactly matches. The leak guard
   * uses this alongside `isSharedScope`: a scope like `user:plur:gregor` is NOT
   * `isSharedScope` (personal prefix) yet routes to plur.datafund.io, so sensitive
   * content written there would cross the machine boundary unguarded.
   *
   * Pure CONFIG lookup — NO driver instantiation, NO network, NO side effects —
   * because this runs on every learn(). It mirrors `_resolveRemoteStoreForScope`'s
   * exact-scope-match rule (no prefix matching) so the guard and the router agree
   * on which writes reach the remote.
   */
  private _isRemoteBackedScope(scope: string): boolean {
    return (this.config.stores ?? []).some(s => !!s.url && s.scope === scope)
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

  /**
   * Strip the store namespace prefix from an ID before sending to a remote server.
   * _loadAllEngrams adds ENG-{PREFIX}- to avoid local ID collisions; the remote
   * server only knows the original ID. If the ID doesn't match this store's prefix,
   * return it unchanged (it may belong to a different store or be unprefixed).
   * See: https://github.com/plur-ai/plur/issues/86
   */
  private _stripRemotePrefix(id: string, scope: string): string {
    const prefix = storePrefix(scope)
    const nsPattern = new RegExp(`^(ENG|ABS|META)-${prefix}-`)
    if (nsPattern.test(id)) {
      return id.replace(nsPattern, '$1-')
    }
    return id
  }

  /** Content hash fast-path dedup. Scope-aware: same statement in a different
   * scope is a promotion, not a duplicate. Retired engrams are excluded —
   * re-learning a retired statement creates a fresh engram (issue #107). */
  private _hashDedup(statement: string, engrams: Engram[], scope?: string): Engram | null {
    const hash = computeContentHash(statement)
    for (const e of engrams) {
      if (e.status === 'active' && (e as any).content_hash === hash) {
        if (scope === undefined || e.scope === scope) return e
      }
    }
    return null
  }

  /** Build the {scope, session_id, stored_at} source entry that gets appended
   * to an engram's sources[] on every write (initial or duplicate). */
  private _buildSourceEntry(scope: string, context?: LearnContext): {
    scope: string; session_id: string | null; stored_at: string
  } {
    return {
      scope,
      session_id: context?.session_episode_id ?? null,
      stored_at: new Date().toISOString(),
    }
  }

  /** Apply a duplicate-write to an existing engram: increment reference_count,
   * append source, persist to primary store if that's where the engram lives.
   * Mutates the engram and (best-effort) writes back. See issue #107. */
  private _recordDuplicate(
    hit: Engram,
    engrams: Engram[],
    scope: string,
    context: LearnContext | undefined,
  ): Engram {
    // Use defaults for engrams migrated without these fields.
    const currentCount = (hit as any).reference_count ?? 1
    const currentSources = (hit as any).sources ?? []
    ;(hit as any).reference_count = currentCount + 1
    ;(hit as any).sources = [...currentSources, this._buildSourceEntry(scope, context)]

    // Persist if the engram is in the primary store. Cross-store duplicates
    // (same scope across stores) are deduplicated but not persisted in v1.
    const idx = engrams.findIndex(e => e.id === hit.id)
    if (idx !== -1) {
      engrams[idx] = hit
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
    }
    return hit
  }

  /** Find an active engram with the same content_hash but a DIFFERENT scope.
   * A hit indicates cross-context recurrence — the same knowledge is being
   * re-learned across scopes, which is evidence of universal applicability.
   * See issue #176. */
  private _crossScopeRecurrenceDetect(
    statement: string,
    engrams: Engram[],
    currentScope: string,
  ): Engram | null {
    const hash = computeContentHash(statement)
    for (const e of engrams) {
      if (e.status === 'active'
          && (e as any).content_hash === hash
          && e.scope !== currentScope) {
        return e
      }
    }
    return null
  }

  /** Record a cross-scope recurrence: append source, increment counters,
   * escalate commitment, and broaden scope to 'global' once the threshold
   * is crossed. Returns the (possibly broadened) engram.
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
  private _recordCrossScopeRecurrence(
    hit: Engram,
    engrams: Engram[],
    scope: string,
    context: LearnContext | undefined,
  ): Engram {
    const previousScope = hit.scope
    const previousCommitment = hit.commitment

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
    const sourceEntry = this._buildSourceEntry(scope, context)
    const lockTimestamp = new Date().toISOString()
    // #181 (audit #213 item 3): an engram in an unresolved persisted tension
    // must not escalate INTO 'locked' — contradicted knowledge freezing at
    // the top of the commitment ladder is exactly the failure #213 feared.
    // Escalation caps at 'decided' until the tension is resolved/dismissed.
    const lockBlockedByTension = this.hasUnresolvedTension(hit.id)
    const applyMutation = (e: Engram, source: typeof sourceEntry, lockedAt: string): number => {
      const newRecurrence = ((e as any).recurrence_count ?? 0) + 1
      ;(e as any).recurrence_count = newRecurrence
      ;(e as any).reference_count = ((e as any).reference_count ?? 1) + 1
      ;(e as any).sources = [...((e as any).sources ?? []), source]

      if (newRecurrence >= 2) {
        // Only promote SHARED scopes (project:*, space:*, etc.) to global —
        // personal-family scopes (local, user:*) stay within their family.
        // See issue #362 item (ii): personal-scope ceiling for cross-scope recurrence.
        if (isSharedScope(e.scope)) e.scope = 'global'
        if (e.commitment !== 'locked') {
          // Forward-only ladder: exploring → leaning → decided → locked.
          e.commitment = e.commitment === 'exploring'
            ? 'leaning'
            : e.commitment === 'leaning'
              ? 'decided'
              : e.commitment === 'decided'
                ? (lockBlockedByTension ? 'decided' : 'locked')
                : (e.commitment ?? 'leaning')
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
      ;(hit as any).reference_count = (mutated as any).reference_count
      ;(hit as any).sources = (mutated as any).sources
      if (mutated.locked_at !== undefined) hit.locked_at = mutated.locked_at
      if (mutated.locked_reason !== undefined) hit.locked_reason = mutated.locked_reason
    }

    type PersistenceTarget = 'primary' | 'secondary' | 'in-memory'
    const primaryIdx = engrams.findIndex(e => e.id === hit.id)
    let persistedTo: PersistenceTarget
    let newRecurrence: number

    if (primaryIdx !== -1) {
      // Primary store: mutate the engram in the loaded array (symmetric with
      // secondary path — both mutate the on-disk-bound object, not hit).
      const target = engrams[primaryIdx]
      newRecurrence = applyMutation(target, sourceEntry, lockTimestamp)
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      persistedTo = 'primary'
      // Audit iter-5 fix (Data finding 1): explicit identity guard makes the
      // self-assign no-op contract visible. When _loadAllEngrams and the primary
      // engrams array share references, target IS hit and syncing is redundant;
      // the guard documents the assumption without changing behavior today.
      if (target !== hit) syncHitFrom(target)
    } else {
      // primaryIdx already proved this isn't in primary; only check writability.
      const storeInfo = this._findEngramStore(hit.id)
      if (storeInfo && !storeInfo.readonly) {
        const storeEngrams = loadEngrams(storeInfo.path)
        const sidx = storeEngrams.findIndex(e => e.id === storeInfo.originalId)
        // Audit iter-5 defense (Critic low #3): _crossScopeRecurrenceDetect
        // filters status==='active' at the entry point, but a cross-process
        // race could retire the secondary-store copy between detection and
        // mutation. Treat retired-on-arrival the same as not-found.
        if (sidx !== -1 && storeEngrams[sidx].status === 'active') {
          newRecurrence = applyMutation(storeEngrams[sidx], sourceEntry, lockTimestamp)
          this._writeEngrams(storeInfo.path, storeEngrams)
          this._syncIndex()
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
      } else {
        // Readonly or remote — apply to hit only. Remote PATCH wiring tracked
        // separately; in-memory state is still returned to the caller.
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
      appendHistory(this.paths.root, {
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
  /**
   * Resolve self-describing metadata for a scope from the loaded config (#345).
   * Metadata is carried on a `stores` entry: the first entry whose `scope`
   * matches and that declares any metadata field (`description`/`covers`/
   * `sensitivity`) is materialized into a {@link ScopeMetadata}. Returns
   * `undefined` when the scope is unknown or declares no metadata — callers
   * (notably the leak guard) treat that as "fall back to default behavior".
   *
   * This is the Stage 2 local resolver. The enterprise `/api/v1/scopes` source
   * is a separate track; when it lands it can back this same accessor.
   */
  getScopeMetadata(scope: string): ScopeMetadata | undefined {
    const entry = (this.config.stores ?? []).find(
      s => s.scope === scope &&
        (s.description !== undefined || s.covers !== undefined || s.sensitivity !== undefined),
    )
    if (!entry) return undefined
    return {
      scope,
      description: entry.description ?? '',
      covers: entry.covers ?? [],
      ...(entry.sensitivity ? { sensitivity: entry.sensitivity } : {}),
    }
  }

  /**
   * All registered scopes that declare self-describing metadata, materialized
   * via {@link getScopeMetadata}. Deduplicated on scope (first declaration
   * wins, matching getScopeMetadata's find-first semantics). Drives discovery
   * surfacing and the {@link suggestScope} ranker. Additive — does not touch
   * routing.
   */
  listScopeMetadata(): ScopeMetadata[] {
    const seen = new Set<string>()
    const out: ScopeMetadata[] = []
    for (const s of this.config.stores ?? []) {
      if (seen.has(s.scope)) continue
      const md = this.getScopeMetadata(s.scope)
      if (md) { out.push(md); seen.add(s.scope) }
    }
    return out
  }

  /**
   * Suggest which registered scope(s) an engram belongs in, ranked by fit
   * (#345/#346, Stage 3a). Deterministic — NO LLM, NO network. Scores the
   * engram's signals (statement keywords, `domain` namespace, `tags`) against
   * the `covers[]` each scope declares (see {@link rankScopes} for the weights).
   *
   * ADVISORY ONLY. This does NOT route or store anything — `learn()` /
   * `learnRouted()` ignore it. The auto-route behavior flip is the gated Stage
   * 3b PR; this method just answers "where would this fit?".
   *
   * `options.minConfidence` (#670) floors the returned list — candidates
   * strictly below it are dropped. Precedence: explicit option >
   * `scope_routing.min_confidence` config > 0 (unfiltered, the historical
   * default). This floors the SUGGESTION surface only; the auto-route gate is
   * `scope_routing.match_threshold` and is deliberately independent. Returns
   * candidates sorted by confidence descending — an empty array means nothing
   * matched OR every match fell below the floor.
   */
  suggestScope(input: ScopeSignals, options?: { minConfidence?: number }): ScopeCandidate[] {
    this.reloadConfigIfChanged()  // pick up out-of-process config edits (#307)
    const minConfidence =
      options?.minConfidence ?? this.config.scope_routing?.min_confidence ?? 0
    return rankScopes(input, this.listScopeMetadata(), { minConfidence })
  }

  /**
   * Read-only view of the `scope_routing` config block (#670). Lets display
   * surfaces (the MCP `plur_suggest_scope` handler) resolve the configured
   * suggestion floor without reaching into the private config — precedence at
   * that surface is: explicit tool arg > this config value >
   * SUGGEST_DISPLAY_MIN_CONFIDENCE.
   */
  getScopeRoutingConfig(): Readonly<ScopeRoutingConfig> {
    this.reloadConfigIfChanged()
    return { ...(this.config.scope_routing ?? {}) }
  }

  /**
   * Write-time leak guard. If the target scope can let data leave the machine —
   * either SHARED (`isSharedScope`: group:/project:/space:/team:/org:/public, so
   * others can read it) OR REMOTE-backed (`_isRemoteBackedScope`: routes to a
   * remote store, e.g. a personal `user:` scope on plur.datafund.io) — AND the
   * statement trips `detectSensitive` (IPs, internal hosts, basic-auth, host:port,
   * secrets), DEMOTE to a private local scope — the engram is kept but never
   * written to a shared/remote store — and warn. Purely-local scopes
   * (`global`/`local`/local-file stores) are exempt: infra notes legitimately
   * live there and never leave the machine. Called at the top of both
   * `learn()` and `learnRouted()`, so every client (CLI, MCP, hooks, OpenClaw,
   * Hermes) is covered, since they all route through one of those two.
   *
   * Per-scope policy (#345): when the target scope declares `sensitivity`
   * metadata, that policy decides demotion. A matched category is tolerated when
   * it is in `sensitivity.allow` (by category name OR by the specific detector
   * pattern name) OR not in `sensitivity.forbid`. Only categories that are both
   * forbidden and not allowed trigger demotion. When the scope has NO metadata,
   * this falls back EXACTLY to the Stage 1 behavior: any `detectSensitive` hit on
   * a shared scope demotes. The default policy (`forbid: ['secrets','infra']`,
   * `allow: []`) reproduces that demote-on-sensitive behavior, so adding metadata
   * is non-breaking.
   */
  /**
   * Single source of truth for "does this content carry sensitivity that scope
   * `scope` forbids?". Returns the offending {@link SecretMatch} hits, or `[]`
   * when there are none.
   *
   * Scope discipline: data can leak when the scope is SHARED (`isSharedScope`,
   * others can read it) OR REMOTE-backed (`_isRemoteBackedScope`, it routes off
   * this machine — e.g. a `user:` scope on plur.datafund.io). For a scope that is
   * neither — `global`/`local`/a local-file store — this returns `[]`
   * unconditionally: infra notes legitimately live in local storage, the content
   * never leaves the machine, and the demotion target is local anyway, so a local
   * write is always coherent.
   *
   * Policy: scan `text` with `detectSensitive`, then keep only the hits the
   * scope's per-scope `sensitivity` policy forbids. With no scope metadata the
   * default policy is `forbid:['secrets','infra'], allow:[]` — i.e. every hit is
   * offending (the Stage 1 behavior). A hit is tolerated when its category is in
   * `allow` (by category name OR by the specific detector pattern name) or when
   * its category is not in `forbid`.
   *
   * Used by `_guardSensitiveScope` (the learn/learnRouted guard) AND by the
   * mutation-path guards (learnAsync UPDATE/MERGE, reportFailure, updateEngram)
   * so there is exactly one definition of "offending".
   */
  private _offendingHitsForScope(statement: string, scope: string): SecretMatch[] {
    // Guard runs when data can leave the machine: a SHARED scope (others read it)
    // OR a REMOTE-backed scope (routes to a remote store). A scope that is neither
    // — `global`/`local`/a local-file store — stays on this machine, so there is
    // nothing to leak and the demotion target (local) is where it lives anyway.
    if (!isSharedScope(scope) && !this._isRemoteBackedScope(scope)) return []
    const hits = detectSensitive(statement)
    if (hits.length === 0) return []
    const policy = this.getScopeMetadata(scope)?.sensitivity
    const forbid = new Set<SensitivityCategory>(policy?.forbid ?? ['secrets', 'infra'])
    const allow = new Set<string>(policy?.allow ?? [])
    return hits.filter(h => {
      // Fail-closed (#386): a truncated-scan signal is always offending — the
      // unscanned tail can't be certified clean, and no scope policy may allow it.
      if (h.pattern === SCAN_TRUNCATED) return true
      const category = sensitivityCategory(h.pattern)
      if (allow.has(category) || allow.has(h.pattern)) return false
      return forbid.has(category)
    })
  }

  /**
   * Collect the context-ish fields of an engram (rationale, source, snippet,
   * dual_coding, domain, tags, knowledge_anchors, structured_data) into a plain
   * object for the explicit-update / meta / outbox-reguard leak scan (LOW-2, #353).
   * Must mirror the field set a LearnContext carries into `_guardSensitiveScope` —
   * which scans `JSON.stringify(context)`. LearnContext carries `domain`, `tags`,
   * and `knowledge_anchors`, so all three must be reconstructed here too, or the
   * reconstruct-from-engram guards (update / meta / outbox-reguard) scan a strictly
   * SMALLER surface than learn-time and than the learnAsync demote (which scans
   * tags, #409) — letting a host:port / basic-auth value placed in a `tag` (or an
   * anchor snippet/path, or `domain`) ride to a git-synced shared scope unguarded
   * (pre-Crt audit, #405/#409 parity). Classification domains and ordinary tags
   * produce no detector hits, so scanning them adds no false-positive demotions.
   * Returns undefined when none are present so the scan text stays statement-only.
   *
   * PLUR-internal bookkeeping keys in `structured_data` (underscore-prefixed:
   * `_outbox`, `_routed`, `_demoted`, …) are STRIPPED before scanning — they are
   * system-generated, never user content, and legitimately carry the very host
   * topology the infra detector flags (e.g. `_outbox.target_url` =
   * `http://127.0.0.1:<port>`). Scanning them would falsely demote every
   * remote-origin or auto-routed engram on update.
   */
  private _engramContextFields(engram: Engram): Record<string, unknown> | undefined {
    const e = engram as Record<string, unknown>
    const fields: Record<string, unknown> = {}
    for (const k of ['rationale', 'source', 'snippet', 'dual_coding', 'domain', 'tags', 'knowledge_anchors'] as const) {
      if (e[k] != null) fields[k] = e[k]
    }
    const sd = e.structured_data
    if (sd != null && typeof sd === 'object' && !Array.isArray(sd)) {
      const userSd: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(sd as Record<string, unknown>)) {
        if (!k.startsWith('_')) userSd[k] = v
      }
      if (Object.keys(userSd).length > 0) fields.structured_data = userSd
    } else if (sd != null) {
      fields.structured_data = sd
    }
    return Object.keys(fields).length > 0 ? fields : undefined
  }

  /**
   * Leak guard for the EXPLICIT-update mutation path (`updateEngram` /
   * `updateEngramAsync`). Unlike learn/learnAsync, the caller hands us a fully
   * formed engram and chose its scope deliberately, so the response differs by
   * residence (#353):
   *
   * - REMOTE-resident (`isRemote: true`): there is no coherent demotion (we
   *   can't silently re-scope an engram living on someone else's server), so a
   *   forbidden hit THROWS — mirroring the hard `detectSecrets` guard. The
   *   caller must re-scope locally or set `config.allow_secrets`.
   * - LOCAL-resident: a forbidden hit DEMOTES in place (scope→'local',
   *   visibility→'private') and warns. Returns the override the caller applies
   *   before persisting; returns `null` when the statement is clean.
   *
   * LOW-2 (#353): scan the FULL content like `_guardSensitiveScope`, not just
   * `statement`. Callers pass the engram's context-ish fields (rationale,
   * source, snippet, dual_coding, structured_data) via `contextFields`; we
   * serialize them onto the scan text so a credential hiding in a context field
   * is caught. The 64KB byte-aware truncation (PR-2) is applied inside
   * `detectSensitive` (reached via `_offendingHitsForScope`), so the scan is
   * bounded here too.
   */
  private _guardExplicitUpdate(
    statement: string,
    scope: string,
    isRemote: boolean,
    contextFields?: Record<string, unknown>,
  ): { scope: string; visibility: 'private' } | null {
    // Scan statement + context fields (mirrors _guardSensitiveScope scanText at
    // index.ts:1052). Omit the context join entirely when there are no fields so
    // the clean-statement scan is byte-identical to the old behavior.
    const scanText = contextFields
      ? `${statement}\n${JSON.stringify(contextFields)}`
      : statement
    const offending = this._offendingHitsForScope(scanText, scope)
    if (offending.length === 0) return null
    const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
    if (isRemote) {
      throw new Error(
        `Cannot update a shared/remote engram with sensitive content: ${patterns}. ` +
        `Use a local scope or config.allow_secrets.`,
      )
    }
    logger.warning(
      `[plur] sensitive content (${patterns}) held back from shared scope "${scope}" — ` +
      `demoted to local/private so it is not written to a shared store. ` +
      `Re-scope deliberately if this is a false positive.`,
    )
    return { scope: 'local', visibility: 'private' }
  }

  /**
   * Resolve the scope for a write whose caller supplied NO explicit scope and
   * for which no session/`.plur.yaml` default is in effect — the genuinely
   * UNSCOPED case (Stage 3b, #351). Two non-explicit signals decide it:
   *
   *  - `config.auto_route_scope` (default true): run the deterministic
   *    {@link suggestScope} ranker over the registered scopes' `covers[]`.
   *      - If the top writable candidate matched via a FULL domain-prefix
   *        (`domainMatch`), route to it DETERMINISTICALLY — bypass the
   *        squash/threshold. A full domain match is the strongest, most
   *        deliberate routing signal; under the current weights a LONE domain
   *        match squashes to EXACTLY {@link SCOPE_MATCH_THRESHOLD} (0.5) and
   *        would route only via the edge-of-threshold `>=` gate (#353 PR-6).
   *        The deterministic bypass removes that fragility with headroom and is
   *        independent of the weight curve.
   *      - Otherwise (tag-only / keyword-only — NO domain match): apply the
   *        threshold to the squashed confidence exactly as before. Weak signals
   *        stay gated — only a genuine domain-prefix match gets the bypass.
   *  - otherwise (auto_route_scope false): fall to `config.unscoped_default`.
   *
   * INERT until scopes declare `covers` (Stage 5): with no `covers` the ranker
   * returns `[]` and every unscoped write falls to `unscoped_default`. Both
   * `local` and `global` are PERSONAL scopes, so this is an organizational
   * default, not a leak-safety control — the sensitivity guard runs AFTER this
   * and still demotes an auto-routed SHARED scope carrying sensitive content.
   *
   * Returns the resolved scope and, when auto-routing fired, a `routed` marker
   * `{ scope, confidence, reason }`; `routed` is null on the `unscoped_default`
   * fall-through (so an explicit/default `global` is never mislabeled as routed).
   */
  private _resolveUnscopedScope(
    statement: string,
    context?: LearnContext,
  ): { scope: string; routed: { scope: string; confidence: number; reason: string } | null } {
    // Pick up out-of-process config edits (#307) — mirrors suggestScope. Without
    // this the WRITE path routed against a stale stores/covers snapshot: a scope
    // registered (or covers synced) by another process after startup was
    // invisible to auto-routing until restart (scope-audit 2026-07-24). Cheap:
    // one statSync, reload only on an actual mtime change.
    this.reloadConfigIfChanged()
    // Match the schema default (config.ts `unscoped_default.default('global')`)
    // so the two cannot drift; reverted local→global in 0.10.0 (#353).
    const fallback = this.config.unscoped_default ?? 'global'
    if (this.config.auto_route_scope === false) {
      return { scope: fallback, routed: null }
    }
    // MED-12 (#353, COSMETIC/REPORTING per D3): exclude readonly / non-writable
    // scopes from the AUTO-ROUTE candidate set so a clean unscoped write is never
    // LABELED as routed to a scope a write can't land on. This is not a
    // write-safety fix — `_resolveRemoteStoreForScope` already `continue`s on
    // readonly (line ~495), so a write to a readonly remote already falls to
    // local; the only defect is that the ranker could RANK/LABEL a readonly scope
    // as the target. `readonly` is one boolean on StoreEntry and applies to both
    // path- and url-based stores, so this view covers both. `listScopeMetadata()`
    // and `suggestScope()` are left UNCHANGED — advisory discovery still surfaces
    // readonly scopes.
    const writableScopeMetadata = this.listScopeMetadata().filter(md => {
      const entry = (this.config.stores ?? []).find(s => s.scope === md.scope)
      return entry?.readonly !== true
    })
    // Scope-routing tuning (#362): enterprise installs with many narrow,
    // covers-rich scopes can raise `match_threshold` to cut false-positive
    // routing, or adjust `weight_tag` to re-weight tag-only signals. Both default
    // to the module constants in scope-routing.ts; WEIGHT_DOMAIN stays hardcoded —
    // the lone-domain-clears-threshold invariant (THRESHOLD_SINGLE_DOMAIN) is
    // load-bearing and must not be tunable.
    const scopeRoutingCfg = this.config.scope_routing ?? {}
    const matchThreshold = scopeRoutingCfg.match_threshold ?? SCOPE_MATCH_THRESHOLD
    const weightTagOverride = scopeRoutingCfg.weight_tag
    const candidates = rankScopes(
      { statement, domain: context?.domain, tags: context?.tags },
      writableScopeMetadata,
      weightTagOverride !== undefined ? { weightTag: weightTagOverride } : undefined,
    )
    const top = candidates[0]
    // PR-6 (#353) + reaudit finding 4: a FORWARD domain-prefix match — the scope's
    // declared coverage CONTAINS the engram's topic (`cover ⊃ domain` or equal) —
    // is the strongest, most deliberate routing signal. Route to it
    // DETERMINISTICALLY — bypass the squash/threshold gate entirely — so a clean
    // domain match routes with headroom instead of landing at exactly
    // SCOPE_MATCH_THRESHOLD (0.5) and clearing only via the edge-of-threshold `>=`.
    //
    // Key the bypass on `coverContainsDomain`, NOT `domainMatch`: `domainMatch` is
    // also true for the REVERSE direction (engram domain BROADER than the cover,
    // `domain ⊃ cover`), and bypassing on that would over-route a broad/generic
    // engram (domain `plur`) into a NARROW shared scope (cover `plur.core`) it
    // doesn't belong in. The reverse match adds only the down-weighted
    // WEIGHT_DOMAIN_REVERSE (0.5 raw, NOT the full WEIGHT_DOMAIN of 1.5), so a lone
    // reverse hit squashes to 0.25 — BELOW SCOPE_MATCH_THRESHOLD (0.5) — and so
    // does NOT route via the `>=` threshold path either (and never gets the
    // deterministic bypass). rankScopes prefers a domain-match candidate at the top
    // on equal confidence, so `top` is the right scope to route to. Weights/
    // threshold/squash UNCHANGED.
    if (top && top.coverContainsDomain) {
      return { scope: top.scope, routed: { scope: top.scope, confidence: top.confidence, reason: top.reason } }
    }
    // No forward domain match: a reverse domain hit, tag-only, or keyword-only
    // candidate stays gated by the threshold. A LONE reverse-direction match
    // squashes to 0.25 (WEIGHT_DOMAIN_REVERSE = 0.5 raw) and so does NOT clear the
    // `>=` gate at the default threshold (0.5); it falls to the unscoped default
    // unless additional tag/keyword evidence lifts the squashed score to
    // >= the threshold. The threshold is configurable (#362): a higher
    // `match_threshold` makes routing more conservative, a lower one more
    // permissive. The deterministic forward-domain bypass above is unaffected.
    if (top && top.confidence >= matchThreshold) {
      return { scope: top.scope, routed: { scope: top.scope, confidence: top.confidence, reason: top.reason } }
    }
    return { scope: fallback, routed: null }
  }

  private _guardSensitiveScope(
    statement: string,
    context?: LearnContext,
  ): { scope: string; context: LearnContext | undefined; demotion: { from: string; to: string; patterns: string } | null; routed: { scope: string; confidence: number; reason: string } | null } {
    // "Truly unscoped" = caller passed no scope AND no session/`.plur.yaml`
    // default is in effect (both land in _sessionScope). Only this path
    // auto-routes / applies unscoped_default; everything else is honored as-is.
    let routed: { scope: string; confidence: number; reason: string } | null = null
    let scope: string
    if (context?.scope == null && this._sessionScope == null) {
      const resolved = this._resolveUnscopedScope(statement, context)
      scope = resolved.scope
      routed = resolved.routed
    } else {
      // Terminal fallback respects unscoped_default so a `unscoped_default:'local'`
      // user with a null _sessionScope and no context scope is not silently forced
      // to global (#353). No behavior change for the default-global user.
      scope = context?.scope ?? this._sessionScope ?? (this.config.unscoped_default ?? 'global')
    }
    // Guard fires when the write can leave the machine: shared scope (others can
    // read it) OR remote-backed scope (routes to a remote store, e.g. a personal
    // `user:` scope on plur.datafund.io). Purely-local scopes (`global`/`local`/
    // local-file stores) stay on this machine and are exempt — same gate as
    // _offendingHitsForScope, kept in sync because this short-circuits before it.
    if (!isSharedScope(scope) && !this._isRemoteBackedScope(scope)) {
      return { scope, context, demotion: null, routed }
    }
    // Scan the FULL content the engram will carry — the statement AND the
    // context fields (rationale, key_files, source, …), not just the statement.
    // Sensitive material hides in context too (#326 review, finding 1).
    const scanText = `${statement}\n${JSON.stringify(context ?? {})}`
    // Single source of truth for the offending-hit policy (#353).
    const offending = this._offendingHitsForScope(scanText, scope)
    if (offending.length === 0) return { scope, context, demotion: null, routed }

    const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
    logger.warning(
      `[plur] sensitive content (${patterns}) held back from shared scope "${scope}" — ` +
      `demoted to local/private so it is not written to a shared store. ` +
      `Re-scope deliberately if this is a false positive.`,
    )
    // Preserve `routed` through demotion: an auto-routed SHARED scope carrying
    // sensitive content is both routed AND demoted — surfacing both is correct.
    return {
      scope: 'local',
      context: { ...context, scope: 'local', visibility: 'private' },
      demotion: { from: scope, to: 'local', patterns },
      routed,
    }
  }

  learn(statement: string, context?: LearnContext): Engram {
    if (typeof statement !== 'string' || statement.length === 0) {
      throw new TypeError(`plur.learn: statement must be a non-empty string, got ${typeof statement}`)
    }
    if (!this.config.allow_secrets) {
      // Scan statement AND the caller-supplied fields that are exported verbatim /
      // rendered into agent context — `domain`, `tags`, `abstract` (#381, #389).
      // A secret in any of them would otherwise reach a shared pack/store. Other
      // context fields are covered by _guardSensitiveScope on shared/remote writes.
      const secretText = [statement, context?.domain, context?.abstract, ...(context?.tags ?? [])]
        .filter(Boolean)
        .join(' ')
      const secrets = detectSecrets(secretText)
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement/domain/tags: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    const guarded = this._guardSensitiveScope(statement, context)
    context = guarded.context
    // #347: resolve the validity window up-front (pure) so malformed
    // valid_from/valid_until fail fast — even when the write would dedup
    // into an existing engram below.
    const validity = resolveValidity(statement, context)
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const allEngrams = this._loadAllEngrams()

      const scope = guarded.scope

      // Idea 29: Content hash fast-path dedup (scope-aware — issue #136).
      // On dedup hit, mutate: increment reference_count, append source (#107).
      const hashMatch = this._hashDedup(statement, allEngrams, scope)
      if (hashMatch) return this._recordDuplicate(hashMatch, engrams, scope, context)

      // #176: cross-scope recurrence — same statement, different scope.
      // Treated as evidence of universal applicability: graduates the
      // existing engram toward 'global' + 'locked' commitment instead of
      // creating a new scope-bound duplicate.
      const crossMatch = this._crossScopeRecurrenceDetect(statement, allEngrams, scope)
      if (crossMatch) return this._recordCrossScopeRecurrence(crossMatch, engrams, scope, context)

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
        // #401: visibility defaults to 'private'. Having a `domain` (a topic
        // classification most engrams carry) must NOT auto-publish an engram —
        // public is opt-in, set it deliberately.
        visibility: context?.visibility ?? 'private',
        statement,
        rationale: context?.rationale,
        source: context?.source,
        domain: context?.domain,
        // #347: validity window — explicit valid_from/valid_until params, or
        // an explicit expiry phrase lifted from the statement. Unset for
        // ordinary engrams.
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
        dual_coding: context?.dual_coding,
        polarity: null,
        content_hash: computeContentHash(statement),
        commitment,
        locked_at: commitment === 'locked' ? now : undefined,
        locked_reason: commitment === 'locked' ? context?.locked_reason : undefined,
        reference_count: 1,
        sources: [this._buildSourceEntry(scope, context)],
        recurrence_count: 0,
        summary: autoSummary(statement, undefined),
        engram_version: 1,
        episode_ids: episodeIds ?? [],
        relations: (conflictIds.length > 0 || (context?.supersedes?.length ?? 0) > 0) ? {
          broader: [],
          narrower: [],
          related: [],
          conflicts: conflictIds,
          supersedes: context?.supersedes ?? [],
          superseded_by: [],
        } : undefined,
        pinned: context?.pinned === true ? true : undefined,
      }

      // #240: supersedes is a graph edge, not a temporality enum — write the
      // reverse superseded_by edge on each target found in the local primary
      // store (best-effort; targets living in other stores are not patched).
      // The tension scanner skips supersedes-linked pairs: an intentional
      // update is not a contradiction.
      if (context?.supersedes?.length) {
        this._writeSupersededByEdges(engrams, context.supersedes, id)
      }

      // Stamp the extraction marker (#347) so the plur_learn MCP response can
      // echo the parsed expiry date back for confirmation — extraction must
      // never silently guess.
      if (validity.extracted) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _expiry_extracted: { valid_until: validity.extracted.valid_until, phrase: validity.extracted.phrase },
        }
      }

      // Stamp the demotion marker (#326 review, finding 2) so the plur_learn MCP
      // response can tell the agent its engram was held back from the shared scope
      // it asked for. Set only on a direct learn() whose own guard demoted.
      if (guarded.demotion) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _demoted: guarded.demotion,
        }
      }

      // Stamp the auto-route marker (Stage 3b, #351) so the plur_learn MCP
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
        // Audit iter-1 fix (Dijkstra): defensive lookup. The resolver and
        // this find use the same predicate semantically (writable + matching
        // scope), but we still guard for null because config drift between
        // resolver-time and outbox-time is possible if config is reloaded.
        const storeEntry = (this.config.stores ?? []).find(s => s.url && s.scope === scope && !s.readonly)
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
            },
          }
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
      // Scan statement AND the caller-supplied fields that are exported verbatim /
      // rendered into agent context — `domain`, `tags`, `abstract` (#381, #389).
      // A secret in any of them would otherwise reach a shared pack/store. Other
      // context fields are covered by _guardSensitiveScope on shared/remote writes.
      const secretText = [statement, context?.domain, context?.abstract, ...(context?.tags ?? [])]
        .filter(Boolean)
        .join(' ')
      const secrets = detectSecrets(secretText)
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement/domain/tags: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    const guarded = this._guardSensitiveScope(statement, context)
    const scope = guarded.scope
    context = guarded.context
    // #347: fail fast on malformed valid_from/valid_until (pure validation),
    // mirroring learn() — before dedup can short-circuit the write.
    resolveValidity(statement, context)
    const remoteDriver = this._resolveRemoteStoreForScope(scope)
    if (!remoteDriver) {
      // Local route — sync learn() owns dedup, build, write, history. learn()'s
      // own guard sees the already-demoted (local) context and no-ops, so the
      // demotion marker is stamped here for the learnRouted-demoted case (#326).
      const engram = this.learn(statement, context)
      if (guarded.demotion) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _demoted: guarded.demotion,
        }
      }
      // Mirror the demotion re-stamp for the auto-route marker (Stage 3b, #351),
      // so an unscoped local-routed write surfaces its routing decision even if
      // the inner learn() took a dedup/recurrence path that didn't stamp it.
      if (guarded.routed) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _routed: guarded.routed,
        }
      }
      return engram
    }
    // Remote route — dedup against the merged local+cached-remote view,
    // then POST and merge the server-assigned ID into the local engram
    // representation we hand back to the caller. On failure, save to
    // local outbox for retry (issue #26).
    const allEngrams = this._loadAllEngrams()
    const hashMatch = this._hashDedup(statement, allEngrams, scope)
    if (hashMatch) {
      // Mutate + persist if local; otherwise return mutated (best-effort)
      return withLock(this.paths.engrams, () => {
        const engrams = loadEngrams(this.paths.engrams)
        return this._recordDuplicate(hashMatch, engrams, scope, context)
      })
    }
    // #176: cross-scope recurrence (same semantics as the local learn() path).
    const crossMatch = this._crossScopeRecurrenceDetect(statement, allEngrams, scope)
    if (crossMatch) {
      return withLock(this.paths.engrams, () => {
        const engrams = loadEngrams(this.paths.engrams)
        return this._recordCrossScopeRecurrence(crossMatch, engrams, scope, context)
      })
    }
    const now = new Date().toISOString()
    const localPlaceholder = this._buildEngramShape(statement, scope, context, now)
    // Stamp the auto-route marker on the remote-routed shape (Stage 3b, #351) so
    // the decision survives onto the server engram and into the MCP response.
    if (guarded.routed) {
      ;(localPlaceholder as any).structured_data = {
        ...((localPlaceholder as any).structured_data ?? {}),
        _routed: guarded.routed,
      }
    }
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
      // Remote failed — save locally with outbox metadata for retry.
      // Audit iter-1 fix (Dijkstra): defensive lookup; the catch is the
      // graceful-fallback path that must never throw. If no writable entry
      // matches the scope (e.g. readonly remote), we still save the local
      // engram but omit the outbox marker — the retry path will skip it.
      const storeEntry = (this.config.stores ?? []).find(s => s.url && s.scope === scope && !s.readonly)
      return withLock(this.paths.engrams, () => {
        const engrams = loadEngrams(this.paths.engrams)
        // Replace placeholder ID with a real local ID
        localPlaceholder.id = generateEngramId([...engrams, ...allEngrams])
        if (storeEntry) {
          ;(localPlaceholder as any).structured_data = {
            ...((localPlaceholder as any).structured_data ?? {}),
            _outbox: {
              target_url: storeEntry.url!,
              target_scope: scope,
              queued_at: now,
              last_attempt: now,
              attempt_count: 1,
              last_error: (err as Error).message,
              // #295: flag auth failures distinctly so the queue isn't read as a
              // transient network blip — a 401/403 means the token needs reauth,
              // and surfacing it (session_start/doctor) is the actionable signal.
              auth_failed: /\b40[13]\b/.test((err as Error).message),
            },
          }
        } else {
          logger.warning(`[plur:learnRouted] no writable store for scope=${scope} — saving locally without outbox marker`)
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
    // #347: validity window — same resolution as the sync learn() constructor.
    const validity = resolveValidity(statement, context)
    const shape: Engram = {
      // Placeholder id — overwritten by the server's assigned id before return.
      // Any consumer that observes this id directly (rather than via learnRouted's
      // return value) is doing it wrong — log says so.
      id: '__pending__',
      version: 2,
      status: 'active',
      consolidated: false,
      type,
      scope,
      // #401: default visibility to 'private' here too. This is the learnRouted
      // constructor — the PRIMARY production write path (plur_learn / CLI both go
      // through learnRouted), where `visibility` is never supplied and `domain`
      // usually is. The old `domain ? 'public'` default silently shipped real
      // learns as public. Mirrors the learn() constructor's #401 fix above.
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
      dual_coding: context?.dual_coding,
      polarity: null,
      content_hash: computeContentHash(statement),
      commitment,
      locked_at: commitment === 'locked' ? now : undefined,
      locked_reason: commitment === 'locked' ? context?.locked_reason : undefined,
      reference_count: 1,
      sources: [this._buildSourceEntry(scope, context)],
      recurrence_count: 0,
      summary: autoSummary(statement, undefined),
      engram_version: 1,
      episode_ids: context?.session_episode_id ? [context.session_episode_id] : [],
      // #240: forward supersedes edge travels with the remote-routed shape.
      // The reverse superseded_by edge on remote targets is NOT patched
      // (best-effort — see LearnContext.supersedes docs).
      relations: (context?.supersedes?.length ?? 0) > 0 ? {
        broader: [], narrower: [], related: [], conflicts: [],
        supersedes: context!.supersedes!, superseded_by: [],
      } : undefined,
      pinned: context?.pinned === true ? true : undefined,
    }
    // Echo marker for extracted expiry (#347) — mirrors the learn() stamping
    // so the remote-routed MCP response can confirm the parse too.
    if (validity.extracted) {
      ;(shape as any).structured_data = {
        _expiry_extracted: { valid_until: validity.extracted.valid_until, phrase: validity.extracted.phrase },
      }
    }
    return shape
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
      offendingHitsForScope: (statement: string, scope: string) => this._offendingHitsForScope(statement, scope),
    }
  }

  /** Async learn with LLM-driven deduplication (Ideas 1+2+19). */
  async learnAsync(statement: string, context?: LearnAsyncContext): Promise<LearnAsyncResult> {
    const { learnAsync: learnAsyncImpl } = await import('./learn-async.js')
    return learnAsyncImpl(this._learnAsyncDeps(), statement, context)
  }

  /** Batch learn with LLM dedup. LLM calls are capped (default 50) to bound bulk-import cost. */
  async learnBatch(
    statements: Array<{ statement: string; context?: LearnAsyncContext }>,
    llm?: LlmFunction,
    opts?: { maxLlmCalls?: number },
  ): Promise<LearnBatchResult> {
    const { learnBatch: learnBatchImpl } = await import('./learn-async.js')
    return learnBatchImpl(this._learnAsyncDeps(), statements, llm, opts)
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

  /** Search engrams using local embeddings. Async, no API calls. Routes through PGLite/pgvector when active (#226), with optional intent routing (#224) + cross-encoder rerank (#220). */
  async recallSemantic(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const filtered = this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const rerank = this._resolveRerankOptions(options?.rerank)
    const intent = this._resolveIntentProfile(query, options?.intentOverride)
    // Two over-fetch sources stack: intent routing wants headroom for its
    // re-rank, the reranker wants topK candidates. Take the larger; truncate
    // back to `limit` after both stages.
    const intentFetch = intent ? Math.max(limit * 2, limit + 10) : limit
    const rerankFetch = rerank ? Math.max(limit, rerank.topK ?? 50) : limit
    const fetchLimit = Math.max(intentFetch, rerankFetch)
    let results: Engram[]
    if (this.pgliteAdapter) {
      results = await this._pgliteSemanticRecall(query, fetchLimit, filtered)
    } else {
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
    this._reactivateResults(results)
    return results
  }

  /** Hybrid search: BM25 + embeddings merged via Reciprocal Rank Fusion. Async, no API calls. Delegates to recallHybridWithMeta so it gets intent/rerank/PGLite routing too. */
  async recallHybrid(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const result = await this.recallHybridWithMeta(query, options)
    return result.engrams
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
    const rerank = this._resolveRerankOptions(options?.rerank)
    const intent = this._resolveIntentProfile(query, options?.intentOverride)
    // When intent routing is on we over-fetch from the hybrid call WITHOUT the
    // reranker, apply intent routing, then run the reranker on the routed set.
    // When intent is off the hybrid call handles reranking inline so the
    // PGLite and JSON paths stay symmetric.
    const intentLimit = intent ? Math.max(limit * 2, limit + 10) : limit
    let result: HybridSearchResult
    if (intent) {
      result = this.pgliteAdapter
        ? await this._pgliteHybridRecall(query, intentLimit, filtered)
        : await hybridSearchWithMeta(filtered, query, intentLimit, this.paths.root)
      let routed = applyIntentRouting(result.engrams, intent.profile)
      let rerankedCount = result.reranked
      if (rerank) {
        const reranked = await applyReranker(routed, query, rerank)
        routed = reranked.engrams
        rerankedCount = reranked.count
      }
      result = { ...result, engrams: routed.slice(0, limit), reranked: rerankedCount }
    } else if (this.pgliteAdapter) {
      result = await this._pgliteHybridRecall(query, limit, filtered, rerank)
    } else {
      result = await hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank)
    }
    this._reactivateResults(result.engrams)
    // WS5 demand flywheel: a zero-result or low-top-score recall is a demand
    // signal. Emit an anonymized, content-free miss-signal (query fingerprint +
    // scope/domain + timestamp; never the raw query). Opt-in/default-off and
    // fire-and-forget — never disturbs the recall path. (topScore is null on the
    // PGLite path, which doesn't surface an RRF fusion score; the count-based
    // miss still fires.)
    void emitMissSignal({
      query,
      scope: options?.scope,
      domain: options?.domain,
      resultCount: result.engrams.length,
      topScore: result.topScore ?? null,
    }).catch(() => {})
    return result
  }

  /** Resolve the cross-encoder rerank options for a call (#220). */
  private _resolveRerankOptions(rerank?: boolean): RerankOptions | undefined {
    if (rerank === false) return undefined
    if (rerank === true) {
      // Explicit opt-in: if PLUR_RERANKER is off (the default), upgrade to
      // bge-reranker-v2-m3 for this call only so opt-in actually does something.
      const envName = resolveRerankerName()
      const name = envName === 'off' ? 'bge-reranker-v2-m3' : envName
      this._reranker = getReranker(name)
      this._maybeLogRerankerEvalAdvisory(name)
      return { reranker: this._reranker }
    }
    // Implicit: follow the env. Off → undefined so the stage is skipped.
    const envName = resolveRerankerName()
    if (envName === 'off') return undefined
    if (!this._reranker || isRerankerOff(this._reranker)) {
      this._reranker = getReranker(envName)
    }
    this._maybeLogRerankerEvalAdvisory(envName)
    return { reranker: this._reranker }
  }

  /**
   * Reranker-enable path advisory (#451): when this store's cached self-eval
   * says the resolved reranker is net-negative HERE, warn once per instance.
   * Never disables anything — the loud-once log is the whole intervention.
   */
  private _maybeLogRerankerEvalAdvisory(rerankerName: string): void {
    if (this._rerankerEvalAdvisoryDone) return
    this._rerankerEvalAdvisoryDone = true
    try {
      logRerankerEvalAdvisory(this.paths.root, rerankerName, this._filterEngrams().length)
    } catch { /* advisory must never break recall */ }
  }

  /**
   * Run the per-store reranker self-eval gate (#451): sample this store's own
   * engrams, synthesize probe queries from their statements, and compare the
   * cross-encoder's ordering against RRF-only. Returns the cached verdict when
   * fresh (same reranker, within the staleness bound, store size stable)
   * unless `force` is set. The result is persisted to `.reranker-eval.json`
   * in the store root and surfaced by plur_doctor + the enable-path advisory.
   */
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
    const name = options?.reranker ?? resolveRerankerName()
    if (name === 'off') {
      throw new Error(
        'No reranker configured — set PLUR_RERANKER (or pass { reranker }) to run the per-store self-eval.',
      )
    }
    const engrams = this._filterEngrams()
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
  }

  /**
   * Read this store's cached reranker self-eval verdict (#451) without
   * running anything. Returns null when the store has never been evaluated
   * for the given (or env-resolved) reranker.
   */
  rerankerEvalStatus(rerankerName?: string): { result: RerankerEvalResult; stale: boolean } | null {
    const name = rerankerName ?? resolveRerankerName()
    if (name === 'off') return null
    const cached = loadRerankerEvalCache(this.paths.root)[name]
    if (!cached) return null
    return { result: cached, stale: isRerankerEvalStale(cached, this._filterEngrams().length) }
  }

  /**
   * Probe whether the configured reranker produces useful signal on this
   * store's engrams (#451). Scores same-domain vs cross-domain pairs and
   * returns a separability measure — callers use it to decide whether to
   * enable the reranker by default.
   *
   * @param opts.sampleSize  Max engrams to sample (default 100).
   * @param opts.rerankerName  Which reranker to probe (default: PLUR_RERANKER).
   */
  async checkRerankerFit(opts?: { sampleSize?: number; rerankerName?: string }): Promise<FitCheckResult> {
    const name = (opts?.rerankerName as RerankerName | undefined) ?? resolveRerankerName()
    const adapter = getReranker(name === 'off' ? undefined : name)
    const engrams = this.list().map(e => ({ statement: e.statement, domain: e.domain }))
    return checkRerankerFit(engrams, adapter, { sampleSize: opts?.sampleSize })
  }

  /** Resolve the query-intent routing profile for a call (#224). undefined = no routing (general). */
  private _resolveIntentProfile(
    query: string,
    intentOverride?: QueryIntent,
  ): { intent: QueryIntent; profile: IntentRoutingProfile } | undefined {
    if (isIntentRoutingDisabled()) return undefined
    const intent: QueryIntent = intentOverride ?? classifyQuery(query).intent
    if (intent === 'general') return undefined
    return { intent, profile: routeForIntent(intent) }
  }

  /**
   * PGLite/pgvector hybrid recall (#226 B-1). Routes the vector portion through
   * the persistent pgvector index, intersects hits against the YAML-rooted
   * `filtered` set (the yaml-as-truth defense — a DB-only row can't surface),
   * RRF-fuses with BM25, then applies the optional rerank. Falls back to the
   * JSON-cache hybrid path on cold-start / embedder-unavailable / PGLite error.
   */
  private async _pgliteHybridRecall(
    query: string,
    limit: number,
    filtered: Engram[],
    rerank?: RerankOptions,
  ): Promise<HybridSearchResult> {
    if (!this.pgliteAdapter) {
      return hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank)
    }
    if (filtered.length === 0) {
      return { engrams: [], mode: 'hybrid', embedderError: null, topScore: null, reranked: 0 }
    }
    const { embed } = await import('./embeddings.js')
    const queryVec = await embed(query, 'query')
    const status = embedderStatus()
    if (!queryVec) {
      return hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank)
    }
    const wantReranker = rerank?.reranker && !isRerankerOff(rerank.reranker)
    const embLimit = Math.min(filtered.length, wantReranker ? Math.max(limit * 3, 50) : limit * 2)
    let pgHits: Engram[] = []
    try {
      const hits = await this.pgliteAdapter.searchVector(queryVec, embLimit)
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
    // #224 remainder: the lexical leg gets the deterministic rewrite, same
    // as the YAML-path hybridSearchWithMeta. Vector leg + reranker keep the
    // original query.
    const lexicalQuery = isQueryRewriteDisabled() ? query : rewriteLexicalQuery(query)
    const bm25Results = searchEngrams(filtered, lexicalQuery, bm25Limit)
    const merged = pgliteRrfMerge([bm25Results, pgHits])
    const reranked = await applyReranker(merged, query, rerank)
    const mode: HybridSearchResult['mode'] = status.disabled ? 'bm25-only' : 'hybrid'
    return { engrams: reranked.engrams.slice(0, limit), mode, embedderError: null, topScore: null, reranked: reranked.count }
  }

  /**
   * PGLite/pgvector semantic recall (#226 B-1). Vector search via pgvector,
   * intersected with the YAML-rooted `filtered` set. Falls back to the JSON
   * cache on cold-start / embedder-unavailable / PGLite error.
   */
  private async _pgliteSemanticRecall(query: string, limit: number, filtered: Engram[]): Promise<Engram[]> {
    if (!this.pgliteAdapter) return []
    const { embed } = await import('./embeddings.js')
    const queryVec = await embed(query, 'query')
    if (!queryVec) {
      return embeddingSearch(filtered, query, limit, this.paths.root)
    }
    try {
      const hits = await this.pgliteAdapter.searchVector(queryVec, Math.max(limit * 3, 50))
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
  }

  /** Inspect embedder availability without forcing a load. */
  embedderStatus(): EmbedderStatus {
    return embedderStatus()
  }

  /** Reset cached embedder failure state — next call will retry the model load. */
  resetEmbedder(): void {
    resetEmbedder()
  }

  /**
   * Inspect reranker runtime state (#341) — engaged/failed counters and the
   * last failure with its classification (corrupt-cache vs unavailable).
   * Lets doctor/recall surface "reranking requested but not happening".
   */
  rerankerStatus(): RerankerRuntimeStatus {
    return rerankerStatus()
  }

  /**
   * Reset cached reranker state (#341) — adapter cache, load-pipeline cache,
   * and the runtime failure tracker. The next rerank call retries the model
   * load from scratch (e.g. after purging a corrupt HF cache).
   */
  resetReranker(): void {
    _resetRerankerCache()
    _resetBgeRerankerCache()
    _resetMsMarcoMiniLmCache()
    resetRerankerStatus()
    this._reranker = null
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
  list(options?: { scope?: string; domain?: string; min_strength?: number; include_expired?: boolean }): Engram[] {
    return this._filterEngrams(options)
  }

  /** Filter engrams by scope/domain/strength (shared by both modes) */
  private _filterEngrams(options?: RecallOptions & { include_expired?: boolean }): Engram[] {
    let engrams: Engram[]
    if (this.indexedStorage) {
      engrams = this.indexedStorage.loadFiltered({
        status: 'active',
        scope: options?.scope,
        domain: options?.domain,
      })
    } else {
      // PGLite path (or no-index path): read from YAML so this code stays
      // synchronous. PGLite is currently used for vector/Cypher queries
      // and remains in sync via _syncIndex on every write — but the
      // filtered relational path here goes through the YAML cache for
      // sync semantics. _loadAllEngrams reads through a mtime-based cache,
      // so the cost is comparable.
      engrams = this._loadAllEngrams()
      engrams = engrams.filter(e => e.status === 'active')
      if (options?.domain) {
        engrams = engrams.filter(e => e.domain?.startsWith(options.domain!))
      }
      if (options?.scope) {
        const scope = options.scope
        // Read-side scope filter (#353). Keep the `startsWith` arm so an explicit
        // personal scope like `user:alice` still catches sub-scopes (e.g.
        // `user:alice:notes`). `isPersonalScope` passes ALL personal-family
        // scopes (local, global, user:*, agent:*), not just global — so a
        // project-scope recall sees personal engrams. D1-ASYMMETRY: an explicit
        // `global` recall therefore includes all personal-family engrams — wider
        // than `global` inject, which is targeted to global-only (see inject.ts
        // INJECT_GLOBAL_IS_TARGETED).
        engrams = engrams.filter(e =>
          isScopeWithin(e.scope, scope) || isPersonalScope(e.scope)
        )
      }
    }
    // Temporal validity: exclude expired or not-yet-valid engrams.
    // `include_expired` opts out — callers that need dedup-identity parity
    // with learn()'s content-hash gate (which ignores temporal validity,
    // e.g. the migration import engine, #441) must see the full active set.
    if (!options?.include_expired) {
      const today = new Date().toISOString().slice(0, 10)
      engrams = engrams.filter(e => {
        if (e.temporal?.valid_until && e.temporal.valid_until < today) return false
        if (e.temporal?.valid_from && e.temporal.valid_from > today) return false
        return true
      })
    }
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
      // Route through PGLite/pgvector when active (#226 B-1), intersecting hits
      // with the YAML-rooted `engrams` set; else the JSON cache path.
      let results: SimilarityResult[] = []
      if (this.pgliteAdapter) {
        const { embed } = await import('./embeddings.js')
        const queryVec = await embed(task, 'query')
        if (queryVec) {
          try {
            const hits = await this.pgliteAdapter.searchVector(queryVec, engrams.length)
            if (hits.length > 0) {
              const allowed = new Map<string, Engram>(engrams.map(e => [e.id, e]))
              for (const hit of hits) {
                const e = allowed.get(hit.engram.id)
                if (e) results.push({ engram: e, score: Math.max(0, Math.min(1, hit.score)) })
              }
            }
          } catch (err) {
            logger.warning(`[plur] PGLite searchVector failed in injectHybrid: ${(err as Error).message}.`)
          }
        }
      }
      if (results.length === 0) {
        results = await embeddingSearchWithScores(engrams, task, engrams.length, this.paths.root)
      }
      // Cross-encoder rerank stage (#220): replace the cosine boosts for the
      // top-K with the reranker's relevance, min-max normalized into [0,1] so
      // the selectAndSpread 0.5 threshold stays meaningful. Off by default.
      const rerank = this._resolveRerankOptions(options?.rerank)
      if (rerank && results.length > 0) {
        const topK = Math.max(1, Math.min(results.length, rerank.topK ?? 50))
        const head = results.slice(0, topK)
        try {
          const scores = await rerank.reranker!.scoreBatch(task, head.map(r => r.engram.statement))
          if (scores.length === head.length) {
            const min = Math.min(...scores)
            const max = Math.max(...scores)
            const span = max - min
            for (let i = 0; i < head.length; i++) {
              const normalized = span > 0 ? (scores[i] - min) / span : 0.5
              head[i] = { engram: head[i].engram, score: normalized }
            }
            head.sort((a, b) => b.score - a.score)
            results = [...head, ...results.slice(topK)]
          }
        } catch (err) {
          logger.warning(`[plur] injectHybrid reranker "${rerank.reranker!.name}" failed: ${(err as Error).message}. Falling back to cosine boosts.`)
        }
      }
      if (results.length > 0) {
        embeddingBoosts = new Map()
        for (const r of results) {
          embeddingBoosts.set(r.engram.id, r.score)
        }
      }
      // Intent-aware boost (#224): modest (<=1.5x) upweight for engrams matching
      // the query intent. Boost cap stays 1.0 so the 0.5 threshold keeps meaning.
      const intent = this._resolveIntentProfile(task, options?.intentOverride)
      if (intent && embeddingBoosts) {
        for (const e of results.map(r => r.engram)) {
          let mult = 1.0
          if (intent.profile.entityBoost !== 1.0 && isEntityDomain(e.domain)) {
            mult *= intent.profile.entityBoost
          }
          if (intent.profile.episodeBoost !== 1.0 && Array.isArray(e.episode_ids) && e.episode_ids.length > 0) {
            mult *= intent.profile.episodeBoost
          }
          if (intent.profile.recencyBoost !== 1.0) {
            const ts = e.activation?.last_accessed ?? e.temporal?.learned_at
            if (ts) {
              const days = (Date.now() - Date.parse(ts)) / (1000 * 60 * 60 * 24)
              if (Number.isFinite(days) && days >= 0) {
                const r = Math.exp(-days / 30) // half-life ~30 days
                mult *= 1.0 + r * (intent.profile.recencyBoost - 1.0)
              }
            }
          }
          if (mult !== 1.0) {
            const cur = embeddingBoosts.get(e.id) ?? 0
            embeddingBoosts.set(e.id, Math.min(1.0, cur * mult))
          }
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
        expiry: this.config.expiry,
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

    // Build per-pack injection counts for telemetry (session_end activation tracking).
    // Uses the `pack` field that selectAndSpread stamps onto every WireEngram —
    // null means the engram belongs to the user's personal store, not an installed pack.
    const injected_packs: Record<string, number> | undefined = injected_ids.length > 0
      ? (() => {
          const allEngrams = [
            ...result.directives,
            ...result.constraints,
            ...result.consider,
          ]
          const counts: Record<string, number> = {}
          for (const e of allEngrams) {
            const key = (e as any).pack ?? '__personal__'
            counts[key] = (counts[key] ?? 0) + 1
          }
          return counts
        })()
      : undefined

    // #452: log a co_injection provenance event — which engrams fired
    // together for which query context. Data source for the co-fires-with
    // edges (#200/#201) and temporal-replay self-labeling (#202). Compact by
    // design (IDs + query hash, never statements); best-effort — a history
    // write failure must never break injection.
    if (injected_ids.length > 0) {
      const injection_id = generateInjectionId()
      try {
        appendHistory(this.paths.root, {
          event: 'co_injection',
          engram_id: injection_id,
          timestamp: new Date().toISOString(),
          data: {
            ids: injected_ids,
            query_hash: computeQueryHash(task),
            // Event provenance for offline token-economics analysis of real
            // sessions (the plur-bench #42 measurement). Deliberately NOT read
            // by the receipt, which shows no token/cost figure by design.
            tokens_used: tokensUsed,
            source: options?.source ?? 'inject',
            ...(options?.scope ? { scope: options.scope } : {}),
            ...(options?.session_id ? { session_id: options.session_id } : {}),
          },
        })
        for (const id of injected_ids) this._lastInjectionByEngram.set(id, injection_id)
      } catch { /* best-effort */ }
    }

    // #181: surface persisted tensions touching this injection — flag,
    // don't adjudicate (audit #213 item 4).
    const warnings = this._tensionWarningsFor(injected_ids)

    return {
      directives: directivesStr,
      constraints: constraintsStr,
      consider: considerStr,
      count,
      tokens_used: tokensUsed,
      injected_ids,
      ...(injected_packs ? { injected_packs } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
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
      // Re-anchor last_accessed when feedback adjusts stored strength. Read-time
      // decay (inject.ts decayedStrength) is computed against last_accessed, so
      // bumping strength without advancing the anchor lets elapsed-time decay
      // immediately swallow the adjustment — a >4x distortion on stale engrams,
      // exactly the ones where a fade-vs-keep signal matters most. Mirrors the
      // strength+anchor pairing in _reactivateResults.
      if (signal !== 'neutral') {
        engram.activation.last_accessed = new Date().toISOString().slice(0, 10)
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

    if (found) {
      this._logInjectionOutcome(id, signal)
      return
    }

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
        // Re-anchor last_accessed so read-time decay doesn't swallow the bump
        // (see the primary-path note above).
        if (signal !== 'neutral') {
          engram.activation.last_accessed = new Date().toISOString().slice(0, 10)
        }
        this._writeEngrams(storeInfo.path, storeEngrams)
        this._syncIndex()
        this._logInjectionOutcome(id, signal)
        return
      }
    }

    // Check remote stores — the engram may live on an enterprise server.
    // See: https://github.com/plur-ai/plur/issues/85
    // The ID may be prefixed (ENG-GPL-...) from _loadAllEngrams namespacing.
    // Strip the prefix before querying the remote server. See: #86
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      const serverId = this._stripRemotePrefix(id, entry.scope)
      if (entry.readonly === true) {
        const roDriver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        const roFound = await roDriver.getById(serverId)
        if (roFound) throw new Error('Engram is in a readonly store')
        continue
      }
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      const found = await driver.getById(serverId)
      if (found) {
        await driver.feedback(serverId, signal)
        appendHistory(this.paths.root, {
          event: 'feedback_received',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { signal, routed_to: 'remote' },
        })
        this._logInjectionOutcome(id, signal)
        return
      }
    }

    // Search pack engrams by scanning pack directories
    this._feedbackPack(id, signal)
    this._logInjectionOutcome(id, signal)
  }

  /**
   * Log an injection_outcome event linking a feedback verdict to the
   * co_injection event the engram came from (#452). Only positive/negative
   * verdicts are outcomes — "ignored" is the absence of an outcome, so
   * neutral signals and feedback on never-injected engrams write nothing.
   * Link resolution: in-process map first, then a bounded history scan for
   * injections logged by another process (hook-inject, CLI).
   */
  private _logInjectionOutcome(engramId: string, signal: 'positive' | 'negative' | 'neutral'): void {
    if (signal === 'neutral') return
    try {
      const injectionId = this._lastInjectionByEngram.get(engramId)
        ?? findLatestInjectionFor(this.paths.root, engramId)?.injection_id
      if (!injectionId) return
      appendHistory(this.paths.root, {
        event: 'injection_outcome',
        engram_id: engramId,
        timestamp: new Date().toISOString(),
        data: { injection_id: injectionId, signal },
      })
    } catch { /* best-effort — outcome logging must never break feedback */ }
  }

  /**
   * Save extracted meta-engrams to the engram store. Skips IDs that already
   * exist.
   *
   * LOW-1 (#353): this is the one public persist method that runs NO part of the
   * scope-security stack (learn/learnRouted/learnAsync/updateEngram all guard;
   * saveMetaEngrams did not). Run the same guard before persisting each meta:
   *  - HARD `detectSecrets` check (mirrors learn/learnRouted) — a raw secret
   *    (API key, token, …) in a meta at a shared scope THROWS unless
   *    `config.allow_secrets`.
   *  - SOFT `_offendingHitsForScope` demotion (mirrors the explicit-update /
   *    learnAsync demotion paths) — infra-sensitive content (public IP, internal
   *    host, …) at a shared scope is DEMOTED in place to local/private and
   *    stamped with `_demoted{from,to,patterns}` rather than written at the
   *    requested shared scope. Local write, so demotion is coherent.
   *
   * No-op for all known in-tree callers: in-tree metas use personal scopes
   * (global/local), and `_offendingHitsForScope` returns [] for non-shared
   * scopes (the index.ts personal fast-path). Defense-in-depth: activates only
   * if a future caller passes a shared-scope meta.
   */
  saveMetaEngrams(metas: Engram[]): { saved: number; skipped: number } {
    return withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const existingIds = new Set(engrams.map(e => e.id))
      let saved = 0
      let skipped = 0
      for (const meta of metas) {
        if (existingIds.has(meta.id)) {
          skipped++
          continue
        }
        // LOW-1: guard each meta on the FULL content (statement + context
        // fields) at its scope before persist. Do NOT call _guardExplicitUpdate
        // (its warning text is the EXPLICIT-update path); inline the demotion
        // shape here so the message is meta-specific.
        const scope = meta.scope ?? 'global'
        const contextFields = this._engramContextFields(meta)
        const scanText = contextFields
          ? `${meta.statement}\n${JSON.stringify(contextFields)}`
          : meta.statement
        // HARD secret check — mirror learn()/learnRouted.
        if (!this.config.allow_secrets) {
          const secrets = detectSecrets(scanText)
          if (secrets.length > 0) {
            throw new Error(
              `Secret detected in meta-engram ${meta.id}: ${secrets[0].pattern}. ` +
              `Use config.allow_secrets to override.`,
            )
          }
        }
        // SOFT infra demotion — mirror the explicit-update / learnAsync paths.
        const hits = this._offendingHitsForScope(scanText, scope)
        if (hits.length > 0) {
          const patterns = [...new Set(hits.map(h => h.pattern))].join(', ')
          logger.warning(
            `[plur] sensitive content (${patterns}) held back from shared scope "${scope}" ` +
            `in meta-engram ${meta.id} — demoted to local/private so it is not written to a ` +
            `shared store. Re-scope deliberately if this is a false positive.`,
          )
          ;(meta as any).scope = 'local'
          ;(meta as any).visibility = 'private'
          ;(meta as any).structured_data = {
            ...((meta as any).structured_data ?? {}),
            _demoted: { from: scope, to: 'local', patterns },
          }
        }
        engrams.push(meta)
        saved++
      }
      if (saved > 0) {
        this._writeEngrams(this.paths.engrams, engrams)
        this._syncIndex()
      }
      return { saved, skipped }
    })
  }

  /** Update an existing engram in the store by ID. Returns true if found and updated.
   *
   * Sync path: only updates the local primary store. Use updateEngramAsync()
   * to ensure remote-routed updates are awaited (used by promote of remote
   * candidate engrams — closes the promote remainder of #86).
   */
  updateEngram(updated: Engram): boolean {
    // Local primary first.
    const localResult = withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const idx = engrams.findIndex(e => e.id === updated.id)
      if (idx === -1) return false
      // Leak guard (#353): local-resident → demote a sensitive update in place.
      // LOW-2: scan context fields too, not just the statement.
      const demote = this._guardExplicitUpdate(updated.statement, updated.scope, false, this._engramContextFields(updated))
      const toWrite = demote ? { ...updated, ...demote } : updated
      engrams[idx] = toWrite
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      return true
    })
    if (localResult) return true

    // Remote routing — fire-and-forget patch with key fields. Callers needing
    // strict ordering should use updateEngramAsync().
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url || entry.readonly === true) continue
      // Leak guard (#353): remote-resident, explicit update → THROW on a
      // forbidden hit (no coherent demotion for a remote engram).
      // LOW-2: scan context fields too, not just the statement.
      this._guardExplicitUpdate(updated.statement, entry.scope, true, this._engramContextFields(updated))
      const serverId = this._stripRemotePrefix(updated.id, entry.scope)
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      // PATCH a focused subset — full-engram PATCH would require strict
      // schema mirroring on the server and is not what enterprise PR #111
      // exposes. Send the fields most commonly mutated by the callers
      // (setPinned, promote, reportFailure).
      void driver.patch(serverId, {
        pinned: updated.pinned,
        status: updated.status,
        statement: updated.statement,
      })
      return true
    }
    return false
  }

  /**
   * Async variant of updateEngram that awaits remote PATCH for ordering
   * guarantees. Returns the patched engram (server-authoritative view)
   * on remote success, null if not found locally or remotely.
   */
  async updateEngramAsync(updated: Engram): Promise<Engram | null> {
    // Local primary first.
    const localResult = withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const idx = engrams.findIndex(e => e.id === updated.id)
      if (idx === -1) return null
      // Leak guard (#353): local-resident → demote a sensitive update in place.
      // LOW-2: scan context fields too, not just the statement.
      const demote = this._guardExplicitUpdate(updated.statement, updated.scope, false, this._engramContextFields(updated))
      const toWrite = demote ? { ...updated, ...demote } : updated
      engrams[idx] = toWrite
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      return toWrite
    })
    if (localResult) return localResult

    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url || entry.readonly === true) continue
      // Leak guard (#353): remote-resident, explicit update → THROW on a
      // forbidden hit (no coherent demotion for a remote engram).
      // LOW-2: scan context fields too, not just the statement.
      this._guardExplicitUpdate(updated.statement, entry.scope, true, this._engramContextFields(updated))
      const serverId = this._stripRemotePrefix(updated.id, entry.scope)
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      const patched = await driver.patch(serverId, {
        pinned: updated.pinned,
        status: updated.status,
        statement: updated.statement,
      })
      if (patched) return patched
    }
    return null
  }

  /**
   * Toggle the always-load (pinned) flag for an engram.
   * Returns the updated engram on success, null if not found.
   */
  setPinned(id: string, pinned: boolean): Engram | null {
    // Local primary first.
    const localResult = withLock(this.paths.engrams, () => {
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
    if (localResult) return localResult

    // Remote routing (closes #86 pin remainder). Strip the namespace prefix
    // before sending the server the unprefixed ID it knows about.
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url || entry.readonly === true) continue
      const serverId = this._stripRemotePrefix(id, entry.scope)
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      try {
        // Note: PATCH is async but setPinned() preserves its sync API for
        // backward compat. We block on a sync-bridge via deasync would be
        // bad; instead we do a fire-and-forget mutation and let the next
        // load() observe the change. The local cache invalidates on patch.
        // Callers needing strict ordering should call setPinnedAsync (TODO).
        void driver.patch(serverId, { pinned: pinned === true ? true : undefined })
        // Return a synthesized view of the expected result so callers don't
        // see null. The real engram comes back on next load() / getById().
        return { id, pinned: pinned === true ? true : undefined } as unknown as Engram
      } catch {
        continue
      }
    }
    return null
  }

  /**
   * Async variant of setPinned that awaits remote PATCH so callers can
   * observe the post-write state. Use this when ordering matters
   * (e.g. test assertions immediately after a pin call).
   */
  async setPinnedAsync(id: string, pinned: boolean): Promise<Engram | null> {
    // Local primary first.
    const localResult = withLock(this.paths.engrams, () => {
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
    if (localResult) return localResult

    // Remote routing
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url || entry.readonly === true) continue
      const serverId = this._stripRemotePrefix(id, entry.scope)
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      const patched = await driver.patch(serverId, { pinned: pinned === true ? true : undefined })
      if (patched) return patched
    }
    return null
  }

  /** List engrams that have pinned: true. */
  listPinned(): Engram[] {
    const all = this._loadAllEngrams()
    return all.filter(e => (e as any).pinned === true && e.status === 'active')
  }

  /** Set engram status to 'retired'. Supports primary and store engrams. */
  async forget(id: string, reason?: string): Promise<void> {
    // Check primary first.
    // Reference-counted retirement (#107): decrement reference_count; only
    // physically retire when it reaches 0. forget() called N times on an
    // engram with reference_count=N retires it; called fewer times, the
    // engram stays active with a lower count.
    const foundInPrimary = withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false

      // Audit iter-2 fix (Data): for legacy engrams created before #107
      // landed, `reference_count` is missing. Defaulting to 1 means the
      // first forget() retires them even if they have multiple sources
      // (i.e., the engram was learned multiple times pre-feature). Infer
      // from sources[] length when available so legacy cross-store dups
      // don't get prematurely retired.
      const currentCount = (engram as any).reference_count
        ?? Math.max(1, ((engram as any).sources?.length ?? 1))
      const newCount = Math.max(0, currentCount - 1)
      ;(engram as any).reference_count = newCount

      if (newCount === 0) {
        engram.status = 'retired'
        if (reason && !engram.rationale) {
          engram.rationale = `Retired: ${reason}`
        }
      }

      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      appendHistory(this.paths.root, {
        event: newCount === 0 ? 'engram_retired' : 'engram_decremented',
        engram_id: id,
        timestamp: new Date().toISOString(),
        data: {
          reason: reason ?? null,
          reference_count_before: currentCount,
          reference_count_after: newCount,
        },
      })
      return true
    })

    if (foundInPrimary) return

    // Check stores for namespaced IDs.
    // Audit iter-1 fix (Taleb): apply same reference-count decrement as
    // primary store. The original implementation retired secondary-store
    // engrams unconditionally on the first forget() call regardless of
    // reference_count — asymmetric with primary-store behavior and breaks
    // the #107 contract for cross-store engrams.
    const storeInfo = this._findEngramStore(id)
    if (storeInfo && storeInfo.path !== this.paths.engrams) {
      if (storeInfo.readonly) {
        throw new Error('Cannot retire engram from readonly store')
      }
      const storeEngrams = loadEngrams(storeInfo.path)
      const engram = storeEngrams.find(e => e.id === storeInfo.originalId)
      if (engram) {
        // Same legacy-engram migration as primary path (audit iter-2, Data).
        const currentCount = (engram as any).reference_count
          ?? Math.max(1, ((engram as any).sources?.length ?? 1))
        const newCount = Math.max(0, currentCount - 1)
        ;(engram as any).reference_count = newCount

        if (newCount === 0) {
          engram.status = 'retired'
          if (reason && !engram.rationale) {
            engram.rationale = `Retired: ${reason}`
          }
        }

        this._writeEngrams(storeInfo.path, storeEngrams)
        this._syncIndex()
        appendHistory(this.paths.root, {
          event: newCount === 0 ? 'engram_retired' : 'engram_decremented',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: {
            reason: reason ?? null,
            reference_count_before: currentCount,
            reference_count_after: newCount,
            routed_to: 'secondary-store',
          },
        })
        return
      }
    }

    // Check remote stores — the engram may live on an enterprise server.
    // See: https://github.com/plur-ai/plur/issues/84
    // Strip store prefix before querying remote. See: #86
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      const serverId = this._stripRemotePrefix(id, entry.scope)
      if (entry.readonly === true) {
        // Check if the engram exists here before throwing, so readonly
        // errors are specific ("cannot retire from readonly") not generic.
        const roDriver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        const roFound = await roDriver.getById(serverId)
        if (roFound) throw new Error('Cannot retire engram from readonly store')
        continue
      }
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      const found = await driver.getById(serverId)
      if (found) {
        const removed = await driver.remove(serverId)
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

  // batchDecay() was removed 2026-07-14. Decay is a pure function of
  // last_accessed and is computed at READ time (see inject.ts — decayedStrength
  // on every candidate); reinforcement re-anchors last_accessed on access
  // (_reactivateResults). A scheduled batch that MATERIALIZED decay back into
  // the store was redundant with that model AND wrong: it lowered stored
  // strength without advancing last_accessed, so read-time decay then
  // double-counted — an untouched engram decayed by (elapsed × how many times
  // the cron fired), not by elapsed time. It also rewrote the whole YAML store
  // on a schedule, which (a) produced the whole-store-overwrite data-loss bug,
  // (b) turned every sync into churn on values that are a pure function of the
  // data, and (c) buried real provenance in git history. PLUR does not need a
  // decay cron. Physical archival of long-cold engrams, if ever wanted, should
  // be an explicit, reversible, logged maintenance op — not this.

  /**
   * Rebuild the derived index from YAML source of truth.
   * Works for both backends: SQLite (legacy) and PGLite (ADR-0001).
   * Sync-shaped to preserve the existing public API; PGLite work is fired off
   * and the promise tracked on the instance so `await plur.reindexAsync()` is
   * available for code paths that need to block.
   */
  reindex(): void {
    if (this.pgliteAdapter) {
      // Fire-and-track. Callers that need to block use reindexAsync().
      const adapter = this.pgliteAdapter
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
    this.indexedStorage.reindex()
  }

  /**
   * Async reindex that resolves when the index is fully rebuilt.
   * Equivalent to `plur sync --full`: drop the index and rebuild from YAML.
   */
  async reindexAsync(): Promise<void> {
    if (this.pgliteAdapter) {
      await this.pgliteAdapter.reindex()
      await this._autoEmbedNewEngrams(this.pgliteAdapter)
      return
    }
    if (!this.indexedStorage) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
    this.indexedStorage.reindex()
  }

  /**
   * Embed any active engrams missing a row in engram_embeddings and upsert them
   * (#226 B-1). Runs after every syncFromYaml/reindex so learn()/learnAsync()/
   * sync() keep the PGLite vector index in step with YAML. Skips silently when
   * the embedder is unavailable (recall on those engrams degrades to the JSON
   * path until the next cycle) or when the active embedder dim differs from the
   * indexed column (run `plur sync --reembed --full` to migrate intentionally).
   */
  private async _autoEmbedNewEngrams(adapter: PGLiteAdapter): Promise<void> {
    try {
      const { embed } = await import('./embeddings.js')
      const indexedDim = await adapter.getVectorColumnDim()
      if (indexedDim !== null && getEmbedder(resolveEmbedderName()).dim !== indexedDim) {
        logger.debug(`[plur] auto-embed skip: active embedder dim differs from indexed column (${indexedDim}). Run 'plur sync --reembed --full' to migrate.`)
        return
      }
      const active = this._loadAllEngrams().filter(e => e.status === 'active' && !(e as any)._originalId && !(e as any)._pack)
      if (active.length === 0) return
      const { engramSearchText } = await import('./fts.js')
      for (const engram of active) {
        if (await adapter.hasEmbedding(engram.id)) continue
        const vec = await embed(engramSearchText(engram))
        if (!vec) return // embedder unavailable — next cycle retries
        await adapter.upsertEmbedding(engram.id, vec)
      }
    } catch (err) {
      this._recordIndexError('auto-embed', err)
      logger.warning(`[plur] auto-embed failed: ${(err as Error).message}`)
    }
  }

  /** Record a background index failure for later surfacing (#272). */
  private _recordIndexError(op: IndexSyncError['op'], err: unknown): void {
    this._lastIndexError = {
      op,
      message: (err as Error)?.message ?? String(err),
      at: new Date().toISOString(),
    }
  }

  /**
   * Last background index failure, or null when the most recent pass
   * succeeded (#272). The background chains (initial sync, syncFromYaml,
   * reindex, auto-embed) swallow rejections so waitForIndex() never throws;
   * this is the state-based surface for CLI/MCP callers. Also included in
   * status().index_error.
   */
  lastIndexError(): IndexSyncError | null {
    return this._lastIndexError
  }

  /** Sync index after YAML write (no-op if no index is active). */
  private _syncIndex(): void {
    if (this.pgliteAdapter) {
      // Synchronous-shaped path: kick off the sync, track the promise.
      // The YAML write already happened — this is the index catching up, then
      // auto-embed any new engrams so they're vector-searchable.
      const adapter = this.pgliteAdapter
      this._lastIndexError = null // new pass — stale failures cleared on success
      this._pgliteInitPromise = adapter.syncFromYaml()
        .then(() => this._autoEmbedNewEngrams(adapter))
        .catch((err: unknown) => {
          this._recordIndexError('sync-from-yaml', err)
          logger.warning(`[plur] PGLite syncFromYaml failed (YAML is still source of truth): ${(err as Error).message}`)
        })
      return
    }
    if (this.indexedStorage) {
      this.indexedStorage.syncFromYaml()
    }
  }

  /** Block until any in-flight PGLite background sync completes. Useful in tests. */
  async waitForIndex(): Promise<void> {
    if (this._pgliteInitPromise) {
      await this._pgliteInitPromise
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
      // Re-anchor last_accessed so read-time decay doesn't swallow the bump
      // (see the primary-path note in feedback()).
      if (signal !== 'neutral') {
        engram.activation.last_accessed = new Date().toISOString().slice(0, 10)
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

  /**
   * Install a pack from a source path. Runs security scan (blocks on secrets
   * and on prompt-injection text unless opts.allowInjection), clamps host-
   * overriding fields (pinned / locked), detects conflicts, records in registry.
   */
  installPack(source: string, opts?: { allowInjection?: boolean }): ReturnType<typeof installPack> {
    const existing = this._loadAllEngrams()
    return installPack(this.paths.packs, source, existing, opts)
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

  /**
   * Sync engrams to git AND refresh the derived index from YAML.
   *
   * Behavior:
   *   - default: git push/pull + incremental syncFromYaml on the active index
   *   - { full: true }: git push/pull + drop-and-rebuild the index from YAML
   *
   * The `--full` mode is the recovery path for "the index is wrong" — it
   * deletes every row in the derived index and replays YAML. YAML is never
   * touched in either mode.
   */
  sync(remote?: string, options?: { full?: boolean; remoteType?: SyncRemoteType }): SyncResult {
    // #640: explicit option > config.sync.remote_type > 'personal' (historical
    // mirror-everything default — `shared` is an explicit opt-in that filters
    // the push set to shared-scope, non-private engrams).
    const remoteType = options?.remoteType ?? this.config.sync?.remote_type ?? 'personal'
    const result = gitSync(this.paths.root, remote, { remoteType })
    // After git pull, YAML may have changed — refresh the index.
    // PGLite path is the only backend that honors --full directly here; the
    // legacy SQLite path also reindexes on full, otherwise calls syncFromYaml.
    if (options?.full) {
      this.reindex()
    } else {
      this._syncIndex()
    }
    return result
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

      // R2-D (#12): re-run the leak guard against the TARGET scope's CURRENT
      // policy before re-pushing. The _outbox marker is only stamped after the
      // write-time guard ran at queue-time, but that verdict can go stale: if a
      // user tightens the scope's `sensitivity.forbid` between queue-time and
      // flush-time (up to the 7-day TTL later), a now-offending engram would
      // otherwise be pushed to the shared store unguarded. Re-scan and, if it
      // now offends, demote in place (scope→local/private, drop _outbox) and
      // skip the push — honoring the current policy, matching the "single source
      // of truth on every write" guarantee the other egress paths uphold.
      const scanText = (() => {
        const fields = this._engramContextFields(cleanEngram as Engram)
        return fields ? `${cleanEngram.statement}\n${JSON.stringify(fields)}` : cleanEngram.statement
      })()
      const offending = this._offendingHitsForScope(scanText, outbox.target_scope)
      if (offending.length > 0) {
        const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
        const localIdx = engrams.findIndex(e => e.id === engram.id)
        if (localIdx !== -1) {
          const local = engrams[localIdx] as any
          const lsd = { ...(local.structured_data ?? {}) }
          delete lsd._outbox
          lsd._demoted = { from: outbox.target_scope, to: 'local', patterns }
          local.structured_data = lsd
          local.scope = 'local'
          local.visibility = 'private'
        }
        expired_warnings.push(
          `${engram.id}: sensitive content (${patterns}) now forbidden by scope ${outbox.target_scope}'s policy — demoted to local/private, not pushed`,
        )
        logger.warning(
          `[plur:outbox] ${engram.id} held back from "${outbox.target_scope}" — policy tightened since queue-time; demoted to local/private (${patterns}).`,
        )
        failed++
        continue
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
  ): Promise<{ engram: Engram; episode: Episode; evolved: boolean; blocked?: boolean }> {
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

          // Try local primary first.
          const localResult = withLock(this.paths.engrams, () => {
            const engrams = loadEngrams(this.paths.engrams)
            const idx = engrams.findIndex(e => e.id === engramId)
            if (idx === -1) return null

            const raw = engrams[idx] as any
            const oldStatement = raw.statement
            const oldVersion = raw.engram_version ?? 1

            raw.statement = improved.trim()
            // Leak guard (#353): the LLM-improved statement can introduce
            // sensitive content. This is a local write, so demotion is coherent:
            // hold it back from the shared scope by demoting to local/private.
            const localOffending = this._offendingHitsForScope(raw.statement, raw.scope ?? 'global')
            if (localOffending.length > 0) {
              const patterns = [...new Set(localOffending.map(h => h.pattern))].join(', ')
              logger.warning(
                `[plur] sensitive content (${patterns}) held back from shared scope "${raw.scope}" — ` +
                `demoted to local/private so it is not written to a shared store. ` +
                `Re-scope deliberately if this is a false positive.`,
              )
              raw.scope = 'local'
              raw.visibility = 'private'
            }
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
          if (localResult) return localResult

          // Remote routing (#86 reportFailure remainder): the engram lives
          // on a remote store. PATCH the new statement; history stays local.
          let blockedRemote = false
          for (const entry of (this.config.stores ?? [])) {
            if (!entry.url || entry.readonly === true) continue
            // Leak guard (#353): this is an AUTONOMOUS push to a shared/remote
            // store — there is no coherent demotion (we can't silently re-scope
            // someone else's remote engram). If the improved statement carries
            // content this scope forbids, SKIP the push entirely and warn. Never
            // throw: reportFailure is a background flow and must not crash.
            const remoteOffending = this._offendingHitsForScope(improved.trim(), entry.scope)
            if (remoteOffending.length > 0) {
              const patterns = [...new Set(remoteOffending.map(h => h.pattern))].join(', ')
              logger.warning(
                `[plur] sensitive content (${patterns}) blocked from remote shared scope "${entry.scope}" — ` +
                `procedure evolution NOT pushed. The remote engram is unchanged.`,
              )
              blockedRemote = true
              continue
            }
            const serverId = this._stripRemotePrefix(engramId, entry.scope)
            const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
            const patched = await driver.patch(serverId, { statement: improved.trim() })
            if (patched) {
              appendHistory(this.paths.root, {
                event: 'procedure_evolved',
                engram_id: engramId,
                timestamp: now,
                data: {
                  event_id: eventId,
                  old_statement: engram.statement,
                  new_statement: improved.trim(),
                  old_version: (engram as any).engram_version ?? 1,
                  new_version: ((engram as any).engram_version ?? 1) + 1,
                  failure_context: failureContext,
                  failure_episode_id: episode.id,
                  routed_to: 'remote',
                },
              })
              evolved = true
              return { engram: patched, episode, evolved }
            }
          }
          // Leak guard (#353): every candidate remote was skipped because the
          // improved statement was sensitive for its scope. The remote engram is
          // intentionally left unchanged — report a not-evolved/blocked outcome
          // (the failure episode is still linked below) instead of throwing.
          if (blockedRemote) {
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
            return { engram, episode, evolved: false, blocked: true }
          }
          // Neither local nor remote had it — defensive fallback (should not
          // happen since getById succeeded at top of function).
          throw new Error(`Engram not found in any store: ${engramId}`)
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
  status(options?: { created_after?: string; domain?: string }): StatusResult {
    const engrams = this._loadAllEngrams()
    const episodes = queryTimeline(this.paths.episodes)
    const packs = listPacks(this.paths.packs)

    let active = engrams.filter(e => e.status !== 'retired')
    if (options?.domain) {
      active = active.filter(e => e.domain?.startsWith(options.domain!))
    }
    if (options?.created_after) {
      const cutoff = options.created_after
      active = active.filter(e => { const d = engramDate(e); return d !== undefined && d >= cutoff })
    }
    const lockedCount = active.filter(e => (e as any).commitment === 'locked').length
    // #181 (audit #213 C2): tension_count counts UNRESOLVED persisted
    // tension records — the LLM-validated detector's output — instead of
    // relations.conflicts, which post-#138 holds only unvalidated importer
    // heuristics (or nothing, post-purge).
    const unresolvedTensions = this.listTensions({ status: ['detected', 'confirmed'] }).length

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
      tension_count: unresolvedTensions,
      versioned_engram_count: versionedCount,
      outbox_count: this.outboxCount(),
      history_events: countInjectionEvents(this.paths.root),
      ...(this._lastIndexError ? { index_error: this._lastIndexError } : {}),
    }
  }

  /**
   * Counted report of what memory retrieved for this user — the "memory
   * receipt". Local and read-only: reads the primary engram store, installed
   * packs and the co_injection history, and transmits nothing.
   *
   * Scoped to LOCAL memory (primary store + installed packs). Remote/team
   * stores are deliberately excluded so the number is identical whether called
   * from the cold CLI or the warm MCP server; retrievals of team engrams are
   * reported separately as `external_retrieved` rather than counted as deleted.
   */
  receipt(options?: { days?: number; now?: Date }): Receipt {
    const primary = this._loadCached(this.paths.engrams).filter(e => e.status === 'active')
    const ownIds = primary.map(e => e.id)

    // Statement snippets for the "most relied on" list, so it reads as memories
    // rather than opaque ids. Built only from LOCAL engrams (primary store +
    // installed packs); remote/team-store statements are never included. The
    // snippet is sanitized downstream and does surface in the MCP result, but
    // only for the caller's own engrams — content that agent already receives
    // via injection, so no new disclosure.
    const statements: Record<string, string> = {}
    for (const e of primary) {
      if (typeof e.statement === 'string') statements[e.id] = e.statement
    }

    const packIds: string[] = []
    for (const pack of loadAllPacks(this.paths.packs)) {
      for (const e of pack.engrams) {
        if (e.status === 'active') {
          packIds.push(e.id)
          if (typeof e.statement === 'string') statements[e.id] = e.statement
        }
      }
    }

    // A retrieved id namespaced with a configured store's prefix (ENG-DFU-…) is
    // a team-store engram this local receipt doesn't scope — mark those prefixes
    // so they read as external, not as retired.
    const externalPrefixes: string[] = []
    for (const store of this.config.stores ?? []) {
      const p = storePrefix(store.scope)
      externalPrefixes.push(`ENG-${p}-`, `ABS-${p}-`, `META-${p}-`)
    }

    return gatherReceipt(this.paths.root, ownIds, packIds, externalPrefixes, { ...options, statements })
  }

  // ------------------------------------------------------------------
  // Tension lifecycle (#181) — persistence, confirm/dismiss/resolve.
  // ------------------------------------------------------------------

  /** List persisted tension records, optionally filtered by status. */
  listTensions(filter?: { status?: TensionStatus[] }): TensionRecord[] {
    const records = loadTensions(this.paths.tensions)
    if (!filter?.status?.length) return records
    const wanted = new Set(filter.status)
    return records.filter(r => wanted.has(r.status))
  }

  /**
   * Canonical pair keys of every recorded tension — the scan exclusion set
   * (#181). Any recorded pair is excluded from future scans regardless of
   * status: dismissed/resolved pairs are suppressed, detected/confirmed
   * pairs are already adjudicated and must not re-pay the LLM judge.
   */
  suppressedTensionPairKeys(): string[] {
    return loadTensions(this.paths.tensions).map(r => tensionPairKey(r.engram_a, r.engram_b))
  }

  /**
   * Persist fresh scan detections as tension records (#181). Pairs already
   * recorded (any status) are returned as-is and counted in existing_count —
   * a scan can never duplicate or resurrect a record. New records get a
   * T-YYYY-MMDD-NNN id, a v1 category (categorizeTension), status
   * 'detected', and emit the `contradiction_detected` history event (the
   * event type existed since SP2 with zero emitters — audit #213 C5).
   */
  recordTensions(pairs: TensionPair[]): { records: TensionRecord[]; new_count: number; existing_count: number } {
    if (pairs.length === 0) return { records: [], new_count: 0, existing_count: 0 }
    const engramById = new Map(this._loadAllEngrams().map(e => [e.id, e]))
    return withLock(this.paths.tensions, () => {
      const all = loadTensions(this.paths.tensions)
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
          appendHistory(this.paths.root, {
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
      if (newCount > 0) saveTensions(this.paths.tensions, all)
      return { records: out, new_count: newCount, existing_count: existingCount }
    })
  }

  /** Locked mutation of a single tension record by id. */
  private _mutateTension(id: string, mutate: (r: TensionRecord) => void): TensionRecord {
    return withLock(this.paths.tensions, () => {
      const all = loadTensions(this.paths.tensions)
      const record = all.find(r => r.id === id)
      if (!record) throw new Error(`Tension ${id} not found`)
      mutate(record)
      saveTensions(this.paths.tensions, all)
      return record
    })
  }

  /** Mark a detected tension as a real conflict (detected → confirmed). */
  confirmTension(id: string): TensionRecord {
    return this._mutateTension(id, r => {
      if (r.status === 'resolved') throw new Error(`Tension ${id} is already resolved`)
      if (r.status === 'dismissed') throw new Error(`Tension ${id} is dismissed — re-scan cannot resurrect it; delete tensions.yaml entry manually if truly needed`)
      r.status = 'confirmed'
    })
  }

  /**
   * Dismiss a tension as a false positive (detected|confirmed → dismissed).
   * The pair stays in the scan exclusion set, so it is never re-flagged.
   */
  dismissTension(id: string): TensionRecord {
    return this._mutateTension(id, r => {
      if (r.status === 'resolved') throw new Error(`Tension ${id} is already resolved`)
      r.status = 'dismissed'
    })
  }

  /**
   * Resolve a tension by picking the winning engram: the loser is retired
   * outright (decisive — NOT reference-count-decremented like forget(), see
   * audit #213 §2), the record becomes status 'resolved' with resolved_by /
   * resolved_at set.
   */
  resolveTension(id: string, winnerId: string): { record: TensionRecord; retired_id: string } {
    const existing = this.listTensions().find(r => r.id === id)
    if (!existing) throw new Error(`Tension ${id} not found`)
    if (existing.status === 'resolved') throw new Error(`Tension ${id} is already resolved`)
    if (existing.status === 'dismissed') throw new Error(`Tension ${id} is dismissed`)
    if (winnerId !== existing.engram_a && winnerId !== existing.engram_b) {
      throw new Error(`Winner ${winnerId} is not part of tension ${id} (${existing.engram_a} vs ${existing.engram_b})`)
    }
    const loserId = winnerId === existing.engram_a ? existing.engram_b : existing.engram_a
    // Retire the loser FIRST — if retirement fails, the record stays
    // unresolved and the operation can be retried.
    const retired = this._retireEngramForResolution(loserId, `tension ${id} resolved in favor of ${winnerId}`)
    if (!retired) throw new Error(`Cannot retire losing engram ${loserId} (not found in a writable local store)`)
    const record = this._mutateTension(id, r => {
      r.status = 'resolved'
      r.resolved_by = winnerId
      r.resolved_at = new Date().toISOString()
    })
    return { record, retired_id: loserId }
  }

  /**
   * Unconditional retirement for tension resolution. Unlike forget(), does
   * NOT decrement reference_count — the user explicitly adjudicated this
   * engram as the losing side, so a multiply-learned loser must still die
   * (audit #213 §2: "a user who resolved a tension by forgetting the loser
   * may find it still active").
   */
  private _retireEngramForResolution(id: string, reason: string): boolean {
    const stamp = (engram: Engram): void => {
      engram.status = 'retired'
      if (!engram.rationale) engram.rationale = `Retired: ${reason}`
    }
    const foundInPrimary = withLock(this.paths.engrams, () => {
      const engrams = loadEngrams(this.paths.engrams)
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false
      stamp(engram)
      this._writeEngrams(this.paths.engrams, engrams)
      this._syncIndex()
      appendHistory(this.paths.root, {
        event: 'engram_retired',
        engram_id: id,
        timestamp: new Date().toISOString(),
        data: { reason },
      })
      return true
    })
    if (foundInPrimary) return true

    // Secondary local stores (namespaced ids) — mirrors forget()'s branch.
    const storeInfo = this._findEngramStore(id)
    if (storeInfo && storeInfo.path !== this.paths.engrams) {
      if (storeInfo.readonly) throw new Error('Cannot retire engram from readonly store')
      const storeEngrams = loadEngrams(storeInfo.path)
      const engram = storeEngrams.find(e => e.id === storeInfo.originalId)
      if (engram) {
        stamp(engram)
        this._writeEngrams(storeInfo.path, storeEngrams)
        this._syncIndex()
        appendHistory(this.paths.root, {
          event: 'engram_retired',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { reason },
        })
        return true
      }
    }
    return false
  }

  /**
   * True when the engram participates in an unresolved (detected|confirmed)
   * persisted tension. Gates commitment escalation into 'locked' (#181,
   * audit #213 item 3): contradicted knowledge must not lock.
   */
  hasUnresolvedTension(engramId: string): boolean {
    try {
      return loadTensions(this.paths.tensions).some(r =>
        (r.status === 'detected' || r.status === 'confirmed')
        && (r.engram_a === engramId || r.engram_b === engramId))
    } catch {
      return false
    }
  }

  /**
   * Injection warnings for persisted tensions (#181, audit #213 item 4 —
   * surface, don't adjudicate):
   * - confirmed tension: warn when EITHER side injects (the user vouched
   *   for the conflict being real; relying on one side blind is a hazard);
   * - detected tension: warn only when BOTH sides inject together.
   */
  private _tensionWarningsFor(injectedIds: string[]): string[] {
    if (injectedIds.length === 0) return []
    try {
      const unresolved = loadTensions(this.paths.tensions)
        .filter(r => r.status === 'detected' || r.status === 'confirmed')
      if (unresolved.length === 0) return []
      const injected = new Set(injectedIds)
      const clip = (t: string) => (t.length > 80 ? `${t.slice(0, 77)}...` : t)
      const warnings: string[] = []
      for (const r of unresolved) {
        const aIn = injected.has(r.engram_a)
        const bIn = injected.has(r.engram_b)
        const fires = r.status === 'confirmed' ? (aIn || bIn) : (aIn && bIn)
        if (!fires) continue
        warnings.push(
          `Tension ${r.id} (${r.status}, ${r.category}): "${clip(r.statement_a)}" [${r.engram_a}] contradicts "${clip(r.statement_b)}" [${r.engram_b}]. Consider resolving before relying on either.`,
        )
      }
      return warnings
    } catch {
      return [] // best-effort — a tension-store problem must never break injection
    }
  }

  /**
   * Resolved tension-scan defaults from config (#240). Consumers (MCP
   * plur_tensions, CLI) merge explicit args over these.
   */
  getTensionsConfig(): { temporal_domains: string[]; snapshot_pairs: 'skip' | 'floor'; temporal_discount: boolean } {
    const t = this.config.tensions ?? {}
    return {
      temporal_domains: t.temporal_domains ?? [],
      snapshot_pairs: t.snapshot_pairs ?? 'skip',
      temporal_discount: t.temporal_discount ?? false,
    }
  }

  /**
   * Write the reverse `relations.superseded_by` edge on each supersede
   * target present in the (already-loaded, lock-held) local engram list
   * (#240). Unknown targets are skipped silently — the forward edge on the
   * new engram still records the intent. Mutates in place; the caller's
   * subsequent _writeEngrams persists the change.
   */
  private _writeSupersededByEdges(engrams: Engram[], targetIds: string[], newId: string): void {
    for (const targetId of targetIds) {
      const target = engrams.find(e => e.id === targetId)
      if (!target) continue
      target.relations = target.relations ?? {
        broader: [], narrower: [], related: [], conflicts: [], supersedes: [], superseded_by: [],
      }
      target.relations.superseded_by = target.relations.superseded_by ?? []
      if (!target.relations.superseded_by.includes(newId)) {
        target.relations.superseded_by.push(newId)
      }
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
   *
   * Dedup semantics (#291):
   *   - REMOTE stores dedup by **url + scope**: a single enterprise URL
   *     legitimately hosts many scopes — the server filters reads per entry
   *     (`?scope=`), so multi-team users need one entry per authorized scope.
   *   - LOCAL stores dedup by **path only**: one engrams.yaml is one store.
   *     The loader clones global-scoped engrams into each entry's scope, so
   *     two entries on the same file would load those engrams twice.
   *
   * Returns the outcome so callers can report honestly: `added` (new entry
   * persisted), `already_registered` (idempotent no-op — `scope` is the
   * EXISTING entry's scope, which for local stores may differ from the
   * requested one), or `overwritten` (same scope reassigned to this endpoint
   * via overwriteScope).
   */
  /** mtime (ms) of config.yaml, or 0 if it cannot be stat'd. */
  private statConfigMtime(): number {
    try { return fs.statSync(this.paths.config).mtimeMs } catch { return 0 }
  }

  /**
   * Reload this.config from disk if config.yaml changed since the last load (#307).
   *
   * The MCP server holds ONE long-lived Plur instance, so a store added by
   * editing ~/.plur/config.yaml directly (or by another process) stays invisible
   * until the server restarts — and nothing hints why. The stores operations call
   * this first so a changed file is picked up on the next call instead of needing
   * a restart. Cheap: one statSync, reload only on an actual mtime change.
   *
   * @returns true if the config was reloaded.
   */
  private reloadConfigIfChanged(): boolean {
    const mtime = this.statConfigMtime()
    if (mtime === 0 || mtime === this.configMtimeMs) return false
    this.config = loadConfig(this.paths.config)
    this.configMtimeMs = mtime
    if (this.config.index) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
    logger.info('[plur] Reloaded config.yaml (changed on disk since last load)')
    return true
  }

  /** Persist a new stores list to config.yaml, preserving other keys, then
   *  refresh the in-memory config + mtime. Shared by addStore's append and
   *  token-rotation paths, and by persistScopeMetadata (which passes
   *  `serverSensitivityScopes` — see {@link mergeStoresForWriteback}).
   *
   *  The read-modify-write runs under {@link withLock} on config.yaml
   *  (scope-audit 2026-07-24): two concurrent persist paths (e.g. an MCP
   *  session_start metadata sync racing a CLI `plur stores add`) could each
   *  re-read the file and last-writer-wins away the other's change. Same
   *  lock discipline engrams.yaml has always had. Lock scope is kept tight —
   *  read + merge + write only; the in-memory refresh happens after release. */
  private persistStores(stores: StoreEntry[], opts?: { serverSensitivityScopes?: Set<string> }): void {
    withLock(this.paths.config, () => {
      let configData: Record<string, unknown> = {}
      // Read the existing config to preserve other top-level keys (auto_learn,
      // packs, embeddings, routing defaults, …). A TRANSIENT read failure on an
      // EXISTING file (EACCES, a concurrent truncating writer, a momentary FS
      // error) must NOT be swallowed: proceeding from `{}` would write a
      // stores-only file and silently drop every other top-level setting. Only an
      // ENOENT (the config genuinely doesn't exist yet) is safe to start from `{}`;
      // any other error aborts the writeback so we never truncate a live config.
      try {
        const raw = fs.readFileSync(this.paths.config, 'utf8')
        if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      configData.stores = this.mergeStoresForWriteback(configData.stores, stores, opts?.serverSensitivityScopes)
      fs.writeFileSync(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }))
    })
    this.config = loadConfig(this.paths.config)
    this.configMtimeMs = this.statConfigMtime()
  }

  /**
   * MERGE the typed `stores` array onto the RAW (freshly-read YAML) entries so a
   * writeback never strips fields the typed schema doesn't know about (PR-3,
   * #353 HIGH-17/18). `stores` is `StoreEntry[]` — the typed parse output —
   * which (without this) would clobber `configData.stores` and lose:
   *   - unknown/future TOP-LEVEL keys (recovered here; also kept by
   *     StoreEntrySchema.passthrough so the typed value already carries them)
   *   - unknown NESTED keys inside `sensitivity` (recovered by the explicit
   *     one-level deep-merge below; a shallow spread would replace `sensitivity`
   *     wholesale and lose them even with ScopeSensitivitySchema.passthrough)
   * Parsed deltas (e.g. a corrected `forbid`) land ON TOP of the raw values.
   *
   * `serverSensitivityScopes` (scope-audit 2026-07-24): the scopes whose typed
   * `sensitivity.forbid` is SERVER-AUTHORITATIVE for this writeback — i.e.
   * persistScopeMetadata just synced them from `/me` — so the raw-forbid
   * restore below must NOT undo the update for those entries. Every other
   * caller omits it and keeps the historical restore-raw behavior.
   */
  private mergeStoresForWriteback(rawStores: unknown, stores: StoreEntry[], serverSensitivityScopes?: Set<string>): StoreEntry[] {
    if (!Array.isArray(rawStores)) return stores
    // Key on url+scope (remote) or path+scope (local); never url alone — one
    // enterprise URL hosts many scopes (addStore dedup identity is url+scope).
    const keyOf = (e: { url?: unknown; path?: unknown; scope?: unknown }): string | null => {
      const scope = typeof e?.scope === 'string' ? e.scope : ''
      if (typeof e?.url === 'string') return `${e.url}\0${scope}`
      if (typeof e?.path === 'string') return `${e.path}\0${scope}`
      return null
    }
    const rawMap = new Map<string, Record<string, unknown>>()
    for (const r of rawStores as unknown[]) {
      const k = keyOf(r as Record<string, unknown>)
      if (k) rawMap.set(k, r as Record<string, unknown>)
    }
    return stores.map((typed) => {
      const k = keyOf(typed)
      const raw = k ? rawMap.get(k) : undefined
      if (!raw) {
        // No raw match (genuinely new entry, e.g. an addStore append) — or an
        // entry with neither url nor path (hand-edited; refine prevents at write
        // time). Use the typed entry as-is rather than dropping it.
        if (!k) logger.warning(`[plur:persistStores] store entry for scope "${typed.scope}" has neither url nor path — writing typed entry as-is`)
        return typed
      }
      const rawSensitivityValue = (raw as { sensitivity?: unknown }).sensitivity
      // The raw config is un-validated, un-salvaged on-disk YAML (persistStores
      // reads it via yaml.load, NOT loadConfig), so `sensitivity` can be ANYTHING
      // a hand-edit put there — including a truthy primitive (`sensitivity: 'oops'`,
      // `5`, `true`). loadConfig dedups nothing over `stores`, so a duplicate entry
      // on the same url+scope key can leave a primitive in rawMap (last-wins) while
      // the typed entry carries a proper object. Only treat raw sensitivity as a
      // mergeable object when it actually IS a plain object — otherwise the spreads
      // and the `in` operator below corrupt the merge or throw a TypeError.
      const rawSensitivity =
        rawSensitivityValue && typeof rawSensitivityValue === 'object' && !Array.isArray(rawSensitivityValue)
          ? (rawSensitivityValue as Record<string, unknown>)
          : undefined
      // R2-D (#14): `forbid` is a KNOWN field whose value is NORMALIZED at read
      // time (loadConfig's preprocess rewrites a forward-compat `forbid:['pii']`
      // to the safe default). A shallow `...typed.sensitivity` would then write
      // the normalized value over the raw one, ERASING the forward-compat
      // declaration on the first writeback. So when raw carried a `forbid` we
      // restore it verbatim — mirroring the nested-unknown preservation below.
      // This is the same version-skew writeback-strip class PR-3 closed for
      // nested unknowns.
      //
      // ONE deliberate exception (scope-audit 2026-07-24): persistScopeMetadata
      // DOES intentionally mutate `forbid` — it syncs the server-authoritative
      // policy from `/me` — and names the affected scopes in
      // `serverSensitivityScopes`. For those entries the typed (sanitized)
      // `forbid` must win, or the server's policy change is silently discarded
      // on every writeback and the metadata change-detector can never converge
      // (config.yaml rewritten on every session_start).
      const restoreRawForbid =
        rawSensitivity && 'forbid' in rawSensitivity && !serverSensitivityScopes?.has(typed.scope)
      const mergedSensitivity = typed.sensitivity
        ? {
            ...(rawSensitivity ?? {}),
            ...typed.sensitivity,
            ...(restoreRawForbid ? { forbid: rawSensitivity.forbid } : {}),
          }
        : rawSensitivity
      const merged: Record<string, unknown> = {
        ...raw,
        ...typed,
        // One-level deep-merge of `sensitivity`: parsed deltas over raw nested
        // unknowns. Without this explicit merge a shallow `...typed` would
        // replace `sensitivity` wholesale and lose nested unknowns.
        sensitivity: mergedSensitivity,
      }
      if (merged.sensitivity === undefined) delete merged.sensitivity
      return merged as StoreEntry
    })
  }

  addStore(
    storePath: string,
    scope: string,
    options?: { shared?: boolean; readonly?: boolean; url?: string; token?: string; overwriteScope?: boolean },
  ): { status: 'added' | 'already_registered' | 'overwritten' | 'token_rotated'; scope: string } {
    const isRemote = Boolean(options?.url)

    // Validation gate (#93): catch malformed URLs and duplicate scopes at
    // registration time instead of silently failing on first use.
    if (isRemote) {
      const url = options!.url!
      // Permissive URL check — must parse, must be http(s).
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(`addStore: invalid URL "${url}" — must be a valid http(s) URL`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`addStore: URL "${url}" has unsupported protocol "${parsed.protocol}" — must be http(s)`)
      }
    } else {
      if (!storePath || typeof storePath !== 'string') {
        throw new Error(`addStore: storePath must be a non-empty string, got ${typeof storePath}`)
      }
    }
    if (!scope || typeof scope !== 'string') {
      throw new Error(`addStore: scope must be a non-empty string, got ${typeof scope}`)
    }

    // Pick up any out-of-process config edit before we dedup/write (#307).
    this.reloadConfigIfChanged()
    const config = loadConfig(this.paths.config)

    // Dedup (#291): for REMOTE stores the URL alone is NOT the identity — a
    // single enterprise URL hosts many scopes (server filters reads per entry
    // via ?scope=), so only an exact url+scope match is "already registered".
    // Keying on URL alone used to drop every scope after the first while
    // still returning success.
    //
    // LOCAL stores keep path-only identity: one engrams.yaml is one store.
    // The loader clones global-scoped engrams into each entry's scope, so a
    // second scope on the same file would double-load those engrams.
    //
    // URL identity is NORMALIZED (scope-audit 2026-07-24): `https://x.com`,
    // `https://x.com/` and `https://x.com/sse` all name the same server
    // (RemoteStore.apiBase folds them at HTTP time), so an exact-string compare
    // here would happily register the same url+scope twice under two spellings.
    // Comparison-time only — the stored spelling is never rewritten.
    const sameEntry = config.stores?.find(s =>
      isRemote ? (s.url !== undefined && normalizeEndpointUrl(s.url) === normalizeEndpointUrl(options!.url!) && s.scope === scope)
               : (s.path === storePath),
    )
    if (sameEntry) {
      // Token rotation (#305): a matched remote endpoint with a NEW token means
      // the server-side token was rotated/expired and the caller is re-supplying
      // it. The old short-circuit returned 'already_registered' and silently kept
      // the stale token — the only workaround was hand-editing config.yaml. Update
      // the token in place instead.
      if (isRemote && options?.token !== undefined && options.token !== sameEntry.token) {
        const rotated = (config.stores ?? []).map(s =>
          s === sameEntry ? { ...s, token: options.token } : s,
        )
        this.persistStores(rotated)
        logger.info(`[plur:addStore] rotated token for ${options.url} (scope "${sameEntry.scope}")`)
        return { status: 'token_rotated', scope: sameEntry.scope }
      }
      return { status: 'already_registered', scope: sameEntry.scope }
    }

    // Different endpoint, same scope (#93): forbid by default to prevent
    // silent ambiguity ("which store does scope X belong to?"). Override
    // with options.overwriteScope=true to replace the existing entry.
    const scopeConflict = config.stores?.find(s => s.scope === scope)
    if (scopeConflict) {
      if (options?.overwriteScope !== true) {
        const existingId = scopeConflict.url ?? scopeConflict.path
        throw new Error(
          `addStore: scope "${scope}" is already registered to a different store (${existingId}). ` +
          `Pass overwriteScope: true to replace, or pick a unique scope.`,
        )
      }
      // Caller opted in — drop the conflicting entry before appending.
      logger.warning(`[plur:addStore] overwriting scope "${scope}" (was: ${scopeConflict.url ?? scopeConflict.path})`)
    }

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
    const stores = scopeConflict
      ? [...(config.stores ?? []).filter(s => s.scope !== scope), newEntry]
      : [...(config.stores ?? []), newEntry]
    this.persistStores(stores)
    return { status: scopeConflict ? 'overwritten' : 'added', scope }
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

  /** Build the primary-store summary row. Shared by listStores +
   * listStoresAsync to keep them in lockstep. */
  private _primaryStoreRow(): StoreSummary {
    return {
      path: this.paths.engrams,
      scope: 'global',
      shared: false,
      readonly: false,
      engram_count: this._loadCached(this.paths.engrams).filter(e => e.status !== 'retired').length,
    }
  }

  /**
   * @deprecated Use {@link listStoresAsync} for accurate remote engram counts.
   * The sync variant returns engram_count: 0 for remote stores on the first
   * call after server start because the remote cache hasn't populated yet
   * (issue #184). Retained for callers that cannot await.
   */
  listStores(): Array<StoreSummary> {
    this.reloadConfigIfChanged()  // pick up out-of-process config edits (#307)
    const stores = this.config.stores ?? []
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
        // #345: surface self-describing metadata in discovery when present.
        ...(s.description !== undefined ? { description: s.description } : {}),
        ...(s.covers !== undefined ? { covers: s.covers } : {}),
      }
    })
    return [this._primaryStoreRow(), ...additional]
  }

  /**
   * List all configured stores with accurate remote engram counts. Awaits
   * remote driver loads with a 5s per-store timeout so a single slow or
   * unreachable remote can never hang the entire call (issue #184).
   *
   * Use for `plur_stores_list` and CLI diagnostics where freshness matters
   * more than latency.
   */
  async listStoresAsync(): Promise<Array<StoreSummary>> {
    this.reloadConfigIfChanged()  // pick up out-of-process config edits (#307)
    const stores = this.config.stores ?? []
    const REMOTE_LOAD_TIMEOUT_MS = 5000

    const additional = await Promise.all(stores.map(async s => {
      let count = 0
      if (s.url) {
        try {
          const driver = this._getRemoteDriver({ url: s.url, token: s.token, scope: s.scope })
          // Race driver.load() against a timeout — a hung remote must not
          // hang the listing call. On timeout, count stays 0. The clearTimeout
          // in finally is critical: in a long-lived MCP server, uncleaned
          // timers per remote × per call would keep the event loop active.
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined
          const loadWithTimeout = Promise.race([
            driver.load().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`remote load timeout (${REMOTE_LOAD_TIMEOUT_MS}ms)`)),
                REMOTE_LOAD_TIMEOUT_MS,
              )
            }),
          ])
          const engrams = await loadWithTimeout
          count = engrams.filter(e => e.status !== 'retired').length
        } catch { /* network/auth failure or timeout — report 0, don't crash */ }
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
        // #345: surface self-describing metadata in discovery when present.
        ...(s.description !== undefined ? { description: s.description } : {}),
        ...(s.covers !== undefined ? { covers: s.covers } : {}),
      }
    }))
    return [this._primaryStoreRow(), ...additional]
  }

  /**
   * Pre-load all remote store caches so subsequent sync reads see data.
   * Call once before injection to avoid the cold-start race (#235).
   *
   * Each remote load races against a 5-second timeout — a single hung or
   * slow remote must not block session_start indefinitely. Same pattern as
   * listStoresAsync (#184). clearTimeout on the success path prevents
   * accumulating dangling timers in the long-lived MCP server process.
   */
  async warmRemoteCaches(): Promise<void> {
    const stores = this.config.stores ?? []
    const remoteStores = stores.filter(s => s.url)
    const REMOTE_LOAD_TIMEOUT_MS = 5000
    await Promise.all(
      remoteStores.map(s => {
        const driver = this._getRemoteDriver({ url: s.url!, token: s.token, scope: s.scope })
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        return Promise.race([
          driver.load().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(`remote warm timeout (${REMOTE_LOAD_TIMEOUT_MS}ms)`)),
              REMOTE_LOAD_TIMEOUT_MS,
            )
          }),
        ]).catch(() => { /* errors logged inside RemoteStore; timeout swallowed */ })
      }),
    )
  }

  /** Return writable remote store scopes for AI caller guidance. */
  getWritableRemoteScopes(): Array<{ scope: string; url: string }> {
    return (this.config.stores ?? [])
      .filter(s => s.url && !s.readonly)
      .map(s => ({ scope: s.scope, url: s.url! }))
  }

  /**
   * Group configured remote stores by distinct URL, returning one entry per URL
   * with the token to query it. Tokens should be identical across a URL's
   * entries (same user, same instance); the first is used.
   *
   * "Distinct" is keyed on {@link normalizeEndpointUrl} (scope-audit
   * 2026-07-24): `https://x.com`, `https://x.com/` and `https://x.com/sse` are
   * ONE endpoint, not three — an exact-string key probed the same server once
   * per spelling and split its registered-scope view across the copies. The
   * FIRST configured spelling is what gets reported/queried; stored values are
   * never rewritten.
   */
  private _distinctRemoteEndpoints(): Array<{ url: string; token?: string }> {
    const byUrl = new Map<string, { url: string; token?: string }>()
    for (const s of this.config.stores ?? []) {
      if (!s.url) continue
      const key = normalizeEndpointUrl(s.url)
      if (!byUrl.has(key)) byUrl.set(key, { url: s.url, token: s.token })
    }
    return [...byUrl.values()]
  }

  /** All store entries registered against `url` under ANY spelling of that
   *  endpoint (scope-audit 2026-07-24) — the identity-normalized counterpart of
   *  `stores.filter(s => s.url === url)`. */
  private _storesForEndpoint(url: string): StoreEntry[] {
    const key = normalizeEndpointUrl(url)
    return (this.config.stores ?? []).filter(s => s.url !== undefined && normalizeEndpointUrl(s.url) === key)
  }

  /**
   * Discover which scopes each configured remote token is authorized for, via
   * `GET /api/v1/me` (#292). For each distinct remote URL, reports the
   * server-authorized scope set and which of those are not yet registered
   * locally — the gap that lets a user authorized for N teams see only the
   * one(s) they happened to register.
   *
   * Read-only: never mutates config. Each `/me` is raced against a timeout and
   * failures are captured per URL (`ok:false`) so one unreachable endpoint
   * never sinks discovery for the others. Restricted to a single URL via
   * `opts.url`.
   */
  async discoverRemoteScopes(opts?: { url?: string; timeoutMs?: number }): Promise<RemoteScopeDiscovery[]> {
    const timeoutMs = opts?.timeoutMs ?? 5000
    // Endpoint identity is normalized (scope-audit 2026-07-24) so a caller
    // restricting by one spelling still matches an entry configured under
    // another, and `registered` sees every spelling's entries.
    const endpoints = this._distinctRemoteEndpoints()
      .filter(e => !opts?.url || normalizeEndpointUrl(e.url) === normalizeEndpointUrl(opts.url))

    return Promise.all(endpoints.map(async ({ url, token }) => {
      const registered = this._storesForEndpoint(url).map(s => s.scope)
      try {
        const driver = this._getRemoteDriver({ url, token, scope: registered[0] ?? '' })
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        const me = await Promise.race([
          driver.me().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(`/me timeout (${timeoutMs}ms)`)), timeoutMs)
          }),
        ])
        const registeredSet = new Set(registered)
        // #647: scopes the user has dismissed from the offer are not "actionable"
        // — drop them from `unregistered` so the session-start hint and CLI stop
        // re-surfacing them every session. `plur scopes --reoffer` clears these.
        // Membership is CASE-INSENSITIVE (scope-audit 2026-07-24): the /me scope
        // grammar admits uppercase, so a case-variant re-advertisement of a
        // dismissed scope must not resurrect the offer. Stored values keep
        // their original case.
        const dismissedSet = this._dismissedScopeKeys()
        return {
          url,
          ok: true,
          username: me.username,
          org_id: me.org_id,
          role: me.role,
          authorized: me.scopes,
          registered,
          unregistered: me.scopes.filter(s => !registeredSet.has(s) && !dismissedSet.has(s.toLowerCase())),
          // #345 D2: server-authoritative metadata for the authorized scopes,
          // already validated in RemoteStore.me(). Empty for older servers.
          metadata: me.scope_metadata ?? [],
        }
      } catch (err) {
        return {
          url, ok: false,
          authorized: [], registered, unregistered: [], metadata: [],
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }))
  }

  /**
   * Local-only read of each configured remote token's JWT expiry (#295). No
   * network. Returns one entry per distinct remote URL; `expiresInDays`/`expired`
   * are null/false for opaque (non-JWT) keys. Used by session_start to warn
   * about imminent/past expiry without a round-trip.
   */
  remoteTokenExpiries(now: number = Date.now()): Array<{ url: string; scopes: string[]; expiresAt: string | null; expiresInDays: number | null; expired: boolean }> {
    return this._distinctRemoteEndpoints().map(({ url, token }) => {
      const scopes = this._storesForEndpoint(url).map(s => s.scope)
      const exp = decodeJwtExpiry(token, now)
      return {
        url, scopes,
        expiresAt: exp.expiresAt ? exp.expiresAt.toISOString() : null,
        expiresInDays: exp.expiresInDays,
        expired: exp.expired,
      }
    })
  }

  /**
   * Probe each configured remote endpoint's auth/reachability (#295) by calling
   * `GET /api/v1/me` (raced against a timeout), combined with a local JWT-expiry
   * read. Distinguishes 'auth_expired' (token rejected or JWT exp passed →
   * reauth) from 'unreachable' (network/timeout/5xx). Read-only; one bad
   * endpoint never affects the others. Powers `plur_doctor`'s remote check so
   * the doctor stops reporting "healthy" when the remote auth is dead.
   */
  async checkRemoteHealth(opts?: { timeoutMs?: number }): Promise<RemoteHealth[]> {
    const timeoutMs = opts?.timeoutMs ?? 5000
    const endpoints = this._distinctRemoteEndpoints()
    return Promise.all(endpoints.map(async ({ url, token }) => {
      const scopes = this._storesForEndpoint(url).map(s => s.scope)
      const exp = decodeJwtExpiry(token)
      const expiryFields = {
        tokenExpiresAt: exp.expiresAt ? exp.expiresAt.toISOString() : undefined,
        tokenExpiresInDays: exp.expiresInDays,
      }
      // A JWT we can already see is expired → don't bother probing; it's auth_expired.
      if (exp.expired) {
        return { url, scopes, status: 'auth_expired' as const, ok: false,
          reason: `token expired ${exp.expiresAt?.toISOString() ?? ''}`.trim(), ...expiryFields }
      }
      try {
        const driver = this._getRemoteDriver({ url, token, scope: scopes[0] ?? '' })
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          driver.me().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(`/me timeout (${timeoutMs}ms)`)), timeoutMs)
          }),
        ])
        return { url, scopes, status: 'ok' as const, ok: true, ...expiryFields }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isAuth = /\b40[13]\b/.test(msg)
        return { url, scopes, status: (isAuth ? 'auth_expired' : 'unreachable') as RemoteHealth['status'],
          ok: false, reason: msg, ...expiryFields }
      }
    }))
  }

  /**
   * Register every authorized-but-unregistered scope discovered for the
   * configured remote URL(s) (#292). One token → all the user's team scopes in
   * a single action. Relies on URL+scope dedup (#291) so multiple scopes coexist
   * under one URL. Scopes the user has dismissed (#647) are respected — the
   * batch path skips them (scope-audit 2026-07-24); only the per-scope
   * {@link registerScope} overrides a dismissal.
   *
   * Returns per-URL what was newly `added` vs `already_registered`. A URL whose
   * `/me` failed yields `ok:false` and registers nothing.
   */
  async registerDiscoveredScopes(opts?: { url?: string; timeoutMs?: number }): Promise<RegisterDiscoveredResult[]> {
    const discoveries = await this.discoverRemoteScopes(opts)
    const results = discoveries.map(d => {
      if (!d.ok) return { url: d.url, ok: false, added: [], already_registered: [], skipped: [], error: d.error }
      const token = this._storesForEndpoint(d.url)[0]?.token
      const added: string[] = []
      const already: string[] = []
      const skipped: string[] = []
      // Dismissals gate the batch path (scope-audit 2026-07-24): iterating the
      // raw `d.authorized` set used to register scopes the user had explicitly
      // dismissed (#647) — `unregistered` filters them out, but this loop never
      // consulted it, so `plur_scopes_discover register:true` silently overrode
      // the recorded opt-out and left the stale `dismissed_scopes` entry behind.
      // The per-scope {@link registerScope} remains the deliberate override
      // (it registers AND clears the dismissal). Case-insensitive, matching
      // the discover-time filter.
      const dismissed = this._dismissedScopeKeys()
      // Attempt every non-dismissed authorized scope (not just the pre-computed
      // unregistered set) and let addStore's url+scope idempotency (#291)
      // classify each — so the result is accurate even if config changed
      // between discover and now.
      for (const scope of d.authorized) {
        if (dismissed.has(scope.toLowerCase()) && !d.registered.includes(scope)) {
          // Dismissed and not currently registered → the batch path must not
          // register it. (A registered scope stays reported as
          // already_registered even if a stale dismissal lingers.)
          skipped.push(scope)
          logger.info(`[plur] skipping dismissed scope "${scope}" from ${d.url} — batch register respects dismissals; use \`plur scopes register ${scope}\` to override (it also clears the dismissal)`)
          continue
        }
        // SECURITY (#382): never auto-register a PERSONAL-family scope returned
        // by `/me` as a writable remote store. A compromised/MITM'd endpoint can
        // claim `scopes:['global','user:<victim>','local']`; registering those
        // makes the hostile server the routing target for the user's default and
        // unscoped writes. Only shared-family scopes (group:/project:/space:/
        // team:/org:/public) are auto-registered. A genuine remote-backed
        // personal scope must be added deliberately via `plur stores add`.
        if (!isSharedScope(scope)) {
          skipped.push(scope)
          logger.warning(
            `[plur] refused to auto-register non-shared scope "${scope}" from ${d.url} — ` +
            `a /me-advertised personal-family scope is not auto-registered (it would route ` +
            `your default/unscoped writes to that endpoint). Add it explicitly if intended.`,
          )
          continue
        }
        try {
          const { status } = this.addStore('', scope, { url: d.url, token })
          if (status === 'added') added.push(scope)
          else already.push(scope)
        } catch (err) {
          // #397: a single bad/conflicting scope (e.g. one already bound to a
          // DIFFERENT endpoint → addStore throws) must NOT abort the whole batch
          // and leave a partial registration. Record it as skipped and continue
          // with the remaining authorized scopes.
          skipped.push(scope)
          logger.warning(`[plur] could not auto-register scope "${scope}" from ${d.url}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return { url: d.url, ok: true, added, already_registered: already, skipped }
    })
    // Persist covers/description/sensitivity for all registered scopes (#668)
    this.persistScopeMetadata(discoveries)
    return results
  }

  /**
   * The single source of truth for the "authorized but unregistered" OFFER
   * (#647), shared by the `plur scopes` CLI and the session-start hint. Returns
   * the shared-family scopes the token is authorized for that are neither
   * registered nor dismissed, deduped across remotes, each with its
   * self-describing metadata description (#345) when the server serves it.
   *
   * Personal-family scopes are excluded here (they can't be registered from
   * discovery — see {@link registerScope} / #382), so the offer only ever shows
   * scopes the user can actually act on.
   *
   * Also returns any `failures` (remotes whose /me could not be reached / whose
   * token was rejected) so the caller can distinguish "genuinely nothing to
   * offer" from "couldn't reach the server" — the CLI must not report an empty
   * offer when it simply failed to talk to the remote (#656 self-review).
   */
  async offerableScopes(opts?: { url?: string; timeoutMs?: number }): Promise<{
    scopes: Array<{ scope: string; url: string; description?: string }>
    failures: Array<{ url: string; error?: string }>
  }> {
    const discoveries = await this.discoverRemoteScopes(opts)
    const seen = new Set<string>()
    const scopes: Array<{ scope: string; url: string; description?: string }> = []
    const failures: Array<{ url: string; error?: string }> = []
    for (const d of discoveries) {
      if (!d.ok) {
        failures.push({ url: d.url, error: d.error })
        continue
      }
      for (const scope of d.unregistered) {
        if (!isSharedScope(scope) || seen.has(scope)) continue
        seen.add(scope)
        const meta = d.metadata.find(m => m.scope === scope)
        scopes.push({ scope, url: d.url, description: meta?.description })
      }
    }
    return { scopes, failures }
  }

  /**
   * Register a SINGLE authorized-but-unregistered shared scope (#647) — the
   * per-scope counterpart to {@link registerDiscoveredScopes} (all-or-nothing).
   * Discovers which configured remote authorizes `scope`, then adds one store
   * entry via the same url+scope-idempotent {@link addStore} path.
   *
   * Rejects personal-family scopes (`user:*`/`global`/…) — same #382 guard as
   * the batch path: a `/me`-advertised personal scope must never become a
   * routing target for the user's default/unscoped writes. Throws if no
   * configured remote authorizes the scope.
   */
  async registerScope(scope: string, opts?: { url?: string; timeoutMs?: number }): Promise<{ url: string; status: 'added' | 'already_registered' | 'overwritten' | 'token_rotated' }> {
    if (!isSharedScope(scope)) {
      throw new Error(`refusing to register non-shared scope "${scope}" — only shared-family scopes (group:/project:/space:/team:/org:/public) can be registered from discovery; add a personal-backed store explicitly with \`plur stores add\``)
    }
    const discoveries = await this.discoverRemoteScopes(opts?.url ? { url: opts.url, timeoutMs: opts?.timeoutMs } : { timeoutMs: opts?.timeoutMs })
    const match = discoveries.find(d => d.ok && d.authorized.includes(scope))
    if (!match) {
      const failed = discoveries.filter(d => !d.ok).map(d => d.url)
      throw new Error(`scope "${scope}" is not authorized on any configured remote${failed.length ? ` (could not reach: ${failed.join(', ')})` : ''}`)
    }
    const token = this._storesForEndpoint(match.url)[0]?.token
    const { status } = this.addStore('', scope, { url: match.url, token })
    // Persist covers/description/sensitivity so suggestScope activates (#668).
    this.persistScopeMetadata(discoveries)
    // Registering a scope also clears any prior dismissal of it (#647) —
    // case-insensitively (scope-audit 2026-07-24), so a case-variant dismissal
    // can't linger and re-suppress the scope from future offers.
    if ((this.config.dismissed_scopes ?? []).some(s => s.toLowerCase() === scope.toLowerCase())) {
      this.persistDismissedScopes((this.config.dismissed_scopes ?? []).filter(s => s.toLowerCase() !== scope.toLowerCase()))
    }
    return { url: match.url, status }
  }

  /**
   * Dismiss a scope from the "authorized but unregistered" offer (#647). It is
   * remembered in config (`dismissed_scopes`) and excluded from
   * discoverRemoteScopes().unregistered + the session-start hint until
   * {@link reofferScopes}. No-op if already dismissed.
   */
  dismissScope(scope: string): void {
    const current = this.config.dismissed_scopes ?? []
    // Case-insensitive membership (scope-audit 2026-07-24): dismissing `Group:x`
    // when `group:x` is already recorded must stay a no-op, not a duplicate.
    if (current.some(s => s.toLowerCase() === scope.toLowerCase())) return
    this.persistDismissedScopes([...current, scope])
  }

  /** Lowercased `dismissed_scopes` for case-insensitive membership tests
   *  (scope-audit 2026-07-24). The stored values keep their original case. */
  private _dismissedScopeKeys(): Set<string> {
    return new Set((this.config.dismissed_scopes ?? []).map(s => s.toLowerCase()))
  }

  /** Clear all dismissals (#647) — previously dismissed scopes are offered again. */
  reofferScopes(): void {
    this.persistDismissedScopes([])
  }

  /** The scopes currently dismissed from the offer (#647). */
  getDismissedScopes(): string[] {
    return [...(this.config.dismissed_scopes ?? [])]
  }

  /**
   * Persist `dismissed_scopes` to config.yaml, preserving every other top-level
   * key, then refresh the in-memory config + mtime. Mirrors {@link persistStores}:
   * a transient read error on an EXISTING config aborts rather than truncating,
   * and the read-modify-write runs under {@link withLock} so a concurrent
   * config persist path can't be last-writer-wins'd away (scope-audit
   * 2026-07-24). Dedup is case-insensitive (first spelling wins) so case
   * variants of one scope never accumulate.
   */
  private persistDismissedScopes(list: string[]): void {
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const s of list) {
      const key = s.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(s)
    }
    withLock(this.paths.config, () => {
      let configData: Record<string, unknown> = {}
      try {
        const raw = fs.readFileSync(this.paths.config, 'utf8')
        if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      configData.dismissed_scopes = deduped.sort()
      fs.writeFileSync(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }))
    })
    this.config = loadConfig(this.paths.config)
    this.configMtimeMs = this.statConfigMtime()
  }

  /**
   * Sync server-authoritative scope metadata (covers/description/sensitivity)
   * from /me discoveries into the matching local config store entries (#668).
   *
   * discoverRemoteScopes() fetches scope_metadata from /me but never persisted
   * covers into local config, so listScopeMetadata() returned empty covers and
   * suggestScope() was inert for remote scopes. Called after any /me pull
   * (session_start, registerDiscoveredScopes, registerScope) to close that gap.
   * Personal-family scopes are skipped — they are never routing targets.
   * No-op when nothing changed (avoids spurious config writes).
   *
   * TRUST RULE for `sensitivity` (scope-audit 2026-07-24): remote-served
   * sensitivity may only TIGHTEN the write-time leak guard, never loosen it.
   * The guard checks `allow` BEFORE `forbid` and `allow` admits arbitrary
   * strings, so persisting a remote `allow:['secrets','infra']` verbatim would
   * let a hostile/compromised enterprise endpoint silently disarm the guard at
   * the next session_start. Therefore:
   *   - a remote `allow` is NEVER persisted (dropped, along with any unknown
   *     nested sensitivity fields the remote sent);
   *   - only the remote `forbid` is persisted, sanitized to the known
   *     SENSITIVITY_CATEGORIES (empty-after-sanitize falls to the safe
   *     default, mirroring ScopeSensitivitySchema);
   *   - a hand-edited `allow` in local config.yaml is preserved and remains
   *     honored by the guard — a deliberate LOCAL decision.
   *
   * The change-detector compares what WILL actually be persisted
   * (post-sanitization, post-merge) against the loaded entry, so an unchanged
   * server state is a true no-op — no write, no mtime bump, no config-reload
   * storm on every session_start. When `forbid` DOES change, the affected
   * scopes are named to persistStores (`serverSensitivityScopes`) so
   * mergeStoresForWriteback's raw-forbid restore doesn't discard the update.
   */
  persistScopeMetadata(discoveries: RemoteScopeDiscovery[]): void {
    const stores = this.config.stores ?? []
    if (!stores.length) return

    let changed = false
    const serverSensitivityScopes = new Set<string>()
    const updated = stores.map(entry => {
      if (!entry.url) return entry                  // local store — no server metadata
      if (!isSharedScope(entry.scope)) return entry // never write covers to personal scopes
      // Endpoint identity is normalized (scope-audit 2026-07-24): a discovery
      // for https://x.com must match an entry configured as https://x.com/sse.
      const discovery = discoveries.find(d => d.ok && normalizeEndpointUrl(d.url) === normalizeEndpointUrl(entry.url!))
      if (!discovery?.metadata.length) return entry
      const meta = discovery.metadata.find(m => m.scope === entry.scope)
      if (!meta) return entry

      // What WILL be persisted (trust rule above): server covers/description
      // verbatim; sensitivity = local entry's policy (incl. any hand-edited
      // `allow` + nested unknowns) with only `forbid` taken from the server,
      // sanitized to the category enum. No server sensitivity → local untouched.
      const nextSensitivity = meta.sensitivity !== undefined
        ? { ...(entry.sensitivity ?? { allow: [] }), forbid: sanitizeForbidCategories(meta.sensitivity.forbid) }
        : entry.sensitivity
      const nextCovers = meta.covers !== undefined ? meta.covers : entry.covers
      const nextDescription = meta.description !== undefined ? meta.description : entry.description

      // Only write when the PERSISTED value would differ — comparing the raw
      // server payload instead (as pre-audit code did) never converges once a
      // field (e.g. `allow`) is deliberately not persisted. stableJson keeps
      // the compare key-order-insensitive across spread/re-parse round-trips.
      const coversMatch = stableJson(nextCovers) === stableJson(entry.covers)
      const descMatch = nextDescription === entry.description
      const sensMatch = stableJson(nextSensitivity) === stableJson(entry.sensitivity)
      if (coversMatch && descMatch && sensMatch) return entry

      // Server-authoritative overwrite is by design — but overwriting a
      // DIFFERENT non-empty local value must be visible, not silent (F5,
      // scope-audit 2026-07-24): a hand-set covers/description vanishing with
      // no trace looks like data loss.
      const clobbered: string[] = []
      if (!coversMatch && (entry.covers?.length ?? 0) > 0) clobbered.push('covers')
      if (!descMatch && entry.description !== undefined && entry.description !== '') clobbered.push('description')
      if (clobbered.length) {
        logger.warning(`[plur:scope-metadata] scope "${entry.scope}": overwriting local ${clobbered.join(' + ')} with server values from ${discovery.url} (server-authoritative)`)
      }

      changed = true
      if (!sensMatch) serverSensitivityScopes.add(entry.scope)
      return {
        ...entry,
        ...(nextCovers !== undefined ? { covers: nextCovers } : {}),
        ...(nextDescription !== undefined ? { description: nextDescription } : {}),
        ...(nextSensitivity !== undefined ? { sensitivity: nextSensitivity } : {}),
      }
    })

    if (changed) this.persistStores(updated, { serverSensitivityScopes })
  }

  /** Set a session-level default scope. Used as fallback in learn/learnRouted when no explicit scope is provided. */
  setSessionScope(scope: string | null): void {
    this._sessionScope = scope
  }

  /** Get the current session-level default scope, or null if not set. */
  getSessionScope(): string | null {
    return this._sessionScope
  }
}
