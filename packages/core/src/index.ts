import * as fs from 'fs'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import yaml from 'js-yaml'
import { collapseLineTerminators } from './sanitize.js'
import { detectPlurStorage, type PlurPaths } from './storage.js'
import { IndexedStorage } from './storage-indexed.js'
import { PGLiteAdapter } from './storage-pglite.js'
import { loadConfig } from './config.js'
import { generateEngramId, engramIdDatePrefix, loadAllPacks, storePrefix, namespaceEngramId, initFilesystemStore } from './engrams.js'
import { maybeDailyBackup } from './backup.js'
import { logger } from './logger.js'
import { searchEngrams, ftsTokenize, extendCorpusStats, searchTextFrom } from './fts.js'
import { selectAndSpread, scoreEngramsPublic, formatWithLayer, assignLayer } from './inject.js'
import { reactivate } from './decay.js'
import { captureEpisode, queryTimeline } from './episodes.js'
import { agenticSearch } from './agentic-search.js'
import { embeddingSearch, embeddingSearchWithScores, type SimilarityResult } from './embeddings.js'
import { applyFeedbackSignal } from './feedback.js'
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
import { atomicWrite, CONFIG_FILE_MODE, sync as gitSync, getSyncStatus, withLock, type SyncResult, type SyncStatus, type SyncRemoteType } from './sync.js'
import { detectSecrets, detectSensitive, sensitivityCategory, SCAN_TRUNCATED } from './secrets.js'
import type { SecretMatch } from './secrets.js'
import { SENSITIVITY_CATEGORIES, type ScopeMetadata, type SensitivityCategory } from './schemas/scope-metadata.js'
import { rankScopes, SCOPE_MATCH_THRESHOLD, type ScopeSignals, type ScopeCandidate } from './scope-routing.js'
import { mintedIdsWithPrefix, appendHistory, readHistoryForEngram, generateEventId, generateInjectionId, computeQueryHash, findLatestInjectionFor, countInjectionEvents, type InjectionEventCounts } from './history.js'
import { computeContentHash, isHashable } from './content-hash.js'
import { isLocalOnlyScope, assertScopeNamesATarget } from './scope-target.js'
import { orderBySupersedes } from './outbox-order.js'
import { loadTensions, loadTensionsWithQuarantine, saveTensions, generateTensionId, tensionPairKey, categorizeTension } from './tension-store.js'
import type { TensionRecord, TensionStatus } from './schemas/tension.js'
import type { TensionPair } from './tensions.js'
import { engramDate } from './tensions.js'
import { resolveValidity, buildTemporal, normalizeIsoDate } from './expiry.js'
import { decodeJwtExpiry, decodeJwtPayload } from './jwt.js'
import { RemoteStore, normalizeEndpointUrl } from './store/remote-store.js'
import {
  remoteRecall, isRemoteRecallDisabled, resolveRemoteRecallTimeoutMs, scopeOrg,
  REMOTE_STATUS_TTL_MS, PROBE_CLEARABLE_STATES,
  type RemoteRecallHost, type RemoteRecallResult, type HostRecallOutcome, type RemoteStoreStatusEntry, isHostInCooldown, recordWriteOutcome} from './remote-recall.js'
import { YamlPrimaryStore } from './store/yaml-primary-store.js'
import { ReadonlyStoreGuard, ReadonlyStoreError } from './store/readonly-store-guard.js'
import { withAsyncLock } from './store/async-lock.js'
import { SessionScopeRegistry } from './session-scopes.js'
import type { AsyncPrimaryStore } from './store/primary-store.js'
import { requiresIndexSync, asDerivedIndex } from './storage-adapter.js'
import type { StorageAdapter } from './storage-adapter.js'
import { resolveBackendTier, type BackendSelection } from './backend-selection.js'
import { isSharedScope, isScopeWithin, scopeAllowFilter, makeVisibilityPredicate } from './scope-util.js'
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
  RemoteProjectConfig,
} from './types.js'

export * from './meta/index.js'
export { classifyPolarity } from './polarity.js'
export { computeConfidence, computeMetaConfidence, confidenceBand } from './confidence.js'
export { SessionBreadcrumbs } from './session-state.js'
export { SessionScopeRegistry } from './session-scopes.js'
export { AsyncMutex, KeyedAsyncMutex } from './async-mutex.js'
export { findProjectConfigPath, readProjectConfig, type ProjectConfig } from './project-config.js'
export { generateGuardrails } from './guardrails.js'
export type { MetaField, StructuralTemplate, EvidenceEntry, MetaConfidence, DomainCoverage, HierarchyPosition, Falsification } from './schemas/meta-engram.js'
export { MetaFieldSchema, StructuralTemplateSchema, EvidenceEntrySchema, MetaConfidenceSchema, DomainCoverageSchema, HierarchyPositionSchema, FalsificationSchema } from './schemas/meta-engram.js'
export { engramSearchText, termMatches, computeIdf, type CorpusStats } from './fts.js'
export { EngramStoreUnreadableError, EngramStoreShrinkError } from './engrams.js'
// Exported for store-repair tooling (#852's `plur reindex-hashes`), which must
// read the RAW store rows. `Plur.list()` goes through `_filterEngrams`, which
// merges packs in and drops inactive/expired engrams — fine for recall, wrong
// for a repair pass, which would then miss stale rows and try to "fix" pack
// entries it does not own. Exposing the existing loader rather than letting a
// caller write a fourth one is the whole point of #877.
export { loadEngrams, saveEngrams } from './engrams.js'
// The id-namespacing pair (#914). `readIdFor` is the API a surface should use;
// these are exported so a caller (and the tests) can reason about the shape
// without re-deriving the prefix rule a fourth time.
export { storePrefix, namespaceEngramId } from './engrams.js'
export {
  maybeDailyBackup,
  listBackups,
  planRestore,
  restoreBackup,
  validateStore,
  BACKUP_DIR,
} from './backup.js'
export type { BackupEntry, BackupOutcome, RestorePlan, RestoreResult, StoreValidity } from './backup.js'
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
export { computeContentHash, normalizeStatement, isHashable } from './content-hash.js'
export { isLocalOnlyScope, assertScopeNamesATarget } from './scope-target.js'
export { orderBySupersedes } from './outbox-order.js'
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
export { isSharedScope, isPersonalScope, SHARED_SCOPE_PREFIXES, scopeAllowFilter, makeVisibilityPredicate } from './scope-util.js'
export { detectPlurStorage, type PlurPaths } from './storage.js'
// Exported so the CLI resolves the Postgres DSN and schema exactly as the
// engine does (#840). A second, divergent resolution in the CLI is how
// `plur reindex-tokens` came to report a false all-clear on a store whose
// connection lived in config.yaml rather than the environment.
export { loadConfig } from './config.js'
export { IndexedStorage } from './storage-indexed.js'
export { PGLiteAdapter, type PGLiteAdapterOptions, type VectorPrecision } from './storage-pglite.js'
export type {
  ScopeRestriction,
  StorageAdapter,
  StorageFilter,
  VectorSearchHit,
  StorageAdapterRole,
  DerivedIndexAdapter,
} from './storage-adapter.js'
export { requiresIndexSync, asDerivedIndex, DERIVED_INDEX_DEFAULTS } from './storage-adapter.js'
export {
  EXACT_VECTOR_INDEX,
  PGVECTOR_DEFAULT_EF_SEARCH,
  EF_SEARCH_FILTER_HEADROOM,
  efSearchFor,
  type VectorIndexKind,
  type VectorIndexStrategy,
  type VectorElementFormat,
} from './storage-adapter.js'
// Server-Postgres backend (ADR-0005): store AND index in one engine.
export {
  PostgresAdapter,
  type PostgresAdapterOptions,
  type PostgresVectorIndexMode,
  DEFAULT_POSTGRES_SCHEMA,
  HNSW_DEFAULT_M,
  HNSW_DEFAULT_EF_CONSTRUCTION,
  HNSW_RECALL_TARGET,
  HNSW_MIN_ROWS,
  redactDsn,
} from './storage-postgres.js'
export {
  resolveBackendTier,
  BACKEND_TIERS,
  SQLITE_MIN_ENGRAMS,
  PGLITE_MIN_ENGRAMS,
  POSTGRES_MIN_ENGRAMS,
  type BackendTier,
  type BackendSelection,
  type BackendSelectionInput,
  type BackendSelectionReason,
} from './backend-selection.js'
export { YamlStore, SqliteStore, createStore, migrateStore, type EngramStore, type StorageBackend, type StorageConfig } from './store/index.js'
export { exportPgliteEmbeddingsToCache, type PgliteEmbeddingsExportReport } from './pglite-embeddings-export.js'
export { YamlPrimaryStore, MemoryPrimaryStore, ReadonlyStoreGuard, ReadonlyStoreError, type PrimaryStore, type AsyncPrimaryStore, type PrimaryStoreKind } from './store/index.js'
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
/**
 * File-write primitives, exported so packages OUTSIDE core write files the same
 * way core does (#805). `@plur-ai/mcp` had its own read-modify-write with
 * neither a lock nor an atomic replace; re-implementing them per package is how
 * the two drift, and the drift is always in the unsafe direction.
 */
export { atomicWrite, withLock } from './sync.js'
export { markRemoteHostDown, remoteHostDownRemainingMs, clearRemoteHostDown, _resetRemoteHostBreaker, salvageRemoteRow } from './store/remote-store.js'
export { checkForUpdate, settleVersionChecks, getCachedUpdateCheck, clearVersionCache, minorVersionsBehind, VERSION_CHECK_SUCCESS_TTL_MS, VERSION_CHECK_FAILURE_TTL_MS, type VersionCheckResult } from './version-check.js'
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

/**
 * Engine primitives — the retrieval and mutation rules, without the file-backed
 * single-user machinery that wraps them in `Plur`.
 *
 * Exported so a second deployment can run the SAME ranking and the SAME
 * feedback arithmetic rather than reimplementing them. A reimplementation does
 * not announce itself when it drifts: it returns a plausible ordering and a
 * plausible strength, and the two deployments simply stop agreeing.
 */
export { rrfMergeEngrams } from './hybrid-search.js'
// Server-authoritative remote recall (#776) — client, health persistence,
// degradation string table (A4′), and env knobs. The MCP server and CLI hook
// consume these so all three surfaces share ONE state vocabulary + strings.
export {
  remoteRecall, isRemoteRecallDisabled, resolveRemoteRecallTimeoutMs,
  remoteHealthPath, readRemoteHealth, scopeOrg,
  mcpRemoteWarningLine, hookRemoteHeaderLine, doctorRemoteRemediation,
  claimHookDegradationLines,
  MAX_REMOTE_QUERY_CHARS, MAX_REMOTE_RESPONSE_BYTES, DEFAULT_REMOTE_RECALL_TIMEOUT_MS,
  BREAKER_FAILURE_THRESHOLD, BREAKER_COOLDOWN_MS, UNSUPPORTED_TTL_MS, HOOK_HEADER_REPEAT_MS,
  REMOTE_STATUS_TTL_MS, PROBE_CLEARABLE_STATES,
  startBudgetTimer, BUDGET_TICK_MS, MAX_STARVATION_CREDIT_MS,
  type RemoteRecallHost, type RemoteRecallResult, type HostRecallOutcome,
  type RemoteHostState, type RemoteStoreStatusEntry, type RemoteRecallOptions,
} from './remote-recall.js'
export {
  applyFeedbackSignal, nextCommitment,
  POSITIVE_STRENGTH_DELTA, NEGATIVE_STRENGTH_DELTA,
  type FeedbackSignal,
} from './feedback.js'
// Client-side token inspection (#295/#587) — expiry + display-only payload
// claims, no signature verification — and the endpoint-identity normalizer,
// so CLI surfaces (login --status) compare hosts the same way the core does.
export { decodeJwtExpiry, decodeJwtPayload, type JwtExpiry } from './jwt.js'
export { normalizeEndpointUrl } from './store/remote-store.js'

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
  /**
   * Artifacts `status()` could not read, by name (#805 follow-up; audit
   * 2026-08-03 finding 6).
   *
   * `status()` is the command an operator reaches for WHEN something is wrong,
   * so it must REPORT a broken artifact rather than die on it. The refuse-on-
   * corrupt loaders are right for the write paths they protect — a write that
   * proceeds from a phantom-empty store destroys data — but propagating those
   * throws out of the diagnostic takes it down along with the thing being
   * diagnosed.
   *
   * The first version of this covered only the pack registry, which left
   * `episodes.yaml` and `tensions.yaml` able to do exactly the same thing. That
   * mattered more than it looks: MCP `session_start` awaits `status()`, so a
   * truncated episodes file meant no session could start at all.
   *
   * Keys are artifact names (`packs`, `episodes`, `tensions`); values are the
   * loader's message, which already carries the repair instructions.
   */
  store_errors?: Record<string, string>
  /** @deprecated Use `store_errors.packs`. Kept so existing readers still work. */
  pack_registry_error?: string
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
  /** Scopes registered locally for this (url, token) group (for the report). */
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
  /** JWT `sub` claim — UNVERIFIED, display only (#587). Absent for opaque keys. */
  tokenSubject?: string
  /** JWT org claim (`orgId`/`org_id`/`org`) — UNVERIFIED, display only (#587). */
  tokenOrg?: string
  /** Server-confirmed identity from the live `/me` probe (status 'ok' only). */
  username?: string
  /** Server-confirmed org from the live `/me` probe (status 'ok' only). */
  orgId?: string
  /** Number of scopes the server reports granted to this token (status 'ok' only). */
  grantedScopes?: number
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

/** Options for {@link Plur.rescope} (#676). */
export interface RescopeOptions {
  /**
   * After a successful REMOTE push, keep the local source engram active
   * instead of retiring it. Default false: the source is soft-retired with a
   * `superseded_by` link to the server copy, so it stops injecting and its
   * content hash cannot resurrect it (`_hashDedup` only matches active rows).
   * Ignored for local (in-place) rescopes — those move the row, nothing to keep.
   */
  keep_local?: boolean
  /** Report what WOULD happen without mutating anything, local or remote. */
  dry_run?: boolean
}

/** Per-engram outcome of {@link Plur.rescope} (#676). */
export interface RescopeResult {
  /** Source engram id the caller passed. */
  id: string
  /**
   * 'rescoped'  — moved (or, with dry_run, would move).
   * 'deduped'   — an identical engram (content-hash + scope match) already
   *               exists at the target: idempotent success, nothing pushed;
   *               the source is still retired per keep_local (constraint 5).
   * 'noop'      — source already carries the target scope.
   * 'error'     — nothing was changed for this id; see `error`.
   */
  status: 'rescoped' | 'deduped' | 'noop' | 'error'
  /** Which path handled it: push to a configured remote store, or in-place scope rewrite. */
  action?: 'remote_push' | 'local_rewrite'
  from_scope?: string
  to_scope?: string
  /**
   * Where the engram lives after the rescope: the SERVER-assigned id for a
   * remote push, the unchanged id for a local rewrite, or the pre-existing
   * target engram's id on a dedup hit.
   */
  new_id?: string
  /** True when the local source stayed active (keep_local remote push). */
  kept_local?: boolean
  /** Echoed when options.dry_run was set — nothing was mutated. */
  dry_run?: boolean
  /**
   * Set when the source carried a PENDING outbox delivery that the rescope
   * cancelled (#848).
   *
   * A failed remote write queues the engram with `structured_data._outbox`
   * naming the target url + scope. Rescoping used to rewrite the scope and
   * leave that entry untouched, so when the original store recovered the
   * engram was delivered to the store the user explicitly moved it away from —
   * silently undoing the rescope, arbitrarily later. Reported rather than done
   * quietly, because the caller cannot otherwise tell a rescope that cancelled
   * a queued delivery from one that did not.
   */
  cancelled_outbox?: { target_url: string; target_scope: string }
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

/**
 * LLM dedup circuit breaker (convergence Phase 2).
 *
 * Sliding window rather than a consecutive-failure counter: see
 * `_recordLlmSuccess`. The threshold of 3 is unchanged from the counter
 * version; the window is what makes it concurrency-safe. It is generous enough
 * (5 min) that three failures inside it still mean "the LLM is broken", and
 * short enough that three failures spread across an afternoon do not.
 */
/**
 * Cap on the persisted outbox local→server id map.
 *
 * One row per remote write, forever, unless bounded. Sized so a busy install
 * keeps months of mappings while the file stays well under a megabyte —
 * comfortably more history than the queued-correction case that needs it.
 */
/**
 * Total time an ambiguity guard may spend probing remotes, across ALL stores.
 *
 * The per-request bound (`fetchBounded`, 30s) stops one host hanging forever;
 * it does not stop N hosts costing N × 30s. These guards run INSIDE the primary
 * store lock, whose acquire budget is 180s — so four stalled remotes would
 * exhaust it and every waiting writer would throw "Failed to acquire lock",
 * which is the silent-lost-write failure the per-request bound was added to
 * close. A budget for the WHOLE walk is what actually bounds it.
 *
 * 45s: comfortably above one healthy round-trip per store for a handful of
 * stores, comfortably below the lock budget even when every store is stalled.
 *
 * Expiry needs no new policy — it routes into the SAME "cannot tell" branch an
 * unreachable store already takes, and the two callers already differ there by
 * design: `forget` refuses (a mis-targeted retire is irreversible), `feedback`
 * warns and proceeds (a mis-targeted rating is recoverable, and rating is a
 * hot path).
 */
const REMOTE_GUARD_BUDGET_MS = 45_000

const OUTBOX_ID_MAP_MAX = 5000

const LLM_BREAKER_THRESHOLD = 3
const LLM_BREAKER_WINDOW_MS = 5 * 60 * 1000
const LLM_BREAKER_COOLDOWN_MS = 60 * 60 * 1000

/** Map engram type to default cognitive level (Idea 5). */
const TYPE_TO_COGNITIVE: Record<string, string> = {
  behavioral: 'apply',
  terminological: 'remember',
  procedural: 'apply',
  architectural: 'evaluate',
}

const VALID_ENGRAM_TYPES = new Set<string>(['behavioral', 'terminological', 'procedural', 'architectural'])

const INGEST_PATTERNS = [
  { re: /(?:we decided|the decision is|agreed to)\s+(.+?)\.?$/gim, type: 'architectural' as const },
  { re: /(?:always|never|must|should)\s+(.+?)\.?$/gim, type: 'behavioral' as const },
  { re: /(?:the convention is|the rule is|the pattern is)\s+(.+?)\.?$/gim, type: 'procedural' as const },
  { re: /(?:use|prefer)\s+(\w+)\s+(?:for|over|instead of)\s+(.+?)\.?$/gim, type: 'behavioral' as const },
  { re: /(?:important|note|remember):\s*(.+?)\.?$/gim, type: 'behavioral' as const },
]

/**
 * How many extra candidates a pushdown fetches per requested result.
 *
 * The store cannot evaluate expiry or `min_strength`, so those run after the
 * SQL LIMIT. Without headroom a page of `limit` rows that are then filtered
 * returns short — and short is invisible: the caller gets fewer results and no
 * indication that any were removed.
 */
const PUSHDOWN_OVERFETCH = 3
/**
 * How many times `recall`'s pushdown may widen its fetch before giving up.
 *
 * 3 rounds at 3x is 27x the requested limit. Derived, not picked: the
 * recoverable rejection ceiling is `1 - OVERFETCH^(-MAX_ROUNDS)` = 1 - 3⁻³ =
 * 26/27 ≈ 96.3%. Residual filters (expiry, min_strength) may reject up to
 * that fraction of every page and a full `limit` still comes back; past it
 * the shortfall is bounded and deterministic — recall returns what the last
 * 27x page yielded rather than escalating into an unbounded scan.
 *
 * Cost note, measured against the one shipping `role: 'primary'` adapter:
 * `PostgresAdapter.searchBM25` deliberately computes the FULL candidate set
 * regardless of the fetch limit (its trigram prefilter cannot rank, so SQL
 * LIMIT before scoring would drop true positives). For that adapter a widening
 * round therefore re-runs an identical query to take a longer slice of an
 * answer it already computed — a 2–3x amplification exactly in the
 * high-rejection case, correctness-preserving but wasteful. The loop cannot
 * see this: `narrowed.length == fetch` is indistinguishable from "more rows
 * exist". An adapter-side exhaustion signal (return fewer than `fetch` when
 * the candidate set is complete) is the fix, tracked in #753.
 */
const PUSHDOWN_MAX_ROUNDS = 3

/**
 * Rows per `listEngramsMissingEmbeddings` batch in the primary-store
 * auto-embed pass (#762). Bounds how much of the corpus is ever held in
 * memory by the pass — the pass itself runs to convergence, one batch at a
 * time, in the background. Each batch is a fresh anti-join, so concurrent
 * writers and a mid-pass crash both converge on the next pass.
 */
const PRIMARY_AUTO_EMBED_BATCH = 100

/**
 * True when a background-pass error means "the store was torn down under
 * us", not "something is wrong" (#762 follow-up, caught by smoke-packaged).
 *
 * The auto-embed pass is fire-and-track, so a short-lived process — the
 * packaged smoke, a CLI invocation, any script that closes or drops its
 * store when its work is done — can legitimately tear the store down while
 * a pass is mid-flight. That is a benign cancellation: there is nothing to
 * fix, nothing to retry, and the next engine over a live store converges.
 * Reporting it as a background FAILURE (warning + `lastIndexError`) is
 * noise at best; at worst the stray warning lands after the process's real
 * output, which is exactly how the release smoke's last-line gate caught it.
 *
 * Patterns, each tied to a specific teardown path:
 *   - Postgres `42P01` (undefined_table) / `3F000` (invalid_schema_name):
 *     `dropSchema()` won the race against the pass's next query.
 *   - "adapter is closed": `close()` beat the pass's next `getPool()`.
 *   - "after calling end": node-postgres's "Cannot use a pool after calling
 *     end on the pool" — same race, seen from a checkout already in flight.
 */
function isStoreTeardownError(err: unknown): boolean {
  const code = (err as { code?: string }).code
  if (code === '42P01' || code === '3F000') return true
  const msg = (err as Error)?.message ?? ''
  return msg.includes('adapter is closed') || msg.includes('after calling end')
}

export class Plur {
  private paths: PlurPaths
  private config: PlurConfig
  private indexedStorage: IndexedStorage | null = null
  /**
   * PGLite adapter (ADR-0001, Sprint 0 PR 2). Selected explicitly via
   * `PLUR_BACKEND=pglite` / `backend: pglite`, or automatically once the store
   * is large enough to make brute-force scanning the dominant cost (ADR-0005,
   * `backend-selection.ts`).
   * When active, runs in parallel to the YAML write path: every YAML
   * mutation triggers syncFromYaml on the PGLite index. The YAML file
   * remains the source of truth — see yaml-truth-rebuild and
   * yaml-truth-traceability tests for the invariant.
   */
  private pgliteAdapter: PGLiteAdapter | null = null
  private _pgliteInitPromise: Promise<void> | null = null
  /**
   * In-flight primary-store auto-embed pass (#762), or null. One pass at a
   * time: a write landing while a pass runs sets `_primaryEmbedRerun` instead
   * of starting a second pass, so back-to-back writes coalesce into one
   * follow-up sweep rather than N overlapping ones re-embedding the same gap.
   */
  private _primaryEmbedPass: Promise<void> | null = null
  private _primaryEmbedRerun = false
  /** One-shot latch for the embeddings-disabled notice on the primary-store auto-embed path. */
  private _primaryEmbedDisabledNoticeDone = false
  /**
   * Last background index failure (#272). Set by the .catch of the
   * fire-and-forget index chains (initial sync, syncFromYaml, reindex,
   * auto-embed); reset when a new chain is kicked off so a completed
   * successful pass leaves it null. Read via lastIndexError()/status().
   */
  private _lastIndexError: IndexSyncError | null = null
  /**
   * The source of truth for this instance's engrams (convergence Phase 1).
   * Defaults to `YamlPrimaryStore(paths.engrams)` — ADR-0001 behaviour,
   * unchanged — but the `Plur` class no longer knows that. All reads and writes
   * of primary engram state go through this, never through `loadEngrams` /
   * `saveEngrams` directly.
   */
  /** Constructor-initiated async work — see `ready()`. */
  private _readyPromise: Promise<void> = Promise.resolve()

  private _primaryStore: AsyncPrimaryStore
  /**
   * File-backed secondary stores (config `stores:` entries and installed packs),
   * memoised by path. These are YAML artifacts by definition and stay YAML even
   * when the primary store is not.
   */
  private _secondaryStores: Map<string, AsyncPrimaryStore> = new Map()
  /**
   * The storage-tier decision this instance was constructed with (ADR-0005).
   * Kept so `backendSelection()` can report the tier AND the reason — "which
   * backend am I on, and why" is a question a deployment must be able to answer
   * without reading the source.
   */
  private _backendSelection: BackendSelection
  /**
   * engram_id → injection_id of the most recent co_injection that included it
   * (#452). Fast path for linking plur_feedback verdicts to their injection
   * event; findLatestInjectionFor covers the cross-process case.
   */
  private _lastInjectionByEngram: Map<string, string> = new Map()
  /**
   * Timestamps (ms) of recent LLM failures, newest last (convergence Phase 2).
   *
   * Replaces a plain `_llmFailureCount` that `_recordLlmSuccess()` zeroed. That
   * reset is a lost-update under concurrency: `isLlmAvailable()` → `await llm()`
   * → record is a read-modify-write straddling an await, so a success returning
   * from one in-flight call erases the failures other in-flight calls just
   * recorded, and a breaker meant to trip on 3 failures never trips at all. A
   * window of failure timestamps has no such reset — a success simply does not
   * add one, and old failures age out on their own.
   */
  private _llmFailures: number[] = []
  private _llmDisabledUntil: number | null = null
  /**
   * Per-session default write scopes (convergence Phase 2). Was a single
   * `_sessionScope` field shared by every caller of the instance; see
   * `session-scopes.ts` for why that could not survive the async write path.
   */
  private _sessionScopes = new SessionScopeRegistry()
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
  /** Whether constructor-time cwd store discovery is enabled for this instance. */
  private _autoDiscover = true
  /**
   * Read-only instance (#731). Guards THREE write surfaces, because the
   * primary-store guard alone covers only one of them:
   *   1. the primary store — wrapped in {@link ReadonlyStoreGuard};
   *   2. secondary file stores — wrapped lazily in `_storeAt`;
   *   3. remote stores — HTTP writes never touch a PrimaryStore, so the
   *      public mutators gate on {@link _assertWritable} before routing.
   */
  private readonly _readonly: boolean = false

  /**
   * @param options.path  Root directory for this instance (defaults to
   *   `PLUR_PATH` or `~/.plur`).
   * @param options.store Source of truth for primary engram state. Defaults to
   *   `YamlPrimaryStore(paths.engrams)`, i.e. exactly the previous behaviour.
   *   Supplying one is what makes `Plur` source-of-truth agnostic: nothing in
   *   the class reads or writes `engrams.yaml` directly any more.
   * @param options.autoDiscover Run cwd-walking project-store discovery in the
   *   constructor. Defaults to true (`PLUR_AUTO_DISCOVER=0` flips the default
   *   without touching call sites). See {@link autoDiscoveryEnabled}.
   * @param options.cwd Directory discovery walks up from. Defaults to
   *   `process.cwd()`.
   * @param options.readonly Open the instance read-only (#731). Every mutation
   *   — local, secondary-store, and remote-routed — throws
   *   {@link ReadonlyStoreError}; reads work unchanged, except that recall's
   *   activation refresh is silently skipped (see `_reactivateResults`).
   */
  constructor(options?: {
    path?: string
    store?: AsyncPrimaryStore
    autoDiscover?: boolean
    cwd?: string
    readonly?: boolean
    /**
     * Attach a store that satisfies neither half of the implementer contract.
     *
     * An explicit acceptance that the store can lose data — see the throw in
     * the constructor. Exists so the check can be a hard failure without
     * stranding anyone who genuinely knows what their store does.
     */
    allowUnprotectedStore?: boolean
  }) {
    this.paths = detectPlurStorage(options?.path)
    this._readonly = options?.readonly === true
    const baseStore = options?.store ?? new YamlPrimaryStore(this.paths.engrams)
    this._primaryStore = this._readonly ? new ReadonlyStoreGuard(baseStore) : baseStore
    // `loadByIds` and `updateMany` are a capability PAIR: recall's targeted
    // reactivation uses them together or not at all (`canTarget` in
    // `_reactivateResults` — implementing only one silently falls back to the
    // whole-corpus load/replace path). Historically, one-without-the-other was
    // a data-loss hazard (#749: targeted read + whole-file write replaced a
    // 12-engram corpus with the 3 recalled rows). The call-site guard makes the
    // split SAFE now, but it is still almost certainly an implementation
    // mistake — so say so at attachment time, where the implementor is looking,
    // instead of leaving it to a JSDoc they may never read. A warning rather
    // than a throw: a split store works correctly today, and construction is
    // not the place to turn a performance mistake into an outage.
    if (options?.store) {
      const s = options.store as Partial<AsyncPrimaryStore>
      // Contract check (audit #794, issue #802). Every write-path guard rests
      // on SOMETHING the store says being trustworthy. A store that can
      // under-report on `load()` and offers no per-row write primitive defeats
      // all of them at once: read-modify-write is the only shape available, the
      // engine has no second opinion to check the read against, and the
      // resulting whole-corpus `save()` is indistinguishable from "the corpus
      // really is this small now". Probe p10 demonstrates it losing rows with
      // every guard in place.
      //
      // This one THROWS where the pair check below only warns, because the two
      // are different in kind: a split loadByIds/updateMany is a performance
      // mistake that still writes correctly, while this is an unprotectable
      // data-loss path. Failing at construction puts it in front of the
      // implementor, seconds after they wired it, instead of in front of the
      // user after their corpus is gone.
      const canWriteRows = typeof s.append === 'function' && typeof s.updateMany === 'function'
      if (!canWriteRows && !s.refusesUnreadable && !options.allowUnprotectedStore) {
        throw new Error(
          `[plur] refusing to attach this primary store: it can neither write single rows ` +
          `(append + updateMany) nor guarantee that a failed read throws rather than returning a ` +
          `short array (refusesUnreadable).\n` +
          `With both absent, every write is a whole-corpus replace derived from a read the engine ` +
          `cannot verify — so a bad read silently becomes permanent data loss, and no guard can ` +
          `catch it.\n` +
          `Fix by implementing append + updateMany (as PostgresAdapter and MemoryPrimaryStore do), ` +
          `or by making load() throw on an unreadable store and setting refusesUnreadable ` +
          `(as YamlPrimaryStore does).\n` +
          `Pass { allowUnprotectedStore: true } only if you accept that this store can lose data.`,
        )
      }
      const hasLoadByIds = typeof s.loadByIds === 'function'
      const hasUpdateMany = typeof s.updateMany === 'function'
      if (hasLoadByIds !== hasUpdateMany) {
        logger.warning(
          `[plur] the supplied primary store implements ${hasLoadByIds ? 'loadByIds' : 'updateMany'} but not `
          + `${hasLoadByIds ? 'updateMany' : 'loadByIds'} — they are used as a pair, so recall falls back to `
          + `whole-corpus reactivation. Implement both to enable targeted reads/writes.`,
        )
      }
      // The `learn()` seams (#828) are a SET, and a partial set is silent:
      // `canDelegate` in `learn()` is a single boolean, so a store missing one
      // member keeps paying two full corpus loads per write with nothing to
      // indicate why. Say so where the implementor is looking. A warning, not a
      // throw — a partial set is a performance mistake, not a data-loss one.
      const hasFindByHash = typeof s.findActiveByContentHash === 'function'
      const hasNextId = typeof s.nextEngramId === 'function'
      if (hasFindByHash !== hasNextId) {
        logger.warning(
          `[plur] the supplied primary store implements ${hasFindByHash ? 'findActiveByContentHash' : 'nextEngramId'} `
          + `but not ${hasFindByHash ? 'nextEngramId' : 'findActiveByContentHash'} — learn() needs both to skip the `
          + `whole-corpus load, so it still loads the corpus. Implement both.`,
        )
      } else if (hasFindByHash && !(canWriteRows && hasLoadByIds)) {
        logger.warning(
          `[plur] the supplied primary store implements the learn() derive seams `
          + `(findActiveByContentHash + nextEngramId) but not the targeted-write seams `
          + `(append + updateMany + loadByIds) — learn() still loads the corpus, because a whole-corpus `
          + `save() is the only write available. Implement all five to enable targeted learns.`,
        )
      }
    }
    this.config = loadConfig(this.paths.config)
    this._autoDiscover = Plur.resolveAutoDiscover(options?.autoDiscover)
    // Auto-discover project stores from CWD (skips temp dirs for test safety).
    //
    // Opt-out exists because this is a constructor with a DISK SIDE EFFECT
    // derived from `process.cwd()`: a discovered `.plur/engrams.yaml` is written
    // into config.yaml via addStore. For a CLI, whose cwd IS the user's intent,
    // that is the feature. For an instance shared by concurrent sessions it is
    // not: the process cwd expresses nobody's intent, and the store it adds
    // becomes visible to every session on the instance. Construction should not
    // silently reconfigure a shared deployment.
    if (this._autoDiscover) this.autoDiscoverStores(options?.cwd)
    // Re-read config after potential store additions
    if (this.config.stores?.length !== loadConfig(this.paths.config).stores?.length) {
      this.config = loadConfig(this.paths.config)
    }
    this.configMtimeMs = this.statConfigMtime()
    const selection = this._resolveBackend()
    this._backendSelection = selection
    // Phase 2b removed the constraint that used to live here: `Plur`'s write
    // path was synchronous, and Node has no synchronous Postgres client, so a
    // network-backed store could not satisfy the primary-store contract. The
    // store interface is async now (`AsyncPrimaryStore`), and `PostgresAdapter`
    // implements it alongside `StorageAdapter` — so the postgres tier CAN be
    // this process's primary store.
    //
    // Selection still does not construct one implicitly: a connection is a
    // resource with credentials and a lifecycle, and manufacturing one from a
    // config string inside a constructor would make failure modes appear at
    // surprising moments. The caller passes the adapter in
    // (`new Plur({ store: new PostgresAdapter(...) })`), and selection reports
    // the tier so a deployment can act on it.
    if (selection.tier === 'postgres' && this._primaryStore.kind !== 'postgres') {
      logger.info(
        `[plur] backend=postgres selected (${selection.reason}, ~${selection.engramCount} engrams), `
        + `but this instance was constructed with a ${this._primaryStore.kind} store. Pass `
        + `new Plur({ store: new PostgresAdapter(...) }) to run on the Postgres tier.`,
      )
    } else if (selection.wanted === 'postgres') {
      logger.warning(
        `[plur] ~${selection.engramCount} engrams is past the Postgres threshold, but no connection string is `
        + `configured (postgres.url / PLUR_POSTGRES_URL) — running the SQLite index instead.`,
      )
    }
    // A Postgres PRIMARY store answers its own queries — do not build a PGLite
    // index alongside it.
    //
    // This used to read `selection.tier === 'postgres' ? 'pglite' : ...`
    // unconditionally, which then constructed a `PGLiteAdapter` rooted at
    // `this.paths.engrams` and synced it `syncFromYaml()`. For a Postgres-backed
    // deployment that YAML file is not the source of truth and need not exist,
    // so the derived index was built from nothing and every query went to it
    // instead of to the store that actually holds the data — which is why
    // `searchBM25` and `corpusStats` had no reachable call sites.
    //
    // The condition is the injected store, not the size-based tier: the tier can
    // read 'postgres' while the caller passed no Postgres store at all (the
    // warning above covers that case), and then PGLite is still the right index.
    const hasPrimaryQueryStore = this._primaryQueryAdapter() !== null
    const indexTier = hasPrimaryQueryStore
      ? 'none'
      : selection.tier === 'postgres' ? 'pglite' : selection.tier
    if (indexTier === 'pglite' && selection.reason !== 'size') {
      // #1046: PGLite is opt-in now. Say so on the way in, so an operator who
      // set it months ago and forgot can see which engine they are on when a
      // command feels slow — it boots Postgres in WASM on every process.
      logger.warning(
        `[plur] backend=pglite (${selection.reason}). PGLite boots Postgres in WASM per process; ` +
        'it is for pgvector/AGE capabilities, not speed. Unset PLUR_BACKEND / backend: to use SQLite.',
      )
    }
    if (indexTier === 'pglite') {
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
    } else if (indexTier === 'sqlite' ? this.config.index !== false : this.config.index) {
      // The `indexTier === 'sqlite'` arm exists because of the bug ADR-0005 §1
      // documents and #1046 nearly reintroduced. `PlurConfigSchema` is
      // `.partial()`, which NEUTRALISES Zod defaults — so `config.index` is
      // `undefined` on a default install, and a plain `if (this.config.index)`
      // silently builds nothing. That is how "the default backend does
      // nothing" happened the first time: selection reported a tier, no index
      // was built, and every recall brute-forced cosine over the whole corpus
      // (~350 MB resident at ~4,700 engrams, per process).
      //
      // When selection ASKED for sqlite, an absent config value means "not
      // configured", not "disabled" — only an explicit `index: false` opts
      // out. The other arm keeps the historical behaviour for tiers that were
      // never size-selected.
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
    // A constructor cannot await, and this is a one-time migration guarded by a
    // sentinel file (#156). It must never take the constructor down — but with
    // an async write path, "started in the constructor" and "finished" are no
    // longer the same moment, so callers that need the result get `ready()`.
    this._readyPromise = this._autoPurgeLegacyTensions().catch((err: unknown) => {
      logger.warning(`[plur] legacy tension auto-purge failed: ${(err as Error).message}`)
    })
  }

  /**
   * Root directory of this instance's store (`~/.plur`, `PLUR_PATH`, or the
   * explicit constructor `path`). Synchronous mirror of `status().storage_root`
   * for callers that need the location without an async round-trip — e.g. the
   * MCP server's payload-drop forensic log (plur-ai/plur#772), which must write
   * next to the store the dropped call was aimed at.
   */
  get storageRoot(): string {
    return this.paths.root
  }

  /**
   * Resolve the active storage tier. Order:
   *   1. `PLUR_BACKEND` env var (yaml|sqlite|pglite|postgres)
   *   2. config.yaml `backend` field
   *   3. the size of the store — see `backend-selection.ts` / ADR-0005
   *
   * Step 3 is the new one. The old implementation stopped at "default: sqlite",
   * which combined with `config.index` being undefined-by-default meant the
   * common case built no index at all and brute-forced cosine over the entire
   * corpus, in every process, on every recall.
   *
   * The estimate comes from `PrimaryStore.estimateCount()` — a `stat()`, not a
   * parse. Deciding which backend to build must not cost what the wrong backend
   * would have cost.
   */
  private _resolveBackend(): BackendSelection {
    return resolveBackendTier({
      env: process.env.PLUR_BACKEND,
      config: (this.config as { backend?: string }).backend,
      engramCount: this._primaryStore.estimateCount?.() ?? 0,
      postgresConfigured: Boolean(this._postgresUrl()),
    })
  }

  /** Configured Postgres DSN, env first. Never logged unredacted. */
  private _postgresUrl(): string | undefined {
    const env = process.env.PLUR_POSTGRES_URL
    if (env) return env
    return (this.config as { postgres?: { url?: string } }).postgres?.url
  }

  /**
   * How this instance's storage tier was chosen — tier, reason, the estimate it
   * was made from, and (when the size estimate wanted a tier it could not have)
   * `wanted`. Diagnostics: a deployment should never have to guess which
   * backend it is on or why.
   */
  backendSelection(): BackendSelection {
    return this._backendSelection
  }

  private async _autoPurgeLegacyTensions(): Promise<void> {
    // A read-only instance must not run a write migration — and must not stamp
    // the sentinel either, or the purge would be recorded as done without ever
    // having happened. Left for the next writable instance to perform (#731).
    if (this._readonly) return
    const sentinel = join(this.paths.root, '.tensions-purged')
    if (fs.existsSync(sentinel)) return
    try {
      const result = await this.purgeTensions()
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
  private async _loadAllEngrams(): Promise<Engram[]> {
    const primary = await this._loadCached(this.paths.engrams)
    return [...primary, ...(await this._loadSecondaryAndPacks())]
  }

  /**
   * Everything that is NOT the primary store: configured secondary stores
   * (file-path AND remote) plus installed packs, with the id namespacing, scope
   * narrowing and containment guard applied.
   *
   * Extracted so the BM25 pushdown path can reach these rows without loading the
   * primary corpus — the whole point of pushing the query into the store. An
   * earlier version of that path re-implemented this loop and got three things
   * wrong at once: it skipped `url` stores entirely (so an enterprise team store
   * vanished from `recall()` while `list()` still showed it), and it returned
   * rows RAW — no namespacing, no `global` narrowing, no `isScopeWithin` guard.
   * The namespacing one had teeth beyond cosmetics: both stores mint
   * date-sequenced ids (`ENG-YYYY-MM-DD-NNN`, legacy `ENG-YYYY-MMDD-NNN`)
   * from a per-store daily sequence, so ids collide as the
   * common case, and `feedback()` / `forget()` resolve by exact id against the
   * primary store first — mutating an unrelated engram.
   *
   * One implementation, two callers. Duplicating it is what caused all three.
   */
  private async _loadSecondaryAndPacks(): Promise<Engram[]> {
    const stores = this.config.stores ?? []
    const all: Engram[] = []
    for (const store of stores) {
      const storeEngrams = store.url
        ? this._loadRemoteCached(store)
        : await this._loadCached(store.path!)
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
        // Sanitise HERE, at the point pack content enters the injection corpus
        // (#940, #952). Pack install does not call learn() or learnRouted() —
        // it copies the pack's file into the packs directory and this loop
        // feeds those rows straight into the corpus — so a pack statement with
        // a forged boundary would mint a fabricated entry with neither write
        // path in front of it. Pack content is the explicit threat model in the
        // splitter's own docstring: it is the one corpus whose author is by
        // definition someone else.
        //
        // Load time rather than install time, deliberately. Install time would
        // leave every already-installed pack, and any pack placed in the
        // directory by hand or by a sync, unsanitised. This is the last gate
        // before injection, so it is the one that has to hold.
        for (const f of ['statement', 'rationale', 'source', 'summary', 'domain'] as const) {
          if (typeof cloned[f] === 'string') cloned[f] = collapseLineTerminators(cloned[f])
        }
        all.push(cloned)
      }
    }

    return all
  }

  /**
   * Cached read from the store that owns `path`.
   *
   * The mtime bookkeeping that used to live here now lives inside
   * `YamlPrimaryStore` — a cache is a property of the backing medium, not of
   * the caller, and a store whose medium has no mtime (memory, Postgres)
   * answers `loadCached()` its own way.
   */
  private async _loadCached(path: string): Promise<Engram[]> {
    return await this._storeAt(path).loadCached()
  }

  /**
   * Per-instance pool of RemoteStore drivers, keyed by url+scope.
   * RemoteStore holds its own internal TTL cache so repeated load()
   * within ttlMs returns the same array without a network call.
   *
   * `_loadRemoteCached` is a synchronous PEEK: it returns whatever the
   * driver's in-memory cache currently holds and NEVER fires a load —
   * background or otherwise. Until something explicitly warms the driver
   * (`warmRemoteCaches()`, e.g. via session_start), it returns [] for that
   * store every time, not just on the first call.
   *
   * #776 (server-authoritative recall): this peek is DEMOTED. Live recall now
   * reaches remote engrams through `remoteRecall` (`POST /api/v1/recall` per
   * host, merged at the call sites), so the peek serves only the non-recall
   * duties that still route through `_loadSecondaryAndPacks` (stores_list
   * counts, feedback/getById resolution) plus warm-site loads. The floating
   * `void driver.load()` background refresh that used to fire here on EVERY
   * read is gone with it — the refresh existed to make the NEXT recall less
   * cold, and recall no longer feeds from this cache. Warm sites
   * (`warmRemoteCaches`) still populate it explicitly.
   */
  private _remoteStores = new Map<string, RemoteStore>()
  private _loadRemoteCached(store: StoreEntry): Engram[] {
    const driver = this._getRemoteDriver({ url: store.url!, token: store.token, scope: store.scope })
    // Synchronously read whatever the driver currently has cached — no
    // background refresh (#776, see JSDoc above).
    const cached = (driver as unknown as { cache: { engrams: Engram[] } | null }).cache
    return cached?.engrams ?? []
  }

  /**
   * Persist engrams to the store that owns `path`.
   *
   * The write-invalidates-cache rule now lives inside the store
   * (`PrimaryStore.save()` drops its own cache) rather than being the caller's
   * job. Why it matters: `YamlPrimaryStore.loadCached()` uses mtime-based
   * invalidation, but on CI tmpfs (ubuntu-latest runners) mtime resolution can
   * be coarse enough that a stat() taken before and after a write returns the
   * same mtime. When that happens the cache serves a pre-write snapshot and a
   * subsequent `getById` returns `undefined` for an engram that `learn()` just
   * created. Invalidating on write removes the filesystem as a source of cache
   * freshness and closes the race. See issue #25.
   */
  private async _writeEngrams(
    path: string,
    engrams: Engram[],
    opts?: { allowShrink?: boolean },
  ): Promise<void> {
    const store = this._storeAt(path)
    // Backend-independent floor (audit #794, issue #802). The YAML writer has
    // its own shrink guard, but that guard lives in `saveEngrams` and so only
    // covers YAML. `save()` is a whole-corpus replace on EVERY backend, and on
    // Postgres it ends in `DELETE FROM engrams WHERE id NOT IN (…)` — with an
    // empty array, an unqualified `DELETE FROM engrams`.
    //
    // Emptying the corpus is never an incidental outcome: `compact`, `forget`,
    // the outbox handoff and pack uninstall all declare `allowShrink`. An
    // undeclared empty save means the caller read nothing and is about to make
    // that permanent, which is the whole shape of this audit.
    if (!opts?.allowShrink && engrams.length === 0) {
      throw new Error(
        `[plur] refusing to write an empty corpus to ${path}.\n` +
        `A store write replaces the whole corpus, so this would delete every engram in it. ` +
        `Operations that legitimately empty a store declare it; this one did not, which means the ` +
        `caller most likely read the store as empty when it is not.\n` +
        `If the store really should be emptied, use the operation that says so (compact/forget).`,
      )
    }
    await store.save(engrams, opts)
  }

  /**
   * Persist one brand-NEW engram to the primary store (#740).
   *
   * `corpus` is the caller's already-loaded primary corpus, held under
   * `_withStoreLock`; the engram is pushed into it here so the caller's view
   * and the fallback write stay consistent by construction. A store with the
   * `append` capability gets a true single-row INSERT; every other store gets
   * exactly the write `learn()` has always done — one `save()` of the corpus
   * in hand. The corpus is REUSED, never re-loaded: re-parsing a file the
   * caller just parsed (under the same lock) was the #745 regression this
   * shape exists to rule out.
   */
  private async _appendEngram(corpus: Engram[], engram: Engram): Promise<void> {
    corpus.push(engram)
    if (this._primaryStore.append) {
      await this._primaryStore.append(engram)
    } else {
      await this._writeEngrams(this.paths.engrams, corpus)
    }
  }

  /**
   * Persist mutations to EXISTING primary-store engrams (#740).
   *
   * `changed` are rows from `corpus` (the caller's already-loaded primary
   * corpus, held under `_withStoreLock`) that the caller has mutated in place.
   * A store with `updateMany` gets a targeted write of just those rows — the
   * same machinery recall's activation refresh uses (#749/#755), so there is
   * ONE incremental-update seam, not two. Every other store gets the
   * whole-corpus `save()` it always got, reusing the corpus in hand.
   *
   * Missing-id policy: this cannot silently drop a mutation. `updateMany` is
   * an upsert on every capability store (Postgres `ON CONFLICT DO UPDATE`,
   * MemoryPrimaryStore mirrors it), so a row that vanished between the
   * caller's locked load and this write is re-inserted rather than lost; the
   * fallback writes the corpus, which contains the mutation by construction.
   * There is deliberately no found/not-found boolean here — a signal every
   * call site would have to remember to check (and #745's `update(): false`
   * showed they don't) is worse than semantics that cannot lose the write.
   */
  /**
   * Read the primary-store rows for `ids` — targeted when the store can, a
   * whole-corpus load when it cannot (#827).
   *
   * Every caller is the same shape: load, find one row by id, mutate it, hand
   * it to {@link _updateEngrams}. The WRITE has been targeted since 0.17; the
   * READ was not, so a store that implements the 0.17 pair still paid a full
   * table scan to fetch a row by primary key on every feedback signal, pin
   * toggle, update and forget. `_reactivateResults` already took the targeted
   * branch for exactly this shape — these call sites were simply missed.
   *
   * `loadByIds` and `updateMany` are checked as a PAIR, and the pair is what
   * makes the return value safe to use as "the corpus in hand". Callers pass
   * the array straight on to `_updateEngrams`, which falls back to a FULL
   * REPLACE of whatever it is given when `updateMany` is absent. Taking the
   * targeted read alone would therefore hand a one-row array to a whole-corpus
   * save and delete everything else — the #749 defect, from the write side.
   * Requiring both means the subset is only ever produced when the write that
   * consumes it is itself targeted.
   *
   * Ids absent from the store are simply not returned, so a caller's
   * `find(...)` miss keeps its existing meaning and its existing fall-through
   * to the secondary stores.
   */
  private async _loadTargeted(ids: string[]): Promise<Engram[]> {
    const store = this._primaryStore
    return store.loadByIds && store.updateMany
      ? await store.loadByIds(ids)
      : await store.load()
  }

  private async _updateEngrams(corpus: Engram[], changed: Engram[]): Promise<void> {
    if (changed.length === 0) return
    if (this._primaryStore.updateMany) {
      await this._primaryStore.updateMany(changed)
    } else {
      await this._writeEngrams(this.paths.engrams, corpus)
    }
  }

  /**
   * Throw {@link ReadonlyStoreError} when this instance was opened with
   * `readonly: true`. Called at the top of every public mutator, BEFORE any
   * routing: remote-routed writes (learnRouted's server POST, outbox flush,
   * remote feedback/forget) never touch the guarded PrimaryStore, so the
   * store guard alone cannot stop them — this gate is what does (#731).
   */
  private _assertWritable(): void {
    if (this._readonly) throw new ReadonlyStoreError()
  }

  /**
   * Resolve the `PrimaryStore` that owns `path`.
   *
   * `paths.engrams` maps to the configured primary store — which may be
   * injected and need not be YAML at all. Every other path is a file-backed
   * secondary store (a `stores:` entry, or an installed pack's engrams.yaml),
   * which is a YAML artifact by definition. Instances are memoised so each
   * path keeps one cache, matching the old per-path `_engramCache` map.
   */
  /**
   * Run a read-modify-write under exclusive access to the store that owns
   * `path`.
   *
   * Every write method here is load → mutate → save, which is only safe under
   * mutual exclusion. That exclusion used to be `withAsyncLock(path, …)`
   * unconditionally: an in-process mutex plus an `O_EXCL` file on the LOCAL
   * disk. Correct for a YAML store, where the path being locked IS the data —
   * and worthless for a shared database, where two processes share neither the
   * mutex nor the file, so both load, both mutate, and both save. Because
   * `save()` replaces the whole corpus, the loser deletes rows the winner had
   * already committed.
   *
   * So ask the store first. A store that spans processes says how it wants to
   * be serialized (`PostgresAdapter` takes a Postgres advisory lock); one that
   * does not, or that has no cross-process story, falls back to the file lock,
   * which is exactly right for a local file.
   *
   * @see AsyncPrimaryStore.withExclusiveAccess
   */
  private async _withStoreLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const store = this._storeAt(path)
    // Lock the store's PHYSICAL location, not the conventional path (#813,
    // audit finding 11). `paths.engrams` is where a store would live by
    // convention; an INJECTED store can own bytes somewhere else entirely, and
    // `location` is the interface's answer to "where are they". Locking the
    // convention meant two Plur instances with different roots but the same
    // injected YamlPrimaryStore took DIFFERENT lock files while doing
    // read-modify-write against the SAME file — so one write could overwrite
    // the other with both reporting success.
    //
    // Falls back to `path` when the store reports no location: an in-memory
    // store has no file to contend over, and a network store answers with
    // `withExclusiveAccess` before this line is reached.
    const lockKey = store.location ?? path
    const guarded = async (): Promise<T> => {
      this._maybeDailyBackup(path)
      return await fn()
    }
    if (store.withExclusiveAccess) return await store.withExclusiveAccess(guarded)
    return await withAsyncLock(lockKey, guarded)
  }

  /**
   * Snapshot the primary store once per process per day (#799).
   *
   * Called from INSIDE the lock and BEFORE `fn` runs, which is the whole point:
   * the copy must be of the on-disk bytes as they were before any write path
   * could replace them, and it must be under the lock so it cannot catch a
   * half-written file.
   *
   * Only the primary store, and only when writable. A read-only instance must
   * not have write side effects (#731), and secondary stores are the remote's
   * or the pack's to protect — snapshotting them here would silently multiply
   * disk use for data this instance does not own.
   *
   * Never throws: the backup is a safety net for the write, not a precondition
   * of it. A failed snapshot warns and lets the write proceed.
   */
  private _maybeDailyBackup(path: string): void {
    if (this._readonly) return
    if (path !== this.paths.engrams) return
    if (this._primaryStore.kind !== 'yaml') return
    // Snapshot the file the store ACTUALLY owns. Backing up the conventional
    // path meant an injected store's real corpus received no backup at all,
    // while a possibly non-existent conventional path was snapshotted in its
    // place (#813, audit finding 11).
    const target = this._primaryStore.location ?? path
    try {
      maybeDailyBackup(this.paths.root, target)
    } catch {
      /* maybeDailyBackup already logs; a backup must never fail a write */
    }
  }

  /**
   * Ids this store has minted today that are no longer in the corpus (#816).
   *
   * Read from the append-only history log, which — unlike the corpus — never
   * forgets. See `mintedIdsWithPrefix` for why an incomplete answer is safe.
   */
  private _mintedTodayIds(): string[] {
    const day = new Date().toISOString().slice(0, 10)
    // Cached per process, per day.
    //
    // Without this, every learn() re-read and re-parsed a month of
    // history.jsonl — on the hottest write path, to answer a question whose
    // answer this process already knows. The cache is keyed on the DAY so it
    // self-invalidates across midnight (allocation is per-day, so yesterday's
    // ids are irrelevant to today's suffix).
    //
    // Staleness is safe in the one direction that matters: ids minted by
    // ANOTHER process after this cache was filled are missing from it, which
    // degrades to the pre-fix corpus-only behaviour rather than introducing a
    // new hazard — and the corpus scan, which is always fresh, still sees any
    // engram that other process actually wrote. Ids minted by THIS process are
    // added below without a re-read, so a burst of writes in one session stays
    // monotonic without touching disk again.
    if (this._mintedCache?.day !== day) {
      this._mintedCache = {
        day,
        ids: new Set(mintedIdsWithPrefix(this.paths.root, day.slice(0, 7), [
          `ENG-${day}-`,
          `ENG-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}-`,
        ])),
      }
    }
    return [...this._mintedCache.ids]
  }

  /** Record an id this process just minted, so the next allocation sees it
   *  without re-reading history (#816). */
  private _rememberMintedId(id: string): void {
    const day = new Date().toISOString().slice(0, 10)
    if (this._mintedCache?.day === day) this._mintedCache.ids.add(id)
  }

  private _mintedCache: { day: string; ids: Set<string> } | null = null

  private _storeAt(path: string): AsyncPrimaryStore {
    if (path === this.paths.engrams) return this._primaryStore
    let store = this._secondaryStores.get(path)
    if (!store) {
      store = new YamlPrimaryStore(path)
      // Read-only instances guard SECONDARY stores too (#731): forget/feedback/
      // recurrence on a store engram write through `_storeAt(storeInfo.path)`,
      // not through the primary store, so wrapping only the primary would leave
      // every `stores:` file writable from a "read-only" engine.
      if (this._readonly) store = new ReadonlyStoreGuard(store)
      this._secondaryStores.set(path, store)
    }
    return store
  }

  /**
   * The store of record for this instance's own engrams.
   *
   * Public so callers can ask what they are actually persisting to
   * (`plur.primaryStore.kind`) instead of assuming `engrams.yaml`.
   */
  get primaryStore(): AsyncPrimaryStore {
    return this._primaryStore
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
  private async _findEngramStore(id: string): Promise<{ path: string; readonly: boolean; originalId: string } | null> {
    // Check primary first (uses mtime cache)
    const primaryEngrams = await this._loadCached(this.paths.engrams)
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
        const storeEngrams = await this._loadCached(store.path)
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
   * re-learning a retired statement creates a fresh engram (issue #107).
   *
   * A statement with no hashable content never matches (#896). Every such
   * statement hashes to the SHA-256 of the empty string, so matching on it
   * declares unrelated facts to be the same fact — which is exactly how the
   * non-Latin collapse absorbed four distinct memories into one row. The
   * normalizer no longer produces that for real prose; this is the belt to its
   * braces, and it fails in the safe direction (a missed dedup costs a
   * duplicate row, a false dedup costs the memory). */
  private _hashDedup(statement: string, engrams: Engram[], scope?: string): Engram | null {
    if (!isHashable(statement)) return null
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

  /** Apply a duplicate-write to an existing engram: increment write_count,
   * append source, persist to primary store if that's where the engram lives.
   * Mutates the engram and (best-effort) writes back. See issue #107. */
  private async _recordDuplicate(
    hit: Engram,
    engrams: Engram[],
    scope: string,
    context: LearnContext | undefined,
    /** The incoming statement this write carried — logged (truncated) so a
     *  MISDIRECTED absorption is visible, which is the whole point of #852. */
    statement = '',
  ): Promise<Engram> {
    // Apply the increment to the row from the CALLER'S array, not to `hit`.
    //
    // `hit` is the match the caller found, and on the remote route that search
    // ran OUTSIDE the write lock — so by the time we are here it may be a stale
    // copy of a row another writer has since changed. Mutating `hit` and
    // splicing it in (`engrams[idx] = hit`, as this did) writes the pre-lock
    // snapshot over the fresh row and reverts that other change: a concurrent
    // `feedback` increment simply disappears, with both calls reporting success.
    //
    // Reading the current row out of `engrams` and incrementing THAT keeps the
    // read-modify-write inside the lock, where it belongs.
    const idx = engrams.findIndex(e => e.id === hit.id)
    const target = idx !== -1 ? engrams[idx] : hit

    // Use defaults for engrams migrated without these fields.
    // write_count was named reference_count before #866.
    const currentCount = target.write_count ?? 1
    const currentSources = (target as any).sources ?? []
    target.write_count = currentCount + 1
    ;(target as any).sources = [...currentSources, this._buildSourceEntry(scope, context)]
    // #852: an absorbed write left NO trace — no engram_created, no
    // recurrence_detected, nothing. That silence is why a misdirected
    // absorption could run for months without anyone seeing it, and it is the
    // difference between "a duplicate was counted" and "my memory vanished".
    // The caller is handed an engram it did not write; the log should say so.
    try {
      appendHistory(this.paths.root, {
        event: 'engram_duplicate_absorbed',
        engram_id: target.id,
        timestamp: new Date().toISOString(),
        data: {
          matched_on: 'content_hash',
          write_count_after: target.write_count,
          scope,
          // Enough to spot a misdirected absorption without storing the
          // incoming statement verbatim.
          incoming_preview: statement.slice(0, 120),
        },
      })
    } catch { /* history is an audit trail, never a gate on the write */ }

    // Persist if the engram is in the primary store. Cross-store duplicates
    // (same scope across stores) are deduplicated but not persisted in v1 —
    // `target` is then `hit` itself and the mutation is returned to the caller
    // without a write, which is the documented v1 behaviour.
    if (idx !== -1) {
      // Incremental write (#740): only the duplicate-counted engram changed.
      await this._updateEngrams(engrams, [target])
      await this._syncIndex()
    }
    return target
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
    // Same guard as `_hashDedup` (#896): an unhashable statement would report
    // every other unhashable statement as the same fact recurring, and this
    // path ESCALATES on a hit — broadening scope to global and hardening
    // commitment. A false positive here is louder than a missed one.
    if (!isHashable(statement)) return null
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
  private async _recordCrossScopeRecurrence(
    hit: Engram,
    engrams: Engram[],
    scope: string,
    context: LearnContext | undefined,
  ): Promise<Engram> {
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
      e.write_count = (e.write_count ?? 1) + 1
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
      hit.write_count = mutated.write_count
      ;(hit as any).sources = (mutated as any).sources
      if (mutated.locked_at !== undefined) hit.locked_at = mutated.locked_at
      if (mutated.locked_reason !== undefined) hit.locked_reason = mutated.locked_reason
    }

    type PersistenceTarget = 'primary' | 'secondary' | 'in-memory'
    const primaryIdx = engrams.findIndex(e => e.id === hit.id)
    // Definite-assignment asserted: every branch below assigns both, but one of
    // those branches now runs inside the secondary store's lock callback, which
    // TypeScript cannot prove is invoked. The alternative — threading both
    // values out through the callback's return type — obscures the control flow
    // for no benefit, since the callback is awaited on the same line.
    let persistedTo!: PersistenceTarget
    let newRecurrence!: number

    if (primaryIdx !== -1) {
      // Primary store: mutate the engram in the loaded array (symmetric with
      // secondary path — both mutate the on-disk-bound object, not hit).
      const target = engrams[primaryIdx]
      newRecurrence = applyMutation(target, sourceEntry, lockTimestamp)
      // Incremental write (#740): only the recurrence-escalated engram changed.
      await this._updateEngrams(engrams, [target])
      await this._syncIndex()
      persistedTo = 'primary'
      // Audit iter-5 fix (Data finding 1): explicit identity guard makes the
      // self-assign no-op contract visible. When _loadAllEngrams and the primary
      // engrams array share references, target IS hit and syncing is redundant;
      // the guard documents the assumption without changing behavior today.
      if (target !== hit) syncHitFrom(target)
    } else {
      // primaryIdx already proved this isn't in primary; only check writability.
      const storeInfo = await this._findEngramStore(hit.id)
      if (storeInfo && !storeInfo.readonly) {
        // Under the SECONDARY store's own lock. This read-modify-write had none
        // at all, while the identical operation on the primary store took one:
        // two processes recording recurrence on the same team engram both
        // loaded, both mutated, and both wrote — and because `_writeEngrams`
        // replaces the whole file, whatever the other added in between was
        // deleted outright, not merely overwritten.
        await this._withStoreLock(storeInfo.path, async () => {
        const storeEngrams = await this._storeAt(storeInfo.path).load()
        const sidx = storeEngrams.findIndex(e => e.id === storeInfo.originalId)
        // Audit iter-5 defense (Critic low #3): _crossScopeRecurrenceDetect
        // filters status==='active' at the entry point, but a cross-process
        // race could retire the secondary-store copy between detection and
        // mutation. Treat retired-on-arrival the same as not-found.
        if (sidx !== -1 && storeEngrams[sidx].status === 'active') {
          newRecurrence = applyMutation(storeEngrams[sidx], sourceEntry, lockTimestamp)
          await this._writeEngrams(storeInfo.path, storeEngrams)
          await this._syncIndex()
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
        })
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
      this._llmFailures = []
    }
    return true
  }

  private _recordLlmFailure(): void {
    const now = Date.now()
    // Age out failures older than the window, then count what is left. Purely
    // additive — nothing here erases a failure another in-flight call recorded.
    this._llmFailures = this._llmFailures.filter(t => now - t < LLM_BREAKER_WINDOW_MS)
    this._llmFailures.push(now)
    if (this._llmFailures.length >= LLM_BREAKER_THRESHOLD) {
      this._llmDisabledUntil = now + LLM_BREAKER_COOLDOWN_MS
      logger.warning('LLM dedup circuit breaker tripped — disabled for 1 hour')
    }
  }

  /**
   * Record a successful LLM call.
   *
   * Deliberately NOT a reset. The previous implementation set the failure count
   * to zero, which under concurrent calls means one success cancels every
   * failure recorded by calls still in flight — the breaker then never trips
   * however badly the LLM is behaving. Successes now only fail to *add* to the
   * window; failures leave it by aging out.
   */
  private _recordLlmSuccess(): void {
    const now = Date.now()
    this._llmFailures = this._llmFailures.filter(t => now - t < LLM_BREAKER_WINDOW_MS)
  }

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
  // Synchronous. An automated add-awaits pass made this `async` during the
  // Phase 2 flip even though it does no async work — every call in its body
  // is synchronous. Reverted: 0.16.0 is unreleased, so this method was never
  // actually breaking, and leaving it async would have been a breaking
  // signature change that bought nothing. Shrinking the migration surface is
  // worth more than uniformity.
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
    // An EMPTY forbid list means "not configured", not "forbid nothing" (#847).
    //
    // `??` supplies the default only for null/undefined, so an explicit `[]`
    // used to forbid nothing and switch this scope's scan off entirely. Nobody
    // declares a sensitivity block in order to forbid nothing — omitting the
    // block already says that, and more clearly. The realistic origin is a
    // layer that normalises a partial policy into a complete object by filling
    // absent keys with empty arrays, which is the obvious way to write one.
    //
    // The failure ran in the dangerous direction: the scope then looked MORE
    // governed than a scope with no policy at all, while being the only one
    // with no scan. Length check rather than `??`, so both shapes default.
    const forbid = new Set<SensitivityCategory>(
      policy?.forbid && policy.forbid.length > 0 ? policy.forbid : ['secrets', 'infra'],
    )
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
  private async _resolveUnscopedScope(
    statement: string,
    context?: LearnContext,
  ): Promise<{ scope: string; routed: { scope: string; confidence: number; reason: string } | null }> {
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
    const writableScopeMetadata = (await this.listScopeMetadata()).filter(md => {
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

  private async _guardSensitiveScope(
    statement: string,
    context?: LearnContext,
  ): Promise<{ scope: string; context: LearnContext | undefined; demotion: { from: string; to: string; patterns: string } | null; routed: { scope: string; confidence: number; reason: string } | null }> {
    // "Truly unscoped" = caller passed no scope AND no session/`.plur.yaml`
    // default is in effect (both land in the session scope registry). Only this
    // path auto-routes / applies unscoped_default; everything else is honored
    // as-is.
    //
    // The session scope is resolved for THIS call's session (`context.session`),
    // not read off a shared field — under concurrent sessions the shared field
    // let one session's `setSessionScope` decide another session's write. See
    // `session-scopes.ts`.
    const sessionScope = this._sessionScopes.get(context?.session)
    let routed: { scope: string; confidence: number; reason: string } | null = null
    let scope: string
    if (context?.scope == null && sessionScope == null) {
      const resolved = await this._resolveUnscopedScope(statement, context)
      scope = resolved.scope
      routed = resolved.routed
    } else {
      // Terminal fallback respects unscoped_default so a `unscoped_default:'local'`
      // user with no session scope and no context scope is not silently forced
      // to global (#353). No behavior change for the default-global user.
      scope = context?.scope ?? sessionScope ?? (this.config.unscoped_default ?? 'global')
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

  async learn(statement: string, context?: LearnContext): Promise<Engram> {
    this._assertWritable()
    if (typeof statement !== 'string' || statement.length === 0) {
      throw new TypeError(`plur.learn: statement must be a non-empty string, got ${typeof statement}`)
    }
    // Collapse line terminators so a crafted boundary cannot be promoted to
    // system-prompt authority by the renderer's splitter (#952, #940).
    // learnRouted() applies the same helper on its own entry, because it does
    // NOT enter this method on the remote route — see sanitize.ts.
    statement = collapseLineTerminators(statement)
    if (context?.type !== undefined && !VALID_ENGRAM_TYPES.has(context.type)) {
      throw new TypeError(
        `plur.learn: invalid type '${context.type}'. Must be one of: behavioral, terminological, procedural, architectural`
      )
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
    const guarded = await this._guardSensitiveScope(statement, context)
    context = guarded.context
    // #347: resolve the validity window up-front (pure) so malformed
    // valid_from/valid_until fail fast — even when the write would dedup
    // into an existing engram below.
    const validity = resolveValidity(statement, context)
    return await this._withStoreLock(this.paths.engrams, async () => {
      const scope = guarded.scope
      const ps = this._primaryStore
      // Can the store answer BOTH derived facts `learn()` needs — "is this
      // statement already here in this scope" and "what is the next id" —
      // without the corpus, AND take every write `learn()` performs as a
      // targeted row operation? (#828)
      //
      // It is a capability SET, not a pair, and every member is load-bearing.
      // The derive seams are jointly required because each of the two facts is
      // otherwise read off the SAME materialised corpus — delegating one still
      // pays the full load for the other. The write seams are required because
      // every fallback below (`_appendEngram`, `_updateEngrams`,
      // `_writeSupersededByEdges`) takes "the corpus in hand" and, absent a
      // row-level write, turns it into a whole-corpus `save()`. Taking the
      // targeted READ without the targeted WRITE would hand a stand-in array
      // of one or two rows to a FULL REPLACE — the #749 shape that deleted a
      // corpus on an ordinary recall, and the reason `_reactivateResults`
      // checks its pair rather than each half.
      const canDelegate = Boolean(
        ps.findActiveByContentHash && ps.nextEngramId
        && ps.append && ps.updateMany && ps.loadByIds,
      )
      // The primary corpus, or an empty stand-in when nothing below will read
      // or rewrite it. Safe ONLY under `canDelegate` — see above.
      const engrams = canDelegate ? [] : await ps.load()
      // Secondary stores and packs are NOT the primary corpus. They are small,
      // separately loaded, and no seam speaks for them, so they are scanned in
      // memory in both modes; only the primary half moves into the store.
      const allEngrams = canDelegate
        ? await this._loadSecondaryAndPacks()
        : await this._loadAllEngrams()

      // Idea 29: Content hash fast-path dedup (scope-aware — issue #136).
      // On dedup hit, mutate: increment write_count, append source (#107).
      //
      // The store is asked first, matching the corpus order it replaces
      // (`_loadAllEngrams` puts primary rows ahead of secondary ones, so a
      // primary match has always won).
      // Unhashable statements skip the store lookup entirely (#896) — the
      // delegated query has the same collapse the in-memory scan does, and
      // this is the branch a Postgres/PGLite install actually takes.
      const primaryHashMatch = canDelegate && isHashable(statement)
        ? await ps.findActiveByContentHash!(computeContentHash(statement), scope)
        : null
      const hashMatch = primaryHashMatch ?? this._hashDedup(statement, allEngrams, scope)
      if (hashMatch) {
        // `_recordDuplicate` persists only when the hit is IN the array it is
        // given — a match from a secondary store or a pack is counted in
        // memory and not written, which is the documented v1 behaviour. The
        // store-served hit is a freshly-read row under this same lock, so it
        // is the corpus in hand for exactly one row.
        const corpusInHand = primaryHashMatch ? [primaryHashMatch] : engrams
        return await this._recordDuplicate(hashMatch, corpusInHand, scope, context, statement)
      }

      // #176: cross-scope recurrence — same statement, different scope.
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
      const crossMatch = this._crossScopeRecurrenceDetect(statement, allEngrams, scope)
      // `engrams` is empty under delegation, so `_recordCrossScopeRecurrence`
      // takes its secondary-store branch — which is where every match it can
      // still see actually lives.
      if (crossMatch) return await this._recordCrossScopeRecurrence(crossMatch, engrams, scope, context)

      const id = canDelegate
        ? await ps.nextEngramId!(engramIdDatePrefix())
        : generateEngramId(allEngrams, this._mintedTodayIds())
      // Claim it in-process immediately (#816). The history record is written
      // later and best-effort; without this, two writes in the same tick — or
      // one whose history append fails — could both take the same suffix.
      this._rememberMintedId(id)
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
        write_count: 1,
        injection_count: 0,
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
        pinned_priority: context?.pinned_priority != null
          ? Math.max(1, Math.min(100, Math.round(context.pinned_priority)))
          : undefined,
        // #869: measurement context — present only when the caller supplies it.
        measured_under: context?.measured_under,
      }

      // #240: supersedes is a graph edge, not a temporality enum — write the
      // reverse superseded_by edge on each target found in the local primary
      // store (best-effort; targets living in other stores are not patched).
      // The tension scanner skips supersedes-linked pairs: an intentional
      // update is not a contradiction. The mutated targets are collected so
      // the incremental write path below can persist them explicitly — on a
      // store with `append`, writing only the new engram would silently drop
      // these back-edges (the CI failure ffe04e0 fixed on #745).
      //
      // Under delegation `engrams` is empty, so the targets are fetched by id.
      // Dropping the back-edges instead would be the quiet kind of regression:
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
        // Incremental write (#740): append the new engram; on a store without
        // `append` this saves the corpus in hand, which already carries the
        // superseded_by back-edges — so the second write below is skipped.
        await this._appendEngram(engrams, engram)
        if (this._primaryStore.append) {
          await this._updateEngrams(engrams, supersededTargets)
        }
        await this._syncIndex()

        // Fire-and-forget: attempt immediate push, clean up on success.
        //
        // The push and the local bookkeeping are caught SEPARATELY. Wrapping
        // both in one try meant a failure while removing the local copy — after
        // the remote had already accepted the engram — was recorded as a failed
        // push, so the outbox retried it and the remote ended up with a
        // duplicate. "The write did not land" and "the write landed but I could
        // not tidy up" are different facts and must not share a handler.
        //
        // The trailing `.catch()` is load-bearing: the error path below itself
        // awaits a store write, and if THAT throws the IIFE's promise rejects
        // with nothing attached — an unhandled rejection, which terminates the
        // process on modern Node. A background task must not be able to take
        // the host down.
        void (async () => {
          let pushed = false
          try {
            await remoteDriver.append(engram)
            pushed = true
          } catch (err) {
            // Already saved locally with outbox metadata — will be retried.
            logger.warning(`[plur:outbox] immediate push failed for ${engram.id}, queued for retry: ${(err as Error).message}`)
            await this._withStoreLock(this.paths.engrams, async () => {
              // Targeted read (#827): only this engram's outbox bookkeeping.
              const fresh = await this._loadTargeted([engram.id])
              const target = fresh.find(e => e.id === engram.id) as any
              if (target?.structured_data?._outbox) {
                target.structured_data._outbox.last_error = (err as Error).message
                target.structured_data._outbox.attempt_count = 1
                // Incremental write (#740): only the outbox bookkeeping changed.
                await this._updateEngrams(fresh, [target as Engram])
              }
            })
            return
          }

          if (!pushed) return
          // Remote has it. Remove the local copy — and if this fails, say so
          // rather than re-queueing something already accepted.
          try {
            await this._withStoreLock(this.paths.engrams, async () => {
              // NOT `_loadTargeted` (#827): this REMOVES a row, and the only
              // removal primitive `PrimaryStore` has is a whole-corpus save of
              // the array without it. A one-row targeted read here would be a
              // full replace by an empty array — the corpus, deleted. It stays
              // a full load until there is a `remove`/`deleteMany` seam.
              const fresh = await this._primaryStore.load()
              const idx = fresh.findIndex(e => e.id === engram.id)
              if (idx !== -1) {
                fresh.splice(idx, 1)
                // Deliberate removal: the remote accepted this engram, so the
                // local copy is redundant by design (audit #794 shrink guard).
                await this._writeEngrams(this.paths.engrams, fresh, { allowShrink: true })
                await this._syncIndex()
              }
            })
          } catch (err) {
            logger.warning(
              `[plur:outbox] ${engram.id} was accepted by the remote but its local copy could not be removed: `
              + `${(err as Error).message}. It will be retried, which may create a duplicate on the remote.`,
            )
          }
        })().catch(err => {
          logger.warning(`[plur:outbox] background push for ${engram.id} failed unexpectedly: ${(err as Error).message}`)
        })

        appendHistory(this.paths.root, {
          event: 'engram_created',
          engram_id: engram.id,
          timestamp: now,
          data: { type: engram.type, scope: engram.scope, source: engram.source, routed_to: 'remote', outbox: true },
        })
        return engram
      }

      // Incremental write (#740): same shape as the outbox path above — append
      // the new engram, then persist superseded_by back-edges when the append
      // was targeted (a fallback save already wrote them with the corpus).
      await this._appendEngram(engrams, engram)
      if (this._primaryStore.append) {
        await this._updateEngrams(engrams, supersededTargets)
      }
      await this._syncIndex()
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
  /**
   * Report the closest existing engrams to a statement — REPORTING ONLY (#856).
   *
   * `plur_learn` goes through {@link learnRouted} → sync `learn()`, which has
   * only ever had exact content-hash dedup; `learnAsync` (and therefore the
   * similarity pass) is reachable solely from `plur_learn_batch`. So the
   * dominant write path had no near-duplicate visibility at all, which is how
   * #854 happened on it.
   *
   * This gives that path the same observation the batch path gets, without
   * giving either the power to suppress a write. Never throws: similarity is an
   * optimisation, and a reporting failure must not affect a write that has
   * already happened.
   *
   * @param excludeId engram to omit — pass the just-written id so it does not
   *                  match itself at 1.0.
   */
  async nearDuplicates(
    statement: string,
    context?: LearnContext,
    excludeId?: string,
  ): Promise<{ mode: 'cosine' | 'hash-only'; near_duplicates?: Array<{ id: string; score: number }> }> {
    // Respect the existing dedup switches. This costs a bounded recall plus one
    // query embedding on every learn, which is a real addition to a hot path —
    // so `dedup.enabled: false` or `mode: 'off'` must turn it off, exactly as
    // they turn off the batch path's similarity pass. Reporting is worth paying
    // for by default; it should not be unavoidable.
    const dedupCfg = this.config.dedup ?? {}
    if (dedupCfg.enabled === false || dedupCfg.mode === 'off') return { mode: 'hash-only' }
    try {
      let candidates: Engram[] = []
      try {
        candidates = await this.recall(statement, { limit: 6 })
      } catch { candidates = [] }
      candidates = candidates.filter(c => c.status === 'active' && c.id !== excludeId)
      // Mirror the batch path's scope-awareness (#359).
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
      const { embeddingSearchWithScores } = await import('./embeddings.js')
      // Dynamic, matching how learn-async is loaded elsewhere in this class —
      // and imported rather than re-declared so both write paths observe at the
      // same floor and the recorded distribution stays comparable.
      const { NEAR_DUPLICATE_OBSERVATION_FLOOR } = await import('./learn-async.js')
      const scored = await embeddingSearchWithScores(candidates, query, candidates.length, this.paths.root)
      if (scored.length === 0) return { mode: 'hash-only' }

      const ranked = scored
        .map(s => ({ id: s.engram.id, score: s.score }))
        .sort((a, b) => b.score - a.score)
      const top = ranked[0]
      if (top.score >= NEAR_DUPLICATE_OBSERVATION_FLOOR) {
        try {
          appendHistory(this.paths.root, {
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
  }

  async learnRouted(statement: string, context?: LearnContext): Promise<Engram> {
    this._assertWritable()
    // Collapse line terminators HERE, not only in learn() (#952, #940).
    //
    // This method enters learn() only on its local route. When a remote store
    // resolves for the scope it builds the engram shape and posts it without
    // entering learn() at all, and the outbox fallback writes that same raw
    // shape locally — so a fix living only in learn() misses the CLI and the
    // Python SDK, both of which route through here, and misses the highest
    // impact variant: a forged entry on a SHARED store reaches other people's
    // system prompts.
    //
    // Applied before the secret scan and before _guardSensitiveScope so every
    // downstream gate, and the content hash, sees the text that is actually
    // stored. Idempotent, so the local route sanitising twice is harmless.
    statement = collapseLineTerminators(statement)
    // #729: validate type BEFORE the secrets scan — a bad type must fail
    // loudly even when the statement would also trip the secret detector.
    if (context?.type !== undefined && !VALID_ENGRAM_TYPES.has(context.type)) {
      throw new TypeError(
        `plur.learnRouted: invalid type '${context.type}'. Must be one of: behavioral, terminological, procedural, architectural`
      )
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
    const guarded = await this._guardSensitiveScope(statement, context)
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
      const engram = await this.learn(statement, context)
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
    const allEngrams = await this._loadAllEngrams()
    const hashMatch = this._hashDedup(statement, allEngrams, scope)
    if (hashMatch) {
      // Mutate + persist if local; otherwise return mutated (best-effort)
      return await this._withStoreLock(this.paths.engrams, async () => {
        const engrams = await this._primaryStore.load()
        return await this._recordDuplicate(hashMatch, engrams, scope, context, statement)
      })
    }
    // #176: cross-scope recurrence (same semantics as the local learn() path).
    const crossMatch = this._crossScopeRecurrenceDetect(statement, allEngrams, scope)
    if (crossMatch) {
      return await this._withStoreLock(this.paths.engrams, async () => {
        const engrams = await this._primaryStore.load()
        return await this._recordCrossScopeRecurrence(crossMatch, engrams, scope, context)
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
    let serverEngram: Engram
    try {
      const { id: serverId } = await remoteDriver.appendAndGetServerId(localPlaceholder)
      serverEngram = { ...localPlaceholder, id: serverId }
    } catch (err) {
      // Remote failed — save locally with outbox metadata for retry.
      // Audit iter-1 fix (Dijkstra): defensive lookup; the catch is the
      // graceful-fallback path that must never throw. If no writable entry
      // matches the scope (e.g. readonly remote), we still save the local
      // engram but omit the outbox marker — the retry path will skip it.
      const storeEntry = (this.config.stores ?? []).find(s => s.url && s.scope === scope && !s.readonly)
      return await this._withStoreLock(this.paths.engrams, async () => {
        const engrams = await this._primaryStore.load()
        // Replace placeholder ID with a real local ID
        localPlaceholder.id = generateEngramId([...engrams, ...allEngrams], this._mintedTodayIds())
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
        // Incremental write (#740): the fallback engram is new by construction
        // (its id was just minted above).
        await this._appendEngram(engrams, localPlaceholder)
        await this._syncIndex()
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

    // History is appended OUTSIDE the try that guards the remote write (#813,
    // audit finding 13). It used to sit inside it, so a history failure —
    // EACCES, disk full — after the server had already persisted the engram was
    // caught as a REMOTE failure: the fallback then created a second local
    // engram plus an outbox entry, and the next flush duplicated it remotely.
    // A bookkeeping write must never be able to undo, or appear to undo, a
    // commit that succeeded.
    try {
      appendHistory(this.paths.root, {
        event: 'engram_created',
        engram_id: serverEngram.id,
        timestamp: now,
        data: { type: serverEngram.type, scope: serverEngram.scope, source: serverEngram.source, routed_to: 'remote' },
      })
    } catch (err) {
      logger.warning(
        `[plur] engram ${serverEngram.id} was stored remotely but its history record could not be ` +
        `written: ${(err as Error).message}. The engram is safe; the local audit trail is incomplete.`,
      )
    }
    return serverEngram
  }

  /**
   * The id shape the READ paths hand back for an engram (#914).
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
  readIdFor(engram: { id: string; scope: string }): string {
    if (!this._isRemoteBackedScope(engram.scope)) return engram.id
    return namespaceEngramId(engram.id, engram.scope)
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
      write_count: 1,
      injection_count: 0,
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
      pinned_priority: context?.pinned_priority != null
        ? Math.max(1, Math.min(100, Math.round(context.pinned_priority)))
        : undefined,
      // #869: measurement context — present only when the caller supplies it.
      measured_under: context?.measured_under,
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
  private async _learnAsyncDeps() {
    return {
      hashDedup: async (statement: string, scope?: string) => this._hashDedup(statement, await this._loadAllEngrams(), scope),
      // remote:false (#776) — dedup queries are DERIVED FROM STATEMENTS. With
      // the remote leg on, every plur_learn would fire statement-derived POSTs
      // to all hosts, and a namespaced remote row could silently suppress a
      // local write as a "dedup match". Dedup is a local decision.
      recallHybrid: (query: string, options?: { limit?: number }) => this.recallHybrid(query, { ...options, remote: false }),
      recall: (query: string, options?: { limit?: number }) => this.recall(query, { ...options, remote: false }),
      learn: (statement: string, context?: LearnContext) => this.learn(statement, context),
      // #930: learnBatch uses this instead of `learn` so remote-scope writes
      // await the server push and return the server-assigned id. See LearnAsyncDeps.learnRouted.
      learnRouted: (statement: string, context?: LearnContext) => this.learnRouted(statement, context),
      getById: (id: string) => this.getById(id),
      store: this._primaryStore,
      engramsPath: this.paths.engrams,
      rootPath: this.paths.root,
      dedupConfig: this.config.dedup ?? {},
      // Local similarity for the no-LLM dedup path (#854). Scores the already
      // fetched candidates rather than the corpus, and reuses the embedding
      // cache, so this costs one query embedding and no API call. Returns []
      // when the embedder is unavailable, which the caller reads as
      // "similarity did not run" rather than "nothing was similar".
      similarityScores: async (statement: string, candidates: Engram[]) => {
        if (candidates.length === 0) return []
        const { embeddingSearchWithScores } = await import('./embeddings.js')
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
    }
  }

  /** Async learn with LLM-driven deduplication (Ideas 1+2+19). */
  async learnAsync(statement: string, context?: LearnAsyncContext): Promise<LearnAsyncResult> {
    this._assertWritable()
    const { learnAsync: learnAsyncImpl } = await import('./learn-async.js')
    return learnAsyncImpl(await this._learnAsyncDeps(), statement, context)
  }

  /** Batch learn with LLM dedup. LLM calls are capped (default 50) to bound bulk-import cost. */
  async learnBatch(
    statements: Array<{ statement: string; context?: LearnAsyncContext }>,
    llm?: LlmFunction,
    opts?: { maxLlmCalls?: number },
  ): Promise<LearnBatchResult> {
    this._assertWritable()
    const { learnBatch: learnBatchImpl } = await import('./learn-async.js')
    return learnBatchImpl(await this._learnAsyncDeps(), statements, llm, opts)
  }

  /**
   * Search engrams, filter by scope/domain/strength, reactivate accessed.
   * Supports two modes:
   *   - 'fast' (default): BM25 keyword search, instant, no API calls
   *   - 'agentic': LLM-assisted semantic search, higher accuracy, requires llm function
   */
  /** Search engrams using fast BM25 keyword matching over the local corpus,
   *  merged with the live server-authoritative remote leg (#776) when a
   *  configured remote host is implicated by the current project/work.
   *  `remote: false` (internal callers) or PLUR_REMOTE_RECALL=off keeps it
   *  fully local. */
  async recall(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const limit = options?.limit ?? 20

    // #776: start the remote leg BEFORE the local pipeline so the effective
    // added latency is max(0, remote − local), not remote + local.
    const remotePromise = this._startRemoteRecall(query, options)

    // Push the search into the store when the store can answer it.
    //
    // Until now this always loaded the corpus into memory and ranked it here,
    // which is correct at YAML scale and is the whole cost the Postgres tier
    // exists to avoid. `searchBM25` and `corpusStats` were implemented and
    // parity-tested against real Postgres but had ZERO call sites — built and
    // unreachable. This is the wiring.
    //
    // Scope, domain and the permitted-scope allow-list go INTO the query, so
    // `limit` is not spent on rows the caller may not see.
    //
    // The rest of `_filterEngrams`'s work still has to happen, and an earlier
    // version of this branch simply returned here — which silently dropped four
    // things the in-memory path applies:
    //
    //   - temporal validity: an engram whose `valid_until` has passed was
    //     returned as current. A fact explicitly withdrawn in 2020 was injected
    //     into an agent's context by `recall()` while `list()` correctly
    //     excluded it. Reproduced, not theorised.
    //   - `min_strength`
    //   - engrams merged in from `config.stores` (team/enterprise stores)
    //   - pack engrams
    //
    // The last two are the ones that would have been reported as "recall is
    // broken": on the Postgres tier `plur_recall` stopped returning the team
    // store entirely, while `recallHybrid` on the SAME instance still did.
    //
    // The adapter cannot answer those — it queries one table and knows nothing
    // about packs, secondary stores, or the caller's clock. So the pushdown is
    // a NARROWING step, not a replacement: it returns a superset, and the
    // remaining predicates are applied here. `limit` is applied last, after all
    // of them, so a row removed by expiry does not consume a slot.
    const adapter = this._primaryQueryAdapter()
    if (adapter) {
      const pushdownFilter = {
        status: 'active' as const,
        scope: options?.scope,
        scopes: options?.scopes,
        // Mounted-scope visibility grants (#775) go INTO the pushdown so
        // `limit` counts granted team rows too. Visibility-only — widens the
        // `scope` clause, never the `scopes` authorization clause.
        visibilityGrants: this._grantedScopes(),
        domain: options?.domain,
      }
      // Widen and retry rather than trust a fixed multiplier.
      //
      // The over-fetch exists because the residual filters below (expiry,
      // min_strength) remove rows the adapter cannot evaluate, and a row
      // dropped after a LIMIT is a result the caller silently never sees. A
      // FIXED 3x is only enough while those filters remove less than two
      // thirds of the page; past that the caller asks for N, the store holds
      // N matching rows, and recall quietly returns fewer.
      //
      // So: if filtering consumed the page AND the adapter returned a full one
      // (meaning it was truncated, so more rows exist), widen and ask again.
      // Bounded, because each round is a real query.
      let narrowed: Engram[] = []
      let surviving: Engram[] = []
      let fetch = Math.max(limit * PUSHDOWN_OVERFETCH, limit)
      for (let round = 0; round < PUSHDOWN_MAX_ROUNDS; round++) {
        // #753: prefer the exhaustion-aware call when the adapter offers one.
        //
        // `narrowed.length < fetch` is the only exhaustion signal core can
        // derive, and it is wrong for an adapter whose prefilter cannot rank:
        // PostgresAdapter computes and scores the FULL candidate set and slices
        // to `limit` here, so a full page means "your slice was full", not
        // "there is more". The loop then re-ran an identical query up to three
        // times to take a longer slice of an answer already computed — a 2-3x
        // amplification, concentrated in the high-rejection case the widening
        // exists to serve, at the scale that selects this tier.
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
        // Rank the union TOGETHER, rather than appending the outsiders.
        //
        // This used to be `[...narrowed, ...extra].slice(0, limit)`, which puts
        // every secondary-store and pack engram after every primary one. With a
        // primary store holding `limit` matches — the normal case — a team
        // engram that is the single best match for the query never appeared at
        // all. The bug is invisible from the primary store's side: results come
        // back, they are just the wrong ones.
        //
        // Scored with the UNION's statistics: the store supplies corpus-wide
        // figures for the primary side, and `extendCorpusStats` folds the
        // outsiders in exactly — they are already materialised in memory, so
        // their `df`/length contributions cost one tokenisation pass.
        //
        // The first version of this ranking scored the union with primary-only
        // stats and called the outsiders' IDF "an approximation". It was not a
        // bounded one: a query term absent from the primary corpus priced at
        // log(N/1) — maximally rare regardless of how common it is in the
        // store it actually lives in — and team-store jargon is by nature
        // common there and absent here. Measured: the single best primary
        // match for a mixed query ranked 197th behind 196 weak outsider rows.
        // The fold takes the PRE-residual outsiders, deliberately asymmetric
        // with the `extra` that gets ranked: the primary side's `corpusStats`
        // counts every active row — SQL cannot evaluate expiry or
        // min_strength — so folding only residual-surviving outsiders would
        // describe a hybrid corpus (full primary + filtered outsiders) and
        // under-weight outsider vocabulary whenever outsiders are expired or
        // weak. Both sides now contribute the same population: post-scope,
        // pre-residual (#752, iteration 2).
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
      const merged = await this._mergeRemoteRecall(results, remotePromise, options, limit)
      await this._reactivateResults(merged)
      return merged
    }

    const filtered = await this._filterEngrams(options)
    const results = searchEngrams(filtered, query, limit)
    const merged = await this._mergeRemoteRecall(results, remotePromise, options, limit)
    await this._reactivateResults(merged)
    return merged
  }

  /**
   * The primary store, when it can also answer queries itself.
   *
   * A `role: 'primary'` adapter IS the source of truth and the query engine at
   * once (ADR-0005), so a search can be pushed into it. A `role: 'index'`
   * adapter is derived from a separate store and is driven through the existing
   * index path instead; returning one here would bypass the sync bookkeeping
   * that keeps it honest.
   *
   * Returns null for the default YAML store, which has no query engine — that
   * path keeps loading and ranking in memory, which is the right answer for a
   * file.
   */
  private _primaryQueryAdapter(): StorageAdapter | null {
    const s = this._primaryStore as unknown as Partial<StorageAdapter>
    if (s?.role === 'primary' && typeof s.searchBM25 === 'function') return s as StorageAdapter
    return null
  }

  /** Search engrams using LLM-assisted semantic filtering. Async, requires llm function. */
  async recallAsync(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]> {
    const filtered = await this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await agenticSearch(filtered, query, limit, options.llm)
    await this._reactivateResults(results)
    return results
  }

  /** Search engrams using local embeddings. Async, no API calls. Routes through PGLite/pgvector when active (#226) or a Postgres primary store's vector index (#762), with optional intent routing (#224) + cross-encoder rerank (#220). */
  async recallSemantic(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const limit = options?.limit ?? 20
    const rerank = await this._resolveRerankOptions(options?.rerank)
    const intent = this._resolveIntentProfile(query, options?.intentOverride)
    // Two over-fetch sources stack: intent routing wants headroom for its
    // re-rank, the reranker wants topK candidates. Take the larger; truncate
    // back to `limit` after both stages.
    const intentFetch = intent ? Math.max(limit * 2, limit + 10) : limit
    const rerankFetch = rerank ? Math.max(limit, rerank.topK ?? 50) : limit
    const fetchLimit = Math.max(intentFetch, rerankFetch)
    let results: Engram[]
    const primaryAdapter = this._primaryQueryAdapter()
    if (this.pgliteAdapter) {
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
  }

  /** Hybrid search: BM25 + embeddings merged via Reciprocal Rank Fusion. Async, no API calls. Delegates to recallHybridWithMeta so it gets intent/rerank/PGLite routing too. */
  async recallHybrid(query: string, options?: Omit<RecallOptions, 'mode' | 'llm'>): Promise<Engram[]> {
    const limit = options?.limit ?? 20
    const result = await this.recallHybridWithMeta(query, options)
    return result.engrams.slice(0, limit)
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
    // #776: remote leg starts BEFORE the local pipeline (added latency =
    // max(0, remote − local)); merged below via RRF.
    const remotePromise = this._startRemoteRecall(query, options)
    // #906: narrowed by the store when provably equivalent, else the full read.
    const filtered = await this._hybridCandidates(query, options)
    const limit = options?.limit ?? 20
    const rerank = await this._resolveRerankOptions(options?.rerank)
    const intent = this._resolveIntentProfile(query, options?.intentOverride)
    // When intent routing is on we over-fetch from the hybrid call WITHOUT the
    // reranker, apply intent routing, then run the reranker on the routed set.
    // When intent is off the hybrid call handles reranking inline so the
    // PGLite and JSON paths stay symmetric.
    const intentLimit = intent ? Math.max(limit * 2, limit + 10) : limit
    let result: HybridSearchResult
    if (intent) {
      result = this.pgliteAdapter
        ? await this._pgliteHybridRecall(query, intentLimit, filtered, undefined, options)
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
      result = await this._pgliteHybridRecall(query, limit, filtered, rerank, options)
    } else {
      result = await hybridSearchWithMeta(filtered, query, limit, this.paths.root, rerank)
    }
    // #776: fold the server leg in (RRF) before reactivation so displaced
    // local rows are not reactivated and server rows rank on merged order.
    result = { ...result, engrams: await this._mergeRemoteRecall(result.engrams, remotePromise, options, limit) }
    // Belt-and-suspenders: all inner paths apply slice(0, limit) before
    // returning, but recallHybridWithMeta is called directly by the MCP layer
    // (#770) and lacks the outer guard that recallHybrid() adds. Note
    // _mergeRemoteRecall only slices when the remote leg returned rows — on the
    // common local-only path it returns the local result unsliced. Enforce here
    // so no over-fetch floor (Math.max(N, 50) for reranker/aggregation paths)
    // can leak through to callers.
    if (result.engrams.length > limit) {
      result = { ...result, engrams: result.engrams.slice(0, limit) }
    }
    await this._reactivateResults(result.engrams)
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
  private async _resolveRerankOptions(rerank?: boolean): Promise<RerankOptions | undefined> {
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
  }

  /**
   * Reranker-enable path advisory (#451): when this store's cached self-eval
   * says the resolved reranker is net-negative HERE, warn once per instance.
   * Never disables anything — the loud-once log is the whole intervention.
   */
  private async _maybeLogRerankerEvalAdvisory(rerankerName: string): Promise<void> {
    if (this._rerankerEvalAdvisoryDone) return
    this._rerankerEvalAdvisoryDone = true
    try {
      logRerankerEvalAdvisory(this.paths.root, rerankerName, (await this._filterEngrams()).length)
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
  }

  /**
   * Read this store's cached reranker self-eval verdict (#451) without
   * running anything. Returns null when the store has never been evaluated
   * for the given (or env-resolved) reranker.
   */
  async rerankerEvalStatus(rerankerName?: string): Promise<{ result: RerankerEvalResult; stale: boolean } | null> {
    const name = rerankerName ?? resolveRerankerName()
    if (name === 'off') return null
    const cached = loadRerankerEvalCache(this.paths.root)[name]
    if (!cached) return null
    return { result: cached, stale: isRerankerEvalStale(cached, (await this._filterEngrams()).length) }
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
    const engrams = (await this.list()).map(e => ({ statement: e.statement, domain: e.domain }))
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
    restrict?: Pick<RecallOptions, 'scope' | 'scopes'>,
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
    // The scope restriction goes INTO the k-NN query, not onto its results.
    //
    // This used to fetch an unrestricted neighbour list and intersect it with
    // the already-filtered set afterwards. That is the dilution failure
    // `ScopeRestriction` exists to prevent: `limit` is spent on rows the caller
    // may not be permitted to see, so a principal whose permitted scopes are a
    // small share of the corpus asks for N results and silently gets far fewer,
    // with relevant permitted rows sitting just below the cut. The intersection
    // kept it CORRECT — nothing out of scope was ever returned — but it made it
    // INCOMPLETE, which is the harder failure to notice.
    //
    // `scope` + mounted-scope visibilityGrants (#775) go in for the same
    // reason: `filtered` already honours them, so a k-NN restricted to
    // `scopes` alone spends `limit` on rows the intersection below is about
    // to discard — and a granted team engram never surfaces via the vector
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
  private async _pgliteSemanticRecall(
    query: string,
    limit: number,
    filtered: Engram[],
    restrict?: Pick<RecallOptions, 'scope' | 'scopes'>,
  ): Promise<Engram[]> {
    if (!this.pgliteAdapter) return []
    const { embed } = await import('./embeddings.js')
    const queryVec = await embed(query, 'query')
    if (!queryVec) {
      return embeddingSearch(filtered, query, limit, this.paths.root)
    }
    try {
    // The scope restriction goes INTO the k-NN query, not onto its results.
    //
    // This used to fetch an unrestricted neighbour list and intersect it with
    // the already-filtered set afterwards. That is the dilution failure
    // `ScopeRestriction` exists to prevent: `limit` is spent on rows the caller
    // may not be permitted to see, so a principal whose permitted scopes are a
    // small share of the corpus asks for N results and silently gets far fewer,
    // with relevant permitted rows sitting just below the cut. The intersection
    // kept it CORRECT — nothing out of scope was ever returned — but it made it
    // INCOMPLETE, which is the harder failure to notice.
    //
    // `scope` + mounted-scope visibilityGrants (#775) go in for the same
    // reason: `filtered` already honours them, so a k-NN restricted to
    // `scopes` alone spends `limit` on rows the intersection below is about
    // to discard — and a granted team engram never surfaces via the vector
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
  }

  /**
   * Semantic recall pushed into a primary query store's vector index (#762) —
   * the `recall()` pushdown's vector twin. Until this existed the Postgres
   * tier answered `recallSemantic` by loading the corpus and embedding it in
   * memory: the O(N) path the tier exists to escape, silently, because
   * nothing populated `engram_embeddings` and nothing read it.
   *
   * Shape mirrors `recall()`'s BM25 pushdown:
   *   - scope/scopes/visibilityGrants go INTO the k-NN query (dilution guard —
   *     see `_pgliteSemanticRecall`'s comment; same reasoning).
   *   - residual filters (expiry, min_strength) run here on the rows that
   *     came back — SQL cannot evaluate them.
   *   - secondary-store and pack engrams cannot be in the store's table, so
   *     they are scored in memory (they are small and already file-backed)
   *     and merged BY SCORE: both sides are cosine similarity from the same
   *     embedder — the store computes `1 - cosine_distance`, clamped here to
   *     [0,1] exactly as `embeddingSearchWithScores` clamps its side — so the
   *     merge is the same metric, not an approximation.
   *
   * Completeness gate: one `listEngramsMissingEmbeddings(1)` anti-join probe
   * per call. While ANY active engram lacks an embedding, vector hits would
   * be drawn from whatever subset happens to be embedded — correct-looking,
   * silently incomplete — so this degrades to the in-memory path for THIS
   * query and kicks the background backfill instead of waiting for it. The
   * probe is also what makes a store migrated in with existing rows converge:
   * the first semantic recall starts the backfill even if nothing was ever
   * written through this instance.
   *
   * Deliberately WITHOUT `includeStale` (#812): a stale vector still returns
   * its engram, merely ranked by older text, so it is not the silent
   * incompleteness this gate is about. Opening the gate on staleness would put
   * every semantic recall on the O(N) fallback until the backfill drained —
   * one edited engram degrading the whole store. Edits kick the backfill from
   * the write path, so they converge without this gate's help.
   */
  private async _primarySemanticRecall(
    adapter: StorageAdapter,
    query: string,
    limit: number,
    options?: Omit<RecallOptions, 'mode' | 'llm'>,
  ): Promise<Engram[]> {
    const fallback = async () =>
      embeddingSearch(await this._filterEngrams(options), query, limit, this.paths.root)
    const { embed } = await import('./embeddings.js')
    const queryVec = await embed(query, 'query')
    // Embedder disabled or unavailable: exactly the degraded path this method
    // replaced — embeddingSearch reports [] without an embedder, never throws.
    if (!queryVec) return fallback()
    try {
      if (typeof adapter.listEngramsMissingEmbeddings === 'function') {
        const gap = await adapter.listEngramsMissingEmbeddings(1)
        if (gap.length > 0) {
          this._kickPrimaryAutoEmbed(adapter)
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
    const filtered = await this._filterEngrams(options)
    const limit = options?.limit ?? 20
    return embeddingSearchWithScores(filtered, query, limit, this.paths.root)
  }

  /** Expanded search: LLM query expansion + hybrid search + RRF merge. Opt-in, requires LLM function. */
  async recallExpanded(query: string, options: RecallOptions & { llm: LlmFunction }): Promise<Engram[]> {
    const filtered = await this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const results = await expandedSearch(filtered, query, limit, options.llm, this.paths.root)
    await this._reactivateResults(results)
    return results
  }

  async recallAutoSearch(query: string, options?: RecallOptions): Promise<AutoSearchResult> {
    const filtered = await this._filterEngrams(options)
    const limit = options?.limit ?? 20
    const result = await recallAuto(filtered, query, limit, this.paths.root, options?.llm)
    await this._reactivateResults(result.results)
    return result
  }

  /** Get a single engram by ID, regardless of status. Searches primary + all stores. */
  async getById(id: string): Promise<Engram | null> {
    const engrams = await this._loadAllEngrams()
    return engrams.find(e => e.id === id) ?? null
  }

  /** List all active engrams, optionally filtered by scope/domain. No search — returns all matches. */
  async list(options?: { scope?: string; scopes?: string[]; domain?: string; min_strength?: number; include_expired?: boolean }): Promise<Engram[]> {
    return await this._filterEngrams(options)
  }

  /**
   * Resolve once the work the constructor kicked off has finished.
   *
   * A constructor cannot await, so one-time migrations start in the background.
   * While the write path was synchronous that was invisible — they completed
   * before anything could observe otherwise. With an async store they do not,
   * and a caller that depends on the migration having run (a test, a first
   * read after upgrade) needs somewhere to wait.
   *
   * Cheap and idempotent: it is the same settled promise on every call.
   */
  async ready(): Promise<void> {
    await this._readyPromise
  }

  /** Filter engrams by scope/domain/strength (shared by both modes) */
  /**
   * Predicates a store CANNOT answer, applied after a pushdown narrows.
   *
   * `searchBM25` filters status/scope/domain/scopes in SQL. Temporal validity
   * and `min_strength` are not columns it can filter on — validity depends on
   * the caller's clock, and strength lives inside the JSONB payload — so they
   * have to run here, on the rows that came back.
   *
   * Deliberately a shared helper rather than a copy of the tail of
   * `_filterEngrams`: two implementations of "which engrams count" is how the
   * pushdown branch came to silently disagree with `list()` in the first place.
   */
  private _applyResidualFilters(engrams: Engram[], options?: RecallOptions & { include_expired?: boolean }): Engram[] {
    let out = engrams
    if (!options?.include_expired) {
      const today = new Date().toISOString().slice(0, 10)
      out = out.filter(e => {
        if (e.temporal?.valid_until && e.temporal.valid_until < today) return false
        if (e.temporal?.valid_from && e.temporal.valid_from > today) return false
        return true
      })
    }
    if (options?.min_strength !== undefined) {
      out = out.filter(e => e.activation.retrieval_strength >= options.min_strength!)
    }
    return out
  }

  /**
   * Mounted-scope visibility grants (#775): the deduplicated scopes of every
   * `config.yaml` `stores:` entry — path AND url entries alike. Mounting a
   * store with your own token is the consent act, so its scope passes a
   * project-scope VISIBILITY filter exactly like the personal family (see
   * `makeVisibilityPredicate` in scope-util.ts). Always on, no config knob.
   *
   * STRICTLY visibility-only: these are threaded into the `scope` visibility
   * filter (in-memory predicate + `StorageFilter.visibilityGrants` SQL
   * pushdown) and MUST NEVER be folded into `options.scopes` — that list is
   * the authorization decision and grants never widen it.
   */
  private _grantedScopes(): string[] {
    return [...new Set((this.config.stores ?? []).map(s => s.scope))]
  }

  // -------------------------------------------------------------------------
  // Server-authoritative remote recall (#776, plan A2′)
  // -------------------------------------------------------------------------

  /** Last per-host recall outcomes (in-process), keyed by normalized URL —
   *  feeds `remoteStoreStatus()` (plan A4′). Each entry carries the time it
   *  was observed: the map is written ONLY by hosts a recall actually dialed,
   *  so without an age the newest entry is indistinguishable from one made
   *  days ago by a process that has since been idle (#864). */
  private _lastRemoteOutcomes = new Map<string, { outcome: HostRecallOutcome; observed_at: number }>()

  /** Where breaker/cooldown/unsupported state persists across processes.
   *  Inside the store root so tests and PLUR_PATH overrides isolate it. */
  remoteHealthStatePath(): string {
    return join(this.paths.root, 'cache', 'remote-health.json')
  }

  /**
   * Where local→server id mappings survive between outbox flushes (#863
   * follow-up, 2026-08-13 panel).
   *
   * `flushOutbox` builds a `localToServer` map as it goes so a correction
   * queued alongside the engram it supersedes can point at the server id. That
   * map was per-flush, and the local row is SPLICED OUT on a successful push —
   * so once the target left in flush N, a correction that missed that flush
   * could never resolve its edge again. It failed identically on every
   * subsequent flush, printing "flush again once X has been pushed" when X had
   * already been pushed and no future flush could change that. The panel
   * measured three consecutive flushes producing the same unfollowable
   * warning.
   *
   * Derived state, not truth: losing this file costs a supersedes edge on a
   * pathological ordering, never an engram. Every read and write is
   * best-effort for that reason.
   */
  outboxIdMapPath(): string {
    return join(this.paths.root, 'cache', 'outbox-id-map.json')
  }

  /** Read the persisted local→server map. Never throws; `{}` on any problem. */
  private _readOutboxIdMap(): Record<string, { server_id: string; url: string; at: number }> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.outboxIdMapPath(), 'utf8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, { server_id: string; url: string; at: number }>
      }
    } catch { /* absent or corrupt — a cache miss, not an error */ }
    return {}
  }

  /**
   * Persist local→server mappings recorded during a flush. Never throws.
   *
   * Bounded at {@link OUTBOX_ID_MAP_MAX} entries, oldest dropped first: this
   * grows by one row per remote write forever otherwise, and an unbounded
   * cache file in the store root is its own defect. Dropping the oldest is
   * safe because the edges that need it are queued corrections, which are
   * resolved within a flush or two of the target.
   */
  private _writeOutboxIdMap(entries: Record<string, { server_id: string; url: string; at: number }>): void {
    try {
      const ids = Object.keys(entries)
      if (ids.length > OUTBOX_ID_MAP_MAX) {
        const keep = ids
          .sort((a, b) => (entries[b].at ?? 0) - (entries[a].at ?? 0))
          .slice(0, OUTBOX_ID_MAP_MAX)
        const trimmed: typeof entries = {}
        for (const id of keep) trimmed[id] = entries[id]
        entries = trimmed
      }
      fs.mkdirSync(dirname(this.outboxIdMapPath()), { recursive: true })
      fs.writeFileSync(this.outboxIdMapPath(), JSON.stringify(entries), 'utf8')
    } catch { /* derived state — a failed write must never fail a flush */ }
  }

  /**
   * Strict scope-relevance dialing (#776, user decision — plan rows 39/44).
   *
   * For each configured (url, token) endpoint group, the dialed scope set is
   * the subset of its granted scopes relevant to the current project/work:
   *   (a) shared (group:/project:/…) scopes sharing the ORG segment with the
   *       session's project scope — org of `project:plur/plur-ai/enterprise`
   *       is `plur`, so every `group:plur/…` + `project:plur/…` scope on that
   *       host is relevant;
   *   (b) the host's personal-family (`user:*`, …) scopes ONLY when an org
   *       context exists implicating that host.
   * No project/work context implicating a remote store → ZERO remote calls.
   * A host whose relevant subset is empty is NOT dialed — a datafund-org host
   * is never dialed from plur-org work (cross-org exfiltration solved by
   * construction).
   *
   * Overrides: per-store `dial: never` removes the entry from dialing;
   * `dial: always` forces its host to be dialed with that entry's scope,
   * context or not. A `.plur.yaml` `remote_url`/`remote_token`
   * (`options.remote_project`, hook path) IS the org context for its host —
   * project config wins: a matching mounted group dials with the project's
   * token when one is supplied, and an unmounted project endpoint dials
   * standalone with the project's `remote_scopes`.
   *
   * Grouping is by (url, token), not url alone — `_distinctRemoteEndpoints`'s
   * "tokens should be identical" assumption is unchecked, and differing
   * tokens per host mean one POST per token. `remoteEndpointTokenConflicts`
   * feeds the doctor warning for that misconfiguration.
   */
  private _remoteRecallHosts(options?: { scope?: string; session?: string; remote_project?: RemoteProjectConfig }): RemoteRecallHost[] {
    // Pick up out-of-process config edits (#307) before reading tokens: a
    // rotated credential must reach the very next dial, not the next restart.
    // The constructor's only re-read compares `stores.length`, so a rotation
    // that leaves the store count unchanged was previously invisible for the
    // life of the process (#864).
    this.reloadConfigIfChanged()
    const stores = (this.config.stores ?? []).filter(s => s.url)
    const rp = options?.remote_project
    const rpKey = rp ? normalizeEndpointUrl(rp.url) : null
    // Dialing context (#243): an explicit recall scope wins; otherwise the
    // SESSION default scope establishes the org context — a session whose
    // default write scope names org X is doing org-X work, so its recalls
    // dial org-X hosts. Resolved per-session via the same registry the write
    // path uses (`options.session` — ADR-0004), so a mid-session scope
    // switch redirects subsequent recall dialing too. No session scope set
    // (the pre-#243 state) leaves dialing exactly as before.
    const dialScope = options?.scope ?? this._sessionScopes.get(options?.session) ?? undefined
    const sessionOrg = scopeOrg(dialScope)

    const groups = new Map<string, { url: string; token?: string; entries: StoreEntry[] }>()
    for (const s of stores) {
      // Same `::` composite-key convention as _getRemoteDriver (#394) — a
      // printable separator (an earlier draft used a raw \x00, which made
      // tooling treat this whole source file as binary). Normalized URLs and
      // tokens don't contain `::` in practice, and a contrived collision only
      // merges two entries into one endpoint group — same POST, same token.
      const key = `${normalizeEndpointUrl(s.url!)}::${s.token ?? ''}`
      let g = groups.get(key)
      if (!g) { g = { url: s.url!, token: s.token, entries: [] }; groups.set(key, g) }
      g.entries.push(s)
    }

    const hosts: RemoteRecallHost[] = []
    for (const g of groups.values()) {
      const dialable = g.entries.filter(e => e.dial !== 'never')
      if (dialable.length === 0) continue
      const always = dialable.filter(e => e.dial === 'always')
      const shared = dialable.filter(e => isSharedScope(e.scope))
      const personal = dialable.filter(e => !isSharedScope(e.scope))
      const orgAffine = sessionOrg ? shared.filter(e => scopeOrg(e.scope) === sessionOrg) : []
      const projectImplicated = rpKey !== null && rpKey === normalizeEndpointUrl(g.url)
      const orgContext = orgAffine.length > 0 || projectImplicated
      if (!orgContext && always.length === 0) continue
      const selected = new Set<StoreEntry>(orgAffine)
      if (projectImplicated) for (const e of shared) selected.add(e)
      for (const e of always) selected.add(e)
      if (orgContext) for (const e of personal) selected.add(e)
      // Config order preserved — row→entry mapping must be deterministic.
      const dialEntries = dialable.filter(e => selected.has(e))
      if (dialEntries.length === 0) continue
      hosts.push({
        url: g.url,
        token: (projectImplicated && rp?.token) ? rp.token : (g.token ?? ''),
        scopes: [...new Set(dialEntries.map(e => e.scope))],
        entries: dialEntries.map(e => ({ scope: e.scope })),
      })
    }

    // Standalone `.plur.yaml` endpoint not mounted in config.stores: dial it
    // with the project's own remote_scopes (the scope guard needs a scope set
    // to admit rows against; without one there is nothing safe to accept).
    if (rp?.token && rpKey && !stores.some(s => normalizeEndpointUrl(s.url!) === rpKey)) {
      const scopes = [...new Set(rp.scopes ?? [])]
      if (scopes.length > 0) {
        hosts.push({ url: rp.url, token: rp.token, scopes, entries: scopes.map(scope => ({ scope })) })
      }
    }
    return hosts
  }

  /**
   * Start the remote recall leg — called BEFORE the local pipeline so the
   * effective added latency is max(0, remote − local). Returns null (zero
   * fetches, zero new latency) when: the caller opted out (`remote: false` —
   * learn-dedup, forget-by-search, self-eval), the `PLUR_REMOTE_RECALL`
   * kill-switch is set, the query is empty, or no host is implicated by the
   * current project/work. The returned promise NEVER rejects.
   */
  private _startRemoteRecall(
    query: string,
    options?: { scope?: string; session?: string; remote?: boolean; remote_timeout_ms?: number; remote_project?: RemoteProjectConfig; limit?: number },
  ): Promise<RemoteRecallResult> | null {
    if (options?.remote === false) return null
    if (isRemoteRecallDisabled()) return null
    if (!query || !query.trim()) return null
    const hosts = this._remoteRecallHosts(options)
    if (hosts.length === 0) return null
    return remoteRecall(hosts, query, {
      timeoutMs: resolveRemoteRecallTimeoutMs(options?.remote_timeout_ms),
      limit: options?.limit,
      statePath: this.remoteHealthStatePath(),
    }).then(result => {
      const observed_at = Date.now()
      for (const o of result.outcomes) {
        this._lastRemoteOutcomes.set(normalizeEndpointUrl(o.url), { outcome: o, observed_at })
      }
      return result
    }).catch((): RemoteRecallResult => ({ engrams: [], scores: new Map(), outcomes: [] }))
  }

  /**
   * Apply the SAME read-side filters to server rows that every local read
   * path applies: `options.scopes` authorization (exact membership),
   * `options.scope` visibility (with grants — server rows sit in granted
   * scopes by construction after the scope guard's global admission +
   * narrowing), domain, and the residual temporal/strength filters.
   */
  private _filterRemoteRows(rows: Engram[], options?: RecallOptions & { include_expired?: boolean }): Engram[] {
    let filtered = rows.filter(e => e.status === 'active')
    if (options?.scopes !== undefined) {
      const allowed = scopeAllowFilter(options.scopes)
      filtered = filtered.filter(e => allowed(e.scope))
    }
    if (options?.domain) filtered = filtered.filter(e => e.domain?.startsWith(options.domain!))
    if (options?.scope) {
      const visible = makeVisibilityPredicate(options.scope, this._grantedScopes())
      filtered = filtered.filter(e => visible(e.scope))
    }
    return this._applyResidualFilters(filtered, options)
  }

  /**
   * Merge the remote leg into a local result set via RRF. Server rows go
   * FIRST so the server copy wins object identity for ids present in both
   * sets (the local set can hold a stale peek-cache copy of the same remote
   * row); RRF scoring itself is order-independent, so this affects identity
   * only, not ranking.
   */
  private async _mergeRemoteRecall(
    local: Engram[],
    remotePromise: Promise<RemoteRecallResult> | null,
    options: (RecallOptions & { include_expired?: boolean }) | undefined,
    limit: number,
  ): Promise<Engram[]> {
    if (!remotePromise) return local
    const remote = await remotePromise
    const rows = this._filterRemoteRows(remote.engrams, options)
    if (rows.length === 0) return local
    return pgliteRrfMerge([rows, local]).slice(0, limit)
  }

  /**
   * Server rows for the injection path (#776): filtered for authorization +
   * visibility BEFORE boosts are assigned — the boost channel resurrects
   * scope-zeroed rows otherwise (`scoreEngram` returns 0 for both
   * no-keyword-hits and scope-excluded, and `raw = embBoost*2` revives
   * anything > 0.5). Boost = 0.55 + 0.45·score, so every server-ranked row
   * clears the 0.5 semantic threshold and the server's top row maps to 1.0.
   */
  private async _remoteInjectCandidates(
    remotePromise: Promise<RemoteRecallResult> | null,
    options?: InjectOptions,
  ): Promise<{ engrams: Engram[]; boosts: Map<string, number> } | undefined> {
    if (!remotePromise) return undefined
    const remote = await remotePromise
    if (remote.engrams.length === 0) return undefined
    const permitted = options?.scopes
    let rows = remote.engrams.filter(e => e.status === 'active')
    if (permitted !== undefined) rows = rows.filter(e => permitted.includes(e.scope))
    if (options?.scope) {
      if (options.scope === 'global') {
        // INJECT_GLOBAL_IS_TARGETED (D1-ASYMMETRY): explicit global inject is
        // targeted to the global namespace only. Server rows are namespaced —
        // global rows were narrowed to their store scope — so none pass here,
        // by design; grants do not reach the targeted-global branch.
        rows = rows.filter(e => e.scope === 'global')
      } else {
        const visible = makeVisibilityPredicate(options.scope, this._grantedScopes())
        rows = rows.filter(e => visible(e.scope))
      }
    }
    if (rows.length === 0) return undefined
    const boosts = new Map<string, number>()
    for (const e of rows) {
      const s = remote.scores.get(e.id) ?? 0
      boosts.set(e.id, 0.55 + 0.45 * Math.max(0, Math.min(1, s)))
    }
    return { engrams: rows, boosts }
  }

  /**
   * Per-host remote recall degradation status (plan A4′), fed by the last
   * outcomes this process observed — NOT by driver caches or fresh probes.
   * MCP surfaces attach a `remote_stores` block from this when any host is
   * non-ok (or silently scope-narrowed); plur_doctor renders remediation.
   *
   * Every entry carries `observed_at` and `age_ms` (#864). An observation is
   * evidence about the moment it was taken, and this map is only written by
   * hosts a recall actually DIALED — a recall that dials nothing leaves the
   * previous entry untouched. Callers that speak in the present tense
   * ("serving local only") must pass `freshOnly` so a stale failure stops
   * being reported as the live state; callers that are explicitly historical
   * (doctor's "last live recall") should read everything and render the age.
   */
  remoteStoreStatus(opts?: { freshOnly?: boolean; now?: number }): RemoteStoreStatusEntry[] {
    const now = opts?.now ?? Date.now()
    const out: RemoteStoreStatusEntry[] = []
    for (const { outcome: o, observed_at } of this._lastRemoteOutcomes.values()) {
      const age_ms = Math.max(0, now - observed_at)
      if (opts?.freshOnly && age_ms > REMOTE_STATUS_TTL_MS) continue
      out.push({
        host: normalizeEndpointUrl(o.url),
        status: o.state,
        ...(o.dropped_scopes && o.dropped_scopes.length > 0 ? { dropped_scopes: o.dropped_scopes } : {}),
        ms: o.ms,
        count: o.count,
        observed_at,
        age_ms,
      })
    }
    return out
  }

  /**
   * Record that a non-recall interaction with `url` just SUCCEEDED, clearing a
   * cached network-class failure for that host (#864).
   *
   * Without this, `plur_doctor` contradicts itself inside one report: the
   * `/me` probe says "Reachable, auth valid" and the line directly beneath it
   * says the host timed out, because the second line is a cached recall
   * outcome that nothing ever invalidates. A store that just answered a
   * request is not unreachable, and the fresher observation wins.
   *
   * Only {@link PROBE_CLEARABLE_STATES} are cleared — see that constant for
   * why an authorization or endpoint-support failure must survive a probe.
   */
  noteRemoteHostReachable(url: string): void {
    const key = normalizeEndpointUrl(url)
    const entry = this._lastRemoteOutcomes.get(key)
    if (entry && PROBE_CLEARABLE_STATES.has(entry.outcome.state)) {
      this._lastRemoteOutcomes.delete(key)
    }
  }

  /**
   * Endpoints configured with more than one distinct token (#776). The
   * (url, token) fan-out dials once per token, so this is a misconfiguration
   * worth a doctor warning — same user, same instance should mean one token.
   */
  remoteEndpointTokenConflicts(): Array<{ url: string; tokens: number }> {
    const byUrl = new Map<string, { url: string; tokens: Set<string> }>()
    for (const s of this.config.stores ?? []) {
      if (!s.url) continue
      const key = normalizeEndpointUrl(s.url)
      let rec = byUrl.get(key)
      if (!rec) { rec = { url: s.url, tokens: new Set() }; byUrl.set(key, rec) }
      rec.tokens.add(s.token ?? '')
    }
    return [...byUrl.values()]
      .filter(r => r.tokens.size > 1)
      .map(r => ({ url: r.url, tokens: r.tokens.size }))
  }

  /**
   * Engrams a primary-store pushdown cannot see: secondary (team/project)
   * stores from `config.stores`, and installed packs.
   *
   * `searchBM25` queries ONE table. `_loadAllEngrams` merges these in, so
   * without this the Postgres tier answered `recall()` from the primary store
   * alone — an enterprise user's team store vanished from `plur_recall` while
   * `recallHybrid` on the same instance still returned it. No error, no
   * warning: just fewer results.
   *
   * Scope and domain are applied here to mirror what the SQL side does to the
   * primary rows; the residual filters are applied by the caller.
   */
  private async _engramsOutsidePrimaryStore(options?: RecallOptions): Promise<Engram[]> {
    // Delegates to the SAME loader `_loadAllEngrams` uses, so remote stores,
    // id namespacing, scope narrowing and the containment guard cannot drift
    // between the pushdown path and every other read path. This method used to
    // re-implement that loop and got all four wrong.
    let filtered = (await this._loadSecondaryAndPacks()).filter(e => e.status === 'active')
    if (options?.scopes !== undefined) {
      const allowed = scopeAllowFilter(options.scopes)
      filtered = filtered.filter(e => allowed(e.scope))
    }
    if (options?.domain) filtered = filtered.filter(e => e.domain?.startsWith(options.domain!))
    if (options?.scope) {
      // Visibility filter (#353/#775): scope containment, personal-family
      // pass-through, and mounted-scope grants — the ONE shared predicate.
      const visible = makeVisibilityPredicate(options.scope, this._grantedScopes())
      filtered = filtered.filter(e => visible(e.scope))
    }
    return filtered
  }

  /**
   * Candidates for the hybrid path — narrowed by the store when that is
   * PROVABLY equivalent, otherwise the full filtered corpus (#906).
   *
   * `recallHybridWithMeta` called `_filterEngrams()` unconditionally, and for a
   * Postgres primary query store that is a full scan on every call: `indexTier`
   * resolves to 'none' when a primary query store is present (ADR-0005 — such
   * an adapter IS both the source of truth and the query engine), so it takes
   * `_filterEngrams`'s else branch and loads everything. `plur_recall` defaults
   * to hybrid, so that is one whole-corpus read per query, on exactly the
   * deployment where a scan is expensive.
   *
   * Narrowing before RRF would normally be a RECALL-QUALITY change — the vector
   * leg can only rank what it is given — and would need a plur-bench number
   * before shipping. This does not, because it narrows only when the adapter
   * reports `exhausted`: the returned rows are then not a sample but everything
   * the store holds for that filter, so ranking over them is identical to
   * ranking over the full corpus BY CONSTRUCTION. Not exhausted, and it falls
   * back to the previous behaviour untouched.
   *
   * The filters are passed through in full. `searchBM25Exhaustive` takes
   * `{ limit } & StorageFilter`, and StorageFilter carries every field
   * `_filterEngrams` applies — status, scope, scopes, visibilityGrants,
   * domain — so this cannot silently drop an authorization filter. That parity
   * is the precondition for the whole approach; if it ever stops holding, this
   * must revert to `_filterEngrams` rather than narrow.
   */
  private async _hybridCandidates(
    query: string,
    options?: RecallOptions & { include_expired?: boolean },
  ): Promise<Engram[]> {
    const adapter = this._primaryQueryAdapter()
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
        if (narrowed.exhausted) return narrowed.rows
      } catch {
        // A pushdown failure must never fail a recall — fall back to the read
        // that has always worked.
      }
    }
    return await this._filterEngrams(options)
  }

  private async _filterEngrams(options?: RecallOptions & { include_expired?: boolean }): Promise<Engram[]> {
    let engrams: Engram[]
    if (this.indexedStorage) {
      engrams = await this.indexedStorage.loadFiltered({
        status: 'active',
        scope: options?.scope,
        scopes: options?.scopes,
        // Mounted-scope visibility grants (#775) — widen the `scope`
        // VISIBILITY clause only; a no-op without `scope`, and never touches
        // the `scopes` authorization pushdown above.
        visibilityGrants: this._grantedScopes(),
        domain: options?.domain,
      })
    } else {
      const adapter = this._primaryQueryAdapter()
      if (adapter && typeof adapter.loadFiltered === 'function' && !this.pgliteAdapter) {
        // #906: primary-store adapter (e.g. Postgres) supports server-side
        // filtered load. Use it instead of _loadAllEngrams + in-memory filter:
        // one scoped query replaces a full table read on every recallHybrid call.
        //
        // The `typeof loadFiltered` check is LOAD-BEARING, not defensive noise:
        // _primaryQueryAdapter() duck-types on role + searchBM25 only, so a
        // store can qualify while implementing just the query surface —
        // ReadonlyStoreGuard forwarded exactly that subset before it learned to
        // forward loadFiltered, and #903's hybrid-pushdown test mock still
        // does. Such a store must take the fallback read below, not crash here.
        //
        // `!pgliteAdapter` is a BELT, not a live branch: the two cannot both be
        // set. `pgliteAdapter` is constructed only when `indexTier === 'pglite'`,
        // and that tier is chosen only when `hasPrimaryQueryStore` is false —
        // i.e. exactly when `_primaryQueryAdapter()` returns null. So whenever
        // `adapter` is non-null, `pgliteAdapter` is already null by construction.
        //
        // Kept because the invariant lives in the constructor's tier selection,
        // far from here, and the consequence of it changing is silent: the
        // PGLite hybrid path needs the full corpus (packs + remote stores) that
        // _loadAllEngrams provides, so taking this branch with PGLite active
        // would narrow the corpus rather than fail. Pinned by
        // `filter-engrams-primary-pushdown.test.ts`.
        //
        // Temporal validity and min_strength are applied below, same as every
        // other path. _engramsOutsidePrimaryStore applies active/scope/domain
        // filters to packs and remote secondary stores.
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
      // so the cost is comparable.
      engrams = await this._loadAllEngrams()
      engrams = engrams.filter(e => e.status === 'active')
      if (options?.scopes !== undefined) {
        // Permitted-scope allow-list (Phase 3). The in-memory twin of the SQL
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
        // Read-side scope filter (#353/#775) — the ONE shared visibility
        // predicate. Segment-aware containment keeps the `startsWith` arm so
        // an explicit personal scope like `user:alice` still catches
        // sub-scopes (e.g. `user:alice:notes`). `isPersonalScope` passes ALL
        // personal-family scopes (local, global, user:*, agent:*), not just
        // global — so a project-scope recall sees personal engrams. Mounted
        // store scopes (#775) pass the same way. D1-ASYMMETRY: an explicit
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
  private async _reactivateResults(results: Engram[]): Promise<void> {
    // Read-only instance: SKIP the activation refresh, silently (#731). Recall
    // is a read and must succeed on a read-only engine; the write it piggy-
    // backs (retrieval_strength / last_accessed / frequency / co-access edges)
    // is freshness bookkeeping, not the answer. Refusing the whole recall
    // because the bookkeeping is forbidden would make the read wrong — exactly
    // the failure mode #731 warned about — so the results are returned as-is
    // and the refresh is deferred to the next writable instance that recalls
    // them. Returning before the lock also keeps a pure read from creating
    // `.lock` files.
    if (this._readonly) return
    if (results.length === 0) return
    // Filter out store engrams — they're managed by their source.
    // Via YAML path: store engrams have _originalId. Via SQLite path: namespaced IDs (ENG-XX-...).
    const isStoreEngram = (e: Engram) =>
      (e as any)._originalId || /^(ENG|ABS|META)-[A-Z]{3}-/.test(e.id)
    const primaryResults = results.filter(e => !isStoreEngram(e))
    if (primaryResults.length === 0) return
    await this._withStoreLock(this.paths.engrams, async () => {
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
      // an ordinary read. No in-tree store does that today; the interface
      // invites it.
      const canTarget = Boolean(store.loadByIds && store.updateMany)
      const allEngrams = canTarget
        ? await store.loadByIds!([...resultIds])
        : await this._primaryStore.load()
      const today = new Date().toISOString().slice(0, 10)
      // WHICH engrams changed, not merely whether any did.
      //
      // This wrote the whole corpus back on every read — activation is updated
      // on each recall, and `_writeEngrams` is a full replace. Measured on
      // Postgres: 252ms for 2,000 engrams, extrapolating to ~6.3s at 50,000,
      // which is the corpus size at which that tier is selected in the first
      // place. All of it under the global write lock, so every writer queued
      // behind every reader.
      //
      // A recall touches a handful of rows. Tracking them lets a store that
      // supports targeted updates write only those.
      const touched = new Map<string, Engram>()

      // Reactivate accessed engrams.
      //
      // TRAFFIC and QUALITY are separate signals here (#846). `frequency`
      // counts retrievals and `last_accessed` carries recency — which is what
      // decay actually keys on, so a frequently-recalled engram still resists
      // decay. `retrieval_strength` is deliberately NOT touched: it moves only
      // on deliberate feedback now, because when retrieval moved it too the
      // traffic term structurally outvoted the quality term (+0.10 per fetch
      // against +0.05 per ★) and saturated at 1.0 within three recalls.
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

      if (canTarget) {
        // Targeted: rewrites the handful of rows a recall actually touched.
        await store.updateMany!([...touched.values()])
      } else {
        // A single-file store has no cheaper option — the whole file is
        // rewritten either way, so this is the same cost it always was.
        await this._writeEngrams(this.paths.engrams, allEngrams)
      }
      await this._syncIndex()
    })
  }

  /** Scored injection within token budget (BM25 only). Returns formatted strings. */
  async inject(task: string, options?: InjectOptions): Promise<InjectionResult> {
    return await this._formatInjection(task, options)
  }

  /** Scored injection with embedding boost when available. Falls back to BM25 if embeddings not installed. */
  async injectHybrid(task: string, options?: InjectOptions): Promise<InjectionResult> {
    // #776: the remote leg starts FIRST — it runs in parallel with the local
    // embedding work below and REPLACES the old hook `tryRemoteInject`
    // remote-first POST /inject path, so a prompt costs at most ONE remote
    // call per host.
    const remotePromise = this._startRemoteRecall(task, {
      scope: options?.scope,
      // #243: the inject's session (same id plur_session_start minted for
      // co_injection provenance) doubles as the dialing-context key — the
      // session default scope drives org-affinity when no explicit scope is
      // given, so a mid-session scope switch redials the right org's hosts.
      session: options?.session_id,
      remote: options?.remote,
      remote_timeout_ms: options?.remote_timeout_ms,
      remote_project: options?.remote_project,
    })
    // Use actual cosine similarity scores as boosts so the 0.5 threshold in
    // selectAndSpread is meaningful. (Pre-0.9.4 used rank-based 1/(1+i*0.1)
    // which gave the top result boost=1.0 even when its cosine was 0.4 —
    // letting unrelated short sentences leak through once embeddings actually
    // started running.)
    let embeddingBoosts: Map<string, number> | undefined
    try {
      const engrams = (await this._loadAllEngrams()).filter(e => e.status === 'active')
      // Route through PGLite/pgvector when active (#226 B-1), intersecting hits
      // with the YAML-rooted `engrams` set; else the JSON cache path.
      let results: SimilarityResult[] = []
      if (this.pgliteAdapter) {
        const { embed } = await import('./embeddings.js')
        const queryVec = await embed(task, 'query')
        if (queryVec) {
          try {
            // Scope-restricted in-query, same reason as the recall legs. Less
            // acute here because `limit` is `engrams.length` rather than a
            // small k, so there is no cut for permitted rows to fall below —
            // but passing it keeps every vector path consistent, and a future
            // change to that limit would otherwise reintroduce the dilution
            // silently.
            const hits = await this.pgliteAdapter.searchVector(queryVec, engrams.length, { scopes: options?.scopes })
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
      const rerank = await this._resolveRerankOptions(options?.rerank)
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
    // #776: server rows join the candidate pool + boost channel. Visibility/
    // authorization run over them INSIDE _remoteInjectCandidates, before any
    // boost exists to resurrect a scope-excluded row.
    const remote = await this._remoteInjectCandidates(remotePromise, options)
    return await this._formatInjection(task, options, embeddingBoosts, remote)
  }

  private async _formatInjection(
    task: string,
    options?: InjectOptions,
    embeddingBoosts?: Map<string, number>,
    // #776: pre-filtered server rows + their score-derived boosts. Only
    // injectHybrid supplies this — the BM25-only inject() path NEVER makes a
    // remote call.
    remote?: { engrams: Engram[]; boosts: Map<string, number> },
  ): Promise<InjectionResult> {
    let allEngrams = await this._loadAllEngrams()
    const allPacks = loadAllPacks(this.paths.packs)

    if (remote && remote.engrams.length > 0) {
      // Candidate-pool dedup by namespaced id — the SERVER copy wins (fresher
      // than any peek-cache copy of the same remote row that
      // _loadSecondaryAndPacks may have merged in).
      const serverIds = new Set(remote.engrams.map(e => e.id))
      allEngrams = [...allEngrams.filter(e => !serverIds.has(e.id)), ...remote.engrams]
      // Boost-channel entry. The map is SHARED with the local cosine/reranker
      // writes — collision rule is max-merge, so neither channel can lower
      // the other's signal.
      if (embeddingBoosts) {
        for (const [id, boost] of remote.boosts) {
          const cur = embeddingBoosts.get(id)
          embeddingBoosts.set(id, cur === undefined ? boost : Math.max(cur, boost))
        }
      } else {
        embeddingBoosts = remote.boosts
      }
    }

    // Permitted-scope allow-list — AUTHORIZATION, applied before selection.
    //
    // `options.scope` below is a VISIBILITY filter and deliberately passes the
    // whole personal family through (`local`, `global`, `user:*`, `agent:*`),
    // which is right for a single user and wrong for a multi-tenant caller:
    // without this, every principal's personal engrams reach every other
    // principal's context. `inject()` is what a session calls on every prompt,
    // so it was the widest surface with no authorization filter at all.
    //
    // Exact membership, matching `ScopeRestriction`: absent = unrestricted,
    // `[]` = nothing (never widened), non-empty = the list itself with no
    // hierarchy expansion.
    //
    // Packs are filtered too. A pack is installed knowledge rather than user
    // data, so it is tempting to exempt it — but its engrams carry scopes, they
    // reach the same output, and an allow-list with an exemption is not an
    // allow-list. A caller that wants pack content in scope names it.
    const permitted = options?.scopes
    const inScope = (e: Engram): boolean => permitted === undefined || permitted.includes(e.scope)
    // Pack engrams are carried by `packs`, NOT by this array (#901).
    //
    // `_loadAllEngrams` merges installed-pack engrams into the corpus and
    // stamps `_pack` — deliberately, and for RECALL: its own comment says
    // "include pack engrams so they're searchable via recall". Injection does
    // not need that merge, because it receives `packs` separately.
    //
    // Leaving them in meant `selectAndSpread` scored every pack engram TWICE:
    // once in its personal-engram loop and once in its pack loop. Not merely a
    // double count — the two loops apply different rules (the pack loop uses
    // `packMatchTerms` and is capped by MAX_PER_PACK, the personal loop is
    // neither), so the stray copy was scored under rules never meant for it,
    // competed for the same token budget, and could displace a genuinely
    // distinct engram. It also inflated `total_injections`, which feeds the
    // H003 activation-rate assumption in hypotheses.yaml.
    const withoutPacks = allEngrams.filter(e => (e as { _pack?: string })._pack === undefined)
    const engrams = permitted === undefined ? withoutPacks : withoutPacks.filter(inScope)
    const packs = permitted === undefined
      ? allPacks
      : allPacks
        .map(p => ({ ...p, engrams: p.engrams.filter(inScope) }))
        .filter(p => p.engrams.length > 0)

    const budget = options?.budget ?? this.config.injection_budget ?? 2000

    const result = selectAndSpread(
      {
        prompt: task,
        scope: options?.scope,
        // Mounted-scope visibility grants (#775): scopes from config.stores
        // pass the `scope` VISIBILITY filter inside scoreEngram like the
        // personal family. Deliberately independent of the `permitted`
        // authorization filter above — grants never widen `options.scopes`.
        grantedScopes: this._grantedScopes(),
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
            // `_pack` FIRST, and that is a bug fix, not a preference (#553).
            //
            // This read only `pack` — the schema field, which an engram carries
            // only if its own YAML declares it. But `_loadAllEngrams` stamps
            // installed-pack engrams with `_pack` (the pack's manifest name),
            // and nothing sets `pack` on them. So the normal case — a pack
            // whose engrams do not self-declare their origin — bucketed
            // ENTIRELY as `__personal__`, and per-pack telemetry counted
            // nothing it existed to count.
            //
            // #553 predicted this shape ("a future regression in that
            // propagation would keep CI green") and was one step off: it was
            // not a future regression, it was already true, and no test
            // installed a pack so nothing could see it.
            //
            // `_pack` survives into `WireEngram` because `stripScoring`
            // rest-spreads. `pack` is kept as the fallback so a pack engram
            // that DOES declare its origin still buckets by it.
            const key = (e as { _pack?: string })._pack ?? e.pack ?? '__personal__'
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

      // #866: increment injection_count on primary-store engrams selected for context.
      // Distinct from activation.frequency (recall events) — this tracks actual
      // injection into the model's context window. Best-effort: never breaks injection.
      //
      // TARGETED, via the `_loadTargeted`/`_updateEngrams` pair (2026-08-13
      // panel). This first loaded the whole corpus and wrote the whole corpus
      // back, on a path that runs at EVERY session start. Measured cost of the
      // block, with and without:
      //
      //     corpus     with      without   overhead
      //        200     48 ms      11 ms      4.4x
      //      2,000    442 ms      42 ms     10.5x
      //     10,000  2,804 ms     142 ms     19.7x
      //
      // …all of it inside the global store lock, so it is not just this call
      // that pays, it is every concurrent writer waiting behind it. Counting
      // injections is worth a row update; it is not worth rewriting the store.
      // On YAML (no `updateMany`) the pair still falls back to a corpus write,
      // but the corpus is the one loaded under this lock, so the fallback is
      // the same shape it always was.
      try {
        await this._withStoreLock(this.paths.engrams, async () => {
          const primaryEngrams = await this._loadTargeted(injected_ids)
          const injectedSet = new Set(injected_ids)
          const touched: Engram[] = []
          for (const e of primaryEngrams) {
            if (injectedSet.has(e.id)) {
              e.injection_count = (e.injection_count ?? 0) + 1
              touched.push(e)
            }
          }
          await this._updateEngrams(primaryEngrams, touched)
        })
      } catch (err) {
        // Best-effort, but not SILENT. `EngramStoreShrinkError` and
        // `EngramStoreUnreadableError` are the #795/#800 guards telling us the
        // store is degrading; swallowing them on the most frequently run write
        // path means the user gets no signal from the operation they run most.
        // Everything else stays quiet — a counter is not worth a warning.
        const name = (err as Error)?.constructor?.name
        if (name === 'EngramStoreShrinkError' || name === 'EngramStoreUnreadableError') {
          logger.warning(
            `[plur] injection counters were not recorded: ${(err as Error).message}. `
            + `The injection itself succeeded — this is a store-integrity signal, not an injection failure.`,
          )
        }
      }
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

  /**
   * Update feedback_signals and adjust retrieval_strength. Searches primary, stores, then packs.
   *
   * Pass `scope` to route directly to a specific store and bypass the first-match-wins
   * walk (#850). Use scope: "primary" to target the local primary store, or a remote
   * scope string (e.g. "group:plur/plur-ai/engineering") to target that remote.
   * Without scope, an ID that exists in both the local store and a warmed remote cache
   * is an error — the caller must disambiguate rather than relying on resolution order.
   */
  async feedback(id: string, signal: 'positive' | 'negative' | 'neutral', scope?: string): Promise<void> {
    this._assertWritable()

    if (scope !== undefined && (typeof scope !== 'string' || scope.trim() === '')) {
      throw new TypeError('plur.feedback: scope must be a non-empty string')
    }
    // Pick up out-of-process config edits (#307) so a store registered after
    // startup is not rejected as unknown by the validation below — mirrors
    // rescope() and forget().
    if (scope) this.reloadConfigIfChanged()

    // Scope-targeted routing (#850): when the caller knows which store the engram
    // lives in, route directly and skip the first-match-wins walk.
    if (scope && scope !== 'primary') {
      const entry = (this.config.stores ?? []).find(s => s.url && s.scope === scope)
      if (entry) {
        if (entry.readonly === true) throw new Error('Engram is in a readonly store')
        const serverId = this._stripRemotePrefix(id, entry.scope)
        const driver = this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
        const remoteEngram = await driver.getById(serverId)
        if (!remoteEngram) throw new Error(`Engram "${id}" not found in store "${scope}"`)
        await driver.feedback(serverId, signal)
        try {
          appendHistory(this.paths.root, {
            event: 'feedback_received',
            engram_id: id,
            timestamp: new Date().toISOString(),
            data: { signal, routed_to: 'remote', scope },
          })
        } catch (err) {
          logger.warning(
            `[plur] feedback on ${id} was applied remotely but its history record could not be written: ` +
            `${(err as Error).message}. Do not retry — the signal is already counted.`,
          )
        }
        this._logInjectionOutcome(id, signal)
        return
      }
      // No URL-backed store carries this scope. Falling through blindly was a
      // hole (#851 audit): because `scope` is truthy, the `if (!scope)`
      // ambiguity guard below is skipped, so a MISTYPED scope silently
      // disabled the guard and restored first-match-wins. Same defect as
      // forget()'s, one severity band down — a mis-targeted signal is
      // recoverable where a retire is not — but the same guard, so the same
      // rule: validate that the scope names something, following rescope().
      assertScopeNamesATarget(scope, this.config.stores ?? [], 'rate in', 'rate the LOCAL engram')
    }

    // Try primary engrams first
    const found = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): rating one engram is a lookup by primary key,
      // not a reason to materialise the corpus. A miss still means "not in the
      // primary store" and still falls through to the secondary stores below.
      const engrams = await this._loadTargeted([id])
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false

      // Ambiguity guard (#850): without an explicit scope, refuse when the same
      // bare ID exists in a warmed remote cache. Silent wrong-target writes are
      // indistinguishable from correct ones; the caller must pass scope to resolve.
      // A COLD cache must not silently downgrade to first-match-wins:
      // `_loadRemoteCached` is a synchronous peek with no fetch, and nothing
      // here warms it, so on a fresh process the guard did not run at all.
      // Peek first (free), then one live probe per remote only when that
      // store's cache is cold — session_start warms the cache, so in normal
      // operation this costs nothing and fires only before the first warm.
      //
      // Unlike forget(), an unreachable store does NOT block the write. A
      // mis-targeted feedback signal is recoverable and rating is a hot path;
      // refusing here would trade a real cost for a reversible risk. Warn
      // instead, so the unverified case is visible rather than silent.
      if (!scope) {
        const guardDeadline = Date.now() + REMOTE_GUARD_BUDGET_MS
        for (const entry of (this.config.stores ?? [])) {
          if (!entry.url) continue
          const serverId = this._stripRemotePrefix(id, entry.scope)
          const remoteCached = this._loadRemoteCached(entry)
          let existsRemotely: boolean
          if (remoteCached.length > 0) {
            existsRemotely = remoteCached.some(e => e.id === serverId)
          } else if (Date.now() >= guardDeadline) {
            // Budget spent on earlier stores. Same branch an unreachable store
            // takes — "cannot tell" — so feedback proceeds with a warning
            // rather than refusing a recoverable operation.
            existsRemotely = false
            logger.warning(
              `[plur] ran out of time probing remotes for an id collision on ${id} `
              + `(${REMOTE_GUARD_BUDGET_MS}ms budget spent before reaching "${entry.scope}") — `
              + `rating the LOCAL engram unverified. Pass scope explicitly to skip this walk.`,
            )
          } else {
            try {
              const driver = this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
              // existsById, NOT getById: getById returns null for a dead
              // network exactly as for a genuine 404, so it would report
              // "no collision" for a store it never reached.
              existsRemotely = await driver.existsById(serverId)
            } catch (err) {
              existsRemotely = false
              logger.warning(
                `[plur] could not reach remote scope "${entry.scope}" to rule out an id collision on ${id} `
                + `(${(err as Error).message}) — rating the LOCAL engram unverified. `
                + `Pass scope explicitly if this id also exists remotely.`,
              )
            }
          }
          if (existsRemotely) {
            throw new Error(
              `Ambiguous engram ID "${id}": exists in both the local store and remote scope "${entry.scope}". ` +
              `Pass scope: "primary" to rate the local engram, or scope: "${entry.scope}" to rate the remote one.`,
            )
          }
        }
      }

      applyFeedbackSignal(engram, signal)

      // Incremental write (#740): only the rated engram changed.
      await this._updateEngrams(engrams, [engram])
      await this._syncIndex()
      // The counter has already changed on disk. A history failure here used to
      // reject the call, and a retry then applied the signal a SECOND time
      // (#813, audit finding 13). Log and continue: the mutation committed.
      try {
        appendHistory(this.paths.root, {
          event: 'feedback_received',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { signal },
        })
      } catch (err) {
        logger.warning(
          `[plur] feedback on ${id} was applied but its history record could not be written: ` +
          `${(err as Error).message}. Do not retry — the signal is already counted.`,
        )
      }
      return true
    })

    if (found) {
      this._logInjectionOutcome(id, signal)
      return
    }

    // scope: "primary" means local-only — do not try secondary or remote stores
    if (scope === 'primary') {
      throw new Error(`Engram "${id}" not found in primary store`)
    }

    // Try configured stores (namespaced IDs)
    const storeInfo = await this._findEngramStore(id)
    if (storeInfo && storeInfo.path !== this.paths.engrams) {
      if (storeInfo.readonly) {
        throw new Error('Engram is in a readonly store')
      }
      // Under the SECONDARY store's own lock — this had none, while the same
      // operation on the primary store took one. Two processes rating the same
      // team engram both loaded, both incremented, and both wrote back, so one
      // increment vanished; and a whole-file replace also deletes anything the
      // other process added in between.
      // Returns whether the engram was found and handled here; a miss falls
      // through to the remote-store search below.
      const handled = await this._withStoreLock(storeInfo.path, async () => {
      // Must load fresh (not cached) since we're about to mutate and write back
      const storeEngrams = await this._storeAt(storeInfo.path).load()
      const engram = storeEngrams.find(e => e.id === storeInfo.originalId)
      if (engram) {
        applyFeedbackSignal(engram, signal)
        await this._writeEngrams(storeInfo.path, storeEngrams)
        await this._syncIndex()
        this._logInjectionOutcome(id, signal)
        return true
      }
      return false
      })
      if (handled) return
    }

    // Check remote stores — the engram may live on an enterprise server.
    // See: https://github.com/plur-ai/plur/issues/85
    //
    // Same local-only guard as forget()'s, and it was missing here entirely —
    // not even the `primary` case was covered, so `feedback(id, signal,
    // 'primary')` on an id absent locally rated a REMOTE engram. One severity
    // band below the retire (a mis-targeted signal is recoverable), same
    // defect, same predicate.
    if (scope && isLocalOnlyScope(scope)) {
      throw new Error(
        `Engram not found in the local store: ${id} (scope: "${scope}"). `
        + `That scope names a local target, so no remote store was searched. `
        + `Omit scope to search everywhere, or pass the remote scope to target it directly.`,
      )
    }
    // The ID may be prefixed (ENG-GPL-...) from _loadAllEngrams namespacing.
    // Strip the prefix before querying the remote server. See: #86
    /** Stores this walk could not reach — so "not found" can say so (#907). */
    const unverifiedStores: string[] = []
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
      // OWNERSHIP is decided by `existsById`, not `getById` (#907).
      //
      // `getById` catches everything and returns null, so a timeout, a 5xx or
      // an auth rejection was indistinguishable from a genuine 404 — the walk
      // read silence as "this store does not have it", moved on, and reported
      // "Engram not found" for an engram the store demonstrably held. That is
      // the exact collapse `existsById` exists to prevent, quoting its own
      // docstring: safe for reads that only want the engram, unsafe for
      // anything deciding whether it is free to act. Deciding which store owns
      // an id IS deciding whether to act.
      let owns: boolean
      try {
        owns = await driver.existsById(serverId)
      } catch (err) {
        // Could not tell. Feedback's established policy is to proceed rather
        // than refuse — a mis-targeted rating is recoverable and rating is a
        // hot path — but the store is COUNTED, so the message below cannot
        // claim knowledge this walk does not have.
        unverifiedStores.push(entry.scope ?? entry.url!)
        logger.warning(
          `[plur] could not reach "${entry.scope ?? entry.url}" while looking for ${id} `
          + `(${(err as Error).message}) — it may hold this engram.`,
        )
        continue
      }
      if (!owns) continue
      const found = await driver.getById(serverId)
      if (found) {
        await driver.feedback(serverId, signal)
        // Same reasoning as the local path: the remote already counted it.
        try {
          appendHistory(this.paths.root, {
            event: 'feedback_received',
            engram_id: id,
            timestamp: new Date().toISOString(),
            data: { signal, routed_to: 'remote' },
          })
        } catch (err) {
          logger.warning(
            `[plur] feedback on ${id} was applied remotely but its history record could not be ` +
            `written: ${(err as Error).message}. Do not retry — the signal is already counted.`,
          )
        }
        this._logInjectionOutcome(id, signal)
        return
      }
    }

    // Search pack engrams by scanning pack directories
    await this._feedbackPack(id, signal, unverifiedStores)
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
  async saveMetaEngrams(metas: Engram[]): Promise<{ saved: number; skipped: number }> {
    this._assertWritable()
    return await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
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
        await this._writeEngrams(this.paths.engrams, engrams)
        await this._syncIndex()
      }
      return { saved, skipped }
    })
  }

  /**
   * Update an existing engram by ID. Returns true if it was found and written,
   * false if no local or writable remote store holds it.
   *
   * Since 0.16 a remote-routed update is awaited and its outcome reported, so a
   * `true` means the write happened. {@link updateEngramAsync} is now
   * equivalent and kept only for source compatibility.
   */
  async updateEngram(updated: Engram): Promise<boolean> {
    this._assertWritable()
    // Local primary first.
    const localResult = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const engrams = await this._loadTargeted([updated.id])
      const idx = engrams.findIndex(e => e.id === updated.id)
      if (idx === -1) return false
      // Leak guard (#353): local-resident → demote a sensitive update in place.
      // LOW-2: scan context fields too, not just the statement.
      const demote = this._guardExplicitUpdate(updated.statement, updated.scope, false, this._engramContextFields(updated))
      const toWrite = demote ? { ...updated, ...demote } : updated
      engrams[idx] = toWrite
      // Incremental write (#740): only the updated engram row changed.
      await this._updateEngrams(engrams, [toWrite])
      await this._syncIndex()
      return true
    })
    if (localResult) return true

    // Remote routing. Awaited, and the outcome reported.
    //
    // This used to `void driver.patch(...)` and `return true` on the next line
    // — the same defect fixed in `setPinned`, missed here. Three consequences,
    // all reproduced: a write that failed was reported as success; the promise
    // had no catch, so a non-2xx (RemoteStore.patch throws on anything but 404)
    // became an UNHANDLED REJECTION, which under Node's default
    // `--unhandled-rejections=throw` terminates a long-lived MCP server; and a
    // 404 returned `null` while the caller was told `true`.
    //
    // Verified against a stub remote returning 401: the old code logged
    // `updateEngram RETURNED: true` alongside
    // `UNHANDLED REJECTIONS: [Error: Remote patch failed: 401 token expired]`.
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
      try {
        const patched = await driver.patch(serverId, {
          pinned: updated.pinned,
          status: updated.status,
          statement: updated.statement,
        })
        // `null` is a 404 — this remote does not hold it, so keep looking.
        if (patched) return true
      } catch {
        // This remote refused it (auth, validation, transport). Try the next
        // writable store rather than reporting a success that did not happen.
        continue
      }
    }
    return false
  }

  /**
   * @deprecated Equivalent to {@link updateEngram} since 0.16 — that method now
   * awaits the remote PATCH too. Kept so existing callers keep compiling.
   *
   * Async variant of updateEngram that awaits remote PATCH for ordering
   * guarantees. Returns the patched engram (server-authoritative view)
   * on remote success, null if not found locally or remotely.
   */
  async updateEngramAsync(updated: Engram): Promise<Engram | null> {
    this._assertWritable()
    // Local primary first.
    const localResult = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const engrams = await this._loadTargeted([updated.id])
      const idx = engrams.findIndex(e => e.id === updated.id)
      if (idx === -1) return null
      // Leak guard (#353): local-resident → demote a sensitive update in place.
      // LOW-2: scan context fields too, not just the statement.
      const demote = this._guardExplicitUpdate(updated.statement, updated.scope, false, this._engramContextFields(updated))
      const toWrite = demote ? { ...updated, ...demote } : updated
      engrams[idx] = toWrite
      // Incremental write (#740): only the updated engram row changed.
      await this._updateEngrams(engrams, [toWrite])
      await this._syncIndex()
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
   *
   * Returns the updated engram on success, `null` if it is not found in the
   * local primary store or in any writable remote. Since 0.16 the remote PATCH
   * is awaited and its result returned, so the value is the real engram rather
   * than a placeholder — {@link setPinnedAsync} is now equivalent and kept only
   * for source compatibility.
   */
  async setPinned(id: string, pinned: boolean): Promise<Engram | null> {
    this._assertWritable()
    // Local primary first.
    const localResult = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const engrams = await this._loadTargeted([id])
      const idx = engrams.findIndex(e => e.id === id)
      if (idx === -1) return null
      const e = engrams[idx]
      const updated: Engram = { ...e, pinned: pinned === true ? true : undefined }
      engrams[idx] = updated
      // Incremental write (#740): only the (un)pinned engram row changed.
      await this._updateEngrams(engrams, [updated])
      await this._syncIndex()
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
        // Awaited, and the SERVER's engram is returned.
        //
        // This used to fire-and-forget the PATCH and return
        // `{ id, pinned } as unknown as Engram` — an object that is not an
        // Engram at all (no statement, scope, status or activation), so
        // `(await plur.setPinned(id, true)).statement` was `undefined`. It also
        // reported success before the write had happened, and a rejected
        // floating promise could not be caught by the `catch` below.
        //
        // The justification was that `setPinned` had to keep a synchronous
        // signature. It is `async` since the 0.16 flip, so that reason is gone
        // and the honest version costs nothing.
        const patched = await driver.patch(serverId, { pinned: pinned === true ? true : undefined })
        if (patched) return patched
      } catch {
        continue
      }
    }
    return null
  }

  /**
   * @deprecated Equivalent to {@link setPinned} since 0.16 — that method now
   * awaits the remote PATCH too. Kept so existing callers keep compiling.
   */
  async setPinnedAsync(id: string, pinned: boolean): Promise<Engram | null> {
    this._assertWritable()
    // Local primary first.
    const localResult = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const engrams = await this._loadTargeted([id])
      const idx = engrams.findIndex(e => e.id === id)
      if (idx === -1) return null
      const e = engrams[idx]
      const updated: Engram = { ...e, pinned: pinned === true ? true : undefined }
      engrams[idx] = updated
      // Incremental write (#740): only the (un)pinned engram row changed.
      await this._updateEngrams(engrams, [updated])
      await this._syncIndex()
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
  async listPinned(): Promise<Engram[]> {
    const all = await this._loadAllEngrams()
    return all.filter(e => (e as any).pinned === true && e.status === 'active')
  }

  /**
   * Recompute `content_hash` for primary-store engrams whose hash no longer
   * describes their statement (#852).
   *
   * ## Why this lives in core rather than in the CLI
   *
   * The first cut of `plur reindex-hashes` did a raw load → mutate → save
   * against `paths.engrams` in the command itself. That is a whole-corpus
   * read-modify-write on an UNLOCKED snapshot, and the 2026-08-13 data-loss
   * audit reproduced the loss 6/6 on a 4,642-engram store: a correctly-locked
   * concurrent writer appends between the load and the save, and the save puts
   * the pre-append snapshot back. The engram is gone with no error — and the
   * shrink guard cannot see it, because the same count goes out that came in.
   *
   * Nothing about that was specific to the CLI. Any caller reaching for the
   * exported `loadEngrams`/`saveEngrams` primitives can reintroduce it, so the
   * repair belongs behind the same seam every other write uses:
   * `_withStoreLock` (which also fires the #799 daily backup) and the
   * `_loadTargeted`/`_updateEngrams` capability pair, so a store that can do a
   * targeted UPDATE is not asked to replace its whole corpus to rewrite one
   * field.
   *
   * ## Why the primary store, not `list()`
   *
   * `list()` merges packs in and drops inactive/expired rows. Measured against
   * one real store it gave 5,388 scanned / 1 stale / 1,805 missing where the
   * primary store itself holds 4,642 / 38 / 961: it counted pack entries this
   * repair does not own, and hid stale hashes on retired engrams. A retired
   * engram with a stale hash still matters — `findActiveByContentHash` is not
   * the only reader, and a resurrected row carries the bad hash with it.
   *
   * STALE and MISSING are reported separately because they are different
   * conditions: a stale hash is actively wrong and absorbs unrelated writes
   * today, a missing one predates the field and is inert until something
   * matches on it.
   *
   * UNHASHABLE is the third category, and it is a refusal rather than a
   * finding. A statement that normalizes to nothing hashes to the SHA-256 of
   * the empty string — the same value every other such statement gets — so
   * writing it does not record a fact about that engram, it enrols the engram
   * in a mutual-absorption set. Before #896 that was every non-Latin statement
   * in the store, and a `--apply` run would have stamped the shared value onto
   * exactly the rows the report called "inert". These are listed and skipped.
   *
   * Read-only unless `apply` is set.
   */
  async repairContentHashes(opts: { apply?: boolean } = {}): Promise<{
    scanned: number
    stale: Array<{ id: string; statement: string }>
    missing: Array<{ id: string; statement: string }>
    unhashable: Array<{ id: string; statement: string }>
    repaired: number
  }> {
    const apply = opts.apply === true
    if (apply) this._assertWritable()
    return await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const stale: Array<{ id: string; statement: string }> = []
      const missing: Array<{ id: string; statement: string }> = []
      const unhashable: Array<{ id: string; statement: string }> = []
      const changed: Engram[] = []
      for (const e of engrams) {
        if (!e.statement) continue
        const current = (e as { content_hash?: string }).content_hash
        if (!isHashable(e.statement)) {
          unhashable.push({ id: e.id, statement: e.statement })
          continue
        }
        const correct = computeContentHash(e.statement)
        if (!current) missing.push({ id: e.id, statement: e.statement })
        else if (current !== correct) stale.push({ id: e.id, statement: e.statement })
        else continue
        if (apply) {
          ;(e as { content_hash?: string }).content_hash = correct
          changed.push(e)
        }
      }
      if (apply && changed.length > 0) {
        // `engrams` was loaded INSIDE this lock, so the fallback whole-corpus
        // write is of a current snapshot — that is the whole point of the move.
        await this._updateEngrams(engrams, changed)
        await this._syncIndex()
      }
      return { scanned: engrams.length, stale, missing, unhashable, repaired: changed.length }
    })
  }

  /** Set engram status to 'retired'. Supports primary and store engrams.
   *
   * options.force=true bypasses write_count and retires immediately,
   * regardless of how many sources reference the engram (#766). Use for
   * explicit user-facing forget (MCP plur_forget), where one call = full
   * retirement. The default decrement-until-zero behavior is for internal
   * dedup tracking (two agents learned the same fact; one forgets — the
   * other's reference should remain). */
  async forget(id: string, reason?: string, options?: { force?: boolean; scope?: string }): Promise<void> {
    this._assertWritable()

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
      const entry = (this.config.stores ?? []).find(s => s.url && s.scope === targetScope)
      if (entry) {
        if (entry.readonly === true) throw new Error('Cannot retire engram from readonly store')
        const serverId = this._stripRemotePrefix(id, entry.scope)
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
        appendHistory(this.paths.root, {
          event: 'engram_retired',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { reason: reason ?? null, routed_to: 'remote', scope: targetScope },
        })
        return
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

    // Check primary first.
    // Reference-counted retirement (#107): decrement write_count; only
    // physically retire when it reaches 0. forget() called N times on an
    // engram with write_count=N retires it; called fewer times, the
    // engram stays active with a lower count.
    // options.force=true overrides this: retires immediately (#766).
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
      if (!targetScope) {
        const guardDeadline = Date.now() + REMOTE_GUARD_BUDGET_MS
        for (const entry of (this.config.stores ?? [])) {
          if (!entry.url) continue
          const serverId = this._stripRemotePrefix(id, entry.scope)
          const cached = this._loadRemoteCached(entry)
          let existsRemotely: boolean
          if (cached.length > 0) {
            existsRemotely = cached.some(e => e.id === serverId)
          } else if (Date.now() >= guardDeadline) {
            // Budget spent on earlier stores. Same branch an unreachable store
            // takes here — and on THIS path that branch REFUSES, because a
            // retire is irreversible and "I ran out of time looking" is not
            // evidence of absence. `scope: "primary"` remains the escape
            // hatch, and it needs no network at all.
            throw new Error(
              `Cannot verify that "${id}" is unambiguous: spent the ${REMOTE_GUARD_BUDGET_MS}ms `
              + `remote budget before reaching scope "${entry.scope}".\n`
              + `Retiring now could destroy the wrong engram (#831), so this refuses rather than guessing.\n`
              + `Pass scope: "primary" to retire the local engram without probing remotes, or pass the `
              + `remote scope to target it directly.`,
            )
          } else {
            try {
              const driver = this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
              // existsById, NOT getById: the latter returns null for a dead
              // network exactly as it does for a genuine 404, so it would
              // report "no collision" for a store it never reached — the
              // silent-no this guard exists to refuse.
              existsRemotely = await driver.existsById(serverId)
            } catch (e) {
              throw new Error(
                `Cannot safely retire "${id}": remote scope "${entry.scope}" is configured but could not be `
                + `reached to rule out an id collision (${e instanceof Error ? e.message : String(e)}). `
                + `Retiring is destructive and irreversible from here, so it will not guess. `
                + `Pass scope: "primary" to retire the local engram without consulting the remote.`,
              )
            }
          }
          if (existsRemotely) {
            throw new Error(
              `Ambiguous engram ID "${id}": exists in both the local store and remote scope "${entry.scope}". `
              + `Retiring is destructive and irreversible from here, so it will not guess. `
              + `Pass scope: "primary" to retire the local engram, or scope: "${entry.scope}" to retire the remote one.`,
            )
          }
        }
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
      appendHistory(this.paths.root, {
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

    if (foundInPrimary) return

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
          if (reason && !engram.rationale) {
            engram.rationale = `Retired: ${reason}`
          }
        }

        await this._writeEngrams(storeInfo.path, storeEngrams)
        await this._syncIndex()
        appendHistory(this.paths.root, {
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
      if (handled) return
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
    if (targetScope && isLocalOnlyScope(targetScope)) {
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
      // Tri-state (#907). `getById` alone cannot distinguish "this store does
      // not have it" from "this store did not answer", so an unreachable
      // remote was walked past and the engram reported as simply not found —
      // absence the walk never verified, which is #831's harm by another route.
      //
      // The walk CONTINUES on `unknown` rather than refusing: `forget handles
      // remote server error gracefully` (#84) asserts a degraded fleet does
      // not stop a retire, and that availability is worth keeping. What
      // changes is only that the store is recorded, so the terminal message
      // below stops claiming knowledge it does not have. Same resolution
      // `feedback` already uses.
      // Optional capability: a driver without `probeById` (an injected stub, a
      // third-party implementation) keeps the previous two-state behaviour
      // rather than crashing. Absence of the capability is not a reason to
      // fail a retire.
      const ownership: 'owned' | 'absent' | 'unknown' = driver.probeById
        ? await driver.probeById(serverId)
        : ((await driver.getById(serverId)) ? 'owned' : 'absent')
      if (ownership === 'unknown') {
        unreachedStores.push(entry.scope ?? entry.url!)
        logger.warning(
          `[plur] could not reach "${entry.scope ?? entry.url}" while looking for ${id} — `
          + `it may hold this engram.`,
        )
        continue
      }
      if (ownership === 'absent') continue
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
        // Found it, and the server declined to remove it. Remember where, so
        // the error below can say what actually happened.
        refusedBy = entry.scope ?? 'a remote store'
      }
    }

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
  }

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
  async rescope(
    idOrIds: string | string[],
    targetScope: string,
    options?: RescopeOptions,
  ): Promise<{ results: RescopeResult[]; success: boolean }> {
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

    // --- Resolve the target route ONCE, before touching any engram, so an
    // invalid target fails the whole batch early (#676 constraint 4). ---
    const remoteDriver = this._resolveRemoteStoreForScope(target)
    const storeEntry = (this.config.stores ?? []).find(s => s.scope === target)
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
  }

  /** One engram's rescope — see {@link rescope} for the contract. */
  private async _rescopeOne(
    id: string,
    target: string,
    route: 'remote' | 'local',
    remoteDriver: RemoteStore | null,
    opts: { dryRun: boolean; keepLocal: boolean },
  ): Promise<RescopeResult> {
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
    const existing = all.find(e =>
      e.id !== id && e.status === 'active' && (e as any).content_hash === hash && e.scope === target)
    if (existing) {
      const targetId = ((existing as any)._originalId as string | undefined) ?? existing.id
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
        await this._retireRescopedSource(id, target, serverId)
      }
      appendHistory(this.paths.root, {
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
    appendHistory(this.paths.root, {
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
        `[plur] rescope of ${id} cancelled a pending delivery to ${cancelledOutbox.target_url} ` +
        `(scope "${cancelledOutbox.target_scope}"). That queued write would have re-delivered the engram to the ` +
        `store it was moved away from once the host recovered (#848).`,
      )
    }
    return {
      id, status: 'rescoped', action, from_scope: source.scope, to_scope: target, new_id: id,
      ...(cancelledOutbox ? { cancelled_outbox: cancelledOutbox } : {}),
    }
  }

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
  private async _retireRescopedSource(id: string, toScope: string, newId: string): Promise<void> {
    const now = new Date().toISOString()
    await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const fresh = await this._loadTargeted([id])
      const t = fresh.find(e => e.id === id)
      if (!t) return
      t.status = 'retired'
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
    })
    appendHistory(this.paths.root, {
      event: 'engram_retired',
      engram_id: id,
      timestamp: now,
      data: { reason: `rescoped to ${toScope}`, rescoped_to: newId, routed_to: 'rescope' },
    })
  }

  /** Remove retired engrams from storage. Returns count of removed and remaining. */
  async compact(): Promise<{ removed: number; remaining: number }> {
    this._assertWritable()
    return await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const active = engrams.filter(e => e.status !== 'retired')
      const removed = engrams.length - active.length
      if (removed > 0) {
        // Removing retired engrams IS this method (audit #794 shrink guard).
        await this._writeEngrams(this.paths.engrams, active, { allowShrink: true })
        await this._syncIndex()
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
  async reindex(): Promise<void> {
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
  }

  /**
   * Async reindex that resolves when the index is fully rebuilt.
   * Equivalent to `plur sync --full`: drop the index and rebuild from YAML.
   */
  async reindexAsync(): Promise<void> {
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
      const active = (await this._loadAllEngrams()).filter(e => e.status === 'active' && !(e as any)._originalId && !(e as any)._pack)
      if (active.length === 0) return
      const { engramSearchText, embeddingContentHash } = await import('./fts.js')
      for (const engram of active) {
        // #812: skip on "already embedded FROM THIS TEXT", not on "already has
        // some vector". The latter is what `hasEmbedding` answered, which meant
        // a dedup UPDATE/MERGE could rewrite an engram and its vector would
        // never be recomputed — semantic recall kept ranking it by the old text.
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
  }

  /**
   * Kick (or coalesce into) the background primary-store auto-embed pass
   * (#762). Fire-and-track: callers never await it — a write must not pay
   * embedding latency, and a semantic recall must not block on a backfill.
   * The pass is tracked on `_pgliteInitPromise` so `waitForIndex()` covers it
   * exactly like the PGLite background chains.
   */
  private _kickPrimaryAutoEmbed(adapter: StorageAdapter): void {
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
  }

  /**
   * Embed active engrams missing a row in the primary store's embedding table
   * (#762) — the Postgres-primary counterpart of `_autoEmbedNewEngrams`.
   *
   * Deliberately NOT that method: `_autoEmbedNewEngrams` loads the whole
   * corpus and probes `hasEmbedding` per id, which is fine for a local PGLite
   * index and a serious per-write regression at the corpus size that selects
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
  private async _autoEmbedPrimaryStore(adapter: StorageAdapter): Promise<void> {
    if (typeof adapter.listEngramsMissingEmbeddings !== 'function') return
    try {
      const { embed, embedderStatus } = await import('./embeddings.js')
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
      // #335 dim guard, mirroring _autoEmbedNewEngrams: an embedder/column
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
      const { engramSearchText, embeddingContentHash } = await import('./fts.js')
      // #812: the loop's exit condition is "the store stops returning rows",
      // and the store's predicate now includes a hash comparison. If the hash
      // this side writes ever stopped matching the one the store's SQL derives,
      // every batch would return the same rows and the pass would spin forever
      // — a background task pinning a core. The two agree by construction (see
      // `embeddingContentHash`), and this set makes that a warning instead of a
      // hang if they ever stop agreeing.
      const embeddedThisPass = new Set<string>()
      for (;;) {
        const batch = await adapter.listEngramsMissingEmbeddings(PRIMARY_AUTO_EMBED_BATCH, { includeStale: true })
        if (batch.length === 0) return
        const fresh = batch.filter(e => !embeddedThisPass.has(e.id))
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
        if (batch.length < PRIMARY_AUTO_EMBED_BATCH) return
      }
    } catch (err) {
      // A store torn down mid-pass (close()/dropSchema() in a short-lived
      // process) is a cancellation, not a failure — stay quiet and do NOT
      // record it, or the stray warning outlives the process's real output
      // (the release smoke's last-line gate caught exactly that).
      if (isStoreTeardownError(err)) {
        logger.debug('[plur] primary-store auto-embed stopped: the store was closed or dropped mid-pass.')
        return
      }
      this._recordIndexError('auto-embed', err)
      logger.warning(`[plur] primary-store auto-embed failed: ${(err as Error).message}`)
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

  /**
   * Sync the index after a write to the primary store.
   *
   * No-op when no index is active, and — via `requiresIndexSync` — when the
   * adapter declares `role: 'primary'`, because then the write already landed
   * in the backend that answers queries and there is no delta to apply.
   */
  private async _syncIndex(): Promise<void> {
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
      this._pgliteInitPromise = adapter.syncFromYaml()
        .then(() => this._autoEmbedNewEngrams(adapter))
        .catch((err: unknown) => {
          this._recordIndexError('sync-from-yaml', err)
          logger.warning(`[plur] PGLite syncFromYaml failed (YAML is still source of truth): ${(err as Error).message}`)
        })
      return
    }
    // Primary query store (#762): the write already landed in the engine that
    // answers queries — no index delta — but its EMBEDDING has not. Kick the
    // background auto-embed pass so `engram_embeddings` tracks the corpus and
    // semantic recall gets to use the vector index instead of falling back to
    // the O(N) in-memory path. Fire-and-track: the write path never waits.
    const primary = this._primaryQueryAdapter()
    if (primary && typeof primary.listEngramsMissingEmbeddings === 'function') {
      this._lastIndexError = null // new pass — stale failures cleared on success
      this._kickPrimaryAutoEmbed(primary)
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
  /**
   * @param unreachedStores stores the caller's remote walk could not probe, so
   *   the terminal "not found" can say so rather than claiming a search that
   *   did not run (#907).
   */
  private async _feedbackPack(
    id: string,
    signal: 'positive' | 'negative' | 'neutral',
    unreachedStores: string[] = [],
  ): Promise<void> {
    if (!fs.existsSync(this.paths.packs)) throw new Error(`Engram not found: ${id}`)

    for (const entry of fs.readdirSync(this.paths.packs)) {
      const packDir = `${this.paths.packs}/${entry}`
      if (!fs.statSync(packDir).isDirectory()) continue
      const engramsPath = `${packDir}/engrams.yaml`
      if (!fs.existsSync(engramsPath)) continue

      // Under the PACK file's own lock, load included.
      //
      // The last unlocked read-modify-write of this shape. `save()` replaces
      // the whole pack file, so two processes rating different engrams in one
      // installed pack did not merely lose an increment — whichever wrote
      // second dropped the other's. Packs are shared by every agent on the
      // machine, which is exactly the concurrency this misses.
      //
      // Keyed on the pack's own path, so it cannot collide with the primary
      // store's lock; the caller holds none.
      const packStore = this._storeAt(engramsPath)
      const handled = await this._withStoreLock(engramsPath, async () => {
        const engrams = await packStore.load()
        const engram = engrams.find(e => e.id === id)
        if (!engram) return false

        applyFeedbackSignal(engram, signal)

        await packStore.save(engrams)
        return true
      })
      if (handled) return
    }

    // "Not found" must not mean "did not look" (#907). If a store could not be
    // reached, say which — the caller can retry or pass an explicit scope, and
    // neither is actionable if the message claims a search that did not run.
    throw new Error(
      unreachedStores.length > 0
        ? `Engram not found: ${id} — but ${unreachedStores.length} store(s) could not be reached `
          + `(${unreachedStores.join(', ')}). This is "not found where I could look", not "does not exist". `
          + `Retry, or pass scope explicitly to target a store directly.`
        : `Engram not found: ${id}`,
    )
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
  async installPack(source: string, opts?: { allowInjection?: boolean }): Promise<ReturnType<typeof installPack>> {
    const existing = await this._loadAllEngrams()
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
  async sync(remote?: string, options?: { full?: boolean; remoteType?: SyncRemoteType }): Promise<SyncResult> {
    // #640: explicit option > config.sync.remote_type > 'personal' (historical
    // mirror-everything default — `shared` is an explicit opt-in that filters
    // the push set to shared-scope, non-private engrams).
    const remoteType = options?.remoteType ?? this.config.sync?.remote_type ?? 'personal'
    // Git sync REPLACES engrams.yaml on the pull/rebase path, so it has to
    // serialize against the write path or it races it (#811 audit, finding 2):
    //
    //   1. writer A takes the store lock and reads corpus N
    //   2. sync B, holding nothing, pulls remote engram R -> the file is N+R
    //   3. writer A appends L to its stale N and saves N+L
    //   4. the shrink guard sees the same COUNT before and after, so it passes
    //   5. the next sync commits and pushes the deletion of R
    //
    // Both operations report success and R is gone. The count-based guard
    // cannot catch this by construction — one row arrived while one row was
    // added — which is why the fix has to be mutual exclusion rather than
    // another validity check.
    //
    // `gitSync` takes no lock of its own (nothing in sync.ts calls withLock),
    // so this cannot self-deadlock against a non-reentrant lock. Held across
    // the network calls deliberately: a waiter blocked for the duration of a
    // fetch is a delay, while a lost engram is permanent. Liveness keeps this
    // lock from being stolen while we hold it, however long the fetch takes.
    //
    // CALLER CONTRACT: `sync()` now acquires the store lock, so it must NOT be
    // called from inside `_withStoreLock`. The in-process queue is FIFO with no
    // timeout — unlike the file lock, which has `acquireTimeout` — so nesting
    // hangs the process rather than erroring. Today's only callers are the
    // `plur_sync` MCP tool and the `plur sync` CLI command, both top-level.
    // (Found by writing this fix's first regression test as a nested call and
    // watching it hang; see async-lock's "NOT REENTRANT" header.)
    const result = await this._withStoreLock(this.paths.engrams, async () => {
      return gitSync(this.paths.root, remote, { remoteType })
    })
    // `git pull --rebase` may have REPLACED engrams.yaml underneath us, so any
    // cached snapshot the store is holding now describes a file that no longer
    // exists in that form. `invalidate()` exists precisely for this and had no
    // caller anywhere in the repo — a cache-invalidation hook that nothing
    // invalidates is a stale read waiting to happen, and this is the one place
    // in the codebase where the bytes change without going through `save()`.
    this._primaryStore.invalidate()
    for (const store of this._secondaryStores.values()) store.invalidate()
    // After git pull, YAML may have changed — refresh the index.
    // PGLite path is the only backend that honors --full directly here; the
    // legacy SQLite path also reindexes on full, otherwise calls syncFromYaml.
    if (options?.full) {
      await this.reindex()
    } else {
      await this._syncIndex()
    }
    return result
  }

  /** Get git sync status without making changes. */
  syncStatus(): SyncStatus {
    return getSyncStatus(this.paths.root)
  }

  /** Count engrams pending remote sync (outbox entries). Must mirror
   *  flushOutbox()'s filter exactly: a retired engram still carrying `_outbox`
   *  (direct YAML edit, older client) is skipped by the flush forever, so
   *  counting it would report a permanent phantom "pending" (#766). */
  async outboxCount(): Promise<number> {
    const engrams = await this._loadCached(this.paths.engrams)
    return engrams.filter(e =>
      (e as any).structured_data?._outbox && e.status !== 'retired'
    ).length
  }

  /**
   * The outbox, as inspectable entries (#667).
   *
   * The outbox works and is effectively invisible: it is not a file or a
   * queue directory, it is `structured_data._outbox` nested inside ordinary
   * engrams in `engrams.yaml`. So a user whose team store was unreachable has
   * queued writes with no supported way to see them — diagnosing meant
   * reverse-engineering the storage model, and the only prose describing the
   * pattern lived inside an engram.
   *
   * `target_url` is DELIBERATELY not returned. It is the one field here that
   * identifies a credentialed endpoint, the entry is rendered into agent
   * context and CLI output, and `target_scope` already answers the question a
   * human is asking ("which store is behind?"). Omitting it at the source
   * beats redacting it at each of the several call sites that print it.
   */
  async listOutbox(): Promise<Array<{
    id: string
    target_scope: string
    queued_at: string
    attempt_count: number
    last_error?: string
    age_days: number
  }>> {
    const engrams = await this._loadCached(this.paths.engrams)
    const now = Date.now()
    const out = []
    for (const e of engrams) {
      const ob = (e as any).structured_data?._outbox as {
        target_scope?: string; queued_at?: string; attempt_count?: number; last_error?: string
      } | undefined
      if (!ob || e.status === 'retired') continue
      const queued_at = typeof ob.queued_at === 'string' ? ob.queued_at : ''
      const queuedMs = queued_at ? Date.parse(queued_at) : NaN
      out.push({
        id: e.id,
        target_scope: ob.target_scope ?? '(unknown)',
        queued_at,
        attempt_count: typeof ob.attempt_count === 'number' ? ob.attempt_count : 0,
        ...(ob.last_error ? { last_error: ob.last_error } : {}),
        // A malformed or missing timestamp reports 0, not NaN: this number is
        // rendered, and NaN in a report reads as a bug in the reporter rather
        // than as the missing data it actually is.
        age_days: Number.isFinite(queuedMs) ? Math.floor((now - queuedMs) / 86_400_000) : 0,
      })
    }
    return out
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
    this._assertWritable()
    const engrams = await this._primaryStore.load()
    // #766: skip retired engrams — a retired engram must not be pushed to the
    // remote and resurrected. The cancel-outbox path in forget() strips _outbox
    // on retirement; this guard is belt-and-suspenders for any path that retires
    // without explicitly cancelling (e.g. direct YAML edits, older client versions).
    const pending = engrams.filter(e =>
      (e as any).structured_data?._outbox && e.status !== 'retired'
    )
    if (pending.length === 0) return { flushed: 0, failed: 0, expired_warnings: [] }

    // #863: push supersedes TARGETS before the engrams that supersede them.
    //
    // The server assigns its own id on flush, so a `supersedes` pointing at a
    // LOCAL id means nothing there and was silently dropped — a correction and
    // the thing it corrected both landed as independent, equally-authoritative
    // records. Worse than a broken link: per the tool contract,
    // supersedes-linked pairs are SKIPPED by tension scans, so dropping the
    // edge both keeps the stale statement live at equal weight AND makes the
    // pair look like a genuine contradiction to the scanner.
    //
    // Both engrams in the reported case were written in one session and queued
    // together, so the mapping is available within this flush — provided the
    // target goes first.
    //
    // A TOPOLOGICAL SORT, not a comparator — see `orderBySupersedes`, which
    // exists as its own module because the defect it replaces was a property
    // of the ALGORITHM (`sort` with a non-transitive comparator) rather than
    // of any store state, and so has to be testable as one.
    const pendingIds = new Set(pending.map(e => e.id))
    const supersedesTargets = (e: Engram): string[] => {
      const rel = (e as any).relations?.supersedes
      return Array.isArray(rel) ? rel.filter((x: unknown): x is string => typeof x === 'string') : []
    }
    const ordered = orderBySupersedes(pending, supersedesTargets)
    pending.length = 0
    pending.push(...ordered)
    /**
     * local id -> server-assigned id.
     *
     * Seeded from the PERSISTED map so an edge whose target left in an earlier
     * flush still resolves; a mapping is only trusted for the host that
     * produced it, since server ids are per-store. Grown as this flush
     * proceeds, and written back at the end.
     */
    const persistedIdMap = this._readOutboxIdMap()
    const localToServer = new Map<string, string>()
    let idMapDirty = false

    let flushed = 0
    let failed = 0
    let skipped = 0
    /** Warn once per host, not once per queued engram (#785). */
    const cooldownSkippedHosts = new Set<string>()
    /**
     * Engrams this flush DEMOTED to local/private on a policy change.
     *
     * Tracked explicitly because the merge-back applies fields, not rows: a
     * demotion changes `scope` and `visibility` as well as the structured-data
     * markers, and those two are ordinary engram fields that a concurrent
     * `rescope` also writes. Carrying them for every survivor would revert
     * that; carrying them only for the ids this flush actually demoted does
     * not.
     */
    const demotedIds = new Set<string>()
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
      // #785: consult the per-host breaker the RECALL leg maintains before
      // spending a full fetch timeout on a host already known to be down.
      //
      // Without this, N queued engrams for an unreachable host cost N
      // sequential timeouts on EVERY session start — and those failures never
      // fed back, so the recall leg learned nothing from them either. Two legs,
      // one host, two independent opinions about whether it is reachable.
      //
      // Skipping leaves the engrams queued: the outbox already retries on the
      // next flush, and the breaker's own cooldown is what decides when that
      // becomes worth attempting.
      // `remoteHealthStatePath()`, explicitly — NOT the default (2026-08-13
      // panel). The default is `remoteHealthPath()`, which resolves from
      // PLUR_PATH; the recall leg passes `this.remoteHealthStatePath()`, which
      // resolves from `paths.root`. For `new Plur({ path })`, `plur --path`,
      // and every embedded consumer those are DIFFERENT FILES, so the two legs
      // kept two independent opinions about whether a host is reachable —
      // which is exactly the split #785 exists to close, reintroduced one
      // level down. Measured: recall wrote plur-store-…/cache/remote-health.json
      // while the write leg wrote plur-env-…/cache/remote-health.json. #785's
      // test set PLUR_PATH and `path` to the same directory, the one
      // configuration in which the bug is invisible.
      const healthPath = this.remoteHealthStatePath()
      const cooldown = isHostInCooldown(storeEntry.url!, Date.now(), healthPath)
      if (cooldown.inCooldown) {
        if (!cooldownSkippedHosts.has(storeEntry.url!)) {
          cooldownSkippedHosts.add(storeEntry.url!)
          const secs = Math.max(1, Math.ceil(((cooldown.until ?? 0) - Date.now()) / 1000))
          expired_warnings.push(
            `${storeEntry.url}: skipped — ${cooldown.reason === 'rate_limit' ? 'rate-limited' : 'circuit breaker open'}, `
            + `retrying in ~${secs}s. Queued engrams stay queued.`,
          )
        }
        skipped++
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
          demotedIds.add(engram.id)
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

      // #863: rewrite supersedes to the DESTINATION's ids before pushing.
      //
      // Three cases, and they are not the same:
      //   - target already flushed in THIS run -> remap to its server id.
      //   - target is a live LOCAL engram that was never destined for this
      //     remote -> the edge is inherently unrepresentable there. Strip it and
      //     say so, rather than blocking a legitimate write forever.
      //   - target is neither -> refuse. Pushing a half-record is what produced
      //     two live contradictory statements in the first place, and the issue
      //     asks for a loud failure over a silent drop.
      const targets = supersedesTargets(cleanEngram as Engram)
      if (targets.length > 0) {
        const remapped: string[] = []
        let refuse: string | null = null
        for (const t of targets) {
          const server = localToServer.get(t)
            ?? (persistedIdMap[t]?.url === storeEntry.url ? persistedIdMap[t].server_id : undefined)
          if (server) { remapped.push(server); continue }
          const localTarget = engrams.find(e => e.id === t)
          if (localTarget && !pendingIds.has(t)) {
            expired_warnings.push(
              `${engram.id}: supersedes ${t}, which lives only in the local store — that edge cannot be `
              + `represented on ${storeEntry.url} and was dropped from the pushed copy. The local record keeps it.`,
            )
            continue
          }
          refuse = t
          break
        }
        if (refuse) {
          expired_warnings.push(
            `${engram.id}: NOT pushed — it supersedes ${refuse}, which could not be resolved in `
            + `"${outbox.target_scope}". Pushing it would create two live, equally-authoritative records `
            + `for the same fact, and tension scans skip supersedes-linked pairs so nothing would flag it. `
            + `Still queued; flush again once ${refuse} has been pushed.`,
          )
          failed++
          continue
        }
        const sd = (cleanEngram as any).relations ?? {}
        ;(cleanEngram as any).relations = { ...sd, supersedes: remapped }
      }

      try {
        const pushed = await driver.appendAndGetServerId(cleanEngram)
        // #863: remember the mapping so a later engram in this same flush can
        // point at the server id rather than the local one.
        if (pushed?.id) {
          localToServer.set(engram.id, pushed.id)
          persistedIdMap[engram.id] = { server_id: pushed.id, url: storeEntry.url!, at: Date.now() }
          idMapDirty = true
        }
        // #785: a write success clears the host's failure count for BOTH legs.
        recordWriteOutcome(storeEntry.url!, true, Date.now(), this.remoteHealthStatePath())
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
        // #785: and a write failure counts toward the same breaker, so a host
        // that only ever fails on writes still opens one.
        recordWriteOutcome(storeEntry.url!, false, Date.now(), this.remoteHealthStatePath())
        failed++
        logger.warning(`[plur:outbox] retry failed for ${engram.id}: ${(err as Error).message}`)
      }
    }

    // Write back changes (removals + updated outbox metadata).
    //
    // MERGED into a fresh authoritative read rather than writing back the array
    // loaded at the top of this method. That array is a snapshot taken BEFORE a
    // series of network round-trips to remote stores, and `_writeEngrams`
    // replaces the whole corpus — so writing it back deletes every engram any
    // other code path (or any other process) created while the flush was in
    // flight. On a slow or unreachable remote that window is seconds long.
    //
    // Only engrams that were in the outbox are touched: `pending` is exactly
    // the set this method considered, so anything outside it is carried through
    // from the fresh read untouched.
    //
    // And within those, only the FIELDS this flush changed are applied — the
    // survivor row is not swapped in wholesale (2026-08-13 data-loss audit,
    // F4). The survivor is a snapshot taken before the network round-trips, so
    // replacing the fresh row with it reverts anything that happened to that
    // engram meanwhile: a feedback counter, an activation bump from a recall,
    // a pin, a local rescope. The flush only ever mutates outbox metadata, the
    // demotion marker, and (for a demotion) scope/visibility — so those are
    // what it writes back, and nothing else.
    if (flushed > 0 || failed > 0) {
      const consideredIds = new Set(pending.map(e => e.id))
      const survivorsById = new Map(
        engrams.filter(e => consideredIds.has(e.id)).map(e => [e.id, e] as const),
      )
      await this._withStoreLock(this.paths.engrams, async () => {
        const fresh = await this._storeAt(this.paths.engrams).load()
        const merged = fresh
          // Drop the ones this flush successfully pushed (remote now owns them).
          .filter(e => !(consideredIds.has(e.id) && !survivorsById.has(e.id)))
          .map(e => {
            const survivor = survivorsById.get(e.id)
            if (!survivor) return e
            const sSd = (survivor as any).structured_data as Record<string, unknown> | undefined
            const fSd = { ...((e as any).structured_data as Record<string, unknown> | undefined ?? {}) }
            // `_outbox` and `_demoted` are the flush's own bookkeeping: copy
            // them across (including their ABSENCE, which is how a cancelled
            // or demoted queue entry is expressed), and leave every other key
            // of the fresh row alone.
            for (const key of ['_outbox', '_demoted'] as const) {
              if (sSd && key in sSd) fSd[key] = sSd[key]
              else delete fSd[key]
            }
            return {
              ...e,
              // A demotion is the one case where the flush changes ordinary
              // engram fields, so those are carried for exactly those ids.
              ...(demotedIds.has(e.id) ? { scope: 'local', visibility: 'private' } : {}),
              structured_data: Object.keys(fSd).length > 0 ? fSd : undefined,
            } as Engram
          })
        // The dropped engrams are the ones the remote accepted — a deliberate
        // handoff, not a loss (audit #794 shrink guard).
        await this._writeEngrams(this.paths.engrams, merged, { allowShrink: true })
      })
      await this._syncIndex()
    }

    // Persist the id map LAST, and only if something was pushed. Writing it
    // before the store write-back would leave a mapping for an engram whose
    // local removal had not landed; writing it unconditionally would rewrite
    // the file on every no-op flush.
    if (idMapDirty) this._writeOutboxIdMap(persistedIdMap)

    return { flushed, failed, expired_warnings }
  }

  /**
   * Promote an episode to an episodic engram (SP2 Idea 3).
   * Creates a new engram with memory_class='episodic' from an episode's summary.
   */
  async episodeToEngram(episodeId: string, context?: Omit<LearnContext, 'memory_class'>): Promise<Engram> {
    const episodes = queryTimeline(this.paths.episodes)
    const episode = episodes.find(e => e.id === episodeId)
    if (!episode) throw new Error(`Episode not found: ${episodeId}`)

    const engram = await this.learn(episode.summary, {
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
    this._assertWritable()
    const engram = await this.getById(engramId)
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
          const localResult = await this._withStoreLock(this.paths.engrams, async () => {
            const engrams = await this._primaryStore.load()
            const idx = engrams.findIndex(e => e.id === engramId)
            if (idx === -1) return null

            const raw = engrams[idx] as any
            const oldStatement = raw.statement
            const oldVersion = raw.engram_version ?? 1

            raw.statement = improved.trim()
            // #852: the hash MUST follow the statement.
            //
            // This was the one statement-mutation path that did not recompute
            // it — learn-async's UPDATE and MERGE both do. A stale hash is not
            // cosmetic: `_hashDedup` matches on `content_hash`, so an engram
            // whose hash still describes its PRE-evolution text becomes an
            // attractor. A later write matching that old text hash-matches this
            // engram, which now says something else, and `_recordDuplicate`
            // absorbs the write into it — silently, since the engram is
            // returned as if it were the write's own. Measured on a real store:
            // 38 engrams carrying a hash that no longer matched their
            // statement, and one pair of distinct engrams sharing a hash.
            raw.content_hash = computeContentHash(raw.statement)
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

            await this._writeEngrams(this.paths.engrams, engrams)
            await this._syncIndex()

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
            await this._withStoreLock(this.paths.engrams, async () => {
              const engrams = await this._primaryStore.load()
              const idx = engrams.findIndex(e => e.id === engramId)
              if (idx !== -1) {
                const raw = engrams[idx] as any
                if (!raw.episode_ids) raw.episode_ids = []
                raw.episode_ids.push(episode.id)
                await this._writeEngrams(this.paths.engrams, engrams)
                await this._syncIndex()
              }
            })
            return { engram, episode, evolved: false, blocked: true }
          }
          // Neither local nor remote had it — defensive fallback (should not
          // happen since getById succeeded at top of function).
          throw new Error(`Engram not found in any store: ${engramId}`)
        }
      } catch (err) {
        // The `try` above spans the LLM call AND the local/remote writes that
        // follow it, so a bare `catch` here reclassifies a genuine store
        // failure as "the LLM was unavailable" — swallowed, unlogged, and
        // reported to the caller as a successful not-evolved outcome. A write
        // that failed must not look like a model that declined.
        //
        // Not rethrown: this path's contract is best-effort evolution, and the
        // fallback below still links the failure episode. But it says so.
        logger.warning(
          `[plur] reportFailure: could not evolve ${engramId} — ${(err as Error).message}. `
          + `Falling back to linking the failure episode without rewriting.`,
        )
      }
    }

    // Fallback: link failure episode to engram without rewriting
    await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const idx = engrams.findIndex(e => e.id === engramId)
      if (idx !== -1) {
        const raw = engrams[idx] as any
        if (!raw.episode_ids) raw.episode_ids = []
        raw.episode_ids.push(episode.id)
        await this._writeEngrams(this.paths.engrams, engrams)
        await this._syncIndex()
      }
    })

    const updated = await this.getById(engramId)
    return { engram: updated ?? engram, episode, evolved }
  }

  /** Return system health info. */
  async status(options?: { created_after?: string; domain?: string }): Promise<StatusResult> {
    // Every artifact this diagnostic reads is behind a refuse-on-corrupt loader,
    // and a diagnostic must REPORT a broken artifact rather than die on it
    // (audit 2026-08-03, finding 6). Each is isolated so one bad file cannot
    // suppress the rest of the report — which is the information an operator
    // needs precisely when one file IS bad.
    const storeErrors: Record<string, string> = {}
    const readOr = <T>(name: string, read: () => T, fallback: T): T => {
      try {
        return read()
      } catch (err) {
        storeErrors[name] = (err as Error).message
        return fallback
      }
    }
    const readOrAsync = async <T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await read()
      } catch (err) {
        storeErrors[name] = (err as Error).message
        return fallback
      }
    }
    // The corpus itself included: if engrams.yaml is the broken file, a thrown
    // status is the least useful possible response to "what is wrong?".
    const engrams = await readOrAsync('engrams', () => this._loadAllEngrams(), [] as Engram[])
    const episodes = readOr('episodes', () => queryTimeline(this.paths.episodes), [] as ReturnType<typeof queryTimeline>)
    const packs = readOr('packs', () => listPacks(this.paths.packs), [] as ReturnType<typeof listPacks>)

    let active = engrams.filter(e => e.status !== 'retired')
    if (options?.domain) {
      active = active.filter(e => e.domain?.startsWith(options.domain!))
    }
    if (options?.created_after) {
      // Validated, not trusted (#547). The comparison below is LEXICOGRAPHIC
      // against a `YYYY-MM-DD` stamp, which is exactly right for a well-formed
      // date and silently wrong for anything else: "last week" sorts after
      // every real date and returns 0, "2026-13-99" sorts after December and
      // does the same. A caller typo produced a confident, quietly wrong count
      // — the one failure a diagnostic must not have.
      //
      // Reuses `normalizeIsoDate` rather than adding a second date rule: it
      // already rejects both malformed shapes and impossible calendar dates
      // (2026-02-30), and one definition means the two cannot disagree.
      const cutoff = normalizeIsoDate(options.created_after)
      if (!cutoff) {
        throw new TypeError(
          `plur.status: created_after must be an ISO date (YYYY-MM-DD), got "${options.created_after}". `
          + `Dates are compared as strings, so a malformed value would return a silently wrong count.`,
        )
      }
      active = active.filter(e => { const d = engramDate(e); return d !== undefined && d >= cutoff })
    }
    const lockedCount = active.filter(e => (e as any).commitment === 'locked').length
    // #181 (audit #213 C2): tension_count counts UNRESOLVED persisted
    // tension records — the LLM-validated detector's output — instead of
    // relations.conflicts, which post-#138 holds only unvalidated importer
    // heuristics (or nothing, post-purge).
    const unresolvedTensions = readOr(
      'tensions',
      () => this.listTensions({ status: ['detected', 'confirmed'] }).length,
      0,
    )

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
      outbox_count: await readOrAsync('outbox', () => this.outboxCount(), 0),
      history_events: readOr('history', () => countInjectionEvents(this.paths.root), undefined as any),
      ...(this._lastIndexError ? { index_error: this._lastIndexError } : {}),
      ...(Object.keys(storeErrors).length > 0 ? { store_errors: storeErrors } : {}),
      // Back-compat alias for the field this replaced.
      ...(storeErrors.packs ? { pack_registry_error: storeErrors.packs } : {}),
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
  async receipt(options?: { days?: number; now?: Date }): Promise<Receipt> {
    const primary = (await this._loadCached(this.paths.engrams)).filter(e => e.status === 'active')
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
  async recordTensions(pairs: TensionPair[]): Promise<{ records: TensionRecord[]; new_count: number; existing_count: number }> {
    if (pairs.length === 0) return { records: [], new_count: 0, existing_count: 0 }
    const engramById = new Map((await this._loadAllEngrams()).map(e => [e.id, e]))
    return withLock(this.paths.tensions, () => {
      // Quarantined records ride along (audit 2026-08-03, finding 4).
      // `loadTensions` withholds schema-invalid entries by design, and this
      // function rewrites the WHOLE file — so loading valid-only and saving
      // that back permanently deleted them on an unrelated scan. Exactly the F2
      // shape, and exactly the bug `_mutateTension` was fixed for; this call
      // site was missed because the regression test only covered that one.
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
      if (newCount > 0) saveTensions(this.paths.tensions, all, quarantined)
      return { records: out, new_count: newCount, existing_count: existingCount }
    })
  }

  /** Locked mutation of a single tension record by id. */
  private _mutateTension(id: string, mutate: (r: TensionRecord) => void): TensionRecord {
    return withLock(this.paths.tensions, () => {
      // Quarantined records ride along — loadTensions withholds schema-invalid
      // entries, so saving without them would delete them on an unrelated
      // mutation. That is the F2 shape, and this call site is how it would
      // have reappeared after tension-store gained quarantine.
      const { valid, quarantined } = loadTensionsWithQuarantine(this.paths.tensions)
      const record = valid.find(r => r.id === id)
      if (!record) throw new Error(`Tension ${id} not found`)
      mutate(record)
      saveTensions(this.paths.tensions, valid, quarantined)
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
  async resolveTension(id: string, winnerId: string): Promise<{ record: TensionRecord; retired_id: string }> {
    // CLAIM the resolution atomically before retiring anything (#813, audit
    // finding 5). The validation used to be a PRE-LOCK read via listTensions(),
    // and the retire and the tension update were separate critical sections
    // with no revalidation. Two concurrent calls picking OPPOSITE winners both
    // read "unresolved", one retired B and the other retired A, both then wrote
    // a resolved record — and the last write merely chose which of the two
    // RETIRED engrams was labelled the winner.
    //
    // Reproduced before this fix: calls-succeeded=2, active-engrams=0, and the
    // recorded winner was itself retired.
    //
    // Marking the record resolved inside the lock is what makes the claim
    // exclusive: the loser of the race now sees status 'resolved' and throws
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
      if (winnerId !== r.engram_a && winnerId !== r.engram_b) {
        throw new Error(`Winner ${winnerId} is not part of tension ${id} (${r.engram_a} vs ${r.engram_b})`)
      }
      loserId = winnerId === r.engram_a ? r.engram_b : r.engram_a
      previous = { status: r.status, resolved_by: r.resolved_by, resolved_at: r.resolved_at }
      r.status = 'resolved'
      r.resolved_by = winnerId
      r.resolved_at = new Date().toISOString()
      saveTensions(this.paths.tensions, valid, quarantined)
      return { ...r }
    })

    // Retire the loser. If that fails, release the claim so the operation can
    // be retried rather than leaving a resolved tension whose loser is alive.
    try {
      const retired = await this._retireEngramForResolution(loserId, `tension ${id} resolved in favor of ${winnerId}`)
      if (!retired) throw new Error(`Cannot retire losing engram ${loserId} (not found in a writable local store)`)
    } catch (err) {
      // Cast: TS cannot see that the closure above ran before this catch, so
      // it narrows `previous` to never.
      const prev = previous as Pick<TensionRecord, 'status' | 'resolved_by' | 'resolved_at'> | null
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
  }

  /**
   * Unconditional retirement for tension resolution. Unlike forget(), does
   * NOT decrement write_count — the user explicitly adjudicated this
   * engram as the losing side, so a multiply-learned loser must still die
   * (audit #213 §2: "a user who resolved a tension by forgetting the loser
   * may find it still active").
   */
  private async _retireEngramForResolution(id: string, reason: string): Promise<boolean> {
    const stamp = (engram: Engram): void => {
      engram.status = 'retired'
      if (!engram.rationale) engram.rationale = `Retired: ${reason}`
    }
    const foundInPrimary = await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false
      stamp(engram)
      await this._writeEngrams(this.paths.engrams, engrams)
      await this._syncIndex()
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
        appendHistory(this.paths.root, {
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
   * new engram still records the intent. Mutates in place and RETURNS the
   * targets it actually changed: on the incremental write path (#740) the
   * new engram is appended on its own, so the caller must persist these
   * mutated rows explicitly via `_updateEngrams` — a whole-corpus fallback
   * save carries them implicitly, a targeted `append` does not.
   */
  private _writeSupersededByEdges(engrams: Engram[], targetIds: string[], newId: string): Engram[] {
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
  }

  /**
   * Remove all conflict relations from every local engram.
   * Used after tension-detection redesign to clear accumulated false positives.
   */
  async purgeTensions(): Promise<{ purged_count: number; engrams_modified: number; stores_cleaned: number }> {
    this._assertWritable()
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
        // This was an unlocked read-modify-write over a CACHED snapshot that
        // rewrites the entire store — the shape `PrimaryStore` documents as
        // wrong: `load()` is the authoritative read "used inside write
        // transactions where a stale snapshot would lose data", `loadCached()`
        // is not. Being synchronous made it accidentally atomic before the
        // async flip; afterwards it has real suspension points between the read
        // and the write, and it is started un-awaited from the constructor, so
        // it can overlap the caller's very first learn and overwrite it.
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
    // Same `.partial()`-neutralised-default rule as the constructor
    // (evaluator audit M4): `config.index` is `undefined` on a default
    // install, and with SQLite now the size-selected tier, a bare truthy
    // check here means the refresh this method exists for (#307 — a store
    // added by editing config.yaml out of process) never reaches
    // indexedStorage on exactly the default installs that have one. Refresh
    // whenever an index is actually active, or config asks for one.
    if (this.indexedStorage !== null || this.config.index) {
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
      // Atomic + fsynced (#813, audit finding 16). A plain writeFileSync
      // truncates in place, and loadConfig turns a parse failure into DEFAULT
      // config — so a crash mid-write silently erases store registrations and
      // routes later writes to the local default store. atomicWrite is
      // tmp + fsync + rename, so a crash leaves the previous complete config.
      atomicWrite(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }), { mode: CONFIG_FILE_MODE })
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
      // #766 heal: a local store registered BEFORE the materialization fix can
      // sit in exactly the broken state this fix closes — config entry exists,
      // file absent — and re-running stores_add with the same path is the
      // natural post-upgrade repair. Run the same init block on the idempotent
      // re-add so it actually heals (and the MCP "Store initialized" note is
      // truthful on this path too). Idempotent and cheap when the file exists.
      if (!isRemote) this._materializeLocalStore(storePath)
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
    // Filesystem stores: initialize the file now so the path materializes
    // immediately. Fail loudly if the path is unwritable — better than
    // silently landing writes in the primary store when the file never
    // exists (#766).
    if (!isRemote) this._materializeLocalStore(storePath)

    const stores = scopeConflict
      ? [...(config.stores ?? []).filter(s => s.scope !== scope), newEntry]
      : [...(config.stores ?? []), newEntry]
    this.persistStores(stores)
    return { status: scopeConflict ? 'overwritten' : 'added', scope }
  }

  /**
   * Materialize a filesystem store file if absent — the existsSync→write
   * sequence runs under the store's own `<path>.lock` file so it cannot race
   * a concurrent writer or a second registration and clobber their content
   * (store-write convention; see `_withStoreLock`). `addStore` is sync and
   * reachable from the constructor via `autoDiscoverStores`, so this takes
   * the SAME lock file via the sync `withLock` rather than the async
   * `_withStoreLock`. Parent dirs are created up front — the lock file lives
   * next to the store file (this used to be atomicWrite's job).
   */
  private _materializeLocalStore(storePath: string): void {
    try {
      const dir = dirname(storePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      withLock(storePath, () => {
        if (!fs.existsSync(storePath)) initFilesystemStore(storePath)
      })
    } catch (err) {
      throw new Error(
        `addStore: cannot initialize store at "${storePath}": ${(err as Error).message}`,
      )
    }
  }

  /**
   * Auto-discover .plur/engrams.yaml in CWD and parent dirs (up to git root).
   * If found and not already registered, auto-register as a project store.
   * Returns list of newly discovered stores (empty if none found or all already known).
   */
  /**
   * Resolve whether constructor-time discovery should run.
   *
   * Explicit option wins; otherwise `PLUR_AUTO_DISCOVER=0` / `=false` disables
   * it. The env var exists so a deployment that does not own the construction
   * call site (an embedded consumer, a wrapper binary) can still turn off a
   * cwd-derived disk side effect it never asked for.
   */
  static resolveAutoDiscover(explicit?: boolean): boolean {
    if (explicit !== undefined) return explicit
    const env = process.env.PLUR_AUTO_DISCOVER
    if (env === '0' || env === 'false') return false
    return true
  }

  /** Whether this instance ran (and would re-run) cwd store discovery. */
  autoDiscoveryEnabled(): boolean {
    return this._autoDiscover
  }

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
  private async _primaryStoreRow(): Promise<StoreSummary> {
    return {
      path: this.paths.engrams,
      scope: 'global',
      shared: false,
      readonly: false,
      engram_count: (await this._loadCached(this.paths.engrams)).filter(e => e.status !== 'retired').length,
    }
  }

  /**
   * @deprecated Use {@link listStoresAsync} for accurate remote engram counts.
   * The sync variant reads only the remote drivers' in-memory peek cache,
   * which no longer self-populates (#776 removed the background refresh): a
   * remote store's engram_count stays 0 on EVERY call — not just the first
   * (issue #184) — until something explicitly warms the cache
   * (`warmRemoteCaches()`, e.g. via session_start). Retained for callers
   * that cannot await.
   */
  async listStores(): Promise<Array<StoreSummary>> {
    this.reloadConfigIfChanged()  // pick up out-of-process config edits (#307)
    const stores = this.config.stores ?? []
    const additional = stores.map(async s => {
      let count = 0
      if (s.url) {
        try { count = this._loadRemoteCached(s).filter(e => e.status !== 'retired').length } catch {}
      } else if (s.path) {
        try { count = (await this._loadCached(s.path)).filter(e => e.status !== 'retired').length } catch {}
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
    return [await this._primaryStoreRow(), ...(await Promise.all(additional))]
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
        try { count = (await this._loadCached(s.path)).filter(e => e.status !== 'retired').length } catch {}
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
    return [await this._primaryStoreRow(), ...(await Promise.all(additional))]
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
   *
   * Public since #776 (was private) so the remote-recall leg's callers and
   * tests can enumerate endpoint identity — but note recall dialing groups by
   * (url, token) via `_remoteRecallHosts`, NOT by url alone: this method's
   * first-token-wins collapse is only safe for probes (`/me`, health) where
   * any of the tokens answers the identity question.
   */
  _distinctRemoteEndpoints(): Array<{ url: string; token?: string }> {
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
   *  `stores.filter(s => s.url === url)`. Public since #776 (was private) for
   *  the remote-recall leg's callers and tests. */
  _storesForEndpoint(url: string): StoreEntry[] {
    const key = normalizeEndpointUrl(url)
    return (this.config.stores ?? []).filter(s => s.url !== undefined && normalizeEndpointUrl(s.url) === key)
  }

  /**
   * Distinct (url, token) groups among the configured remote stores (#587) —
   * the AUTH-identity counterpart of {@link _distinctRemoteEndpoints}. Same
   * `::` composite key as `_remoteRecallHosts` (#776): two entries on one URL
   * with DIFFERENT tokens are two distinct credentials with independent
   * validity, so token-status surfaces must report them separately rather
   * than letting first-token-wins mask a dead second token. URL identity is
   * normalized ({@link normalizeEndpointUrl}); the first-configured spelling
   * is reported. `scopes` lists the group's registered scopes in config order.
   */
  remoteEndpointTokenGroups(): Array<{ url: string; token?: string; scopes: string[] }> {
    const groups = new Map<string, { url: string; token?: string; scopes: string[] }>()
    for (const s of this.config.stores ?? []) {
      if (!s.url) continue
      const key = `${normalizeEndpointUrl(s.url)}::${s.token ?? ''}`
      let g = groups.get(key)
      if (!g) { g = { url: s.url, token: s.token, scopes: [] }; groups.set(key, g) }
      if (!g.scopes.includes(s.scope)) g.scopes.push(s.scope)
    }
    return [...groups.values()]
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
   * Probe each configured remote credential's auth/reachability (#295) by
   * calling `GET /api/v1/me` (raced against a timeout), combined with a local
   * JWT-expiry read. Distinguishes 'auth_expired' (token rejected or JWT exp
   * passed → reauth) from 'unreachable' (network/timeout/5xx). Read-only; one
   * bad endpoint never affects the others. Powers `plur_doctor`'s remote check
   * and `plur login --status` (#587), so neither reports "healthy" when the
   * remote auth is dead.
   *
   * Probes per distinct (url, token) group ({@link remoteEndpointTokenGroups}),
   * not per URL (#587): each token's validity is independent, and the old
   * first-token-wins collapse reported a URL as ok while its second configured
   * token was expired. Also surfaces display-only JWT claims (`tokenSubject`,
   * `tokenOrg` — unverified) and, on a successful probe, the server-confirmed
   * `username`/`orgId`/`grantedScopes` from `/me`.
   */
  async checkRemoteHealth(opts?: { timeoutMs?: number }): Promise<RemoteHealth[]> {
    const timeoutMs = opts?.timeoutMs ?? 5000
    // Decode the token that is on DISK now, not the one read at construction
    // (#307/#864). Reporting "expires in 4d" from a 13-day-old in-memory copy
    // of a credential the user rotated hours ago sends them to fix the server.
    this.reloadConfigIfChanged()
    const groups = this.remoteEndpointTokenGroups()
    return Promise.all(groups.map(async ({ url, token, scopes }) => {
      const exp = decodeJwtExpiry(token)
      const payload = decodeJwtPayload(token)
      const subject = typeof payload?.sub === 'string' ? payload.sub : undefined
      const orgClaim = [payload?.orgId, payload?.org_id, payload?.org]
        .find((v): v is string => typeof v === 'string')
      const expiryFields = {
        tokenExpiresAt: exp.expiresAt ? exp.expiresAt.toISOString() : undefined,
        tokenExpiresInDays: exp.expiresInDays,
        ...(subject !== undefined ? { tokenSubject: subject } : {}),
        ...(orgClaim !== undefined ? { tokenOrg: orgClaim } : {}),
      }
      // A JWT we can already see is expired → don't bother probing; it's auth_expired.
      if (exp.expired) {
        return { url, scopes, status: 'auth_expired' as const, ok: false,
          reason: `token expired ${exp.expiresAt?.toISOString() ?? ''}`.trim(), ...expiryFields }
      }
      try {
        const driver = this._getRemoteDriver({ url, token, scope: scopes[0] ?? '' })
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        const me = await Promise.race([
          driver.me().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(`/me timeout (${timeoutMs}ms)`)), timeoutMs)
          }),
        ])
        // A host that just answered /me is not unreachable — retire any cached
        // network-class recall failure for it rather than reporting both (#864).
        this.noteRemoteHostReachable(url)
        return { url, scopes, status: 'ok' as const, ok: true,
          ...(me.username ? { username: me.username } : {}),
          ...(me.org_id ? { orgId: me.org_id } : {}),
          grantedScopes: me.scopes.length,
          ...expiryFields }
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
  // Synchronous. An automated add-awaits pass made this `async` during the
  // Phase 2 flip even though it does no async work — every call in its body
  // is synchronous. Reverted: 0.16.0 is unreleased, so this method was never
  // actually breaking, and leaving it async would have been a breaking
  // signature change that bought nothing. Shrinking the migration surface is
  // worth more than uniformity.
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
  // Synchronous. An automated add-awaits pass made this `async` during the
  // Phase 2 flip even though it does no async work — every call in its body
  // is synchronous. Reverted: 0.16.0 is unreleased, so this method was never
  // actually breaking, and leaving it async would have been a breaking
  // signature change that bought nothing. Shrinking the migration surface is
  // worth more than uniformity.
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
      // Atomic + fsynced (#813, audit finding 16). A plain writeFileSync
      // truncates in place, and loadConfig turns a parse failure into DEFAULT
      // config — so a crash mid-write silently erases store registrations and
      // routes later writes to the local default store. atomicWrite is
      // tmp + fsync + rename, so a crash leaves the previous complete config.
      atomicWrite(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }), { mode: CONFIG_FILE_MODE })
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

  /**
   * Set a session-level default scope — the fallback in learn/learnRouted when
   * no explicit scope is provided.
   *
   * Omit `session` and this sets the process-wide slot, exactly as before: one
   * session per instance, one scope. That is right for the CLI and for an MCP
   * server handling one session at a time.
   *
   * Pass `session` and the scope is isolated to that session key. Any
   * deployment where one `Plur` serves concurrent sessions MUST do this and
   * thread the same key through `LearnContext.session` — otherwise the scope is
   * a single shared field, and a `setSessionScope` from one session decides
   * where another session's in-flight write lands. Passing `null` for a keyed
   * session pins it to "no session scope" (unscoped writes auto-route), which
   * is distinct from never having registered it (inherits the process slot).
   */
  setSessionScope(scope: string | null, opts?: { session?: string }): void {
    this._sessionScopes.set(scope, opts?.session)
  }

  /**
   * Adjust the session default scope MID-session (#243) — `setSessionScope`
   * plus observability: appends a `session_scope_changed` history event so the
   * scope active at any point in a session can be reconstructed retrospectively
   * (which scope routed a given engram, whether an agent oscillates scopes).
   *
   * `setSessionScope` stays the raw, silent primitive — session bootstrap
   * (every `plur_session_start`) uses it without flooding history; deliberate
   * mid-session changes go through here. Same registry, same keying rules:
   * omit `session` for the process slot, pass it for per-session isolation
   * (ADR-0004 — one `Plur` serving concurrent sessions MUST key).
   *
   * Returns the previous and new effective scope for the targeted slot.
   */
  adjustSessionScope(
    scope: string | null,
    opts?: { session?: string; reason?: string; trigger?: 'set' | 'clear' },
  ): { previous: string | null; next: string | null } {
    const previous = this._sessionScopes.get(opts?.session)
    this._sessionScopes.set(scope, opts?.session)
    appendHistory(this.paths.root, {
      event: 'session_scope_changed',
      engram_id: '', // session-level event — no engram (see HistoryEvent doc)
      timestamp: new Date().toISOString(),
      data: {
        previous,
        next: scope,
        ...(opts?.trigger ? { trigger: opts.trigger } : {}),
        ...(opts?.reason ? { reason: opts.reason } : {}),
        ...(opts?.session ? { session_id: opts.session } : {}),
      },
    })
    return { previous, next: scope }
  }

  /**
   * Get the session-level default scope for `opts.session`, or the process-wide
   * one when no session is named. Returns null if not set.
   */
  getSessionScope(opts?: { session?: string }): string | null {
    return this._sessionScopes.get(opts?.session)
  }

  /**
   * Forget a session's scope registration. Call on session end: a long-lived
   * deployment would otherwise retain one entry per session it has ever served.
   * Omitting `session` clears the process-wide slot.
   */
  clearSessionScope(opts?: { session?: string }): void {
    this._sessionScopes.clear(opts?.session)
  }

  /** Session keys with their own scope registration. Diagnostic / test seam. */
  trackedSessionScopes(): string[] {
    return this._sessionScopes.trackedSessions
  }
}
