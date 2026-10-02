import * as fs from 'fs'
import { randomUUID, createHash } from 'crypto'
import { tmpdir, hostname } from 'os'
import { join, dirname, basename } from 'path'
import yaml from 'js-yaml'
import { collapseLineTerminators } from './sanitize.js'
import { detectPlurStorage, type PlurPaths } from './storage.js'
import { IndexedStorage } from './storage-indexed.js'
import { PGLiteAdapter } from './storage-pglite.js'
import { loadConfig } from './config.js'
import { canonicalize } from './project-config.js'
import { classifyStoreDuplicates, removePrimaryStoreEntries } from './store-duplicates.js'
import { generateEngramId, engramIdDatePrefix, loadAllPacks, storePrefix, namespaceEngramId, bareEngramId, initFilesystemStore } from './engrams.js'
import { maybeDailyBackup } from './backup.js'
import { logger } from './logger.js'
import { searchEngrams, ftsTokenize, extendCorpusStats, searchTextFrom } from './fts.js'
import { selectAndSpread, scoreEngramsPublic, formatWithLayer, assignLayer, estimateTokens, pinnedHardCap, isHardPinned, DEFAULT_PINNED_HARD_RATIO } from './inject.js'
import { reactivate } from './decay.js'
import { captureEpisode, queryTimeline } from './episodes.js'
import { agenticSearch } from './agentic-search.js'
import { embeddingSearch, embeddingSearchWithScores, type SimilarityResult } from './embeddings.js'
import { applyFeedbackSignal, type FeedbackSource } from './feedback.js'
import { hybridSearch, hybridSearchWithMeta, applyReranker, rrfMergeEngrams as pgliteRrfMerge, type HybridSearchResult, type RerankOptions } from './hybrid-search.js'
import { getReranker, resolveRerankerName, isRerankerOff, rerankerStatus, resetRerankerStatus, _resetRerankerCache, type RerankerAdapter, type RerankerRuntimeStatus, type RerankerName } from './rerankers/index.js'
import { checkRerankerFit, type FitCheckResult } from './rerankers/fit-check.js'
import { runRerankerSelfEval, loadRerankerEvalCache, saveRerankerEvalResult, isRerankerEvalStale, logRerankerEvalAdvisory, type RerankerEvalResult } from './reranker-eval.js'
import { _resetCrossEncoderCaches } from './rerankers/transformers-cross-encoder.js'
import { classifyQuery, routeForIntent, applyIntentRouting, isIntentRoutingDisabled, isEntityDomain, rewriteLexicalQuery, isQueryRewriteDisabled, type QueryIntent, type IntentRoutingProfile } from './intent/index.js'
import { getEmbedder, resolveEmbedderName } from './embedders/index.js'
import { emitMissSignal } from './telemetry-miss-signal.js'
import { embedderStatus, resetEmbedder, setEmbeddingsEnabled, type EmbedderStatus } from './embeddings.js'
import { expandedSearch } from './query-expansion.js'
import { recallAuto, type AutoSearchResult } from './search-orchestrator.js'
import { autoSummary } from './summary.js'
import { installPack, uninstallPack, listPacks, exportPack, scanPrivacy, computePackHash, previewPack, containsEmail, migratePackIntegrity } from './packs.js'
import type { ExportOptions } from './packs.js'
import { learnContextContent, engramContentFields } from './content-fields.js'
export { LEARN_CONTEXT_FIELD_ROLES, LEARN_CONTENT_FIELDS, learnContextContent, engramContentFields } from './content-fields.js'
// SP5 imports (deferred — vault-export, registry not yet merged)
// import { exportVault, type VaultExportOptions, type VaultExportResult } from './vault-export.js'
// import { fetchRegistry, discoverPacks, verifyPackIntegrity, DEFAULT_REGISTRY_URL, type PackRegistry, type RegistryPack } from './registry.js'
import { atomicWrite, CONFIG_FILE_MODE, sync as gitSync, getSyncStatus, withLock, type SyncResult, type SyncStatus, type SyncRemoteType } from './sync.js'
import { detectSecrets, detectSensitive, detectPromptInjection, sensitivityCategory, SCAN_TRUNCATED } from './secrets.js'
import type { SecretMatch } from './secrets.js'
import { SENSITIVITY_CATEGORIES, type ScopeMetadata, type SensitivityCategory } from './schemas/scope-metadata.js'
import { rankScopes, decideAutoRoute, SCOPE_MATCH_THRESHOLD, type ScopeSignals, type ScopeCandidate, type AutoRouteDecision, type ScopeSource } from './scope-routing.js'
import { mintedIdsWithPrefix, appendHistory, readHistoryForEngram, type HistoryEvent as HistoryEventType, generateEventId, generateInjectionId, computeQueryHash, findLatestInjectionFor, countInjectionEvents, isRecentDuplicateInjection, type InjectionEventCounts } from './history.js'
import { computeContentHash, isHashable } from './content-hash.js'
import { isLocalOnlyScope, assertScopeNamesATarget, personalStoreEntry } from './scope-target.js'
import { orderBySupersedes } from './outbox-order.js'
import { loadTensions, loadTensionsWithQuarantine, saveTensions, generateTensionId, tensionPairKey, categorizeTension } from './tension-store.js'
import type { TensionRecord, TensionStatus } from './schemas/tension.js'
import type { TensionPair } from './tensions.js'
import { engramDate } from './tensions.js'
import { resolveValidity, buildTemporal, normalizeIsoDate, type ResolvedValidity } from './expiry.js'
import { isCurrentlyValid } from './validity.js'
import { decodeJwtExpiry, decodeJwtPayload } from './jwt.js'
import { RemoteStore, RemoteAbortedError, RemoteHttpError, RemoteTimeoutError, normalizeEndpointUrl, FEEDBACK_SOURCE_CAPABILITY } from './store/remote-store.js'
import { classifyOutboxFailure, NEEDS_ACTION_RETRY_MS, NEEDS_ACTION_STATUSES, summarizeOutbox, type OutboxState, type OutboxSummary } from './outbox-health.js'
import { redactToken, containsToken } from './redact-token.js'
import {
  remoteRecall, isRemoteRecallDisabled, resolveRemoteRecallTimeoutMs, scopeOrg,
  REMOTE_STATUS_TTL_MS, PROBE_CLEARABLE_STATES,
  type RemoteRecallHost, type RemoteRecallResult, type HostRecallOutcome, type RemoteStoreStatusEntry, isHostInCooldown, recordWriteOutcome, stampStoreRow} from './remote-recall.js'
import { YamlPrimaryStore } from './store/yaml-primary-store.js'
import { ReadonlyStoreGuard, ReadonlyStoreError } from './store/readonly-store-guard.js'
import { withAsyncLock } from './store/async-lock.js'
import { SessionScopeRegistry, NO_SESSION } from './session-scopes.js'
import type { AsyncPrimaryStore } from './store/primary-store.js'
import { requiresIndexSync, asDerivedIndex } from './storage-adapter.js'
import type { StorageAdapter } from './storage-adapter.js'
import { resolveBackendTier, type BackendSelection } from './backend-selection.js'
import { isSharedScope, isScopeWithin, scopeAllowFilter, makeVisibilityPredicate } from './scope-util.js'
import {
  isDirectoryTrusted as _isDirectoryTrusted,
  trustDirectory as _trustDirectory,
  untrustDirectory as _untrustDirectory,
  listTrustedDirectories as _listTrustedDirectories,
  coveringTrustedAncestor as _coveringTrustedAncestor,
} from './trust.js'
import {
  resolveFolderPolicy as _resolveFolderPolicy,
  loadFolderMap as _loadFolderMap,
  setFolderEntry as _setFolderEntry,
  removeFolderEntry as _removeFolderEntry,
  issueFolderNonce as _issueFolderNonce,
  endFolderNonceSession as _endFolderNonceSession,
  type FolderPolicy,
  type FolderEntry,
  type FolderChange,
  type FolderAnswer,
} from './folders.js'
import type { Engram } from './schemas/engram.js'
import { ATTRIBUTION_UNIDENTIFIED, MeasuredUnderSchema, type MeasuredUnder } from './schemas/engram.js'
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
export { SessionScopeRegistry, NO_SESSION } from './session-scopes.js'
export { AsyncMutex, KeyedAsyncMutex } from './async-mutex.js'
export { pendingStoreLockOps } from './store/async-lock.js'
export { findProjectConfigPath, readProjectConfig, readProjectConfigFromPath, canonicalize, type ProjectConfig } from './project-config.js'
// The trust gate a project's REMOTE settings must pass before an adapter may
// route prompt text to the host they name (#1196/#1198). Lives here, not in
// the CLI, so out-of-package adapters (@plur-ai/opencode) can take the
// capability and the gate together rather than copying one without the other
// (#1207). See project-remote.ts.
export {
  resolveProjectRemote,
  resolveProjectRemoteFromConfig,
  projectRemoteRefusalNotice,
  type ProjectRemote,
  type TrustChecker,
} from './project-remote.js'
// Directory trust (2026-09 audit, D2) — a one-time per-directory grant
// (`plur trust`) an adapter should require before adopting behaviour-changing
// configuration it finds on disk (a `.plur.yaml` scope, say) from a directory
// the user opened but never explicitly vetted. See trust.ts for the model.
export { isDirectoryTrusted, trustDirectory, untrustDirectory, listTrustedDirectories, coveringTrustedAncestor } from './trust.js'
// Folder map (#1347) — the user's on/off/ask, default scope and trust
// decisions per folder, in <PLUR home>/folders.yaml. See folders.ts.
export {
  resolveFolderPolicy,
  folderOffEntries,
  folderMapProblem,
  loadFolderMap,
  saveFolderMap,
  folderMapPath,
  setFolderEntry,
  removeFolderEntry,
  clearFolderTrust,
  coversHomeOrRoot,
  findPlurMarker,
  folderPatternMatches,
  folderPatternSpecificity,
  issueFolderNonce,
  consumeFolderNonce,
  verifyFolderNonce,
  endFolderNonceSession,
  removeLegacyTrustEntry,
  FolderMapError,
  FOLDER_NONCE_TTL_MS,
  safeSessionKey,
  type FolderMode,
  type FolderEntry,
  type FolderMap,
  type FolderPolicy,
  type FolderPolicySource,
  type FolderChange,
  type FolderAnswer,
  type FolderMapErrorCode,
} from './folders.js'
// The one-time folder question and an `on` folder's session settings (#1347),
// shared by the CLI's editor hooks and the opencode plugin. See folder-ask.ts.
export {
  folderAskOnce,
  sessionSettings,
  clearFolderAsk,
  quoted as folderQuoted,
  escapedPath as folderEscapedPath,
  isFolderAskText,
  type FolderAskOptions,
  type FolderAskScopeRanker,
} from './folder-ask.js'
export { generateGuardrails } from './guardrails.js'
// Shared memory system-prompt renderer (opencode plugin's task 1): one
// implementation so @plur-ai/claw and @plur-ai/opencode render the PLUR
// memory block byte-identically instead of each vendoring a copy.
export { renderMemoryBlock, PLUR_MEMORY_INSTRUCTIONS } from './memory-block.js'
export {
  upsertInstructionSection, isShippedText, hasStandaloneMarker, writeWithBackup, backupFile,
  type InstructionSectionOptions, type InstructionSectionResult,
} from './instruction-section.js'
export { SHIPPED_PLUR_SECTIONS, SHIPPED_CURSOR_RULES, SHIPPED_CLAW_SECTIONS } from './instruction-history.js'
// Shared learning-extraction heuristics (opencode plugin's task 6a): one
// implementation so @plur-ai/claw and @plur-ai/opencode derive learning
// candidates identically instead of each vendoring a copy.
export { extractLearnings, extractSelfReportedLearnings, isCorrection, type LearnCandidate, type LearnableMessage } from './learner.js'
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
export { storePrefix, namespaceEngramId, bareEngramId } from './engrams.js'
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
export { isLocalOnlyScope, assertScopeNamesATarget, personalStoreEntry } from './scope-target.js'
export { orderBySupersedes } from './outbox-order.js'
export {
  classifyOutboxFailure, summarizeOutbox, describeNeedsAction, statusFromErrorText,
  NEEDS_ACTION_RETRY_MS, NEEDS_ACTION_STATUSES,
  type OutboxState, type OutboxVerdict, type OutboxSummary, type OutboxFailureInput,
} from './outbox-health.js'
export { RemoteHttpError } from './store/remote-store.js'
export { parseDedupResponse, buildDedupPrompt, buildBatchDedupPrompt } from './dedup.js'
export { runMigrations, rollbackMigrations, getSchemaVersion, setSchemaVersion, ALL_MIGRATIONS, CURRENT_SCHEMA_VERSION, type Migration, type MigrationResult } from './migrations/index.js'
export { detectSecrets, detectSensitive, detectPromptInjection, sensitivityCategory } from './secrets.js'
export { scanForInversions, type InversionSuspect } from './inversion-scan.js'
export { ScopeMetadataSchema, ScopeSensitivitySchema, SENSITIVITY_CATEGORIES, type ScopeMetadata, type ScopeSensitivity, type SensitivityCategory } from './schemas/scope-metadata.js'
export { rankScopes, decideAutoRoute, SCOPE_MATCH_THRESHOLD, WEIGHT_TAG, SUGGEST_DISPLAY_MIN_CONFIDENCE, type ScopeSignals, type ScopeCandidate, type RankScopesOptions, type AutoRouteDecision, type DecideAutoRouteOptions, type ScopeSource } from './scope-routing.js'

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
export { classifyStoreDuplicates, removePrimaryStoreEntries, type IgnoredStoreEntry, type StoreDuplicateReport } from './store-duplicates.js'
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
  type RerankerName, type RerankerRuntimeStatus, type RerankerFailureKind,
} from './rerankers/index.js'
export { checkRerankerFit, type FitCheckResult, type FitCheckEngram } from './rerankers/fit-check.js'
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
export { markRemoteHostDown, remoteHostDownRemainingMs, clearRemoteHostDown, _resetRemoteHostBreaker, salvageRemoteRow, FEEDBACK_SOURCE_CAPABILITY, _resetRemoteCapabilityCache } from './store/remote-store.js'
export { checkForUpdate, settleVersionChecks, getCachedUpdateCheck, clearVersionCache, minorVersionsBehind, VERSION_CHECK_SUCCESS_TTL_MS, VERSION_CHECK_FAILURE_TTL_MS, type VersionCheckResult } from './version-check.js'
export { scanForTensions, getCandidatePairs, getCandidatePairsDetailed, measuredUnderDiffers, measuredUnderGateApplies, engramOrigin, MEASURED_UNDER_DIMENSIONS, MEASURED_UNDER_CONFIDENCE_CAP, type CandidatePairs, scopesOverlap, domainSegmentsOverlap, subjectsOverlap, statementOverlap, buildContradictionPrompt, parseContradictionResponse, buildBatchContradictionPrompt, parseBatchContradictionResponse, engramDate, daysApart, inTemporalDomain, temporalDiscountFactor, SNAPSHOT_CONFIDENCE_CAP, type ContradictionVerdict, type TensionPair, type TensionScanResult, type TensionScanOptions, type TemporalGateOptions, type CandidatePairOptions, type JudgeStatement } from './tensions.js'
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
export { shortPackIntegrity, isTransientPackDir } from './packs.js'
export type { PreviewResult, RegistryEntry, PrivacyScanResult, PrivacyIssue, PackProvenanceView, InstallResult, NeutralizedCounts, PackIntegrityMigrationReport } from './packs.js'
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
  type FeedbackSignal, type FeedbackSource, type ApplyFeedbackOptions,
} from './feedback.js'
// Automatic rating of injected engrams from the reply text (#1310).
export {
  detectInjectionSignal, rateInjectedEngrams, AUTO_FEEDBACK_MIN_CONFIDENCE,
  type InjectionSignal, type InjectionSignalResult, type RatedEngram,
} from './injection-signal.js'
// Client-side token inspection (#295/#587) — expiry + display-only payload
// claims, no signature verification — and the endpoint-identity normalizer,
// so CLI surfaces (login --status) compare hosts the same way the core does.
export { decodeJwtExpiry, decodeJwtPayload, type JwtExpiry } from './jwt.js'
export { normalizeEndpointUrl } from './store/remote-store.js'
export { redactToken, redactTokenDeep, containsToken, tokenForms } from './redact-token.js'

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
  /** Queued writes a retry cannot deliver (401/403/404/422, refusal, no store) (#1299). */
  outbox_needs_action?: number
  /** Present when `outbox_needs_action` > 0: one row per scope and reason, with its next step. */
  outbox_attention?: OutboxSummary['scopes']
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
  /**
   * Spreading-activation association edges dropped since process start, by reason.
   * Accumulates across all `inject()` calls in this process — resets on restart.
   * `dropped_unresolvable`: target id absent from local engramMap (remote-only or
   * deleted engram). `dropped_retired`: target found but not active. Absent when
   * both counts are zero.
   */
  spread_drops?: { dropped_unresolvable: number; dropped_retired: number }
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

/**
 * How long a push claim is honoured when its owner is on ANOTHER host, whose
 * pid cannot be checked: longer than one bounded request (30s). An owner on
 * this host holds its claim while its process is alive (see
 * `_outboxClaimHeld`).
 */
const OUTBOX_CLAIM_LEASE_MS = 60_000

/**
 * Hard cap on a live same-host owner's claim: far above one push's worst case
 * (a 30s request plus the 180s store-lock wait before the merge-back), so it
 * never cuts a real push short, but finite so a recycled pid cannot hold an
 * entry forever.
 */
const OUTBOX_CLAIM_MAX_AGE_MS = 15 * 60_000

/**
 * How many dead takeover markers a claimer walks past before it gives up.
 * Each level is a racer that died inside a critical section a few syscalls
 * long, so reaching this means something is badly wrong; the entry waits.
 */
const OUTBOX_TAKEOVER_MAX_DEPTH = 8

/** id → idempotency key of every row still queued in the outbox (not retired). */
function queuedOutboxKeys(rows: Engram[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  for (const e of rows) {
    const ob = (e as any).structured_data?._outbox
    if (ob && e.status !== 'retired') out.set(e.id, typeof ob.idempotency_key === 'string' ? ob.idempotency_key : undefined)
  }
  return out
}

/** Names one exact claim (or marker) content, for its takeover marker. */
function outboxClaimTag(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** Is this process still running? (`kill 0` probes without signalling.) */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

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

/** Default memory_class per engram type when the caller sets none (SP2 Idea 3). */
const TYPE_TO_MEMORY_CLASS: Record<string, 'semantic' | 'episodic' | 'procedural' | 'metacognitive'> = {
  behavioral: 'semantic',
  terminological: 'semantic',
  procedural: 'procedural',
  architectural: 'semantic',
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

/**
 * The origin block, written only when the caller chose a licence (#970).
 *
 * The block is left off otherwise. A default licence written into every engram
 * would be indistinguishable from one somebody picked, and the whole point of
 * marking defaults is that the difference is visible.
 */
/** How far back a derivation chain is followed before it is truncated. */
const MAX_CHAIN_DEPTH = 32

/**
 * The ancestors of a new engram, nearest first (#958, spec §4.1).
 *
 * `chain` was the last of the four origin fields that nothing ever wrote — not
 * read anywhere, not written anywhere, for the whole life of the schema.
 *
 * It is a SHORTCUT, not the truth. Section 2.1 of the profile is explicit that
 * where the shortcut and the history log disagree, the log wins. It exists so a
 * reader can see the lineage without walking a log they may not have — which is
 * exactly the case for a portable record.
 *
 * `supersedes` comes before `derived_from` because a replacement is the nearer
 * relationship: engram C that replaces B, which was derived from A, has B as its
 * immediate ancestor.
 *
 * The walk is bounded and cycle-guarded. Neither should happen — supersession is
 * acyclic by construction — but a chain built from store data that a user can
 * edit by hand has no business hanging on a loop somebody typed.
 */
function buildChain(
  context: LearnContext | undefined,
  ancestorsOf: (id: string) => string[],
): string[] {
  const immediate = [...(context?.supersedes ?? []), ...(context?.derived_from ? [context.derived_from] : [])]
  const chain: string[] = []
  const seen = new Set<string>()
  const queue = [...immediate]
  while (queue.length && chain.length < MAX_CHAIN_DEPTH) {
    const id = queue.shift() as string
    if (!id || seen.has(id)) continue
    seen.add(id)
    chain.push(id)
    for (const parent of ancestorsOf(id)) {
      if (!seen.has(parent)) queue.push(parent)
    }
  }
  return chain
}

/**
 * The origin block, written when there is something to record in it.
 *
 * Was gated on a licence alone, which meant the other three fields could only
 * be written by somebody who happened to be licensing their memory — so `chain`
 * stayed empty even where the lineage was known. It is now written whenever any
 * of origin, chain or licence has content.
 *
 * A licence is still only recorded when somebody chose one. A default written
 * here would be indistinguishable from a decision, which is the whole point of
 * marking defaults.
 */
function buildProvenanceBlock(
  context: LearnContext | undefined,
  ancestorsOf: (id: string) => string[] = () => [],
): NonNullable<Engram['provenance']> | undefined {
  const chain = buildChain(context, ancestorsOf)
  const origin = context?.source
    ?? (context?.session_episode_id ? `session:${context.session_episode_id}` : undefined)
  if (!context?.license && !origin && chain.length === 0) return undefined
  return {
    // `direct` only when there is other content worth a block. As the sole
    // occupant it said nothing at all.
    origin: origin ?? 'direct',
    chain,
    signature: null,
    ...(context?.license ? { license: context.license } : {}),
  } as NonNullable<Engram['provenance']>
}

/**
 * Assemble the attribution block for a new engram (#961).
 *
 * Returns undefined when the caller supplied nothing, so the field is absent
 * rather than present-and-empty. We never invent a runtime, and we never read
 * the operating system account for an identity.
 */
function buildAttribution(
  context?: LearnContext,
  /** `provenance.identity` from config, when the user has set one. */
  configuredIdentity?: string,
): NonNullable<Engram['attribution']> | undefined {
  const a = context?.attribution
  const out: NonNullable<Engram['attribution']> = {}

  // WHO. Three states, and the third is the point.
  //
  //   the caller said so         -> use it (a per-engram override)
  //   the user configured one    -> use that
  //   neither                    -> the `unidentified` marker, written OUT
  //
  // Writing the marker rather than omitting the field is what makes the record
  // honest. An absent field cannot be told apart from a record written before
  // identity was captured at all; the marker says we looked and found nobody.
  //
  // Never the operating system account. That writes a real person's name into
  // shared records because they installed software, not because they chose to
  // be named.
  out.asserted_by = a?.asserted_by ?? configuredIdentity ?? ATTRIBUTION_UNIDENTIFIED

  // WHAT WROTE IT. Always recorded, because it is the one fact we always have:
  // software knows its own name.
  //
  // No version here, deliberately. Core has no version constant, and adding one
  // would create a seventeenth place `release.sh` has to bump — a standing cost
  // for a value that is almost never the one a reader wants. Every real write
  // arrives through a wrapper that DOES track its version (plur-mcp, plur-cli),
  // and those pass name and version both; this is the honest floor beneath them.
  out.runtime = a?.runtime ?? { name: 'plur-core' }

  if (a?.model) out.model = a.model
  if (a?.tool) out.tool = a.tool
  if (a?.on_behalf_of) out.on_behalf_of = a.on_behalf_of
  return out
}

import { buildProvenanceRecord, type ProvenanceOptions } from './provenance.js'
import { FileProvenanceStore, provenanceMode, type ProvenanceStore } from './provenance-store.js'

export {
  FileProvenanceStore,
  MemoryProvenanceStore,
  provenanceMode,
  type ProvenanceStore,
  type ProvenanceMode,
} from './provenance-store.js'

export {
  buildProvenanceRecord,
  buildPackProvenanceRecord,
  serializeProvenanceRecord,
  summariseProvenance,
  renderProvenanceSummary,
  assertDomainFields,
  LICENSE_SOURCES,
  type LicenseSource,
  type ProvenanceOptions,
  type DomainExtension,
  type PackProvenanceInput,
  type ProvenanceSummary,
} from './provenance.js'

/** Most remote ids `getByIds` fetches from one store in one call (#1318 review). */
const GET_BY_IDS_REMOTE_CAP = 20

/**
 * Reciprocal-rank-fusion score of `id` across ranked lists — the same formula
 * (`Σ 1/(k + rank + 1)`, k = 60) `hybrid-search.ts` `rrfMerge` sums. Used by
 * the PGLite recall path to report its top score (decision I4).
 */
function rrfScoreOf(id: string, lists: ReadonlyArray<ReadonlyArray<{ id: string }>>, k = 60): number {
  let score = 0
  for (const list of lists) {
    const rank = list.findIndex(e => e.id === id)
    if (rank >= 0) score += 1 / (k + rank + 1)
  }
  return score
}

/**
 * Where a learn result went (#1264). `remote`: a url store accepted it.
 * `outbox`: it is saved here and queued for a url store (the push is deferred,
 * or failed and will be retried). `local`: it exists on this machine only.
 */
export type LearnDelivery = 'remote' | 'outbox' | 'local'

/**
 * Why an engram went to the outbox instead of the server (0.21.1).
 * `auth_rejected`: the store answered 401/403 — the token is expired, revoked
 * or lacks rights, and retrying will not help until a person fixes it.
 * `unreachable`: no answer (network error or the caller's deadline passed).
 * `server_error`: the store answered with another error status.
 * `no_store`: no writable url store is registered for the scope.
 */
export type OutboxReasonCode = 'auth_rejected' | 'unreachable' | 'server_error' | 'no_store'

/** Options for {@link Plur.learnRouted} (0.21.1). */
export interface LearnRoutedOptions {
  /**
   * Deadline for the server request, in ms. When it passes, the engram is
   * saved locally and queued in the outbox — the save never fails because a
   * server is slow. Local work is never raced. Unset: the driver's own 30 s.
   */
  remoteTimeoutMs?: number
}

/** What {@link Plur.forget} and {@link Plur.feedback} did not refuse but want said (0.21.1). */
export interface MutationOutcome {
  /** Plain-language warnings, e.g. a remote whose token was rejected during the collision probe. */
  warnings: string[]
}

/** Per-store answer of the id-collision probe run by forget, feedback and setPinned. */
interface CollisionProbe {
  scope: string
  url: string
  outcome: 'present' | 'absent' | 'auth_rejected' | 'unreachable'
  detail?: string
}

/** Budget for ONE live collision probe (0.21.1). Was the 30 s request deadline. */
const REMOTE_PROBE_TIMEOUT_MS = 5_000

/** Refusal from {@link Plur.addRemoteStore} (#1265). `code` is stable for
 *  callers; `message` never contains the token. */
export class AddRemoteStoreError extends Error {
  constructor(
    readonly code: 'invalid_url' | 'missing_token' | 'missing_scope' | 'auth_rejected' | 'unreachable' | 'scope_not_authorised' | 'scope_conflict',
    message: string,
    readonly authorised: string[] = [],
  ) {
    super(message)
    this.name = 'AddRemoteStoreError'
  }
}

export class Plur {
  /**
   * Engrams a url store confirmed on the write path (#1264). The server's reply
   * is the only evidence a write left the machine, and it leaves no mark on the
   * engram itself, so it is remembered here — per returned object, never
   * persisted.
   */
  private _remoteDelivered = new WeakSet<object>()
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
  /** Spreading-activation drop counters — accumulated in-memory, reset on process restart. */
  private _spreadDrops = { dropped_unresolvable: 0, dropped_retired: 0 }
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
  /** Local store entries dropped at load because they name the primary file
   *  or a store already registered under another spelling (#1319). Kept on
   *  disk; see {@link _loadConfig}. */
  private _ignoredDuplicates: Array<{ entry: StoreEntry; duplicateOf: string }> = []
  private _warnedDuplicateStores = new Set<string>()
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
  /** Unsubscribes this instance from its store's id-rename reports (P1); see `close()`. */
  private _unsubscribeRenames: (() => void) | null = null

  /**
   * Detach this instance from resources it subscribed to on a store it does
   * not own. Today: the id-rename reports of a shared primary store (owner
   * decision P1 — a Postgres `save` that renames a clashing id reports it to
   * every attached instance, which records it in its own history). Does NOT
   * close the store: the caller passed it in and owns its lifecycle.
   * Idempotent.
   */
  close(): void {
    this._unsubscribeRenames?.()
    this._unsubscribeRenames = null
  }

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
    // Owner decision P1 (2026-09-27, "keep both, rename one — nothing lost or
    // hidden"): a store that renames a clashing id on write (Postgres `save`)
    // reports the rename here, and it is recorded in THIS instance's history
    // like every other rename — never log-only.
    // Every instance on a shared store subscribes (a Set on the store side), and
    // `close()` unsubscribes.
    const renameSink = (baseStore as { addRenameListener?: (fn: (r: Array<{ from: string; to: string }>) => void) => () => void }).addRenameListener
    if (typeof renameSink === 'function' && !this._readonly) {
      this._unsubscribeRenames = renameSink.call(baseStore, renames => {
        for (const r of renames) {
          this._appendHistory({
            event: 'engram_rekeyed',
            engram_id: r.to,
            timestamp: new Date().toISOString(),
            data: { from: r.from, to: r.to, store: this._primaryStore.kind, cause: 'store-save' },
            reason: 'duplicate id: a later, different engram in a save batch was given a fresh id (P1)',
          })
        }
      })
    }
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
    this.config = this._loadConfig()
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
    if (this.config.stores?.length !== this._loadConfig().stores?.length) {
      this.config = this._loadConfig()
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
      for (const e of storeEngrams) {
        // Phase 4: Scope validation. Segment-aware (#383): a sibling that is a
        // mere string-prefix of the store scope (group:plur/eng-private under a
        // group:plur/eng store) must NOT load.
        if (e.scope !== 'global' && !isScopeWithin(e.scope, store.scope)) {
          logger.debug(`Skipping engram ${e.id} from store ${store.scope}: scope mismatch (${e.scope})`)
          continue
        }

        // The same stamp as the remote recall leg (R2-CoreB core-policy#6/#7,
        // applied here by R2-CoreA): drop `_`-prefixed keys the row ships (a
        // forged `_pack` made a store row pass as pack content in
        // `withoutPacks` and injected-pack counts), narrow `global` to the
        // store scope, and namespace the id IDEMPOTENTLY — the regex replace
        // used here turned an id already carrying the prefix into
        // `ENG-XXX-XXX-…`, a different id from the recall leg's for one row.
        const cloned = stampStoreRow(e, store.scope) as any
        // Which store served the row, not just its scope: several stores may
        // share one scope (a url store and a path store both load), and
        // delivery reporting must classify by the one that held the row. A
        // boolean, not the url: every field of a loaded row is content-scanned
        // on the explicit-update path, and a url is not content. Set AFTER the
        // stamp, which drops `_`-prefixed keys a row ships.
        if (store.url) cloned._fromRemoteStore = true
        all.push(cloned)
      }
    }

    // Include pack engrams so they're searchable via recall
    const packs = loadAllPacks(this.paths.packs)
    for (const pack of packs) {
      for (const e of pack.engrams) {
        if (e.status !== 'active') continue
        // A pack row cannot ship loader markers (`_storeScope`, `_originalId`,
        // its own `_pack`): only this loader stamps them (R2-CoreB).
        const cloned = Object.fromEntries(
          Object.entries(e as unknown as Record<string, unknown>).filter(([k]) => !k.startsWith('_')),
        ) as any
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
  /**
   * Ids whose outbox delivery is being pushed by THIS instance right now —
   * learn()'s fire-and-forget push or a running flushOutbox(). A second pusher
   * skips them: without this, a flush that started while learn()'s immediate
   * push was in flight selected the same row (attempt_count 0) and POSTed it
   * again, so the remote got the engram twice (formal WritePath, candidate 1).
   * In-process only; across processes (and instances) the per-entry claim
   * file does the same job (decision C3, `_claimOutboxEntry`).
   */
  private _outboxInFlight = new Set<string>()
  /**
   * What the ambiguity guards (#831 forget, #850 feedback) may conclude from a
   * store's cache WITHOUT a network call (core-index#7, round 2).
   *
   * - `present`: the cache holds the id — a collision, refuse.
   * - `absent`: ONLY when the cache is a complete load younger than the
   *   driver's TTL. A cold-cache `append()` seeds `{ ts: 0, [stored] }` —
   *   explicitly "one engram is not all engrams in this scope" — and a cache
   *   past its TTL may predate the remote row. Both used to count as proof of
   *   absence because any non-empty cache did, so after a single push the
   *   guard retired the local engram while the same id lived remotely.
   * - `unknown`: cold, empty, partial or stale — the caller probes live.
   *
   * Model: spec/formal/PlurSpec/R2CoreA.lean §2 (`peek_absent_sound`).
   */
  private _remoteCacheAnswer(store: StoreEntry, serverId: string): 'present' | 'absent' | 'unknown' {
    const driver = this._getRemoteDriver({ url: store.url!, token: store.token, scope: store.scope })
    const view = driver as unknown as { cache: { ts: number; engrams: Engram[] } | null; ttlMs?: number }
    const cache = view.cache
    if (!cache || cache.engrams.length === 0) return 'unknown'
    if (cache.engrams.some(e => e.id === serverId)) return 'present'
    const ttl = typeof view.ttlMs === 'number' ? view.ttlMs : 60_000
    const age = Date.now() - cache.ts
    return cache.ts > 0 && age >= 0 && age < ttl ? 'absent' : 'unknown'
  }

  /**
   * Does a bare id ALSO name an engram in a configured url store? (0.21.1)
   *
   * One answer per url store, for the operations that act on a local row by
   * a bare id — forget, feedback, setPinned — since ids are minted per store
   * and two stores mint the same id on the same day (#831).
   *
   * Run WITHOUT the store lock. It used to run inside it, so a hanging server
   * held the lock every other writer needs for the full 30 s request budget.
   * Each live probe is bounded by REMOTE_PROBE_TIMEOUT_MS, and the walk by
   * REMOTE_GUARD_BUDGET_MS. A warmed cache answers for free.
   *
   * Outcomes are reported, not acted on; each caller decides:
   *   - `present`: ambiguous — every caller refuses and says how to choose.
   *   - `auth_rejected` (401/403): this caller cannot read OR change anything
   *     in that store, so the bare id can only mean the local row it holds.
   *   - `unreachable`: cannot tell. forget refuses (irreversible); feedback
   *     and pin go ahead with a warning (recoverable).
   */
  private _hasUrlStore(): boolean {
    return (this.config.stores ?? []).some(s => !!s.url)
  }

  private async _probeIdCollisions(id: string, opts?: { skipLive?: boolean }): Promise<CollisionProbe[]> {
    const out: CollisionProbe[] = []
    const deadline = Date.now() + REMOTE_GUARD_BUDGET_MS
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      const scope = entry.scope ?? entry.url
      const serverId = this._stripRemotePrefix(id, entry.scope)
      const peek = this._remoteCacheAnswer(entry, serverId)
      if (peek !== 'unknown') { out.push({ scope, url: entry.url, outcome: peek }); continue }
      if (opts?.skipLive) { out.push({ scope, url: entry.url, outcome: 'absent' }); continue }
      const left = deadline - Date.now()
      if (left <= 0) {
        out.push({ scope, url: entry.url, outcome: 'unreachable', detail: `the ${REMOTE_GUARD_BUDGET_MS}ms probe budget was spent before reaching it` })
        continue
      }
      try {
        const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
        // existsById, NOT getById: getById returns null for a dead network
        // exactly as for a genuine 404 — the silent "no" this must refuse.
        const exists = await driver.existsById(serverId, { signal: AbortSignal.timeout(Math.min(REMOTE_PROBE_TIMEOUT_MS, left)) })
        out.push({ scope, url: entry.url, outcome: exists ? 'present' : 'absent' })
      } catch (err) {
        const status = err instanceof RemoteHttpError ? err.status : undefined
        out.push({
          scope, url: entry.url,
          outcome: status === 401 || status === 403 ? 'auth_rejected' : 'unreachable',
          detail: (err as Error).message,
        })
      }
    }
    return out
  }

  /** The warning for a store whose token was rejected during a collision probe. */
  private _rejectedTokenWarning(p: CollisionProbe, id: string, acted: string): string {
    return `Remote scope "${p.scope}" rejected this machine's token (${p.detail ?? 'HTTP 401/403'}), so it could not ` +
      `be checked for another engram with id ${id}; ${acted} the LOCAL engram. The token for ${p.scope} is expired, ` +
      `revoked or lacks access — check it with \`plur login --status\` and refresh it in config.yaml.`
  }

  /**
   * forget()'s reading of the collision probe (#831, 0.21.1). Retiring is
   * irreversible, so "cannot tell" refuses; a rejected token does not, since
   * this caller cannot retire anything in that store either.
   */
  private _decideForgetProbes(id: string, probes: CollisionProbe[], warnings: string[]): void {
    for (const p of probes) {
      if (p.outcome === 'present') {
        throw new Error(
          `Ambiguous engram ID "${id}": exists in both the local store and remote scope "${p.scope}". `
          + `Retiring is destructive and irreversible from here, so it will not guess. `
          + `To retire the local engram: \`plur forget ${id} --scope primary\` (MCP: scope: "primary"). `
          + `To retire the remote one: --scope ${p.scope} (MCP: scope: "${p.scope}").`,
        )
      }
      if (p.outcome === 'unreachable') {
        throw new Error(
          `Cannot safely retire "${id}": remote scope "${p.scope}" could not be reached to rule out an id `
          + `collision (${p.detail ?? 'no answer'}). Retiring is destructive and irreversible from here, so it will `
          + `not guess. To retire the local engram without consulting the remote: `
          + `\`plur forget ${id} --scope primary\` (MCP: scope: "primary").`,
        )
      }
      if (p.outcome === 'auth_rejected') warnings.push(this._rejectedTokenWarning(p, id, 'retired'))
    }
  }

  /**
   * feedback()'s reading of the collision probe (#850, 0.21.1). Same as
   * forget() except that "cannot tell" rates the local engram with a warning.
   */
  private _decideFeedbackProbes(id: string, probes: CollisionProbe[], warnings: string[]): void {
    for (const p of probes) {
      if (p.outcome === 'present') {
        throw new Error(
          `Ambiguous engram ID "${id}": exists in both the local store and remote scope "${p.scope}". `
          + `To rate the local engram: \`plur feedback ${id} <signal> --scope primary\` (MCP: scope: "primary"). `
          + `To rate the remote one: --scope ${p.scope} (MCP: scope: "${p.scope}").`,
        )
      }
      if (p.outcome === 'auth_rejected') {
        const w = this._rejectedTokenWarning(p, id, 'rated')
        warnings.push(w)
        logger.warning(`[plur] ${w}`)
      }
      if (p.outcome === 'unreachable') {
        const w = `Remote scope "${p.scope}" could not be reached to rule out another engram with id ${id} `
          + `(${p.detail ?? 'no answer'}) — rated the LOCAL engram unverified. Pass --scope primary (MCP: scope: "primary") `
          + `to skip this check, or --scope ${p.scope} if you meant the remote one.`
        warnings.push(w)
        logger.warning(`[plur] ${w}`)
      }
    }
  }

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
    // A personal scope routes through the ONE selected entry (#1515 L1): when
    // a local path store shares the exact scope, the write stays local.
    const personal = this._exactPersonalStore(scope)
    if (personal !== undefined) {
      return personal?.url && personal.readonly !== true
        ? this._getRemoteDriver({ url: personal.url, token: personal.token, scope: personal.scope })
        : null
    }
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
   * `url` (data leaves this machine) whose scope exactly matches; for a personal
   * scope, when the ONE selected store is a url store. Used for routing
   * decisions (auto-route refusal, `readIdFor`). The secret scan does NOT use
   * it: it uses {@link _hasUrlStoreForScope}, which ignores the selection
   * (#1515 re-audit 3, M2).
   *
   * Pure CONFIG lookup — NO driver instantiation, NO network, NO side effects —
   * because this runs on every learn(). It uses `_resolveRemoteStoreForScope`'s
   * exact-scope-match rule (no prefix matching), but DELIBERATELY does not
   * mirror its readonly skip (core-index#9, round 2): a readonly URL store is not
   * a write target, yet its scope names a remote namespace, so the leak guard
   * still scans writes into it. That can only demote more, never let more out.
   * Where "a write here reaches the remote" is the question, use
   * {@link _isRemoteWriteScope}.
   */
  private _isRemoteBackedScope(scope: string): boolean {
    const personal = this._exactPersonalStore(scope)
    if (personal !== undefined) return !!personal?.url
    return (this.config.stores ?? []).some(s => !!s.url && s.scope === scope)
  }

  /**
   * The SECRET-SCAN predicate (#1515 re-audit 3, M2): any url store whose
   * scope is exactly `scope`, readonly or not, whatever the personal-store
   * selection says. The selection decides ROUTING only. Callers of the scan
   * also act on a concrete url entry — the remote update walk, the outbox
   * flush, a queued-row retarget — and that entry is not the selected one
   * when a local store shares the identical scope. Scanning there too can
   * only demote a write that would have stayed local; it never lets one out.
   */
  private _hasUrlStoreForScope(scope: string): boolean {
    return (this.config.stores ?? []).some(s => !!s.url && s.scope === scope)
  }

  /** Exactly the router's rule (`_resolveRemoteStoreForScope`): a writable URL
   *  store for exactly this scope, so a write to it leaves the machine. */
  private _isRemoteWriteScope(scope: string): boolean {
    const personal = this._exactPersonalStore(scope)
    if (personal !== undefined) return !!personal?.url && personal.readonly !== true
    return (this.config.stores ?? []).some(s => !!s.url && s.readonly !== true && s.scope === scope)
  }

  /**
   * For a personal `user:` scope that exactly names a configured store: the
   * ONE selected entry (`personalStoreEntry` — local first, then writable url,
   * then readonly url). `undefined` when the scope is not personal or names
   * no store exactly, so callers keep their previous exact-match rule. Pure
   * config lookup (no reload): it runs per engram on some paths, after the
   * caller's own reload.
   */
  private _exactPersonalStore(scope: string): StoreEntry | null | undefined {
    if (!scope.toLowerCase().startsWith('user:')) return undefined
    const stores = this.config.stores ?? []
    if (!stores.some(s => s.scope === scope)) return undefined
    return personalStoreEntry(scope, stores.filter(s => typeof s.scope === 'string'))
  }

  /**
   * Decision E1 "me-only" (2026-09-26): the `/me` identity each remote token
   * last reported, keyed `normalizedUrl::token`. Filled by every successful
   * `/me` this instance makes (`discoverRemoteScopes`, `checkRemoteHealth`);
   * DROPPED when a later `/me` for the same key fails, so "unknown" — never
   * fetched, offline, token rejected — is the fail-closed state. In memory only.
   */
  private _meIdentities = new Map<string, { username: string; org_id: string }>()

  private _meKey(url: string, token: string | undefined): string {
    return `${normalizeEndpointUrl(url)}::${token ?? ''}`
  }

  private _noteMeIdentity(url: string, token: string | undefined, me: { username?: string; org_id?: string } | null): void {
    const key = this._meKey(url, token)
    if (me && typeof me.username === 'string' && me.username.length > 0) {
      this._meIdentities.set(key, { username: me.username, org_id: typeof me.org_id === 'string' ? me.org_id : '' })
    } else {
      this._meIdentities.delete(key)
    }
  }

  /**
   * Is `scope` the user's OWN personal namespace on the URL store that backs
   * it, per that store's `/me` identity? Own = `user:<username>` or
   * `user:<org_id>:<username>` (case-folded), or a segment-descendant of
   * either (`isScopeWithin`). `agent:*` and every other personal scope are not
   * the user's own. Unknown identity → false (fail closed).
   */
  private _isOwnRemoteNamespace(scope: string): boolean {
    // The entry the write lands on (#1515: one selection for a personal scope).
    const personal = this._exactPersonalStore(scope)
    const entry = personal !== undefined
      ? personal
      : (this.config.stores ?? []).find(s => !!s.url && s.scope === scope)
    if (!entry?.url) return false
    const id = this._meIdentities.get(this._meKey(entry.url, entry.token))
    if (!id) return false
    const s = scope.toLowerCase()
    const user = id.username.toLowerCase()
    const own = [`user:${user}`, ...(id.org_id ? [`user:${id.org_id.toLowerCase()}:${user}`] : [])]
    return own.some(o => isScopeWithin(s, o))
  }

  /**
   * The configured scope a personal `user:` scope resolves to (#1515):
   * `personalStoreEntry` over EVERY configured store, path-backed and url —
   * exact case first, else case-folded; local before remote within each.
   * Returns `scope` unchanged when it is not personal, names no store, or
   * already names one exactly. One rule for writes (learn, learnAsync,
   * learnBatch) and for the read dial, so the same string reaches the same
   * store (re-audit N1/N3/N5).
   */
  private _canonicalPersonalScope(scope: string): string {
    // Read the CURRENT config (re-audit M1): learnAsync/learnBatch fold here
    // before the guard's own reload, and a store another process just added
    // must already count — a stale list would send a write meant for a new
    // local store to a remote case twin.
    this.reloadConfigIfChanged()
    const entry = personalStoreEntry(scope, (this.config.stores ?? []).filter(s => typeof s.scope === 'string'))
    return entry ? entry.scope : scope
  }

  /**
   * Decision E1 "me-only": an auto-route candidate the router must refuse like
   * a shared scope — backed by a URL store (so the write would leave the
   * machine) and not the user's own `/me` namespace. Path-backed and unbacked
   * personal scopes are never refused here. Shared scopes are
   * `allow_shared_auto_route`'s business, not this predicate's.
   */
  private _refuseRemotePersonalAutoRoute(scope: string): boolean {
    return this._isRemoteBackedScope(scope) && !this._isOwnRemoteNamespace(scope)
  }

  /**
   * Find which store owns an engram by ID. For namespaced IDs, strips prefix to find in store.
   *
   * `storeScope` — the loader's `_storeScope` stamp of the row, when the caller
   * holds one — names the store exactly. `storePrefix` is three letters, so
   * two store scopes can share one (group:plur/eng and group:plur/ops are both
   * GPL) and a namespaced id alone then names both; ids collide across stores
   * as the common case, so the first store with the bare id was the wrong one
   * (audit of #1228). A stamped row is never the primary's.
   *
   * The stored id may itself carry the prefix (a row from another client or
   * a sync): namespacing on load is idempotent, so the loaded id IS the stored
   * id, and the stripped form is not in the file (audit of #1228, finding 2).
   * Both forms are tried; `originalId` is the id as the store file has it.
   */
  private async _findEngramStore(
    id: string, storeScope?: string,
  ): Promise<{ path: string; readonly: boolean; originalId: string } | null> {
    // Check primary first (uses mtime cache)
    if (storeScope === undefined) {
      const primaryEngrams = await this._loadCached(this.paths.engrams)
      if (primaryEngrams.find(e => e.id === id)) {
        return { path: this.paths.engrams, readonly: false, originalId: id }
      }
    }

    // Check stores — ID might be namespaced. Remote stores are skipped
    // here because remote IDs are not namespaced (the remote PLUR
    // Enterprise server assigns its own IDs); writes to remote stores
    // go through their own path.
    const stores = this.config.stores ?? []
    for (const store of stores) {
      if (!store.path) continue
      if (storeScope !== undefined && store.scope !== storeScope) continue
      const prefix = storePrefix(store.scope)
      const nsPattern = new RegExp(`^(ENG|ABS|META)-${prefix}-`)
      if (nsPattern.test(id)) {
        // Strip the namespace prefix to get the original ID — or the id as it
        // is, when the store file already holds it namespaced.
        const stripped = id.replace(nsPattern, '$1-')
        const storeEngrams = await this._loadCached(store.path)
        const found = storeEngrams.find(e => e.id === stripped) ?? storeEngrams.find(e => e.id === id)
        if (found) {
          return { path: store.path, readonly: store.readonly ?? false, originalId: found.id }
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
  /**
   * Build a provenance record for an engram (#964), without storing it.
   *
   * Defaults to a portable record: one that stands on its own, names no other
   * engram, and can be handed to someone who has none of our files.
   */
  async provenanceFor(engramId: string, options: ProvenanceOptions = {}): Promise<unknown | undefined> {
    const engram = await this.getById(engramId)
    if (!engram) return undefined
    // Decision E6: a scope backed by a remote store on this install leaves the
    // machine; only this instance knows its stores. Current config, not a
    // stale snapshot (core-index#9).
    this.reloadConfigIfChanged()
    const cfg = (this.config as any)?.provenance
    return buildProvenanceRecord(engram, this.getEngramHistory(engramId), {
      includeStatement: cfg?.include_statement ?? false,
      // Writable URL stores only: a readonly one is not a path off the machine,
      // and not knowing can only withhold more (core-index#9b).
      remoteBacked: this._isRemoteWriteScope(engram.scope),
      ...options,
    })
  }

  /**
   * Build a provenance record and store it (#964, #965).
   *
   * Returns the reference the store gave back, or undefined when the engram is
   * unknown. Storage is pluggable: pass a store, or let it default to files
   * under the PLUR home directory.
   */
  async writeProvenance(
    engramId: string,
    options: ProvenanceOptions & { store?: ProvenanceStore } = {},
  ): Promise<string | undefined> {
    const record = await this.provenanceFor(engramId, options)
    if (!record) return undefined
    const store = options.store ?? this._provenanceStore()
    return store.put(engramId, record)
  }

  /**
   * Append a history event, stamped with who caused it (#959).
   *
   * Every event site in this class goes through here rather than calling
   * `appendHistory` directly, for the same reason `buildAttribution` exists:
   * there are 28 of them, and a policy applied at 28 call sites is a policy
   * that will be missed at the 29th. Stamping centrally also means a new event
   * type gets an actor without its author having to know that it should.
   *
   * A caller that knows better — a dedup pass acting on behalf of somebody
   * else, say — passes its own `actor` and this leaves it alone.
   *
   * The actor answers a DIFFERENT question from the engram's `attribution`.
   * Attribution says who asserted the statement; this says who caused this
   * event. An engram asserted by one person and retired by another has two
   * answers, and collapsing them loses both — which is precisely what a reader
   * auditing a correction needs to know.
   */
  /**
   * @returns whether the event was written — propagated from `appendHistory`,
   *   which reports rather than throws (#1017). `inject()` gates
   *   `injection_count` on this, so swallowing it here would put the counter
   *   back out of step with the log it is supposed to be explained by.
   */
  private _appendHistory(event: HistoryEventType): boolean {
    if (!event.actor) {
      event.actor = {
        asserted_by: this._configuredIdentity() ?? ATTRIBUTION_UNIDENTIFIED,
        runtime: { name: 'plur-core' },
      }
    }
    return appendHistory(this.paths.root, event)
  }

  /**
   * The recorded ancestors of one engram, for extending a derivation chain.
   *
   * Reads the chain the ancestor already carries rather than walking the graph
   * again — each engram's chain was resolved when it was written, so this is
   * one lookup deep instead of a traversal per write.
   *
   * Takes the already-loaded engram list rather than reading the store: both
   * call sites have it in hand, and a store read inside the write path would
   * add latency to every learn for a field that is a convenience. An ancestor
   * that is not in the list contributes nothing, which shortens the chain and
   * never fails the write.
   */
  private _ancestorsOf(loaded: Engram[], id: string): string[] {
    const engram = loaded.find(e => e.id === id)
    const chain = (engram as { provenance?: { chain?: string[] } } | undefined)?.provenance?.chain
    return Array.isArray(chain) ? chain : []
  }

  /**
   * The identity this user configured, if any (`provenance.identity`).
   *
   * Returns undefined when unset, and `buildAttribution` then writes the
   * `unidentified` marker. Never falls back to the operating system account.
   */
  private _configuredIdentity(): string | undefined {
    const id = (this.config as any)?.provenance?.identity
    return typeof id === 'string' && id.trim() ? id.trim() : undefined
  }

  /**
   * Who new memories will be attributed to, and whether anybody chose that.
   *
   * Exposed so a surface can ask before writing — the CLI prompts on `init`,
   * and `plur identity` reports it. `stated: false` means every engram written
   * from here is recorded as `unidentified`, which is honest but answers
   * nobody's question about who is responsible.
   */
  identity(): { identity: string; stated: boolean } {
    const configured = this._configuredIdentity()
    return { identity: configured ?? ATTRIBUTION_UNIDENTIFIED, stated: Boolean(configured) }
  }

  /**
   * Set, change, or clear who memories are attributed to.
   *
   * Applies to memories written from now on. Existing engrams keep whatever was
   * recorded at the time, which is the point of recording it — rewriting them
   * would be editing history to match a later decision.
   */
  setIdentity(identity: string | null): { identity: string; stated: boolean; warning?: string } {
    const value = typeof identity === 'string' ? identity.trim() : ''
    // An email address is the most natural identity to type and the one that
    // silently breaks sharing: the export privacy scan flags email addresses,
    // so every memory attributed this way is dropped from every pack (#999).
    // Accept it — it is the user's decision — but say so at the moment they
    // choose it rather than at the first empty export.
    const warning = value && containsEmail(value)
      ? `"${value}" is an email address. The pack export privacy scan flags email addresses, so memories `
        + 'attributed to it are held back from every pack until #999 lands. Prefer a local name '
        + '(local:yourname) or a DID if you intend to share.'
      : undefined
    if (warning) logger.warning(`[plur:identity] ${warning}`)
    // Same read-modify-write discipline as every other config mutation here:
    // under the config lock, and written atomically. A plain write truncates in
    // place, and a parse failure makes loadConfig fall back to DEFAULT config —
    // so a crash mid-write would silently erase store registrations too.
    withLock(this.paths.config, () => {
      let configData: Record<string, unknown> = {}
      try {
        const raw = fs.readFileSync(this.paths.config, 'utf8')
        if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      const provenance = (configData.provenance as Record<string, unknown> | undefined) ?? {}
      if (value) provenance.identity = value
      else delete provenance.identity
      configData.provenance = provenance
      atomicWrite(this.paths.config, yaml.dump(configData, { lineWidth: 120, noRefs: true }), { mode: CONFIG_FILE_MODE })
    })
    this.config = this._loadConfig()
    this.configMtimeMs = this.statConfigMtime()
    return { ...this.identity(), ...(warning ? { warning } : {}) }
  }

  private _provenanceStoreInstance?: ProvenanceStore

  private _provenanceStore(): ProvenanceStore {
    if (!this._provenanceStoreInstance) {
      this._provenanceStoreInstance = new FileProvenanceStore(
        this.paths.root,
        this.config.provenance?.path,
      )
    }
    return this._provenanceStoreInstance
  }

  /**
   * Write a record at creation time, when the setting asks for it (#966).
   *
   * Default is `never`: a record per engram duplicates the history log, and the
   * trust boundary is the moment an engram leaves, not the moment it is written.
   * Never throws — provenance is a description, and failing to write one must
   * not fail the learn that prompted it.
   */
  /**
   * Run fire-and-forget work only once the store has committed (#1178, F16).
   *
   * A transactional store runs a protected write inside one connection and one
   * ownership context. Background work started inside that context would
   * inherit it, then fail once the transaction ends, or run against state that
   * a later rollback discards. Stores without transactions run it immediately.
   */
  private _afterStoreCommit(callback: () => void): void {
    if (this._primaryStore.afterCommit) this._primaryStore.afterCommit(callback)
    else callback()
  }

  private _maybeWriteProvenance(engramId: string): void {
    if (provenanceMode(this.config) !== 'always') return
    this._afterStoreCommit(() => {
      void this.writeProvenance(engramId).catch(err => {
        logger.warning(`[plur:provenance] could not write a record for ${engramId}: ${(err as Error).message}`)
      })
    })
  }

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
      this._appendHistory({
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

    // Persist where the engram lives.
    if (idx !== -1) {
      // Incremental write (#740): only the duplicate-counted engram changed.
      await this._updateEngrams(engrams, [target])
      await this._syncIndex()
    } else {
      // A hit in a WRITABLE secondary (path) store is persisted there, under
      // that store's lock with the load inside it (core-index#8, round 2).
      // forget() decrements write_count in secondary stores and cross-scope
      // recurrence persists its increment there; counting this increment only
      // in memory made the pair asymmetric — two writers, one forget, retired,
      // and the second writer's reference (#107) was gone. Packs, readonly
      // stores and other scopes' remote rows never reach here (Decision A:
      // they do not absorb a write); the writable remote of this very scope
      // is counted in memory only, as before (a remote retire is a whole
      // DELETE; the server owns its row).
      // Lock order primary → secondary, same as `_recordCrossScopeRecurrence`.
      const storeInfo = await this._findEngramStore(hit.id, (hit as any)._storeScope)
      if (storeInfo && storeInfo.path !== this.paths.engrams && !storeInfo.readonly) {
        const sourceEntry = ((target as any).sources as unknown[]).at(-1)
        await this._withStoreLock(storeInfo.path, async () => {
          const storeEngrams = await this._storeAt(storeInfo.path).load()
          const row = storeEngrams.find(e => e.id === storeInfo.originalId)
          if (!row || row.status !== 'active') return
          row.write_count = (row.write_count ?? (row as any).reference_count ?? 1) + 1
          ;(row as any).sources = [...((row as any).sources ?? []), sourceEntry]
          await this._writeEngrams(storeInfo.path, storeEngrams)
          await this._syncIndex()
          // The caller gets the persisted count, not the pre-lock guess.
          target.write_count = row.write_count
          ;(target as any).sources = (row as any).sources
        })
      }
    }
    return target
  }

  /**
   * May a cross-scope hit (#176) absorb a write INTO `scope`? Not when `scope`
   * is backed by a writable remote store (R2-Integrations, applied by
   * R2-CoreA): the write is then an explicit egress to a team store, and
   * absorbing it into a local engram of another scope meant the team never
   * received it — no POST, nothing queued (replayed for learn() and
   * learnRouted()). The same-scope dedup still applies there.
   */
  private _crossScopeRecurrenceApplies(scope: string): boolean {
    return !this._isRemoteWriteScope(scope)
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
    // #1268: for a SHARED write, a shared hit is preferred. Either way the hit
    // is only CREDITED — decision A1 (2026-09-29): a team save is never
    // absorbed, not even into another team's engram. See `_isTeamValidation`.
    const sharedWrite = isSharedScope(currentScope)
    let fallback: Engram | null = null
    for (const e of engrams) {
      if (e.status === 'active'
          && (e as any).content_hash === hash
          && e.scope !== currentScope) {
        if (!sharedWrite || isSharedScope(e.scope)) return e
        fallback ??= e
      }
    }
    return fallback
  }

  /**
   * #1268: a shared-scope save that matched an engram in another scope. The
   * match is credited as a recurrence (counted, a `validated_by` source,
   * commitment escalated by the ladder up to `recurrence.max_commitment`) and
   * the team copy is written anyway. Decision A1 (2026-09-29): this holds for
   * EVERY match — personal, global, or another team's engram — so a team save
   * always reaches its own team store. The user may then hold several engrams
   * with the same text; that is intended.
   */
  private _isTeamValidation(scope: string, _hit: Engram): boolean {
    return isSharedScope(scope)
  }

  /** Decision A3 (2026-09-29): the ladder's ceiling, from `recurrence.max_commitment`. */
  private _maxRecurrenceCommitment(): 'locked' | 'decided' {
    return (this.config as any).recurrence?.max_commitment === 'decided' ? 'decided' : 'locked'
  }

  /**
   * One step up the commitment ladder (exploring → leaning → decided →
   * locked), never past `recurrence.max_commitment`, and never into `locked`
   * while `lockBlocked` (an unresolved tension, #181).
   */
  private _stepCommitment(c: Engram['commitment'] | undefined, lockBlocked: boolean): Engram['commitment'] {
    // Only the four ladder rungs advance. `draft` (pending human approval) and
    // any unknown/extension value are not the ladder's to move — the same rule
    // as `feedback.ts` `nextCommitment` (formal replay, field-report cluster 1).
    switch (c as string | undefined) {
      case undefined:   return 'leaning'
      case 'exploring': return 'leaning'
      case 'leaning':   return 'decided'
      case 'decided':   return lockBlocked || this._maxRecurrenceCommitment() === 'decided' ? 'decided' : 'locked'
      default:          return c   // 'locked', 'draft', and anything unknown: unchanged
    }
  }

  /**
   * #1268 guard: an engram bound for a remote team store — queued in the
   * outbox for one, served by one, or in a scope a url store is registered for
   * — must never be rewritten to `global` by the recurrence ladder. Otherwise
   * the outbox pushes `scope: global` into the team store.
   */
  private _isTeamStoreBound(e: Engram): boolean {
    // Owner decision (2026-09-29): what is in a team store stays there. A team
    // store is any url store or any `shared: true` file-path store; an engram
    // it serves, or one queued for it, keeps its scope. The ladder may still
    // credit it, and a personal/global copy can exist alongside.
    const a = e as any
    if (a.structured_data?._outbox) return true
    const teamStores = (this.config.stores ?? []).filter(s => !!s.url || s.shared === true)
    if (teamStores.some(s => isScopeWithin(e.scope, s.scope))) return true
    if (typeof a._storeScope === 'string' && teamStores.some(s => s.scope === a._storeScope)) return true
    return false
  }

  /**
   * #1268 copy-on-promote. `hit` is an engram the ladder would broaden to
   * global, but either it is bound for a team store (what is in a team store
   * stays there) or a global engram with the same text already exists. Leave
   * `hit` in its scope, store and file, and credit a `global` engram in the
   * LOCAL primary store instead — the existing twin if there is one, else a
   * copy created now.
   *
   * Decision A2 (2026-09-29, "both"): a team engram still QUEUED for its store
   * (an `_outbox` row in the primary store) also records the recurrence on
   * itself — count and source only; its scope, commitment and outbox entry
   * are kept — before the global copy is created or credited.
   *
   * The copy links back with `derived_from: <hit id>` (the existing lineage
   * field) and its first source carries `promoted_from: <hit scope>`.
   * Commitment is escalated as the ladder would, up to
   * `recurrence.max_commitment` (decision A3). The
   * copy is appended directly — never given an `_outbox` marker — and its
   * scope is `global`, which no team store serves, so it is never pushed.
   *
   * Carried from `hit`: statement, type, domain, tags, rationale, the validity
   * window (`valid_from`/`valid_until` — an expiring team engram must not yield
   * a copy that never expires), `knowledge_anchors` and `dual_coding` (content
   * that cites and explains the statement). NOT carried: `pinned` — a pin is
   * the owner's own injection-budget choice and is quota-gated, so a
   * teammate's pin must not spend it — and `relations`, whose edges name
   * team-store ids and whose `supersedes` edges have side effects; the copy's
   * one edge is `derived_from`.
   *
   * Uses the same id allocation and storage seams as `learn()`: on a store
   * with the write-path seams it asks the store for the id and never loads the
   * corpus (review finding 3).
   */
  private async _promoteTeamCopy(
    hit: Engram,
    engrams: Engram[],
    scope: string,
    context: LearnContext | undefined,
    twin: Engram | null,
  ): Promise<Engram> {
    const source = this._buildSourceEntry(scope, context)
    const lockedAt = new Date().toISOString()
    const step = (e: any, lockBlocked: boolean, count: number): void => {
      e.commitment = this._stepCommitment(e.commitment, lockBlocked)
      if (e.commitment === 'locked' && !e.locked_at) {
        e.locked_at = lockedAt
        e.locked_reason = `Auto-locked: cross-scope recurrence detected (${count}x)`
      }
    }

    // A2: the queued team row records the recurrence on itself.
    const h = hit as any
    // Tension gate (#181) at every escalation site: an unresolved tension on
    // the SOURCE engram blocks the copy's — or the twin's — step into locked,
    // as it blocks the in-place promotion it replaces.
    const sourceTension = this.hasUnresolvedTension(hit.id)
      || (typeof h._originalId === 'string' && this.hasUnresolvedTension(h._originalId))
    let hitCount = h.recurrence_count ?? 0
    if (h.structured_data?._outbox) {
      let row = engrams.find(e => e.id === hit.id) as any
      if (!row && this._primaryStore.loadByIds) row = (await this._primaryStore.loadByIds([hit.id]))[0]
      if (row) {
        row.recurrence_count = (row.recurrence_count ?? 0) + 1
        row.write_count = (row.write_count ?? 1) + 1
        row.sources = [...(row.sources ?? []), source]
        hitCount = row.recurrence_count - 1
        await this._updateEngrams(engrams, [row as Engram])
      }
    }

    if (twin) {
      const e = twin as any
      e.recurrence_count = (e.recurrence_count ?? 0) + 1
      e.write_count = (e.write_count ?? 1) + 1
      e.sources = [...(e.sources ?? []), source]
      step(e, sourceTension || this.hasUnresolvedTension(twin.id), e.recurrence_count)
      await this._updateEngrams(engrams, [twin])
      await this._syncIndex()
      return twin
    }

    const now = new Date().toISOString()
    const ps = this._primaryStore
    const id = this._canDelegateLearn()
      ? await ps.nextEngramId!(engramIdDatePrefix())
      : generateEngramId(engrams, this._mintedTodayIds())
    this._rememberMintedId(id)
    const copy: Engram = {
      ...this._buildEngramShape(hit.statement, 'global', {
        scope: 'global',
        type: hit.type,
        domain: hit.domain,
        tags: hit.tags,
        rationale: h.rationale,
        knowledge_anchors: h.knowledge_anchors?.length ? h.knowledge_anchors : undefined,
        dual_coding: h.dual_coding,
        derived_from: hit.id,
        commitment: hit.commitment,
      } as LearnContext, now, {
        ...(h.temporal?.valid_from ? { valid_from: h.temporal.valid_from } : {}),
        ...(h.temporal?.valid_until ? { valid_until: h.temporal.valid_until } : {}),
      }, eid => this._ancestorsOf(engrams, eid), 'default'),
      id,
    }
    const c = copy as any
    c.recurrence_count = hitCount + 1
    c.write_count = (h.write_count ?? 1) + 1
    step(c, sourceTension, c.recurrence_count)
    c.sources = [
      { scope: hit.scope, session_id: null, stored_at: now, promoted_from: hit.scope },
      source,
    ]
    await this._appendEngram(engrams, copy)
    await this._syncIndex()
    this._appendHistory({
      event: 'engram_created',
      engram_id: id,
      timestamp: now,
      data: { type: copy.type, scope: 'global', source: copy.source, promoted_from: { engram_id: hit.id, scope: hit.scope } },
    })
    return copy
  }

  /** The store capability set `learn()` delegates on (#828) — see there. */
  private _canDelegateLearn(): boolean {
    const ps = this._primaryStore
    return Boolean(ps.findActiveByContentHash && ps.nextEngramId && ps.append && ps.updateMany && ps.loadByIds)
  }

  /**
   * An active `global` engram in the primary store with `hit`'s text (#1268
   * review finding 2). Asked of the store when it has the seam, so this never
   * loads the corpus there; otherwise found in the corpus in hand.
   */
  private async _findGlobalTwin(hit: Engram, engrams: Engram[]): Promise<Engram | null> {
    if (!isHashable(hit.statement)) return null
    const hash = (hit as any).content_hash ?? computeContentHash(hit.statement)
    if (this._canDelegateLearn()) {
      return await this._primaryStore.findActiveByContentHash!(hash, 'global')
    }
    return engrams.find(e => e.status === 'active' && e.scope === 'global'
      && e.id !== hit.id && (e as any).content_hash === hash) ?? null
  }

  /** Record a cross-scope recurrence: append source, increment counters,
   * escalate commitment, and broaden scope to 'global' once the threshold
   * is crossed — except for a row still queued for a remote store (`_outbox`),
   * whose scope is never changed (decision D3). Returns the (possibly
   * broadened) engram.
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
    const teamValidation = this._isTeamValidation(scope, hit)

    // #1268 copy-on-promote (owner decision 2026-09-29): what is in a team
    // store stays there. When this hit would broaden a team-bound engram to
    // global, the team engram is left untouched and a global copy in the local
    // primary store takes the promotion instead.
    //
    // The same path handles a global twin (review finding 2): when a global
    // engram with the same text already exists, broadening `hit` in place
    // would make a second one. The existing global engram is credited instead
    // and `hit` is left where it is.
    if (((hit as any).recurrence_count ?? 0) + 1 >= 2 && isSharedScope(hit.scope)) {
      const twin = await this._findGlobalTwin(hit, engrams)
      if (twin || this._isTeamStoreBound(hit)) {
        return await this._promoteTeamCopy(hit, engrams, scope, context, twin)
      }
    }

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
    const sourceEntry: { scope: string; session_id: string | null; stored_at: string; validated_by?: string } =
      this._buildSourceEntry(scope, context)
    if (teamValidation) sourceEntry.validated_by = scope
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
        //
        // Decision D3 "no-widen" (2026-09-26): never widen a row that still
        // carries `_outbox` — it is queued for a team store under its current
        // scope. #1268 extends the guard to every engram bound for a team store;
        // `_isTeamStoreBound` covers the `_outbox` case too.
        if (isSharedScope(e.scope) && !this._isTeamStoreBound(e)) e.scope = 'global'
        if (e.commitment !== 'locked') {
          // Forward-only ladder: exploring → leaning → decided → locked, capped
          // by `recurrence.max_commitment` (decision A3, 2026-09-29) — team
          // validations included.
          e.commitment = this._stepCommitment(e.commitment, lockBlockedByTension)
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
      ;(hit as any).structured_data = (mutated as any).structured_data
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
      const storeInfo = await this._findEngramStore(hit.id, (hit as any)._storeScope)
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
        // Readonly or remote — apply to hit only. Since Decision A (owner,
        // 2026-09-27) learn()/learnRouted() never route such a hit here: a
        // pack / readonly / other-remote match gets a new row instead and a
        // history-only note (`_noteUnpersistableRecurrence`). Kept as the
        // defensive fallback for a hit whose store vanished meanwhile.
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
      this._appendHistory({
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
  /**
   * Registered scopes eligible as an AUTO-ROUTE target: those declaring
   * metadata, minus readonly stores (MED-12). Shared by the write path and
   * {@link previewAutoRoute} so the two cannot rank different candidate sets —
   * the same drift #1115 is about, one level up from the decision itself.
   */
  private _writableScopeMetadata(): ScopeMetadata[] {
    return this.listScopeMetadata().filter(md => {
      const entry = (this.config.stores ?? []).find(s => s.scope === md.scope)
      return entry?.readonly !== true
    })
  }

  /**
   * What a genuinely-unscoped write of these signals WOULD do (#1115).
   *
   * `suggestScope` ranks; this decides. They answered differently before: the
   * ranker weighs domain, tags and statement keywords, while the write path
   * routed a forward domain-prefix match deterministically and ignored the rest.
   * A user could consult the suggestion tool and then write without a scope and
   * land somewhere else. Both now go through `decideAutoRoute`, so a suggestion
   * surface can report the real outcome instead of an approximation of it.
   */
  previewAutoRoute(input: ScopeSignals): AutoRouteDecision {
    this.reloadConfigIfChanged()
    if (this.config.auto_route_scope === false) {
      return { action: 'no-match', scope: null, candidate: null, refusedShared: null }
    }
    const cfg = this.config.scope_routing ?? {}
    const candidates = rankScopes(
      input,
      this._writableScopeMetadata(),
      cfg.weight_tag !== undefined ? { weightTag: cfg.weight_tag } : undefined,
    )
    return decideAutoRoute(candidates, {
      matchThreshold: cfg.match_threshold ?? SCOPE_MATCH_THRESHOLD,
      allowSharedScope: cfg.allow_shared_auto_route === true,
      refuseScope: s => this._refuseRemotePersonalAutoRoute(s),
    })
  }

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
   * others can read it) OR REMOTE-backed (`_hasUrlStoreForScope`: routes to a
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
   * others can read it) OR REMOTE-backed (`_hasUrlStoreForScope`, it routes off
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
    // "Remote-backed" here is ANY url store with this exact scope, not the
    // personal-store selection: callers that PATCH or push to a concrete url
    // entry rely on this scan (#1515 re-audit 3, M2).
    if (!isSharedScope(scope) && !this._hasUrlStoreForScope(scope)) return []
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
   * Everything on an engram, apart from its statement, for the explicit-update /
   * meta / outbox-reguard / rescope leak scan (LOW-2, #353).
   *
   * This used to be a hand-kept list of context-ish fields that had to mirror
   * `LearnContext`, and it drifted three times (#381, #405, and the #1002
   * review: `attribution`, `claim_class` and `provenance.license` were added to
   * the write path and not here, so a credential in `attribution.asserted_by`
   * rescoped from local into a shared scope unscanned). It now serialises the
   * whole engram — see `engramContentFields` for the one deliberate exclusion —
   * so a field that reaches the engram by any route is scanned by construction.
   */
  private _engramContextFields(engram: Engram): Record<string, unknown> | undefined {
    return engramContentFields(engram)
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
  ): Promise<{ scope: string; routed: { scope: string; confidence: number; reason: string } | null; refusedShared: { scope: string; confidence: number; reason: string } | null }> {
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
      return { scope: fallback, routed: null, refusedShared: null }
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
    const writableScopeMetadata = this._writableScopeMetadata()
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
    // #1115: ONE decision function, shared with `previewAutoRoute` (and through
    // it the `plur_suggest_scope` surface), so the write path and the suggestion
    // tool can no longer disagree about where an unscoped write lands.
    //
    // Eligibility is unchanged — a FORWARD domain match routes deterministically,
    // everything weaker stays gated by `matchThreshold`. What changed is that a
    // SHARED candidate is refused unless this install opted in: an unscoped write
    // whose domain prefix happened to match a team scope's covers used to land in
    // that team store and be pushed to its remote, where local cleanup could not
    // undo it. A refused shared candidate does not end the search — the next
    // eligible PERSONAL candidate still wins, so personal-scope routing is intact.
    // Decision E1 "me-only": a URL-backed personal candidate that is not the
    // user's own `/me` namespace (or whose identity is unknown) is refused
    // exactly like a shared one — same predicate as previewAutoRoute.
    const decision = decideAutoRoute(candidates, {
      matchThreshold,
      allowSharedScope: scopeRoutingCfg.allow_shared_auto_route === true,
      refuseScope: s => this._refuseRemotePersonalAutoRoute(s),
    })
    const marker = (c: ScopeCandidate) => ({ scope: c.scope, confidence: c.confidence, reason: c.reason })
    const refusedShared = decision.refusedShared ? marker(decision.refusedShared) : null
    if (decision.action === 'route' && decision.scope && decision.candidate) {
      return { scope: decision.scope, routed: marker(decision.candidate), refusedShared }
    }
    // Both 'refuse-shared' and 'no-match' fall to the unscoped default. The
    // refusal travels separately so the caller can say what it declined to do,
    // rather than reporting a plain unrouted write.
    return { scope: fallback, routed: null, refusedShared }
  }

  /**
   * The text the write-time HARD secret scan reads: the statement plus every
   * caller-supplied content field, as listed by `LEARN_CONTEXT_FIELD_ROLES`.
   * Statement-only when the context carries no content field, so a plain
   * write scans exactly what it always did.
   */
  private _hardScanText(statement: string, context: LearnContext | undefined): string {
    const content = learnContextContent(context)
    return content ? `${statement}\n${JSON.stringify(content)}` : statement
  }

  private async _guardSensitiveScope(
    statement: string,
    context?: LearnContext,
  ): Promise<{ scope: string; context: LearnContext | undefined; demotion: { from: string; to: string; patterns: string } | null; routed: { scope: string; confidence: number; reason: string } | null; refusedShared: { scope: string; confidence: number; reason: string } | null; scopeSource: ScopeSource }> {
    // Every egress decision below reads the CURRENT config (core-index#9,
    // round 2): this ran `reloadConfigIfChanged` only on the unscoped path, so
    // an explicit-scope write in a long-running process was guarded — and
    // routed — against a `sensitivity` policy another process had since
    // tightened. One statSync; reloads only on an mtime change.
    this.reloadConfigIfChanged()
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
    let refusedShared: { scope: string; confidence: number; reason: string } | null = null
    let scope: string
    // #1221: WHO chose this scope. The decision is made here and nowhere else,
    // so it is recorded here rather than inferred later from the absence of a
    // `_routed` marker — "the caller named it" and "nothing named it and the
    // default applied" are different facts and both are absent-marker cases.
    let scopeSource: ScopeSource
    if (context?.scope == null && sessionScope == null) {
      const resolved = await this._resolveUnscopedScope(statement, context)
      scope = resolved.scope
      routed = resolved.routed
      refusedShared = resolved.refusedShared
      scopeSource = resolved.routed ? 'routed' : 'default'
    } else {
      // Terminal fallback respects unscoped_default so a `unscoped_default:'local'`
      // user with no session scope and no context scope is not silently forced
      // to global (#353). No behavior change for the default-global user.
      scope = context?.scope ?? sessionScope ?? (this.config.unscoped_default ?? 'global')
      // A session / `.plur.yaml` scope is a human's standing choice, not a
      // guess — deliberate, but not stated on this call, which is a distinction
      // a server reviewing writes may reasonably care about.
      scopeSource = context?.scope != null ? 'explicit' : 'session'
    }
    // A personal `user:` scope that names a configured store under a
    // different case writes to that store under ITS configured scope — the
    // same case-folded, exact-first, single-entry match the recall dial uses
    // (`_canonicalPersonalScope`, #1515 audit F5). Every configured store
    // counts, path-backed ones included, so a scope that exactly names a
    // LOCAL store is never redirected to a remote case twin (re-audit N1).
    const canonical = this._canonicalPersonalScope(scope)
    if (canonical !== scope) {
      // On the auto-routing path the router already judged `scope` with the
      // "me-only" ownership check (Decision E1). The rewrite must not carry
      // the write past that check to a different destination: judge the
      // rewritten scope again and keep the original when it is refused.
      if (scopeSource === 'routed' && this._refuseRemotePersonalAutoRoute(canonical)) {
        logger.warning(`[plur:learn] auto-routed scope=${scope} not rewritten to ${canonical}: not your own remote namespace`)
      } else {
        scope = canonical
        if (context?.scope != null) context = { ...context, scope }
      }
    }
    // Guard fires when the write can leave the machine: shared scope (others can
    // read it) OR remote-backed scope (routes to a remote store, e.g. a personal
    // `user:` scope on plur.datafund.io). Purely-local scopes (`global`/`local`/
    // local-file stores) stay on this machine and are exempt — same gate as
    // _offendingHitsForScope, kept in sync because this short-circuits before it.
    // The scan gate is "a url store has this exact scope" (`_hasUrlStoreForScope`),
    // not the personal-store selection (#1515 re-audit 3, M2).
    if (!isSharedScope(scope) && !this._hasUrlStoreForScope(scope)) {
      return { scope, context, demotion: null, routed, refusedShared, scopeSource }
    }
    // Scan the FULL content the engram will carry — the statement AND the
    // context fields (rationale, key_files, source, …), not just the statement.
    // Sensitive material hides in context too (#326 review, finding 1).
    const scanText = `${statement}\n${JSON.stringify(context ?? {})}`
    // Single source of truth for the offending-hit policy (#353).
    const offending = this._offendingHitsForScope(scanText, scope)
    if (offending.length === 0) return { scope, context, demotion: null, routed, refusedShared, scopeSource }

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
      refusedShared,
      // The demotion overrode the destination; it did not change who picked it.
      scopeSource,
    }
  }

/**
   * `measured_under` as it may be persisted (#869 review): validated against
   * MeasuredUnderSchema, or absent. The MCP tool passes the LLM's object
   * through as a bare cast, and a non-string dimension written to disk makes
   * the loader quarantine the WHOLE engram on the next read — the field that
   * was meant to add context would silently remove the memory. Refusing at
   * write time keeps the store loadable; the caller gets a TypeError naming
   * the field instead of a warning in a log they may never see.
   */
  private _validatedMeasuredUnder(context: LearnContext | undefined): MeasuredUnder | undefined {
    const raw = context?.measured_under
    if (raw === undefined || raw === null) return undefined
    const parsed = MeasuredUnderSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      throw new TypeError(`plur.learn: invalid measured_under — ${issues}. Every dimension must be a string.`)
    }
    return parsed.data
  }

  /**
   * The input gate every learn path runs before touching a store.
   *
   * The statement must be a non-empty string; line terminators are collapsed
   * so a crafted boundary cannot be promoted to system-prompt authority by the
   * renderer's splitter (#952, #940); the type must be a known engram type —
   * checked BEFORE the secret scan (#729) so a bad type fails loudly even when
   * the statement would also trip the detector; and, unless
   * `config.allow_secrets`, the statement plus every caller-supplied content
   * field — as listed by `LEARN_CONTEXT_FIELD_ROLES`, which the compiler
   * checks against `LearnContext` (#381, #389, #1002 review) — must carry no
   * secret. Shared/remote writes are additionally policy-scanned by
   * `_guardSensitiveScope`.
   *
   * `learn()` and `learnRouted()` both call it on entry. learnRouted must,
   * because on its remote route it never enters learn(): it posts the shape it
   * builds and the outbox fallback writes that same shape locally — a gate
   * living only in learn() would miss the CLI and the Python SDK, and the
   * highest-impact variant (a forged entry on a SHARED store reaching other
   * people's system prompts). Idempotent, so the local route gating twice is
   * harmless. Returns the sanitised statement, which every downstream gate
   * and the content hash must see. One function (2026-09 audit): it used to
   * be two inline copies that had already diverged on the empty-statement
   * check.
   */
  private _validateLearnInput(fn: 'learn' | 'learnRouted', statement: string, context?: LearnContext): string {
    if (typeof statement !== 'string' || statement.length === 0) {
      throw new TypeError(`plur.${fn}: statement must be a non-empty string, got ${typeof statement}`)
    }
    statement = collapseLineTerminators(statement)
    if (context?.type !== undefined && !VALID_ENGRAM_TYPES.has(context.type)) {
      throw new TypeError(
        `plur.${fn}: invalid type '${context.type}'. Must be one of: behavioral, terminological, procedural, architectural`
      )
    }
    // Pinned two-tier fields. Nothing Zod-validates an engram before save, so
    // an out-of-range priority written here would be stored verbatim — and a
    // 9999 sorts ahead of every legitimately prioritised pin.
    if (context?.pin_tier !== undefined && context.pin_tier !== 'hard' && context.pin_tier !== 'soft') {
      throw new TypeError(`plur.${fn}: invalid pin_tier '${String(context.pin_tier)}'. Must be "hard" or "soft"`)
    }
    if (context?.pinned_priority !== undefined) {
      const p = context.pinned_priority
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 100) {
        throw new TypeError(`plur.${fn}: pinned_priority must be an integer from 1 to 100, got ${String(p)}`)
      }
    }
    if (!this.config.allow_secrets) {
      // Scan the statement AND every caller-supplied content field (#381,
      // #389, #1002 review). The field set comes from ONE table,
      // `LEARN_CONTEXT_FIELD_ROLES`, checked against `LearnContext` by the
      // compiler — a hand-picked subset here is how `attribution` and
      // `license` went unscanned. Shared/remote writes are additionally
      // policy-scanned by _guardSensitiveScope below.
      const secrets = detectSecrets(this._hardScanText(statement, context))
      if (secrets.length > 0) {
        throw new Error(`Secret detected in statement or context: ${secrets[0].pattern}. Use config.allow_secrets to override.`)
      }
    }
    // D4 (2026-09 audit): `detectPromptInjection` (secrets.ts) was wired only
    // to pack installs, on the premise "a third-party pack is untrusted, my
    // own conversation is trusted." An adapter that auto-harvests engrams
    // from text an agent merely READ (a webpage it summarized, a file it was
    // asked to quote, tool output) breaks that premise: the "conversation"
    // can itself carry attacker-authored content the agent never asserted on
    // its own account.
    //
    // The signal that distinguishes the two is `claim_class: 'inferred'`
    // (#963) — "I worked this out", set by every automatic harvester
    // (opencode's self-report/user-text paths; `@plur-ai/mcp`'s
    // `plur_session_end` engram_suggestions) and never set by a human calling
    // `plur_learn` directly. Gating on it rather than on `source` (free text,
    // one string per adapter, easy to add a new harvester without updating an
    // allowlist) means a human-invoked write is untouched by construction —
    // nobody types `claim_class: 'inferred'` to describe their own assertion.
    // Refuses (does not quarantine) on a hit, mirroring the secret check just
    // above: there is no queued-for-review path for engram writes yet, and a
    // caller can still write the statement as `asserted`/omitted if it
    // genuinely came from the user.
    if (context?.claim_class === 'inferred') {
      const injections = detectPromptInjection(this._hardScanText(statement, context))
      if (injections.length > 0) {
        throw new Error(
          `Prompt injection pattern detected in an auto-harvested (claim_class: 'inferred') statement or context: `
          + `${injections[0].pattern}. Refusing the write.`,
        )
      }
    }
    return statement
  }

  /** learn()'s delegation test (#828) — the capability SET, see learn(). */
  private _learnCanDelegate(): boolean {
    const ps = this._primaryStore
    return Boolean(
      ps.findActiveByContentHash && ps.nextEngramId
      && ps.append && ps.updateMany && ps.loadByIds,
    )
  }

  /** learn()'s same-scope content-hash dedup: the store seam first (a primary
   *  match has always won), then the in-memory scan. One implementation for
   *  learn(), learnRouted(), learnAsync's hash step and {@link wouldDeduplicate}.
   *
   *  Decision A ("always store my write", owner 2026-09-27): only a hit the
   *  writer can persist absorbs the write (`hashMatch`). A match held only
   *  where the writer cannot persist it — a pack, a readonly store, another
   *  scope's remote cache — comes back as `foreign`: the caller stores a new
   *  row and records the recurrence against it in history only. */
  private async _learnHashMatch(
    statement: string, scope: string, canDelegate: boolean, allEngrams: Engram[],
  ): Promise<{ primaryHashMatch: Engram | null; hashMatch: Engram | null; foreign: Engram | null }> {
    const primaryHashMatch = canDelegate && isHashable(statement)
      ? await this._primaryStore.findActiveByContentHash!(computeContentHash(statement), scope)
      : null
    if (primaryHashMatch) return { primaryHashMatch, hashMatch: primaryHashMatch, foreign: null }
    const { hit, foreign } = await this._firstPersistableHit(
      allEngrams, this._hashDedupPredicate(statement, scope), scope,
    )
    return { primaryHashMatch: null, hashMatch: hit, foreign }
  }

  /** `_hashDedup`'s match rule as a predicate (null: nothing can match, #896). */
  private _hashDedupPredicate(statement: string, scope?: string): ((e: Engram) => boolean) | null {
    if (!isHashable(statement)) return null
    const hash = computeContentHash(statement)
    return e => e.status === 'active' && (e as any).content_hash === hash
      && (scope === undefined || e.scope === scope)
  }

  /** `_crossScopeRecurrenceDetect`'s match rule as a predicate. */
  private _crossScopePredicate(statement: string, scope: string): ((e: Engram) => boolean) | null {
    if (!isHashable(statement)) return null
    const hash = computeContentHash(statement)
    return e => e.status === 'active' && (e as any).content_hash === hash && e.scope !== scope
  }

  /**
   * Where a dedup hit lives, as far as a writer to `scope` is concerned
   * (Decision A). `primary`, a writable `secondary` path store, and
   * `own-remote` (the cache of a writable URL store for exactly `scope`) are
   * the writer's own; `pack`, `readonly` and another scope's `remote-cache`
   * are not. Every non-primary row carries the loader's `_storeScope` or
   * `_pack` stamp (`_loadSecondaryAndPacks`), so an unstamped row is primary.
   */
  private async _hitHolder(
    hit: Engram, scope: string,
  ): Promise<'primary' | 'secondary' | 'own-remote' | 'pack' | 'readonly' | 'remote-cache'> {
    if ((hit as any)._pack) return 'pack'
    const storeScope = (hit as any)._storeScope as string | undefined
    if (storeScope === undefined) return 'primary'
    const info = await this._findEngramStore(hit.id, storeScope)
    if (info) {
      if (info.path === this.paths.engrams) return 'primary'
      return info.readonly ? 'readonly' : 'secondary'
    }
    // A URL store's cache row (or a path row that vanished meanwhile — then no
    // writable URL entry matches either, and it is treated as not persistable).
    const urlEntries = (this.config.stores ?? []).filter(s => !!s.url && s.scope === storeScope)
    if (!urlEntries.some(s => s.readonly !== true)) return 'readonly'
    // Own only when a write to `scope` actually goes to that url store: with a
    // local store selected for the identical personal scope (#1515 re-audit 3,
    // L2) the write stays local, so the cached row must not absorb it.
    return storeScope === scope && this._isRemoteWriteScope(scope) ? 'own-remote' : 'remote-cache'
  }

  /** The first candidate matching `pred` that the writer can persist (`hit`),
   *  and the first one it cannot (`foreign`), in corpus order. */
  private async _firstPersistableHit(
    candidates: Engram[], pred: ((e: Engram) => boolean) | null, scope: string | undefined,
  ): Promise<{ hit: Engram | null; foreign: Engram | null }> {
    let foreign: Engram | null = null
    if (!pred) return { hit: null, foreign }
    for (const e of candidates) {
      if (!pred(e)) continue
      const holder = await this._hitHolder(e, scope ?? e.scope)
      if (holder === 'primary' || holder === 'secondary' || holder === 'own-remote') return { hit: e, foreign }
      foreign ??= e
    }
    return { hit: null, foreign }
  }

  /** Decision A for learnAsync's dedup candidates: keep only rows the writer
   *  can persist (`_hitHolder` of the row in its own scope). */
  private async _persistableCandidates(rows: Engram[]): Promise<Engram[]> {
    const out: Engram[] = []
    for (const e of rows) {
      const holder = await this._hitHolder(e, e.scope)
      if (holder === 'primary' || holder === 'secondary' || holder === 'own-remote') out.push(e)
    }
    return out
  }

  /** #176 cross-scope match over `allEngrams`, split by Decision A like
   *  {@link _learnHashMatch}. Nothing when `_crossScopeRecurrenceApplies`
   *  says a cross-scope hit may not absorb a write into `scope`. */
  private async _crossScopeMatch(
    statement: string, allEngrams: Engram[], scope: string, opts?: { creditOnly?: boolean },
  ): Promise<{ hit: Engram | null; foreign: Engram | null }> {
    // `creditOnly`: the caller only CREDITS the hit and writes anyway (the
    // remote route, #1268 A1), so the absorb rule below does not apply.
    if (!opts?.creditOnly && !this._crossScopeRecurrenceApplies(scope)) return { hit: null, foreign: null }
    const pred = this._crossScopePredicate(statement, scope)
    // #1268: for a SHARED write a shared hit is preferred, the same order as
    // `_crossScopeRecurrenceDetect`. The hit is only credited either way
    // (decision A1, `_isTeamValidation`).
    if (pred && isSharedScope(scope)) {
      const shared = await this._firstPersistableHit(allEngrams, e => pred(e) && isSharedScope(e.scope), scope)
      if (shared.hit) return shared
      const any = await this._firstPersistableHit(allEngrams, pred, scope)
      return { hit: any.hit, foreign: shared.foreign ?? any.foreign }
    }
    return this._firstPersistableHit(allEngrams, pred, scope)
  }

  /**
   * Decision A: the write was stored as `storedAs` although its statement was
   * already held by `hit`, which the writer cannot persist (pack, readonly
   * store, another scope's remote cache). The hit is NOT mutated — not on disk
   * and not in memory; the recurrence is recorded in history only.
   */
  private async _noteUnpersistableRecurrence(hit: Engram, scope: string, storedAs: string): Promise<void> {
    try {
      const heldIn = await this._hitHolder(hit, scope)
      this._appendHistory({
        event: 'recurrence_detected',
        engram_id: hit.id,
        timestamp: new Date().toISOString(),
        data: {
          previous_scope: hit.scope,
          new_scope: hit.scope,
          previous_commitment: hit.commitment ?? null,
          new_commitment: hit.commitment ?? null,
          // The hit's own count, unchanged: nothing was written to it.
          recurrence_count: (hit as any).recurrence_count ?? 0,
          from_scope: scope,
          matched: hit.scope === scope ? 'same-scope' : 'cross-scope',
          held_in: heldIn,
          persisted_to: 'history-only',
          stored_as: storedAs,
        },
      })
    } catch { /* history is an audit trail, never a gate on the write */ }
  }

  /**
   * Would `learn(statement, context)` resolve to an EXISTING engram instead of
   * writing a new one? Returns that engram's id, or null. Writes nothing.
   *
   * Same scope resolution (`_guardSensitiveScope`) and the same dedup code as
   * learn(): the same-scope hash match (store seam or scan), then cross-scope
   * recurrence over the corpus learn() scans — which on a delegating store
   * (Postgres/PGLite) deliberately excludes the primary store (scopes are a
   * permission boundary there). So a dry run — the importer's — predicts the
   * real run on every backend (R2-Retrieval core-retrieval#10 residual).
   * Covers learn()'s local dedup; secret refusal is the caller's own check.
   *
   * Decision A: a hit the writer cannot persist (pack, readonly store, another
   * scope's remote cache) does not count — learn() stores a new row — so it
   * answers null. Decision R: the importer asks this BEFORE learn() and skips
   * without writing when it answers an id.
   */
  async wouldDeduplicate(statement: string, context?: LearnContext): Promise<string | null> {
    const guarded = await this._guardSensitiveScope(statement, context)
    const scope = guarded.scope
    const canDelegate = this._learnCanDelegate()
    const allEngrams = canDelegate ? await this._loadSecondaryAndPacks() : await this._loadAllEngrams()
    const { hashMatch } = await this._learnHashMatch(statement, scope, canDelegate, allEngrams)
    if (hashMatch) return hashMatch.id
    // #1268 decision A1 (and F1 for the importer): a cross-scope hit absorbs
    // only a non-shared save. A shared save is credited and written anyway.
    const { hit } = await this._crossScopeMatch(statement, allEngrams, scope)
    return hit && !this._isTeamValidation(scope, hit) ? hit.id : null
  }

  /**
   * The scope learn() would write `statement` into (after the sensitive-scope
   * guard and routing), and whether learn()'s dedup there also matches a row
   * of ANOTHER scope in the primary store (#176 over the corpus). False on a
   * delegating store (Postgres/PGLite: scopes are a permission boundary, see
   * learn()) and for a writable-remote scope (`_crossScopeRecurrenceApplies`).
   * Writes nothing. The importer's dry run keys its in-file duplicate map with
   * it, so two records of one file in different scopes are predicted as the
   * real run treats them (dry-run parity, owner 2026-09-27).
   */
  async dedupScopeFor(statement: string, context?: LearnContext): Promise<{ scope: string; acrossScopes: boolean }> {
    const { scope } = await this._guardSensitiveScope(statement, context)
    // A shared save is never absorbed by another scope's row (#1268 decision
    // A1), so its in-file duplicates are keyed by (hash, scope) as well.
    return { scope, acrossScopes: !this._learnCanDelegate() && this._crossScopeRecurrenceApplies(scope) && !isSharedScope(scope) }
  }

  async learn(statement: string, context?: LearnContext): Promise<Engram> {
    this._assertWritable()
    statement = this._validateLearnInput('learn', statement, context)
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
      const canDelegate = this._learnCanDelegate()
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
      const { primaryHashMatch, hashMatch, foreign: sameScopeForeign } =
        await this._learnHashMatch(statement, scope, canDelegate, allEngrams)
      if (hashMatch) {
        // Decision A: `hashMatch` is a row the writer can persist (primary, a
        // writable secondary store, or the writable remote of this very
        // scope); a pack / readonly / other-remote match never gets here.
        // The store-served hit is a freshly-read row under this same lock, so
        // it is the corpus in hand for exactly one row.
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
      //
      // Decision A: only a hit the writer can persist graduates; one held in a
      // pack, a readonly store or another scope's remote cache does not absorb
      // the write — it falls through to a new row and is noted in history.
      const cross = await this._crossScopeMatch(statement, allEngrams, scope)
      // `engrams` is empty under delegation, so `_recordCrossScopeRecurrence`
      // takes its secondary-store branch — which is where every match it can
      // still see actually lives.
      if (cross.hit && !this._isTeamValidation(scope, cross.hit)) {
        return await this._recordCrossScopeRecurrence(cross.hit, engrams, scope, context)
      }
      // #1268: a shared save credits the engram it matched — personal, global
      // or another team's (decision A1) — and then falls through to write its
      // own team copy below.
      if (cross.hit) await this._recordCrossScopeRecurrence(cross.hit, engrams, scope, context)
      const unpersistableHit = sameScopeForeign ?? cross.foreign

      const id = canDelegate
        ? await ps.nextEngramId!(engramIdDatePrefix())
        : generateEngramId(allEngrams, this._mintedTodayIds())
      // Claim it in-process immediately (#816). The history record is written
      // later and best-effort; without this, two writes in the same tick — or
      // one whose history append fails — could both take the same suffix.
      this._rememberMintedId(id)
      const now = new Date().toISOString()
      // One constructor for every write path: `_buildEngramShape` is what the
      // remote route posts, so a field added there is a field added here.
      const engram: Engram = {
        ...this._buildEngramShape(statement, scope, context, now, validity, id => this._ancestorsOf(engrams, id), guarded.scopeSource),
        id,
      }
      // Hard-tier cap: AFTER dedup (a re-learn that folds into an existing
      // engram creates no row and must not be charged), on the engram as it
      // will be committed, and inside the lock the write commits under.
      await this._assertHardTierFits(engram)

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
      // #1115 mirror: a shared scope matched and was refused. Stamped the same
      // way and only when present, so a caller can report what did NOT happen.
      if (guarded.refusedShared) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _routeRefused: guarded.refusedShared,
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
        // Idempotency key for this write (2026-09-29 audits): random, minted
        // once, persisted on the outbox entry, never derived from an id.
        const pushKey = randomUUID()
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
              // One key per logical write, reused by every retry of it.
              idempotency_key: pushKey,
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
        // Started only once the local write has committed (#1178, F16). A
        // transactional primary store would otherwise hand this task the
        // write's own connection, which is gone by the time it runs. A
        // rolled-back write never launches it, so nothing is marked in flight.
        this._afterStoreCommit(() => {
          this._outboxInFlight.add(engram.id)
          void (async () => {
            // One pusher per entry (2026-09-29 panel, M6): a flush that started
            // between the local write and this push must not POST it too.
            if (this._claimOutboxEntry(engram.id, () => pushKey).status === 'busy') return
            let pushed = false
            // Decision D1: keep the id the server assigned — if a forget/rescope
            // cancels the delivery while this POST is on the wire, the accepted
            // remote copy is queued for retirement by that id.
            let serverId: string | undefined
            try {
              ;({ id: serverId } = await remoteDriver.appendAndGetServerId(engram, { idempotencyKey: pushKey }))
              pushed = true
            } catch (err) {
              // The POST did not land. The in-flight claim is still held, and is
              // released only by the `finally` below, AFTER this bookkeeping
              // write (review of #1231): released before it, another writer could
              // take the row in the gap and put its own POST on the wire.
              // Already saved locally with outbox metadata — will be retried.
              logger.warning(`[plur:outbox] immediate push failed for ${engram.id}, queued for retry: ${(err as Error).message}`)
              await this._withStoreLock(this.paths.engrams, async () => {
                // Targeted read (#827): only this engram's outbox bookkeeping.
                const fresh = await this._loadTargeted([engram.id])
                const target = fresh.find(e => e.id === engram.id) as any
                if (target?.structured_data?._outbox) {
                  target.structured_data._outbox.last_error = (err as Error).message
                  target.structured_data._outbox.attempt_count = 1
                  // #1299: the status, when the remote gave one — it is what
                  // tells a refusal from a blip.
                  if (err instanceof RemoteHttpError) target.structured_data._outbox.last_status = err.status
                }
                if (target?.structured_data?._outbox) {
                  // Incremental write (#740): only the outbox bookkeeping changed.
                  await this._updateEngrams(fresh, [target as Engram])
                }
              })
              this._releaseOutboxClaim(engram.id)
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
                // Hand off only a row that is STILL queued FOR THIS STORE. A
                // forget() or a local rescope that landed while the POST was in
                // flight cancelled the delivery (#766, #848); a D4 update or a
                // rescope to another store RETARGETED it (audit of #1228,
                // finding 1) — the row still carries `_outbox`, but for a store
                // that has not received it. Deleting the row in either case
                // loses a decision; keep it and say so.
                const pushedTarget = storeEntry ? { url: storeEntry.url!, scope } : undefined
                if (idx !== -1 && !Plur._stillQueuedFor(fresh[idx], pushedTarget)) {
                  const retargeted = Plur._stillQueued(fresh[idx])
                  // Decision D1: queue a durable "retire on remote" entry for the
                  // copy the remote just accepted; flushOutbox() retries it (and,
                  // for a retargeted row, before it delivers to the new store).
                  const queuedRetire = serverId
                    ? Plur._queueRetireRemote(fresh[idx], {
                        target_url: pushedTarget?.url ?? '',
                        target_scope: scope,
                        server_id: serverId,
                      }, new Date().toISOString())
                    : false
                  if (queuedRetire) await this._updateEngrams(fresh, [fresh[idx]])
                  logger.warning(
                    `[plur:outbox] ${engram.id} reached the remote${serverId ? ` as ${serverId}` : ''} after its delivery `
                    + (retargeted
                      ? `was retargeted to another store during the push. The local record stays queued for the new store`
                      : `was cancelled locally (forget/rescope during the push). The local record is kept`)
                    + (queuedRetire
                      ? `; the old copy is queued for retirement and the next flush retires it.`
                      : `; the remote copy must be retired there.`),
                  )
                  return
                }
                if (idx !== -1) {
                  fresh.splice(idx, 1)
                  // Deliberate removal: the remote accepted this engram, so the
                  // local copy is redundant by design (audit #794 shrink guard).
                  await this._writeEngrams(this.paths.engrams, fresh, { allowShrink: true })
                  await this._syncIndex()
                }
              })
            } catch (err) {
              // Retried by the next flush with the same key (decision C4): a
              // key-honouring server collapses it; one that ignores keys may
              // hold one duplicate.
              logger.warning(
                `[plur:outbox] ${engram.id} was accepted by the remote but its local copy could not be removed: `
                + `${(err as Error).message}. The next flush will retry it with the same idempotency key.`,
              )
            } finally {
              this._releaseOutboxClaim(engram.id)
            }
          })().catch(err => {
            logger.warning(`[plur:outbox] background push for ${engram.id} failed unexpectedly: ${(err as Error).message}`)
          }).finally(() => { this._outboxInFlight.delete(engram.id) })
        })

        this._appendHistory({
          event: 'engram_created',
          engram_id: engram.id,
          timestamp: now,
          data: { type: engram.type, scope: engram.scope, source: engram.source, routed_to: 'remote', outbox: true },
        })
        if (unpersistableHit) await this._noteUnpersistableRecurrence(unpersistableHit, scope, engram.id)
        this._maybeWriteProvenance(engram.id)
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
      this._appendHistory({
        event: 'engram_created',
        engram_id: engram.id,
        timestamp: now,
        data: { type: engram.type, scope: engram.scope, source: engram.source },
      })
      if (unpersistableHit) await this._noteUnpersistableRecurrence(unpersistableHit, scope, engram.id)
      this._maybeWriteProvenance(engram.id)
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

      // Carry the neighbour's own text, not just its id. Reporting id+score
      // alone makes "read the neighbour first" an extra tool call, and that
      // call does not get made (2026-09-07: four near-identical engrams in one
      // session, every one reporting an unread 0.86-0.87 neighbour).
      const ranked = scored
        .map(s => ({
          id: s.engram.id,
          score: s.score,
          statement: s.engram.statement.length > 240
            ? `${s.engram.statement.slice(0, 240)}…`
            : s.engram.statement,
        }))
        .sort((a, b) => b.score - a.score)
      const top = ranked[0]
      if (top.score >= NEAR_DUPLICATE_OBSERVATION_FLOOR) {
        try {
          this._appendHistory({
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

  async learnRouted(statement: string, context?: LearnContext, options?: LearnRoutedOptions): Promise<Engram> {
    // 0.21.1: the caller's deadline for the server leg ONLY. Local work (load,
    // dedup, write, index) is never raced: a slow local save is a success. A
    // server that does not answer inside the deadline takes the existing
    // outbox fallback, so the engram is always stored somewhere. Before, the
    // CLI raced the WHOLE call against 5 s and exited while core was still
    // waiting on its 30 s request, so a hanging team server lost the save.
    const remoteTimeoutMs = options?.remoteTimeoutMs
    if (remoteTimeoutMs !== undefined && !(Number.isFinite(remoteTimeoutMs) && remoteTimeoutMs > 0)) {
      throw new TypeError('plur.learnRouted: remoteTimeoutMs must be a positive number of milliseconds')
    }
    this._assertWritable()
    statement = this._validateLearnInput('learnRouted', statement, context)
    const guarded = await this._guardSensitiveScope(statement, context)
    const scope = guarded.scope
    context = guarded.context
    // #347: fail fast on malformed valid_from/valid_until (pure validation),
    // mirroring learn() — before dedup can short-circuit the write.
    resolveValidity(statement, context)
    const remoteDriver = this._resolveRemoteStoreForScope(scope)
    // #90, formal WritePath candidate 4: an engram the caller explicitly marked
    // private does not go to a remote store. learn() has always refused it
    // (and warns); this path never checked, so the same input left the machine
    // or not depending on which method was called. Take the local route and let
    // learn() apply its #90 branch.
    if (!remoteDriver || context?.visibility === 'private') {
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
      // #1115 mirror: a shared scope matched and was refused. Stamped the same
      // way and only when present, so a caller can report what did NOT happen.
      if (guarded.refusedShared) {
        ;(engram as any).structured_data = {
          ...((engram as any).structured_data ?? {}),
          _routeRefused: guarded.refusedShared,
        }
      }
      return engram
    }
    // Remote route — dedup against the merged local+cached-remote view,
    // then POST and merge the server-assigned ID into the local engram
    // representation we hand back to the caller. On failure, save to
    // local outbox for retry (issue #26).
    const allEngrams = await this._loadAllEngrams()
    // Decision A: a same-scope match only in a pack or a readonly store does
    // not absorb the write; it is POSTed and the match noted in history.
    const { hit: hashMatch, foreign: unpersistableHit } = await this._firstPersistableHit(
      allEngrams, this._hashDedupPredicate(statement, scope), scope,
    )
    if (hashMatch) {
      // Mutate + persist if local; otherwise return mutated (best-effort)
      return await this._withStoreLock(this.paths.engrams, async () => {
        const engrams = await this._primaryStore.load()
        return await this._recordDuplicate(hashMatch, engrams, scope, context, statement)
      })
    }
    // #176 cross-scope recurrence does NOT absorb here: this is the remote
    // route, and an explicit write to a team store must reach it
    // (`_crossScopeRecurrenceApplies`). Only the same-scope match above
    // absorbs a write. A cross-scope hit is still CREDITED (#1268 A1).
    const { hit: crossMatch } = await this._crossScopeMatch(statement, allEngrams, scope, { creditOnly: true })
    if (crossMatch) {
      // #1268: decided BEFORE the recurrence is recorded, exactly as learn()
      // does — recording can broaden `crossMatch` to global, and reading the
      // flag afterwards turned an absorbed save into a second team write.
      const teamValidation = this._isTeamValidation(scope, crossMatch)
      const credited = await this._withStoreLock(this.paths.engrams, async () => {
        const engrams = await this._primaryStore.load()
        return await this._recordCrossScopeRecurrence(crossMatch, engrams, scope, context)
      })
      // A team validation of a non-shared engram does not stand in for the
      // team write — fall through and POST the team copy. Nor does any
      // cross-scope hit for a remote write scope (see above).
      if (!teamValidation && this._crossScopeRecurrenceApplies(scope)) return credited
    }
    const now = new Date().toISOString()
    const localPlaceholder = this._buildEngramShape(statement, scope, context, now, undefined, undefined, guarded.scopeSource)
    // Stamp the auto-route marker on the remote-routed shape (Stage 3b, #351) so
    // the decision survives onto the server engram and into the MCP response.
    if (guarded.routed) {
      ;(localPlaceholder as any).structured_data = {
        ...((localPlaceholder as any).structured_data ?? {}),
        _routed: guarded.routed,
      }
    }
    if (guarded.refusedShared) {
      ;(localPlaceholder as any).structured_data = {
        ...((localPlaceholder as any).structured_data ?? {}),
        _routeRefused: guarded.refusedShared,
      }
    }
    // Hard-tier cap on the remote route. The engram is built here and POSTed,
    // so this is a write path that produces a hard-tier engram exactly like
    // learn() — and so is the local fallback below. Both run under ONE hold of
    // the store lock, taken only for a hard-tier write so ordinary remote
    // writes keep their lock-free POST. The cost is estimated with an id of
    // the longest shape either outcome can carry (the server's id, or a local
    // one), since neither is known until after the POST.
    if (isHardPinned(localPlaceholder as never)) {
      return await this._withStoreLock(this.paths.engrams, async () => {
        await this._assertHardTierFits({ ...localPlaceholder, id: 'ENG-XXXXXX-0000-00-00-000' })
        return await this._commitRemoteRouted(localPlaceholder, remoteDriver, scope, now, allEngrams, unpersistableHit, true, remoteTimeoutMs)
      })
    }
    return await this._commitRemoteRouted(localPlaceholder, remoteDriver, scope, now, allEngrams, unpersistableHit, false, remoteTimeoutMs)
  }

  /**
   * The commit half of `learnRouted`'s remote route: POST, or on failure save
   * locally with an outbox marker. `lockHeld` says whether the caller already
   * holds the primary store lock (a hard-tier write does, so its admission
   * check and its fallback save observe one state); the lock is not reentrant,
   * so the fallback takes it only when the caller does not.
   */
  private async _commitRemoteRouted(
    localPlaceholder: Engram,
    remoteDriver: RemoteStore,
    scope: string,
    now: string,
    allEngrams: Engram[],
    /** Decision A: a same-scope match held only in a pack or readonly store, noted in history. */
    unpersistableHit: Engram | null,
    lockHeld: boolean,
    /** The caller's deadline for the POST (0.21.1). Unset: the driver's own 30 s. */
    remoteTimeoutMs?: number,
  ): Promise<Engram> {
    let serverEngram: Engram
    // Idempotency key for this write (2026-09-29 audits). The placeholder's id
    // is `__pending__` on EVERY direct write, so it can never be the key: a
    // server honouring the contract would collapse them all into the first.
    const writeKey = randomUUID()
    try {
      // AbortSignal.timeout is unref'd: it never keeps a one-shot CLI alive.
      const signal = remoteTimeoutMs !== undefined ? AbortSignal.timeout(remoteTimeoutMs) : undefined
      try {
        const { id: serverId } = await remoteDriver.appendAndGetServerId(localPlaceholder, { idempotencyKey: writeKey, signal })
        serverEngram = { ...localPlaceholder, id: serverId }
      } catch (inner) {
        // Say what happened in words a person can act on: the caller's
        // deadline passed with no answer. Recorded as the outbox's last_error.
        if (inner instanceof RemoteAbortedError && remoteTimeoutMs !== undefined) {
          throw new Error(`the server did not answer within ${remoteTimeoutMs}ms (unreachable or not responding)`)
        }
        throw inner
      }
    } catch (err) {
      // Remote failed — save locally with outbox metadata for retry.
      // Audit iter-1 fix (Dijkstra): defensive lookup; the catch is the
      // graceful-fallback path that must never throw. If no writable entry
      // matches the scope (e.g. readonly remote), we still save the local
      // engram but omit the outbox marker — the retry path will skip it.
      const storeEntry = (this.config.stores ?? []).find(s => s.url && s.scope === scope && !s.readonly)
      const saveFallback = async () => {
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
              // The same key the failed attempt carried: if that POST did land
              // (a timeout after the server stored it), the retry is collapsed.
              idempotency_key: writeKey,
              // #1299: recorded so the outbox can be classified without
              // parsing the message.
              ...(err instanceof RemoteHttpError ? { last_status: err.status } : {}),
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
        this._appendHistory({
          event: 'engram_created',
          engram_id: localPlaceholder.id,
          timestamp: now,
          data: { type: localPlaceholder.type, scope, source: localPlaceholder.source, routed_to: 'outbox', error: (err as Error).message },
        })
        if (unpersistableHit) await this._noteUnpersistableRecurrence(unpersistableHit, scope, localPlaceholder.id)
        this._maybeWriteProvenance(localPlaceholder.id)
        logger.warning(`[plur:outbox] remote write failed for ${localPlaceholder.id}, queued for retry: ${(err as Error).message}`)
        return localPlaceholder
      }
      return lockHeld ? await saveFallback() : await this._withStoreLock(this.paths.engrams, saveFallback)
    }

    // History is appended OUTSIDE the try that guards the remote write (#813,
    // audit finding 13). It used to sit inside it, so a history failure —
    // EACCES, disk full — after the server had already persisted the engram was
    // caught as a REMOTE failure: the fallback then created a second local
    // engram plus an outbox entry, and the next flush duplicated it remotely.
    // A bookkeeping write must never be able to undo, or appear to undo, a
    // commit that succeeded.
    try {
      this._appendHistory({
        event: 'engram_created',
        engram_id: serverEngram.id,
        timestamp: now,
        data: { type: serverEngram.type, scope: serverEngram.scope, source: serverEngram.source, routed_to: 'remote' },
      })
      if (unpersistableHit) await this._noteUnpersistableRecurrence(unpersistableHit, scope, serverEngram.id)
      this._maybeWriteProvenance(serverEngram.id)
    } catch (err) {
      logger.warning(
        `[plur] engram ${serverEngram.id} was stored remotely but its history record could not be ` +
        `written: ${(err as Error).message}. The engram is safe; the local audit trail is incomplete.`,
      )
    }
    this._remoteDelivered.add(serverEngram)
    return serverEngram
  }

  /**
   * Where a learn result went, and a warning when that is not where a reader
   * would assume (#1264).
   *
   * A write to a shared scope (`group:`, `project:`, `org:` …) with no writable
   * url store registered for exactly that scope falls through to the local
   * primary store. That is deliberate — nothing is auto-routed into a shared
   * store — but it used to be silent, so a team save could sit on one machine
   * indefinitely while the caller was told only `ADD`. This reports it.
   *
   * Pure: reads the returned engram and the store config, never the network,
   * and changes nothing about where anything was written. Pass the object
   * `learn()` / `learnRouted()` returned; a copy loses the `remote` evidence.
   *
   * `requestedScope` (audit F8): the scope the caller asked for. When the save
   * came back as an engram in a DIFFERENT scope — recorded as a recurrence on
   * another team's engram, or on a `global` one — nothing was written to the
   * requested shared scope, so the result is `local` for that scope and the
   * warning names the requested scope, not the one it landed in. A sensitive-
   * content demotion is excluded: it already carries its own warning.
   */
  deliveryOf(engram: Engram, requestedScope?: string): {
    delivery: LearnDelivery
    warning?: string
    /** Only for `outbox`: why it was queued, in plain words, with what to do. */
    reason?: string
    reason_code?: OutboxReasonCode
  } {
    const e = engram as any
    const stores = this.config.stores ?? []
    if (requestedScope && requestedScope !== engram.scope && isSharedScope(requestedScope)
        && !e.structured_data?._demoted) {
      return {
        delivery: 'local',
        warning: `You saved to shared scope "${requestedScope}", but this matched an existing engram in ` +
          `"${engram.scope}" and was recorded on it as a recurrence. Nothing was written to ` +
          `"${requestedScope}" or sent to its store, so that team will not see it.`,
      }
    }
    let delivery: LearnDelivery
    if (this._remoteDelivered.has(engram)) delivery = 'remote'
    else if (e.structured_data?._outbox) delivery = 'outbox'
    else if (typeof e._storeScope === 'string') {
      // A dedup/recurrence hit on a row read from a secondary store: it lives
      // wherever the store that SERVED it lives. Classified by the loader's
      // `_fromRemoteStore` marker, never by the scope's first store entry — a
      // url store and a path store can share one scope (formal replay, cluster 1).
      delivery = e._fromRemoteStore === true ? 'remote' : 'local'
    } else delivery = 'local'
    if (delivery === 'outbox') return { delivery, ...this._outboxReason(engram) }
    if (delivery !== 'local' || !isSharedScope(engram.scope)) return { delivery }

    const scope = engram.scope
    const urlStores = stores.filter(s => !!s.url && s.scope === scope)
    let why: string
    // `visibility` defaults to 'private' on every engram, so it cannot tell an
    // explicitly private write apart here; the store config can.
    if (urlStores.length > 0 && urlStores.every(s => s.readonly === true)) {
      why = 'the store registered for it is read-only, so this engram was saved on this machine only'
    } else if (urlStores.length > 0) {
      why = 'this engram was not sent to the store registered for it (an explicitly private write, or a match ' +
        'with a copy already saved on this machine)'
    } else {
      why = 'no remote store is registered for exactly that scope, so this engram was saved on this machine only'
    }
    return {
      delivery,
      warning: `Scope "${scope}" is shared, but ${why}. No one else will see it. ` +
        `To share this scope, register a writable store for "${scope}" ` +
        `(plur_stores_add with url, token and scope "${scope}", or a url store in ~/.plur/config.yaml). ` +
        `Engrams already saved here are not moved automatically.`,
    }
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
  /**
   * Why an outbox engram was queued (0.21.1), from the failure recorded on it.
   * Pure: reads `_outbox`, never the network. Uses the outbox classifier so
   * this line, `plur outbox` and `plur doctor` agree on the cause.
   */
  private _outboxReason(engram: Engram): { reason: string; reason_code: OutboxReasonCode } {
    const ob = (engram as any).structured_data?._outbox as
      { target_scope?: string; last_status?: number; last_error?: string; auth_failed?: boolean } | undefined
    const scope = ob?.target_scope ?? engram.scope
    const v = classifyOutboxFailure({
      last_status: ob?.last_status, last_error: ob?.last_error, scope,
      has_store: (this.config.stores ?? []).some(s => !!s.url && s.scope === scope && s.readonly !== true),
    })
    const status = ob?.last_status
    const queued = `Saved on this machine and queued for ${scope}`
    if (v.state === 'needs_action' && (status === 401 || status === 403 || ob?.auth_failed === true)) {
      return {
        reason_code: 'auth_rejected',
        reason: `${queued}: the store rejected the token${status ? ` (HTTP ${status})` : ''} — it is expired, revoked or lacks write access. ` +
          `Check it with \`plur login --status\`, refresh the token for ${scope} in config.yaml, then run \`plur outbox --flush\`.`,
      }
    }
    if (v.state === 'needs_action' && v.reason?.startsWith('no writable store')) {
      return { reason_code: 'no_store', reason: `${queued}: ${v.reason}. ${v.next_step ?? ''}`.trim() }
    }
    if (v.state === 'needs_action' || (typeof status === 'number' && status >= 400)) {
      return {
        reason_code: 'server_error',
        reason: `${queued}: ${v.reason ?? `the store answered HTTP ${status}`}.${v.next_step ? ` Next: ${v.next_step}.` : ' It is retried on the next session start or `plur outbox --flush`.'}`,
      }
    }
    return {
      reason_code: 'unreachable',
      reason: `${queued}: the server is unreachable (${ob?.last_error ?? 'no answer'}). ` +
        `It is retried on the next session start or \`plur outbox --flush\`.`,
    }
  }

  readIdFor(engram: { id: string; scope: string }): string {
    if (!this._isRemoteBackedScope(engram.scope)) return engram.id
    return namespaceEngramId(engram.id, engram.scope)
  }

  /**
   * THE engram constructor — the one place the shape of a new engram is
   * written down (2026-09 audit; it used to be duplicated inline in `learn()`,
   * so every new field had to be added twice).
   *
   * Builds without persisting: `learn()` spreads the result and sets the id it
   * minted; `learnRouted()` posts it to the remote, which assigns the id, and
   * on failure mints a local id for the outbox copy. Neither acquires the
   * lock nor touches disk here. `validity` (#347) is taken from callers that
   * already resolved it — learn() fails fast on a malformed window before
   * taking the lock — and derived otherwise.
   */
  private _buildEngramShape(
    statement: string,
    scope: string,
    context: LearnContext | undefined,
    now: string,
    validity: ResolvedValidity = resolveValidity(statement, context),
    /**
     * Recorded ancestors of an engram, for the derivation chain (#958).
     * learn() passes a lookup over the corpus it already holds; the remote
     * route passes nothing — it holds no engram list, and reading the store
     * would put disk I/O in the middle of a remote write — so its chain
     * carries the immediate ancestors only. Section 2.1 of the profile makes
     * the history log authoritative over the chain precisely so a shortcut
     * may be incomplete.
     */
    ancestorsOf: (id: string) => string[] = () => [],
    /**
     * Who chose `scope` (#1221). Defaulted from the context so a direct call
     * to this constructor produces the same shape the write paths do — they
     * pass the guard's answer, which also knows about session scopes and the
     * router, neither of which is visible from here.
     */
    scopeSource: ScopeSource = context?.scope != null ? 'explicit' : 'default',
  ): Engram {
    const type = context?.type ?? 'behavioral'
    const cogLevel = TYPE_TO_COGNITIVE[type] ?? 'remember'
    const memoryClass = context?.memory_class ?? TYPE_TO_MEMORY_CLASS[type] ?? 'semantic'
    const commitment = context?.commitment ?? 'leaning'
    const shape: Engram = {
      // Placeholder id — learn() overwrites it with the id it minted and
      // learnRouted with the server's assigned id before anything observes it.
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
      // Who is answerable (#961) and what kind of claim this is (#963).
      // Both absent when the caller supplied nothing: a missing agent is
      // honest, a guessed one is not.
      attribution: buildAttribution(context, this._configuredIdentity()),
      claim_class: context?.claim_class,
      provenance: buildProvenanceBlock(context, ancestorsOf),
      dual_coding: context?.dual_coding,
      polarity: null,
      content_hash: computeContentHash(statement),
      commitment,
      locked_at: commitment === 'locked' ? now : undefined,
      locked_reason: commitment === 'locked' ? context?.locked_reason : undefined,
      created_at: now,
      updated_at: now,
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
      pinned_tier: context?.pin_tier,
      pinned_priority: context?.pinned_priority,
      // #869: measurement context — present only when the caller supplies it.
      measured_under: this._validatedMeasuredUnder(context),
    }
    // Echo marker for extracted expiry (#347) — mirrors the learn() stamping
    // so the remote-routed MCP response can confirm the parse too.
    //
    // #1221 joins it here rather than being stamped by each caller afterwards.
    // Both write paths run through this constructor, so putting it here is what
    // makes them agree by construction instead of by two parallel stamps that
    // can drift — the property test/write-path-consolidation.test.ts and
    // test/leak-surface.test.ts both exist to hold.
    //
    // Unlike every other marker it is unconditional: "the caller named it" is
    // as much an answer as "the router guessed it", and a field present on only
    // some writes cannot be read as an answer on the rest.
    ;(shape as any).structured_data = {
      ...(validity.extracted
        ? { _expiry_extracted: { valid_until: validity.extracted.valid_until, phrase: validity.extracted.phrase } }
        : {}),
      _scopeSource: scopeSource,
    }
    return shape
  }

  /** Build deps for learn-async module. */
  private async _learnAsyncDeps() {
    return {
      // Decision A: only a hit the writer can persist is a NOOP; a pack /
      // readonly / other-remote match falls through to learn(), which stores
      // the write and notes the match in history.
      hashDedup: async (statement: string, scope?: string) => (await this._firstPersistableHit(
        await this._loadAllEngrams(), this._hashDedupPredicate(statement, scope), scope,
      )).hit,
      // remote:false (#776) — dedup queries are DERIVED FROM STATEMENTS. With
      // the remote leg on, every plur_learn would fire statement-derived POSTs
      // to all hosts, and a namespaced remote row could silently suppress a
      // local write as a "dedup match". Dedup is a local decision.
      //
      // Decision A (follow-up, owner 2026-09-27): these results are the
      // LLM/cosine candidates learnAsync may NOOP/UPDATE/MERGE into, so only
      // rows the writer can persist are offered. A pack / readonly / other-
      // scope remote-cache row is dropped; with nothing left the write is an
      // ADD through learn(), which notes an exact match in history only.
      // learnAsync keeps only candidates in the requested scope, so each row
      // is judged against its own scope (== the writer's when one is given).
      recallHybrid: async (query: string, options?: { limit?: number }) =>
        this._persistableCandidates(await this.recallHybrid(query, { ...options, remote: false })),
      recall: async (query: string, options?: { limit?: number }) =>
        this._persistableCandidates(await this.recall(query, { ...options, remote: false })),
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
    return learnAsyncImpl(await this._learnAsyncDeps(), statement, this._canonicalLearnContext(context))
  }

  /**
   * Fold a personal `user:` scope to its configured store's scope BEFORE the
   * async/batch hash dedup runs, so dedup looks in the namespace the write
   * will land in (re-audit N5). Same rule as `_guardSensitiveScope`.
   */
  private _canonicalLearnContext<C extends { scope?: string } | undefined>(context: C): C {
    if (!context?.scope) return context
    const scope = this._canonicalPersonalScope(context.scope)
    return scope === context.scope ? context : { ...context, scope } as C
  }

  /** Batch learn with LLM dedup. LLM calls are capped (default 50) to bound bulk-import cost. */
  async learnBatch(
    statements: Array<{ statement: string; context?: LearnAsyncContext }>,
    llm?: LlmFunction,
    opts?: { maxLlmCalls?: number },
  ): Promise<LearnBatchResult> {
    this._assertWritable()
    const { learnBatch: learnBatchImpl } = await import('./learn-async.js')
    return learnBatchImpl(
      await this._learnAsyncDeps(),
      statements.map(s => ({ ...s, context: this._canonicalLearnContext(s.context) })),
      llm,
      opts,
    )
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
    // fire-and-forget — never disturbs the recall path. Both backends report
    // the RRF fusion top score (decision I4 — the PGLite path returned null,
    // which read as `no_results` whenever it found something).
    //
    // One retrieval leg (embeddings off by choice, or the embedder failed —
    // `mode` is not 'hybrid'): the threshold (I3, 0.025) sits between 1/61 and
    // 2/61 and is calibrated for TWO legs, so every non-empty one-leg recall
    // would read as `low_score`. Offer only `no_results` then (follow-up to
    // I3, round 2): a weak one-leg top hit is not evidence of a miss.
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
    // Decision I4 "rrf" (2026-09-26): report the top candidate's RRF fusion
    // score, captured BEFORE the rerank exactly as hybridSearchWithMeta does,
    // so the miss-signal classifies a PGLite recall the same way as a YAML one.
    // It was null here, and classifyMiss reads null-with-results as
    // `no_results` — every PGLite recall that FOUND something was reported as
    // a miss. Same k (60) and the same two lists the merge just fused.
    const topScore = merged.length > 0 ? rrfScoreOf(merged[0].id, [bm25Results, pgHits]) : null
    const reranked = await applyReranker(merged, query, rerank)
    const mode: HybridSearchResult['mode'] = status.disabled ? 'bm25-only' : 'hybrid'
    return { engrams: reranked.engrams.slice(0, limit), mode, embedderError: null, topScore, reranked: reranked.count }
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
    _resetCrossEncoderCaches()
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

  /**
   * Get several engrams by ID (#1310). The primary store is read by primary
   * key; only ids it does not hold fall back to the full walk over stores and
   * packs, once. Ids that exist nowhere are simply absent from the result.
   *
   * Remote stores: the walk only peeks at their in-process cache, which is
   * empty in a fresh process (a hook). With `remoteCapability`, ids still
   * missing after the walk are fetched BY ID from each url store whose server
   * advertises that capability, and whose namespace prefix the id carries
   * (#1318 review). A store without the capability is never asked. Bounded:
   * one GET per id (the REST surface has no batch-by-id route), in parallel,
   * at most {@link GET_BY_IDS_REMOTE_CAP} per store, each on the driver's
   * bounded fetch. Without the option nothing is fetched — unchanged.
   */
  async getByIds(ids: string[], options?: { remoteCapability?: string }): Promise<Engram[]> {
    const wanted = [...new Set(ids.filter(Boolean))]
    if (wanted.length === 0) return []
    const primary = (await this._loadTargeted(wanted)).filter(e => wanted.includes(e.id))
    const found = new Set(primary.map(e => e.id))
    let missing = wanted.filter(id => !found.has(id))
    if (missing.length === 0) return primary
    const rest = (await this._loadAllEngrams()).filter(e => missing.includes(e.id))
    for (const e of rest) found.add(e.id)
    missing = missing.filter(id => !found.has(id))
    const remote = options?.remoteCapability && missing.length > 0
      ? await this._fetchRemoteByIds(missing, options.remoteCapability)
      : []
    return [...primary, ...rest, ...remote]
  }

  private async _fetchRemoteByIds(ids: string[], capability: string): Promise<Engram[]> {
    const out: Engram[] = []
    const taken = new Set<string>()
    for (const entry of (this.config.stores ?? [])) {
      if (!entry.url) continue
      const prefixRe = new RegExp(`^(ENG|ABS|META)-${storePrefix(entry.scope)}-`)
      const mine = ids.filter(id => !taken.has(id) && prefixRe.test(id)).slice(0, GET_BY_IDS_REMOTE_CAP)
      if (mine.length === 0) continue
      const driver = this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })
      if (!(await driver.hasCapability(capability))) continue
      const rows = await Promise.all(mine.map(async id => {
        const row = await driver.getById(this._stripRemotePrefix(id, entry.scope))
        return row ? { id, row } : null
      }))
      for (const hit of rows) {
        if (!hit) continue
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
      // #1150: instants compared as instants. The lexical form this replaces
      // read `valid_until: 2026-09-07T01:00:00Z` as still valid at noon that
      // day, and a `valid_from` of the same shape as not yet reached.
      const nowMs = Date.now()
      out = out.filter(e => isCurrentlyValid(e.temporal, nowMs))
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

  /**
   * Per-entry push claims — the one duplicate-push guard (decision C3). A
   * claim is a small file created with O_EXCL, so two writers — two flushes,
   * or a flush and learn()'s background push, in one process or several —
   * cannot both push an entry at once. It is released once the push's outcome
   * is recorded (or the flush ends); a claim left by a process that died is
   * taken over (see `_claimOutboxEntry`), and the write is simply retried with
   * the key already on its outbox row (decision C4). A claim guards the row,
   * not a snapshot: whoever takes it re-reads the row before pushing.
   */
  outboxClaimsDir(): string {
    return join(this.paths.root, 'cache', 'outbox-claims')
  }

  /** Token of each claim this instance holds, so a release removes only its own. */
  private _outboxClaimTokens = new Map<string, string>()

  private _outboxClaimPath(id: string): string {
    return join(this.outboxClaimsDir(), `${id.replace(/[^\w.-]/g, '_')}.json`)
  }

  /**
   * Take the claim on an outbox entry. `busy` when another live writer holds
   * it. A lapsed claim (its process is gone, or its lease expired) is taken
   * over. `keyFor` supplies the key recorded in the claim.
   *
   * Every decision is made by O_EXCL, never by reading and comparing (decision
   * C3; the review of #1277 measured more than one winner in 79 of 80 rounds
   * of 6 processes racing the read-compare-rename takeover this replaces):
   *
   * - **A free entry**: the claim is published with `link(2)`, which fails
   *   with EEXIST when the path exists. Its content is written first, so no
   *   reader ever sees a half-written claim and mistakes it for a lapsed one.
   * - **A lapsed claim**: the right to replace it is a takeover marker,
   *   `<claim>.takeover-<tag>`, where `<tag>` names that exact stale content.
   *   Of any number of racers exactly one can create it. The winner re-reads
   *   the claim under it (it must still be the stale one), renames a fresh
   *   claim over it, and removes the marker. The claim path is never empty
   *   during a takeover. A late racer that creates the marker after it was
   *   removed finds a different claim on the re-read and backs off.
   * - **A marker whose holder died** before it renamed would wedge the entry,
   *   so it is judged by the same liveness rule as a claim and replaced the
   *   same way: by a marker named after IT (`…-<tag>-<tag>`), created with
   *   O_EXCL. A dead marker is removed only once the stale claim it guards
   *   has changed hands, so two racers can never win at two levels at once.
   *
   * Never throws: if the claim cannot be recorded at all, the push goes ahead
   * unclaimed rather than never.
   */
  private _claimOutboxEntry(
    id: string,
    keyFor: () => string,
  ): { status: 'busy' } | { status: 'claimed'; key: string } {
    const path = this._outboxClaimPath(id)
    const readRaw = (at: string): string | undefined => {
      try { return fs.readFileSync(at, 'utf8') } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    }
    const heldBy = (raw: string): boolean => {
      let held: { pid?: number; host?: string; until?: number; at?: number } = {}
      try { held = JSON.parse(raw) } catch { /* unreadable: lapsed */ }
      return this._outboxClaimHeld(held, Date.now())
    }
    /** Create `target` holding `body` only if nothing is there (O_EXCL). */
    const publishExclusive = (target: string, body: string): boolean => {
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
      fs.writeFileSync(tmp, body)
      try {
        fs.linkSync(tmp, target)
        return true
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return false
        // A filesystem without hard links: O_EXCL on open instead.
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') {
          try { fs.writeFileSync(target, body, { flag: 'wx' }); return true } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
            throw e
          }
        }
        throw err
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }
    try {
      fs.mkdirSync(this.outboxClaimsDir(), { recursive: true })
      const stale = readRaw(path)
      if (stale !== undefined && heldBy(stale)) return { status: 'busy' }
      const key = keyFor()
      const token = randomUUID()
      const at = Date.now()
      const owner = { token, pid: process.pid, host: hostname(), at, until: at + OUTBOX_CLAIM_LEASE_MS }
      const body = JSON.stringify({ key, ...owner })
      if (stale === undefined) {
        if (!publishExclusive(path, body)) return { status: 'busy' } // someone else got it first
        this._outboxClaimTokens.set(id, token)
        return { status: 'claimed', key }
      }

      // Takeover (C3): win the marker for this exact stale claim.
      const passed: string[] = []
      let marker = `${path}.takeover-${outboxClaimTag(stale)}`
      let won = false
      for (let depth = 0; depth < OUTBOX_TAKEOVER_MAX_DEPTH; depth++) {
        if (publishExclusive(marker, JSON.stringify(owner))) { won = true; break }
        const m = readRaw(marker)
        // Gone means its holder finished: the claim has changed hands.
        if (m === undefined || heldBy(m)) return { status: 'busy' }
        passed.push(marker)
        marker = `${marker}-${outboxClaimTag(m)}`
      }
      if (!won) return { status: 'busy' }
      let changedHands = false
      try {
        // Under the marker: is it still the claim we judged stale?
        if (readRaw(path) !== stale) { changedHands = true; return { status: 'busy' } }
        const tmp = `${path}.${process.pid}.${token}.tmp`
        fs.writeFileSync(tmp, body)
        fs.renameSync(tmp, path)
        changedHands = true
        this._outboxClaimTokens.set(id, token)
        return { status: 'claimed', key }
      } finally {
        fs.rmSync(marker, { force: true })
        // The dead markers we walked past are cleared only once the stale
        // claim they guard is gone. Before that, clearing one would let a
        // second racer win a level we already passed.
        if (changedHands) for (const p of passed) fs.rmSync(p, { force: true })
      }
    } catch (err) {
      logger.warning(`[plur:outbox] could not record a push claim for ${id}: ${(err as Error).message}`)
      return { status: 'claimed', key: keyFor() }
    }
  }

  /**
   * Is this claim still held by a live writer?
   *
   * - **Owner on this host:** held while its process is alive, however long
   *   its push runs. The lease is NOT the bound here: a POST held open past
   *   it by a slow but alive server would otherwise let a second flusher
   *   take the claim over and re-push the same entry. A dead owner's claim is
   *   stale at once. A hard age cap ({@link OUTBOX_CLAIM_MAX_AGE_MS}) still
   *   applies, so a recycled pid cannot block an entry forever.
   * - **Owner on another host** (a shared store directory): its pid cannot be
   *   checked, so the lease decides.
   *
   * A timestamp dated implausibly far ahead is clock skew, not a live writer.
   */
  private _outboxClaimHeld(
    held: { pid?: number; host?: string; until?: number; at?: number },
    now: number,
  ): boolean {
    if (held.host === hostname()) {
      if (typeof held.pid !== 'number' || !pidAlive(held.pid)) return false
      const at = typeof held.at === 'number'
        ? held.at
        : typeof held.until === 'number' ? held.until - OUTBOX_CLAIM_LEASE_MS : undefined
      if (at === undefined) return false
      const age = now - at
      return age >= -OUTBOX_CLAIM_LEASE_MS && age < OUTBOX_CLAIM_MAX_AGE_MS
    }
    return typeof held.until === 'number' && held.until > now
      && held.until - now <= 2 * OUTBOX_CLAIM_LEASE_MS
  }

  /**
   * When the live claim on `id` lapses, as an ISO time; undefined when there is
   * no live claim. Read from the claim file alone (decision C3) and judged by
   * the same rule as `_claimOutboxEntry`. Advisory: nothing is held back by it.
   */
  private _outboxClaimUntil(id: string, now: number): string | undefined {
    try {
      const held = JSON.parse(fs.readFileSync(this._outboxClaimPath(id), 'utf8')) as { pid?: number; host?: string; until?: number; at?: number }
      if (!this._outboxClaimHeld(held, now) || typeof held.until !== 'number') return undefined
      return new Date(held.until).toISOString()
    } catch { return undefined }
  }

  /**
   * Release a claim this process holds. Never throws.
   *
   * Also clears takeover markers left by a racer that died after its rename
   * but before its cleanup. Only markers guarding a claim that is no longer in
   * place (their tag differs from the current claim's) are removed: a racer
   * that re-creates one then fails its re-read, so this cannot make a second
   * winner.
   */
  private _releaseOutboxClaim(id: string): void {
    const path = this._outboxClaimPath(id)
    const token = this._outboxClaimTokens.get(id)
    this._outboxClaimTokens.delete(id)
    try {
      const held = JSON.parse(fs.readFileSync(path, 'utf8')) as { pid?: number; host?: string; token?: string }
      // Only the writer that took this claim releases it: its token, not just
      // its pid. Two Plur instances in one process share a pid; one that never
      // took the claim holds no token and must not remove the other's.
      if (token !== undefined && held.token === token && held.pid === process.pid && held.host === hostname()) {
        fs.rmSync(path, { force: true })
      }
    } catch { /* already gone */ }
    try {
      let current: string | undefined
      try { current = outboxClaimTag(fs.readFileSync(path, 'utf8')) } catch { /* no claim now */ }
      const prefix = `${basename(path)}.takeover-`
      for (const f of fs.readdirSync(this.outboxClaimsDir())) {
        if (!f.startsWith(prefix) || f.endsWith('.tmp')) continue
        if (f.slice(prefix.length).split('-')[0] !== current) fs.rmSync(join(this.outboxClaimsDir(), f), { force: true })
      }
    } catch { /* best effort */ }
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
   *   (c) a personal `user:` scope the caller passed (or the session's own
   *       registration — not the inherited process default) adds the ONE
   *       entry whose scope matches it, case-folded, exact-case preferred.
   *       It adds no other entry; `dial: always` and a `.plur.yaml` remote
   *       project can still add theirs.
   * When `options.scopes` is given, nothing outside it is dialed (`[]` →
   * nothing), whichever rule selected the entry.
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
  private _remoteRecallHosts(options?: { scope?: string; scopes?: string[]; session?: string; remote_project?: RemoteProjectConfig }): RemoteRecallHost[] {
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
    // A personal `user:` scope names its own store (#1515): a recall scoped to
    // `user:acme:me` dials the ONE store entry whose scope matches it (case
    // folded, exact-case preferred — `personalStoreEntry`), with that entry
    // alone. Only a scope the caller passed, or the session's OWN
    // registration, counts — never the process default an unregistered
    // session inherits (audit F2): that default is another caller's choice.
    // Without this a personal scope gave no dialing context, so `learn` to a
    // personal remote store landed on the server but `recall` with the same
    // scope never read it back.
    const personalScope = options?.scope ?? this._sessionScopes.own(options?.session) ?? undefined
    // Selected over EVERY configured store, exactly as a write selects
    // (`_canonicalPersonalScope`); a selected path-backed or `dial: never`
    // store means no personal dial — never a fall-through to a case twin
    // (re-audit N3).
    const selectedPersonal = personalStoreEntry(personalScope, (this.config.stores ?? []).filter(e => typeof e.scope === 'string'))
    const personalEntry = selectedPersonal?.url && selectedPersonal.dial !== 'never' ? selectedPersonal : null
    // The caller's authorization allow-list bounds what is DIALED, not only
    // what is kept afterwards: a query sent to a scope the caller may not
    // read has already left the machine (audit F2). `[]` dials nothing. A
    // store is dialable when it can hold rows the allow-list admits: its
    // scope equals, or is a parent of, an allowed scope (`isScopeWithin`,
    // the nesting every read filter uses — re-audit N4). The rows themselves
    // are still filtered by exact membership afterwards (`_filterRemoteRows`).
    const allowList = options?.scopes
    const allowed = (storeScope: string): boolean =>
      allowList === undefined || allowList.some(a => isScopeWithin(a, storeScope))

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
      const personalExact = personalEntry && dialable.includes(personalEntry) ? [personalEntry] : []
      const orgContext = orgAffine.length > 0 || projectImplicated
      if (!orgContext && always.length === 0 && personalExact.length === 0) continue
      const selected = new Set<StoreEntry>(orgAffine)
      for (const e of personalExact) selected.add(e)
      if (projectImplicated) for (const e of shared) selected.add(e)
      for (const e of always) selected.add(e)
      if (orgContext) for (const e of personal) selected.add(e)
      // Config order preserved — row→entry mapping must be deterministic.
      const dialEntries = dialable.filter(e => selected.has(e) && allowed(e.scope))
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
      const scopes = [...new Set(rp.scopes ?? [])].filter(allowed)
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
    options?: { scope?: string; scopes?: string[]; session?: string; remote?: boolean; remote_timeout_ms?: number; remote_project?: RemoteProjectConfig; limit?: number },
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
      // #1150: one evaluator, shared with _applyResidualFilters and injection.
      const nowMs = Date.now()
      engrams = engrams.filter(e => isCurrentlyValid(e.temporal, nowMs))
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
      // The authorization allow-list bounds dialing too (#1515 audit F2).
      scopes: options?.scopes,
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
    // Why the semantic leg did not contribute, when it did not (R2-Retrieval
    // core-retrieval#12, applied by R2-CoreA). `embed()` swallows an embedder
    // failure and returns null, and this catch was silent, so the injection
    // quietly ran on keyword matching only and nobody could tell.
    let embedFailure: string | null = null
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
    } catch (err) {
      // Continue without boosts — but say so.
      embedFailure = (err as Error)?.message ?? String(err)
      logger.warning(`[plur] injectHybrid: embeddings failed (${embedFailure}) — keyword-only injection.`)
    }
    // A swallowed failure shows in the embedder's status. Embeddings the USER
    // turned off (`disabled`) are a choice, not a degradation: never flagged.
    const st = embedderStatus()
    if (!embedFailure && !st.disabled && !st.available) embedFailure = st.lastError ?? 'embedder unavailable'
    // #776: server rows join the candidate pool + boost channel. Visibility/
    // authorization run over them INSIDE _remoteInjectCandidates, before any
    // boost exists to resurrect a scope-excluded row.
    const remote = await this._remoteInjectCandidates(remotePromise, options)
    const result = await this._formatInjection(task, options, embeddingBoosts, remote)
    // Reported as structured fields mirroring `HybridSearchResult`, not as a
    // `warnings` line: `warnings` is rendered into the injected context on
    // every prompt, and an install without the model would repeat the same
    // line forever. Logged once per process for an operator.
    if (embedFailure) {
      result.mode = 'hybrid-degraded'
      result.embedder_error = embedFailure
      if (!Plur._injectDegradedLogged) {
        Plur._injectDegradedLogged = true
        logger.warning(`[plur] injectHybrid: embedder unavailable (${embedFailure}) — injecting by keyword match only.`)
      }
    } else {
      result.mode = st.disabled ? 'bm25-only' : 'hybrid'
    }
    return result
  }

  /** One operator log line per process for a degraded injectHybrid. */
  private static _injectDegradedLogged = false

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
        pinned_hard_ratio: this.config.injection?.pinned_hard_ratio,
        pinned_ratio: this.config.injection?.pinned_ratio,
      },
      embeddingBoosts,
    )

    if (result.spread_drops) {
      this._spreadDrops.dropped_unresolvable += result.spread_drops.dropped_unresolvable
      this._spreadDrops.dropped_retired += result.spread_drops.dropped_retired
    }

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
    //
    // #975: cross-process dedup. Hooks spawn fresh processes (empty address
    // space each time), so an in-memory map cannot see the other process's
    // injection. The check reads the HISTORY FILE — durable, shared across
    // processes. Keyed on query_hash + sorted engram IDs (not hash alone)
    // because the same query can legitimately select different engrams after
    // a write.
    if (injected_ids.length > 0) {
      // #975: cross-process dedup for the co_injection HISTORY EVENT only.
      // The injection_count increment (#866) is NOT gated — the engram was
      // genuinely injected into context even if the history event is a
      // duplicate. Only the provenance log is deduped.
      const queryHash = computeQueryHash(task)

      // The check and the append are ONE critical section, or this does not
      // dedup anything.
      //
      // The duplicates being suppressed come from hook processes that spawn
      // "within milliseconds" of each other — which is precisely the window in
      // which both read the tail before either has appended to it. Read, decide,
      // then append is a read-modify-write across processes, and O_APPEND makes
      // the WRITE atomic without making the SEQUENCE atomic. Both would see no
      // duplicate and both would write one, so the fix would help only when the
      // processes happen to be staggered by more than a read plus an append —
      // the case that was never the problem.
      //
      // Its OWN lock file, deliberately not the one #1051 uses for chain
      // stamping. #1051 moves that lock INSIDE appendHistory; taking the same
      // file here would mean this frame holds it while appendHistory tries to
      // take it again, and withLock is file-based and not reentrant — so once
      // both changes are on main every co_injection would fail to acquire,
      // fall through to the unlocked path, and the dedup would be silently
      // inert again. Two locks, two concerns: this one serialises the
      // dedup DECISION, #1051's serialises the chain STAMP. They nest in one
      // direction only (this one outside), and never contend for the same file.
      //
      // Tuned like #1051's: the section is a tail read and an append, so the
      // stock 100 ms first backoff has waiters sleeping orders of magnitude
      // longer than the holder needs.
      const historyDir = join(this.paths.root, 'history')
      // Whether THIS call is the one that recorded the injection. Decided inside
      // the lock, read afterwards by the injection_count block so both counters
      // follow the same verdict.
      let recordedInjection = false
      // Dedup applies to HOOK-sourced injections only.
      //
      // The key is content-based — query hash, engram set, source, session — so
      // it cannot tell "the hook fired twice for one event" from "the caller
      // injected the same thing three times". #975's duplicates come from
      // hook processes: a fresh process per event, racing a sibling
      // milliseconds away. Every other source ('inject', 'session_start')
      // originates in a single long-lived MCP process making deliberate calls,
      // and three deliberate calls are three injections, not one duplicated.
      //
      // Applied to all sources, the filter swallowed those: it turned three
      // explicit `inject()` calls into one recorded injection, which
      // inject-counter-and-flush-merge.test.ts has asserted against since
      // #900. That test predates this dedup and is right — the counter is
      // supposed to accumulate.
      //
      // Narrowing here is what lets BOTH counters follow one reading without
      // redefining what an injection is for every other caller.
      const dedupApplies = options?.source === 'hook'
      // Decision E7: NO_SESSION selects "no session default" for the dial
      // context; it is not a session id and is never recorded as one.
      const recordedSessionId = options?.session_id === NO_SESSION ? undefined : options?.session_id
      const writeCoInjection = (): void => {
        if (dedupApplies
          && isRecentDuplicateInjection(this.paths.root, queryHash, injected_ids, 5_000, options?.source, recordedSessionId)) return
        const injection_id = generateInjectionId()
        try {
          // ASK whether the write landed; do not infer it from the absence of a
          // throw (review of #1017). `recordedInjection = true` used to sit
          // above this block, so a failed history write still counted the
          // injection — injection_count incremented with no co_injection event
          // to explain it, which is the store-disagrees-with-its-own-history
          // state this change set out to eliminate, relocated to the error
          // path.
          //
          // Moving the assignment below `appendHistory` — the obvious fix, and
          // the one the review suggested — does NOT close it: appendHistory
          // deliberately swallows its own failure and returns normally, so an
          // unwritable history directory cannot fail the learn that called it.
          // Nothing is ever thrown, so the try/catch never fires and the
          // assignment runs either way. Verified: the regression test still
          // read injection_count: 1 with the assignment moved.
          //
          // So it reports instead.
          // `this._appendHistory`, not the bare `appendHistory` (#963). The
          // wrapper stamps `event.actor` with the configured identity, and
          // taking main's dedup block wholesale would have dropped that from
          // co_injection events alone — the one history event with no actor.
          const wrote = this._appendHistory({
            event: 'co_injection',
            engram_id: injection_id,
            timestamp: new Date().toISOString(),
            data: {
              ids: injected_ids,
              query_hash: queryHash,
              // Event provenance for offline token-economics analysis of real
              // sessions (the plur-bench #42 measurement). Deliberately NOT read
              // by the receipt, which shows no token/cost figure by design.
              tokens_used: tokensUsed,
              source: options?.source ?? 'inject',
              ...(options?.scope ? { scope: options.scope } : {}),
              ...(recordedSessionId ? { session_id: recordedSessionId } : {}),
            },
          })
          // In-memory provenance is set regardless: the engrams WERE injected,
          // whatever the log managed to record.
          for (const id of injected_ids) this._lastInjectionByEngram.set(id, injection_id)
          recordedInjection = wrote
        } catch { /* best-effort */ }
      }

      try {
        // The lock file lives beside the month files, so the directory has to
        // exist before we can take it. appendHistory creates it too, but that
        // is inside the section we are trying to guard.
        if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true })
        withLock(join(historyDir, 'co-injection-dedup'), writeCoInjection, { maxRetries: 12, baseDelay: 2 })
      } catch {
        // Could not take the lock. Write UNDEDUPED rather than dropping the
        // event: a duplicate provenance record is noise, a missing one is a
        // hole in the log `plur restore` reads to NAME what it cannot recover.
        // Losing a record to avoid a duplicate is the wrong way round.
        writeCoInjection()
      }

      // #866: increment injection_count on primary-store engrams selected for context.
      // Distinct from activation.frequency (recall events) — this tracks actual
      // injection into the model's context window. Best-effort: never breaks injection.
      //
      // GATED on the same verdict as the history event. It used to be exempt, on
      // the reasoning that the engram was genuinely injected even when the log
      // entry is a duplicate — but that contradicts the premise the dedup rests
      // on. Either the two events describe ONE injection, in which case counting
      // it twice is the inflation #975 opens with ("usage data is inflated, and
      // not by a constant factor"), or they describe two, in which case the
      // history event should not have been suppressed either. It cannot be one
      // reading for the log and the other for the counter: that left
      // engrams.yaml showing injection_count: 2 against a single co_injection
      // event, which is a store that disagrees with its own history.
      //
      // One reading, taken: they are one injection. Both counters follow.
      if (!recordedInjection) {
        // A duplicate. The engram's count was already incremented by the call
        // that recorded the event, microseconds ago and in another process.
      } else {
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
      // Pinned engrams that did not make it (#1142). Surfaced here because the
      // internal result carried it and the public shape dropped it, so the
      // reporting existed and never reached a caller — the same silent-omission
      // shape the field was added to close.
      ...(result.omitted_pinned?.length ? { omitted_pinned: result.omitted_pinned } : {}),
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
   *
   * `options.source: 'auto'` (#1310) marks a verdict an editor hook inferred
   * from the reply text. It adjusts ranking only — `commitment` is never
   * advanced. A remote store receives it only when its server advertises the
   * `feedback.source` capability in `/me` (and so promises the same rule —
   * docs/specs/2026-09-29-feedback-source-contract.md); any other remote is
   * skipped. The ambiguity guard below does not dial a cold remote for it,
   * because hooks must not wait on the network.
   */
  async feedback(
    id: string,
    signal: 'positive' | 'negative' | 'neutral',
    scope?: string,
    options?: { source?: FeedbackSource },
  ): Promise<MutationOutcome> {
    this._assertWritable()
    const warnings: string[] = []
    const auto = options?.source === 'auto'
    const applyOpts = auto ? { source: 'auto' as const } : {}
    const sourceData = auto ? { source: 'auto' as const } : {}
    const refuseRemote = (where: string): never => {
      throw new Error(
        `Automatic feedback is not sent to this remote store: ${id} is in "${where}", whose server does not `
        + `advertise the "${FEEDBACK_SOURCE_CAPABILITY}" capability. Rate it with plur_feedback to send an explicit signal.`,
      )
    }
    // Only a capable server may receive an automatic verdict (#1310).
    const remoteAccepts = async (driver: RemoteStore): Promise<boolean> =>
      !auto || await driver.hasCapability(FEEDBACK_SOURCE_CAPABILITY)
    const remoteOpts = auto ? { source: 'auto' as const } : undefined

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
        if (!(await remoteAccepts(driver))) refuseRemote(entry.scope ?? entry.url!)
        const remoteEngram = await driver.getById(serverId)
        if (!remoteEngram) throw new Error(`Engram "${id}" not found in store "${scope}"`)
        await driver.feedback(serverId, signal, remoteOpts)
        try {
          this._appendHistory({
            event: 'feedback_received',
            engram_id: id,
            timestamp: new Date().toISOString(),
            data: { signal, routed_to: 'remote', scope, ...sourceData },
          })
        } catch (err) {
          logger.warning(
            `[plur] feedback on ${id} was applied remotely but its history record could not be written: ` +
            `${(err as Error).message}. Do not retry — the signal is already counted.`,
          )
        }
        this._logInjectionOutcome(id, signal, options?.source)
        return { warnings }
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
    // Collision probe OUTSIDE the store lock (0.21.1), bounded per store —
    // the same walk forget() runs, read the same way except that "cannot
    // tell" goes ahead with a warning: a mis-targeted rating is recoverable.
    // An automatic signal never waits on the network (a cold cache reads as
    // no collision; it moves strength one step and never commitment).
    let probedOutsideLock = false
    if (!scope && this._hasUrlStore()) {
      const pre = (await this._loadTargeted([id])).find(e => e.id === id)
      if (pre) {
        this._decideFeedbackProbes(id, await this._probeIdCollisions(id, { skipLive: auto }), warnings)
        probedOutsideLock = true
      }
    }
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
      // The collision probe (#850) runs BEFORE this lock (0.21.1); only a row
      // that appeared in between is probed here.
      if (!scope && !probedOutsideLock) {
        this._decideFeedbackProbes(id, await this._probeIdCollisions(id, { skipLive: auto }), warnings)
      }

      applyFeedbackSignal(engram, signal, undefined, applyOpts)

      // Incremental write (#740): only the rated engram changed.
      await this._updateEngrams(engrams, [engram])
      await this._syncIndex()
      // The counter has already changed on disk. A history failure here used to
      // reject the call, and a retry then applied the signal a SECOND time
      // (#813, audit finding 13). Log and continue: the mutation committed.
      try {
        this._appendHistory({
          event: 'feedback_received',
          engram_id: id,
          timestamp: new Date().toISOString(),
          data: { signal, ...sourceData },
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
      this._logInjectionOutcome(id, signal, options?.source)
      return { warnings }
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
        applyFeedbackSignal(engram, signal, undefined, applyOpts)
        await this._writeEngrams(storeInfo.path, storeEngrams)
        await this._syncIndex()
        this._logInjectionOutcome(id, signal, options?.source)
        return true
      }
      return false
      })
      if (handled) return { warnings }
    }

    // Check remote stores — the engram may live on an enterprise server.
    // See: https://github.com/plur-ai/plur/issues/85
    //
    // Same local-only guard as forget()'s, and it was missing here entirely —
    // not even the `primary` case was covered, so `feedback(id, signal,
    // 'primary')` on an id absent locally rated a REMOTE engram. One severity
    // band below the retire (a mis-targeted signal is recoverable), same
    // defect, same predicate.
    if (scope && isLocalOnlyScope(scope, this.config.stores ?? [])) {
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
      // Automatic feedback (#1310): a server that does not advertise
      // `feedback.source` is skipped before any engram lookup is spent on it.
      if (auto && !(await remoteAccepts(this._getRemoteDriver({ url: entry.url, token: entry.token, scope: entry.scope })))) continue
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
        await driver.feedback(serverId, signal, remoteOpts)
        // Same reasoning as the local path: the remote already counted it.
        try {
          this._appendHistory({
            event: 'feedback_received',
            engram_id: id,
            timestamp: new Date().toISOString(),
            data: { signal, routed_to: 'remote', ...sourceData },
          })
        } catch (err) {
          logger.warning(
            `[plur] feedback on ${id} was applied remotely but its history record could not be ` +
            `written: ${(err as Error).message}. Do not retry — the signal is already counted.`,
          )
        }
        this._logInjectionOutcome(id, signal, options?.source)
        return { warnings }
      }
    }

    // Search pack engrams by scanning pack directories
    await this._feedbackPack(id, signal, unverifiedStores, applyOpts)
    this._logInjectionOutcome(id, signal, options?.source)
    return { warnings }
  }

  /**
   * Log an injection_outcome event linking a feedback verdict to the
   * co_injection event the engram came from (#452). Only positive/negative
   * verdicts are outcomes — "ignored" is the absence of an outcome, so
   * neutral signals and feedback on never-injected engrams write nothing.
   * Link resolution: in-process map first, then a bounded history scan for
   * injections logged by another process (hook-inject, CLI).
   */
  private _logInjectionOutcome(
    engramId: string,
    signal: 'positive' | 'negative' | 'neutral',
    source?: FeedbackSource,
  ): void {
    if (signal === 'neutral') return
    try {
      const injectionId = this._lastInjectionByEngram.get(engramId)
        ?? findLatestInjectionFor(this.paths.root, engramId)?.injection_id
      if (!injectionId) return
      this._appendHistory({
        event: 'injection_outcome',
        engram_id: engramId,
        timestamp: new Date().toISOString(),
        data: { injection_id: injectionId, signal, ...(source === 'auto' ? { source } : {}) },
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
      // Hard-tier tokens accepted earlier in this batch; listPinned cannot see
      // them until the batch is written.
      let pendingHard = 0
      for (const meta of metas) {
        if (existingIds.has(meta.id)) {
          skipped++
          continue
        }
        pendingHard += await this._assertHardTierFits(meta, pendingHard)
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
   * `true` means the write happened. {@link updateEngramAsync} is the same
   * operation returning the written engram.
   */
  async updateEngram(updated: Engram): Promise<boolean> {
    return (await this._updateEngramReturning(updated)) !== null
  }

  /**
   * @deprecated Equivalent to {@link updateEngram} since 0.16 — that method now
   * awaits the remote PATCH too — differing only in returning the written
   * engram (the server-authoritative view for a remote hit) instead of a
   * boolean. Kept so existing callers keep compiling. One implementation
   * (2026-09 audit): the two bodies had drifted on how a refusing remote is
   * handled; both now try the next writable store rather than throwing.
   */
  async updateEngramAsync(updated: Engram): Promise<Engram | null> {
    return await this._updateEngramReturning(updated)
  }

  private async _updateEngramReturning(updated: Engram): Promise<Engram | null> {
    this._assertWritable()
    // Guards and routing below read the current config (core-index#9).
    this.reloadConfigIfChanged()
    // Local primary first.
    const localResult = await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const engrams = await this._loadTargeted([updated.id])
      const idx = engrams.findIndex(e => e.id === updated.id)
      if (idx === -1) return null
      // Ambiguity guard (0.21.1). Ids are minted per store, so a team row the
      // server returned with a bare id (learnRouted's result, say) can share
      // that id with an unrelated local row. Local-first matching then wrote
      // the team content over the local engram. A row whose scope is backed
      // by a url store, unlike the local row's, is not this row: refuse.
      const localScope = engrams[idx].scope
      if (updated.scope !== localScope && this._isRemoteBackedScope(updated.scope)
          && !this._isRemoteBackedScope(localScope)) {
        throw new Error(
          `Ambiguous engram ID "${updated.id}": the local engram with this id is in "${localScope}", but the row passed `
          + `is in "${updated.scope}", which a remote store holds. Nothing was written. To update the remote engram, `
          + `pass its namespaced id (${namespaceEngramId(updated.id, updated.scope)}); to move the local one, use rescope.`,
        )
      }
      // Leak guard (#353): local-resident → demote a sensitive update in place.
      // LOW-2: scan context fields too, not just the statement.
      const demote = this._guardExplicitUpdate(updated.statement, updated.scope, false, this._engramContextFields(updated))
      // #1138 review: stamp `updated_at` on the mutation path, not only on
      // creation and retirement. Without this it equalled `created_at` for
      // every engram that had ever been edited — worse than an absent field,
      // because it reads as authoritative. The spec added alongside it names
      // statement, scope, commitment, relations and retirement as the tracked
      // mutations, and this is where four of the five actually happen.
      const toWrite = { ...(demote ? { ...updated, ...demote } : updated), updated_at: new Date().toISOString() }
      // A whole-engram update can set `pinned` and `pinned_tier` — a write path
      // that can produce a hard-tier engram, so it passes the same cap. Checked
      // before the queued-scope reconcile so a refused update has no side effects.
      await this._assertHardTierFits(toWrite)
      this._reconcileQueuedScope(engrams[idx], toWrite)
      const retiresNow = engrams[idx].status !== 'retired' && toWrite.status === 'retired'
      engrams[idx] = toWrite
      // Incremental write (#740): only the updated engram row changed.
      await this._updateEngrams(engrams, [toWrite])
      await this._syncIndex()
      // "Every removal is explicit" (coordinator, 2026-09-27): an update that
      // retires a row is a removal and leaves the same trace forget() does.
      // `plur_validate_meta` retires a failing meta-engram through here, and
      // it used to vanish with no history event. Nothing when the row was
      // already retired or its status did not change.
      if (retiresNow) {
        try {
          this._appendHistory({
            event: 'engram_retired',
            engram_id: toWrite.id,
            timestamp: toWrite.updated_at,
            data: { reason: null, via: 'update' },
          })
        } catch { /* history is an audit trail, never a gate on the write */ }
      }
      return toWrite
    })
    if (localResult) return localResult

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
    // Refusal rule (2026-09 audit), the same one `forget()` uses since #1109:
    // when the id is NAMESPACED to this store (`_stripRemotePrefix` stripped
    // its prefix), the target is unambiguous, so a refusal (auth, validation,
    // transport) is thrown as-is — reporting it as "not found" would claim
    // an absence that was never verified, which is how the MCP plur_pin tool
    // came to turn a 401 into "Engram not found". A BARE id is ambiguous
    // across stores, so there the walk keeps the graceful contract pinned by
    // `set-pinned-remote.test.ts`: try the next store, and report null/false
    // rather than a success that did not happen.
    // core-index#9 (round 2): an id NAMESPACED to a configured store names that
    // store (the refusal rule above relies on it), so only the store(s) it is
    // namespaced to are candidates. The walk used to run EVERY store's guard —
    // and PATCH every store — in order until one answered, so store A's
    // stricter policy refused an update of store B's engram, and B's content
    // was sent to A first. A bare id keeps the full walk (ownership unknown).
    // Audit of #1228: `storePrefix` is three letters, so two store scopes can
    // share one and a namespaced id then names both. Disambiguate on the full
    // store scope — the loader's `_storeScope` stamp when the caller passes
    // the row it got from us, else the store whose scope holds the row's
    // scope. Neither narrows to nothing: an unmatched hint keeps `namedBy`.
    const writableRemotes = (this.config.stores ?? []).filter(e => !!e.url && e.readonly !== true)
    let namedBy = writableRemotes.filter(e => this._stripRemotePrefix(updated.id, e.scope) !== updated.id)
    if (namedBy.length > 1) {
      const stamp = (updated as any)._storeScope as string | undefined
      const byStamp = stamp ? namedBy.filter(e => e.scope === stamp) : []
      const byScope = typeof updated.scope === 'string' ? namedBy.filter(e => isScopeWithin(updated.scope, e.scope)) : []
      if (byStamp.length > 0) namedBy = byStamp
      else if (byScope.length > 0) namedBy = byScope
    }
    for (const entry of (namedBy.length > 0 ? namedBy : writableRemotes)) {
      // Leak guard (#353): remote-resident, explicit update → THROW on a
      // forbidden hit (no coherent demotion for a remote engram).
      // LOW-2: scan context fields too, not just the statement.
      this._guardExplicitUpdate(updated.statement, entry.scope, true, this._engramContextFields(updated))
      const serverId = this._stripRemotePrefix(updated.id, entry.scope)
      const driver = this._getRemoteDriver({ url: entry.url!, token: entry.token, scope: entry.scope })
      // PATCH a focused subset — full-engram PATCH would require strict
      // schema mirroring on the server and is not what enterprise PR #111
      // exposes. Send the fields most commonly mutated by the callers
      // (setPinned, promote, reportFailure).
      try {
        // "Every removal is explicit and traced" (owner, 2026-09-27): a patch
        // that sets `retired` reads the previous status first, so the history
        // records a real transition only. `getById` answers null for both a
        // 404 and an unreachable store, so null or a throw is "unknown" — then
        // the event is still written, flagged, rather than dropped.
        let previous: { status?: string } | null | undefined
        if (updated.status === 'retired') {
          try { previous = await driver.getById(serverId) } catch { previous = null }
        }
        const patched = await driver.patch(serverId, {
          pinned: updated.pinned,
          status: updated.status,
          statement: updated.statement,
        })
        // `null` is a 404 — this remote does not hold it, so keep looking.
        if (patched) {
          if (updated.status === 'retired' && previous?.status !== 'retired') {
            try {
              this._appendHistory({
                event: 'engram_retired',
                engram_id: updated.id,
                timestamp: new Date().toISOString(),
                data: {
                  reason: null, via: 'update', routed_to: 'remote', scope: entry.scope,
                  ...(previous ? {} : { previous_status_unknown: true }),
                },
              })
            } catch { /* history is an audit trail, never a gate on the write */ }
          }
          return patched
        }
      } catch (err) {
        if (serverId !== updated.id) throw err
        continue
      }
    }
    return null
  }

  /**
   * Decision D4 "like-rescope" (2026-09-26): an update that changes the scope
   * of a row still queued for a remote store (`_outbox` on the STORED row)
   * behaves like `rescope()` (#848):
   *   - new scope local-family (`isLocalOnlyScope`, config-aware) → the
   *     pending delivery is cancelled;
   *   - new scope has a writable URL store → `_outbox` is retargeted to it
   *     (attempts reset). The leak guard has already run against the new
   *     scope (`_guardExplicitUpdate` above); a demotion lands on `local` and
   *     so takes the first branch;
   *   - otherwise (no store, or only a readonly one) → cancelled, with a warning.
   * The queue entry is read from the STORED row, never the caller's object,
   * and so is `_retireRemote` (decision D1) — a caller-set value of either
   * would otherwise direct a push or a remote DELETE. Mutates `toWrite`.
   */
  private _reconcileQueuedScope(stored: Engram, toWrite: Engram): void {
    const storedSd = (stored as any).structured_data as Record<string, unknown> | undefined
    const sd: Record<string, unknown> = { ...(((toWrite as any).structured_data as Record<string, unknown> | undefined) ?? {}) }
    let changed = false
    if (storedSd && '_retireRemote' in storedSd) { sd._retireRemote = storedSd._retireRemote; changed = true }
    else if ('_retireRemote' in sd) { delete sd._retireRemote; changed = true }
    const pending = storedSd?._outbox as { target_url?: string; target_scope?: string } | undefined
    if (pending && stored.status !== 'retired' && toWrite.scope !== stored.scope) {
      changed = true
      const stores = this.config.stores ?? []
      const newScope = toWrite.scope
      // A personal scope goes where the ONE selected store is (#1515 re-audit
      // 3): a local store sharing the identical scope keeps the row local, so
      // its pending delivery is cancelled rather than retargeted to the url.
      const personal = this._exactPersonalStore(newScope)
      const writable = personal !== undefined
        ? (personal?.url && personal.readonly !== true ? personal : undefined)
        : stores.find(st => !!st.url && st.scope === newScope && st.readonly !== true)
      if (personal && !personal.url) {
        delete sd._outbox
        logger.warning(
          `[plur] update of ${stored.id} moved it to "${newScope}", which a local store holds, and cancelled its `
          + `pending delivery to ${pending.target_url ?? '?'} (scope "${pending.target_scope ?? stored.scope}").`,
        )
      } else if (isLocalOnlyScope(newScope, stores)) {
        delete sd._outbox
        logger.warning(
          `[plur] update of ${stored.id} moved it to "${newScope}" and cancelled its pending delivery to `
          + `${pending.target_url ?? '?'} (scope "${pending.target_scope ?? stored.scope}") — like rescope (#848).`,
        )
      } else if (writable) {
        sd._outbox = { ...pending, target_url: writable.url, target_scope: newScope, attempt_count: 0, last_error: '' }
      } else {
        delete sd._outbox
        logger.warning(
          `[plur] update of ${stored.id} moved it to "${newScope}", which has no writable remote store — its pending `
          + `delivery to ${pending.target_url ?? '?'} (scope "${pending.target_scope ?? stored.scope}") was CANCELLED. `
          + `Rescope it to a store scope to deliver it.`,
        )
      }
    }
    if (changed) (toWrite as any).structured_data = Object.keys(sd).length > 0 ? sd : undefined
  }

  /**
   * Toggle the always-load (pinned) flag for an engram.
   *
   * Returns the updated engram on success, `null` if it is not found in the
   * local primary store or in any writable remote. Since 0.16 the remote PATCH
   * is awaited and its result returned, so the value is the real engram rather
   * than a placeholder — {@link setPinnedAsync} is the same call.
   */
  async setPinned(id: string, pinned: boolean, options?: { scope?: string }): Promise<Engram | null> {
    this._assertWritable()
    // Which store holds it (0.21.1). Ids are minted per store, so a bare id
    // can name a local engram AND an unrelated remote one; pinning went
    // local-first with no check and changed the wrong engram silently.
    // `scope: "primary"` = the local row only; a url store's scope = that
    // store only; omitted = local first, refused when the id is ambiguous.
    const targetScope = options?.scope
    if (targetScope !== undefined && (typeof targetScope !== 'string' || targetScope.trim() === '')) {
      throw new TypeError('plur.setPinned: scope must be a non-empty string')
    }
    if (targetScope) this.reloadConfigIfChanged()
    const scopedEntry = targetScope && targetScope !== 'primary'
      ? (this.config.stores ?? []).find(s => s.url && s.scope === targetScope && s.readonly !== true)
      : undefined
    if (targetScope && targetScope !== 'primary' && !scopedEntry) {
      throw new Error(`Cannot pin in scope "${targetScope}": no writable url store is registered for it. Use scope "primary" for the local engram.`)
    }
    if (!targetScope && this._hasUrlStore()) {
      const pre = (await this._loadTargeted([id])).find(e => e.id === id)
      if (pre) {
        for (const p of await this._probeIdCollisions(id)) {
          if (p.outcome === 'present') {
            throw new Error(
              `Ambiguous engram ID "${id}": exists in both the local store and remote scope "${p.scope}", so it was `
              + `not ${pinned ? 'pinned' : 'unpinned'}. Pass scope: "primary" for the local engram, or the namespaced id `
              + `${namespaceEngramId(this._stripRemotePrefix(id, p.scope), p.scope)} (or scope: "${p.scope}") for the remote one.`,
            )
          }
          if (p.outcome === 'auth_rejected') logger.warning(`[plur] ${this._rejectedTokenWarning(p, id, pinned ? 'pinned' : 'unpinned')}`)
          if (p.outcome === 'unreachable') {
            logger.warning(`[plur] remote scope "${p.scope}" could not be reached to rule out another engram with id ${id} `
              + `(${p.detail ?? 'no answer'}) — ${pinned ? 'pinning' : 'unpinning'} the LOCAL engram unverified.`)
          }
        }
      }
    }
    // Local primary first (skipped when a remote scope was named).
    const localResult = scopedEntry ? null : await this._withStoreLock(this.paths.engrams, async () => {
      // Targeted read (#827): resolving one engram by id.
      const engrams = await this._loadTargeted([id])
      const idx = engrams.findIndex(e => e.id === id)
      if (idx === -1) return null
      const e = engrams[idx]
      // #1138 review: pinning is a mutation, so it moves `updated_at`.
      const updated: Engram = {
        ...e,
        pinned: pinned === true ? true : undefined,
        updated_at: new Date().toISOString(),
      }
      // Pinned two-tier model: an unpin clears the tier and the priority with
      // the flag. They describe a pin; left behind, a later re-pin would
      // silently restore hard-tier membership without the cap ever being
      // consulted.
      if (pinned !== true) {
        delete (updated as { pinned_tier?: unknown }).pinned_tier
        delete (updated as { pinned_priority?: unknown }).pinned_priority
      }
      // A re-pin of an engram that still carries `pinned_tier: 'hard'` (written
      // before unpin cleared it, or by another path) is a hard-tier write.
      await this._assertHardTierFits(updated)
      engrams[idx] = updated
      // Incremental write (#740): only the (un)pinned engram row changed.
      await this._updateEngrams(engrams, [updated])
      await this._syncIndex()
      return updated
    })
    if (localResult) return localResult
    if (targetScope === 'primary') return null

    let remotePatched: {
      patched: Engram; driver: RemoteStore; serverId: string; scope: string
      /** Whether the engram was pinned BEFORE this call; null when unknown. */
      priorPinned: boolean | null
    } | null = null
    // Remote routing (closes #86 pin remainder). Strip the namespace prefix
    // before sending the server the unprefixed ID it knows about. Same
    // refusal rule as `_updateEngramReturning`: a namespaced id names ONE
    // store, so its refusal is thrown; a bare id keeps walking and reports
    // null rather than a success that did not happen.
    for (const entry of (scopedEntry ? [scopedEntry] : (this.config.stores ?? []))) {
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
        // Send the BOOLEAN, including an explicit `false` (#1149).
        //
        // This read `pinned === true ? true : undefined`, mirroring the local
        // branch above — but the two representations exist for opposite
        // reasons. Locally the engram is rewritten WHOLE, so `undefined`
        // drops the key and keeps unpinned rows out of the YAML. Here the
        // object is a PARTIAL update, and `JSON.stringify` omits `undefined`,
        // so the unpin left as `{}` — a server applying ordinary PATCH
        // semantics changed nothing and returned the still-pinned row, which
        // this method then reported as success.
        //
        // Measured on a loopback server against the real serializer: PATCH
        // body `{}`, engram still pinned afterwards, no error raised. An
        // unpin the user was told had worked had not happened on any other
        // machine — and with the pinned set now quota-enforced at pin time,
        // it also held budget nobody could reclaim.
        // Record the prior pin state BEFORE the PATCH, so a refused hard-tier
        // pin can be reverted to what it was rather than to a forced unpin —
        // and so re-pinning an engram that was already pinned (which cannot
        // grow the tier) is never refused. Read from the driver's cache when
        // it holds the row, else one GET; only for a pin, never an unpin.
        let priorPinned: boolean | null = null
        if (pinned === true) {
          const cachedRow = ((driver as unknown as { cache?: { engrams?: Engram[] } | null }).cache?.engrams ?? [])
            .find(e => e.id === serverId)
          const prior = cachedRow ?? (typeof driver.getById === 'function' ? await driver.getById(serverId) : null)
          priorPinned = prior ? (prior as { pinned?: boolean }).pinned === true : null
        }
        const patched = await driver.patch(serverId, { pinned })
        if (!patched) continue
        remotePatched = { patched, driver, serverId, scope: entry.scope, priorPinned }
        break
      } catch (err) {
        if (serverId !== id || scopedEntry) throw err
        continue
      }
    }
    if (!remotePatched) return null
    // Pinned two-tier model: a remote re-pin can restore a hard tier the
    // engram still carries (a partial PATCH cannot clear it on unpin). Only
    // the server's answer says which tier the engram is in, so the cap is
    // checked on it — under the store lock, like every other hard-tier write
    // — and a pin that would overrun the cap is reverted to the state recorded
    // before the PATCH and refused. There is a window between the PATCH and
    // the revert. An engram that was already pinned is not checked: re-pinning
    // it cannot grow the tier. When the prior state is unknown (no cached row,
    // GET failed) the engram is treated as previously unpinned.
    const { patched, driver, serverId, scope, priorPinned } = remotePatched
    if (pinned === true && priorPinned !== true && isHardPinned(patched as never)) {
      try {
        await this._withStoreLock(this.paths.engrams, async () => {
          await this._assertHardTierFits({ ...patched, id: namespaceEngramId(serverId, scope) })
        })
      } catch (err) {
        // Surface a failed revert: swallowing it would report "refused" while
        // the engram stays pinned over the cap on the server.
        let revertError: string | null = null
        try {
          // Back to the recorded prior state. It is "not pinned" here: an
          // engram that was pinned before the call never reaches this check.
          const reverted = await driver.patch(serverId, { pinned: false })
          if (!reverted) revertError = 'the server no longer holds the engram (404)'
        } catch (e) {
          revertError = (e as Error).message
        }
        if (revertError) {
          throw new Error(
            `${(err as Error).message} The pin was applied on the remote store and could NOT be reverted ` +
            `(${revertError}); the engram ${serverId} is still pinned there. Unpin it explicitly.`,
          )
        }
        throw err
      }
    }
    return patched
  }

  /**
   * @deprecated Equivalent to {@link setPinned} since 0.16 — that method now
   * awaits the remote PATCH too. Kept so existing callers keep compiling; it
   * IS setPinned (2026-09 audit), so the two cannot drift apart.
   */
  async setPinnedAsync(id: string, pinned: boolean, options?: { scope?: string }): Promise<Engram | null> {
    return await this.setPinned(id, pinned, options)
  }

  /** List engrams that have pinned: true. */
  async listPinned(): Promise<Engram[]> {
    const all = await this._loadAllEngrams()
    return all.filter(e => (e as any).pinned === true && e.status === 'active')
  }

  /**
   * Token cap of the HARD pinned tier at write time (pinned two-tier model):
   * `injection.pinned_hard_ratio` of the same quota {@link pinnedQuota}
   * enforces. The ratio is bounded to [0, 1], so the hard tier can never
   * exceed the pinned quota. Default: 0.5 × 1000 = 500 tokens.
   */
  hardTierCap(): number {
    return pinnedHardCap(
      this.config.injection_budget ?? 2000,
      this.config.injection?.pinned_hard_ratio ?? DEFAULT_PINNED_HARD_RATIO,
      this.config.injection?.pinned_ratio ?? 0.5,
    )
  }

  /**
   * Refuse a write that would grow the hard pinned tier past
   * {@link hardTierCap}. The ONE check every write path that can produce a
   * hard-tier engram goes through: `learn()`, both halves of `learnRouted()`'s
   * remote route, `setPinned()`, `updateEngram()` and `saveMetaEngrams()`.
   *
   * MUST be called while holding the primary store lock. A cap is a
   * read-modify-write on a shared total: checked outside the lock, N
   * concurrent hard-tier writes each read the same total, each conclude they
   * fit, and all commit. `listPinned` takes no lock of its own, so calling it
   * here does not re-enter.
   *
   * Cost is `estimateTokens` — the function injection charges the budget
   * with — over the engram AS IT WILL BE COMMITTED, so admission, accounting
   * and injection agree. It counts only what is rendered into the prompt; an
   * unrendered field (`abstract`, `structured_data`, `tags`, …) costs nothing
   * because it reaches no model.
   *
   * What the total counts: every hard-tier engram this client can see —
   * the primary store, file-backed stores, and remote stores as far as their
   * read cache holds them (`_loadRemoteCached` is a synchronous peek and may be
   * cold). A remote store's hard tier can also be written by other clients,
   * which no local check can serialise against. That is why injection enforces
   * the same cap again (`fillTokenBudget`) and reports any overflow in
   * `omitted_pinned` as `hard-tier-cap`: this check keeps the local tier honest,
   * the injection-time cap is the one that cannot be bypassed.
   *
   * A write that does not GROW the tier is always allowed — an unrelated update
   * to a hard-tier engram must not fail because the tier is (already) full.
   *
   * @param pendingTokens hard-tier tokens accepted earlier in the same locked
   *   batch that `listPinned` cannot see yet.
   * @returns the candidate's cost if it counts toward the tier, else 0.
   */
  private async _assertHardTierFits(candidate: Engram, pendingTokens = 0): Promise<number> {
    if (!isHardPinned(candidate as never)) return 0
    // A retired (or otherwise non-active) engram is not injected, so it is
    // outside the tier: editing or retiring it must never be refused because
    // the tier is full. listPinned() already excludes such rows from the total.
    if (candidate.status !== undefined && candidate.status !== 'active') return 0
    const cost = estimateTokens(candidate as never)
    const hard = (await this.listPinned()).filter(e => isHardPinned(e as never))
    const previous = hard.find(e => e.id === candidate.id)
    if (previous && cost <= estimateTokens(previous as never)) return cost
    const others = hard.filter(e => e.id !== candidate.id)
    const current = others.reduce((n, e) => n + estimateTokens(e as never), 0) + pendingTokens
    const cap = this.hardTierCap()
    if (current + cost > cap) {
      const list = others.map(e => `${e.id} (${estimateTokens(e as never)} tokens)`).join(', ')
      throw new Error(
        `Hard-tier pinned cap exceeded: the hard tier holds ${current} tokens, ` +
        `this engram costs ${cost}, and the cap is ${cap} ` +
        `(injection.pinned_hard_ratio of the pinned quota). ` +
        `Existing hard-tier engrams: [${list}]. ` +
        `Pin it in the soft tier instead, or unpin a hard-tier engram first.`,
      )
    }
    return cost
  }

  /**
   * Pinned-budget accounting (#1142).
   *
   * The spec says `pinned` is an "always-load flag". The selector did not
   * honour that: it capped pinned at a share of the injection budget and
   * silently skipped the overflow, so pinning something could quietly evict
   * something else the user had also pinned. Measured on a real store,
   * lowering `injection_budget` from 56,000 to 12,000 dropped 36 of 46 pinned
   * engrams with nothing in the output saying so.
   *
   * The fix is not a better eviction rule — it is to stop over-committing.
   * Pinning is a deliberate act with a human present, so the quota is checked
   * THERE, where someone can decide, instead of at injection time where nobody
   * can. Over quota, the user unpins something or raises the limit.
   */
  async pinnedQuota(candidateId?: string): Promise<{
    quota: number
    used: number
    free: number
    count: number
    over: boolean
    /** Pinned engrams, most-expendable first — the unpin suggestion order. */
    entries: Array<{ id: string; statement: string; cost: number; net_feedback: number; last_accessed: string | null }>
    /** Set when `candidateId` names a not-yet-pinned engram: what pinning it would cost. */
    candidate?: { id: string; cost: number; would_be: number; fits: boolean }
  }> {
    const budget = this.config.injection_budget ?? 2000
    const ratio = this.config.injection?.pinned_ratio ?? 0.5
    const quota = Math.floor(budget * ratio)
    const pinned = await this.listPinned()

    const entries = pinned.map(e => {
      const fb = e.feedback_signals
      return {
        id: e.id,
        statement: e.statement,
        cost: estimateTokens(e as never),
        net_feedback: (fb?.positive ?? 0) - (fb?.negative ?? 0),
        last_accessed: e.activation?.last_accessed ?? null,
      }
    })

    // Ordered by COST, largest first — "what frees the most budget", which is
    // arithmetic. Deliberately NOT an expendability ranking.
    //
    // The first version sorted by net feedback ascending, on the theory that
    // an unendorsed engram is a safe cut. Run against a real store it proposed
    // unpinning the demo-redaction rule, "never name enterprise customers",
    // and "customer-named work runs in a dedicated session" — the three rules
    // whose absence had caused a live disclosure that same day. The reason is
    // structural: only 275 of 7,920 injections were ever rated, so ~96% of
    // engrams sit at net_feedback 0 and the sort collapses into noise.
    //
    // `net_feedback` and `last_accessed` are still reported per entry, because
    // they are real signals a human can weigh. They are just not a ranking,
    // and presenting them as one puts the system's thumb on a decision it has
    // no basis for.
    entries.sort((a, b) => b.cost - a.cost)

    const used = entries.reduce((n, e) => n + e.cost, 0)

    let candidate: { id: string; cost: number; would_be: number; fits: boolean } | undefined
    if (candidateId) {
      const e = await this.getById(candidateId)
      // Already-pinned is a no-op re-pin, not a new commitment — it must not
      // be charged twice or it would refuse itself.
      if (e && (e as { pinned?: boolean }).pinned !== true) {
        const cost = estimateTokens(e as never)
        candidate = { id: e.id, cost, would_be: used + cost, fits: used + cost <= quota }
      }
    }

    return {
      quota, used, free: Math.max(0, quota - used),
      count: entries.length, over: used > quota, entries,
      ...(candidate ? { candidate } : {}),
    }
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
  async forget(id: string, reason?: string, options?: { force?: boolean; scope?: string }): Promise<MutationOutcome> {
    this._assertWritable()
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
    // Decision E4: stores are passed, so a `project:*` scope a URL store
    // covers (equal or segment-contained) is NOT local-only and reaches it.
    if (targetScope && isLocalOnlyScope(targetScope, this.config.stores ?? [])) {
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
        ? await driver.probeById(serverId)
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
  private async _retireRescopedSource(id: string, toScope: string, newId: string): Promise<boolean> {
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
  }

  /** Remove retired engrams from storage. Returns count of removed and remaining. */
  async compact(): Promise<{ removed: number; remaining: number }> {
    this._assertWritable()
    return await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      // Decision D1: a retired row still carrying a queued "retire on remote"
      // entry is kept until the flush has retired the remote copy — removing
      // it would lose the only durable record of that pending DELETE.
      const active = engrams.filter(e => e.status !== 'retired' || !!(e as any).structured_data?._retireRemote)
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
      this._afterStoreCommit(() => this._kickPrimaryAutoEmbed(primary))
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
    applyOpts: { source?: FeedbackSource } = {},
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

        applyFeedbackSignal(engram, signal, undefined, applyOpts)

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
  // `allowModified` was declared on `InstallOptions` and then narrowed away
  // here, so no caller outside this module could ever pass it. That made the
  // standard's own remedy for a false-positive scan — correct the pack and
  // install it — unreachable, since correcting a pack moves the hash it shipped.
  async installPack(source: string, opts?: { allowInjection?: boolean; allowModified?: boolean }): Promise<ReturnType<typeof installPack>> {
    const existing = await this._loadAllEngrams()
    return installPack(this.paths.packs, source, existing, opts)
  }

  /** Uninstall a pack by name. */
  uninstallPack(name: string): ReturnType<typeof uninstallPack> {
    return uninstallPack(this.paths.packs, name)
  }

  /**
   * Export engrams as a shareable pack with privacy scanning and integrity hash.
   *
   * Throws when no licence has been chosen — by the caller here, or once in
   * `provenance.default_license`. That is deliberate: see `exportPack`.
   */
  exportPack(
    engrams: Engram[],
    outputDir: string,
    manifest: ExportOptions,
  ): ReturnType<typeof exportPack> {
    const configured = (this.config as any)?.provenance?.default_license as string | undefined
    return exportPack(engrams, outputDir, manifest, configured)
  }

  /** List all installed packs (with integrity hashes). */
  listPacks(): ReturnType<typeof listPacks> {
    return listPacks(this.paths.packs)
  }

  /**
   * Re-baseline installed packs' registry integrity from v1 to `sha256:v2:`
   * (ENGRAM-STANDARD-v1 §5.5), only for packs that still verify clean under v1.
   * `dryRun: true` reports without writing. See `migratePackIntegrity`.
   */
  migratePackIntegrity(opts: { dryRun?: boolean } = {}): ReturnType<typeof migratePackIntegrity> {
    return migratePackIntegrity(this.paths.packs, opts)
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
    // Same entries as `listOutbox()` (pushes AND queued remote retirements,
    // decision D1), so the count and the list cannot disagree.
    return (await this.listOutbox()).length
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
    /** `push`: a write waiting to reach its store (`_outbox`). `retire`: a
     *  queued DELETE of a copy the remote accepted after a forget/rescope
     *  cancelled its delivery (decision D1, `_retireRemote`) — listed so a
     *  stuck retirement is visible, not reported as an empty outbox. */
    kind: 'push' | 'retire'
    target_scope: string
    queued_at: string
    attempt_count: number
    last_error?: string
    /** HTTP status of the last failed push, when the remote gave one (#1299). */
    last_status?: number
    age_days: number
    /**
     * #1299: `retrying` — the next flush may succeed; `needs_action` — it
     * cannot (401/403/404/422, a write refusal, no writable store).
     */
    state: OutboxState
    /** One line, `needs_action` only: why retrying will not help. */
    reason?: string
    /** One line, `needs_action` only: what would. */
    next_step?: string
    /** `needs_action` only: the earliest time an automatic flush retries it. */
    next_retry_at?: string
    /** Advisory (decision C3): set while a writer holds the entry's live
     *  per-entry claim — any process's, THIS instance's own in-progress flush
     *  or learn() push included: the row is not stuck, it is being delivered,
     *  until this time. Read from the claim file alone. Only the expiry is
     *  reported — the holder names a process. */
    leased_until?: string
  }>> {
    const engrams = await this._loadCached(this.paths.engrams)
    const now = Date.now()
    const out = []
    type Entry = {
      target_scope?: string; queued_at?: string; attempt_count?: number; last_error?: string
      last_status?: unknown; last_attempt?: string
    }
    const toEntry = (id: string, kind: 'push' | 'retire', ob: Entry) => {
      const queued_at = typeof ob.queued_at === 'string' ? ob.queued_at : ''
      const queuedMs = queued_at ? Date.parse(queued_at) : NaN
      const target_scope = ob.target_scope ?? '(unknown)'
      const last_status = typeof ob.last_status === 'number' ? ob.last_status : undefined
      const verdict = classifyOutboxFailure({
        last_status,
        last_error: ob.last_error,
        has_store: this._hasWritableStoreFor(target_scope),
        scope: target_scope,
      })
      const nextRetry = verdict.state === 'needs_action' ? this._needsActionRetryAt(ob) : undefined
      return {
        id,
        kind,
        target_scope,
        queued_at,
        attempt_count: typeof ob.attempt_count === 'number' ? ob.attempt_count : 0,
        ...(ob.last_error ? { last_error: ob.last_error } : {}),
        ...(last_status !== undefined ? { last_status } : {}),
        state: verdict.state,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        ...(verdict.next_step ? { next_step: verdict.next_step } : {}),
        ...(nextRetry !== undefined && nextRetry > now ? { next_retry_at: new Date(nextRetry).toISOString() } : {}),
        // A malformed or missing timestamp reports 0, not NaN: this number is
        // rendered, and NaN in a report reads as a bug in the reporter rather
        // than as the missing data it actually is.
        age_days: Number.isFinite(queuedMs) ? Math.floor((now - queuedMs) / 86_400_000) : 0,
      }
    }
    for (const e of engrams) {
      const sd = (e as any).structured_data as { _outbox?: Entry; _retireRemote?: Entry } | undefined
      // Decision C3: advisory only, read from the entry's claim file alone.
      // A live claim (#1277) — any holder's, this instance's own included —
      // says the entry is being pushed now.
      const claimUntil = sd ? this._outboxClaimUntil(e.id, now) : undefined
      const leased = claimUntil ? { leased_until: claimUntil } : {}
      if (sd?._outbox && e.status !== 'retired') out.push({ ...toEntry(e.id, 'push', sd._outbox), ...leased })
      // Selected exactly as flushOutbox selects them (any status).
      if (sd?._retireRemote) out.push({ ...toEntry(e.id, 'retire', sd._retireRemote), ...leased })
    }
    return out
  }

  /** Counts by state plus one line per needs_action scope (#1299). */
  async outboxSummary(): Promise<OutboxSummary> {
    return summarizeOutbox(await this.listOutbox())
  }

  /** A url store accepting writes for exactly this scope — the flush's own lookup. */
  private _hasWritableStoreFor(scope: string): boolean {
    return (this.config.stores ?? []).some(s => s.url && s.scope === scope && !s.readonly)
  }

  /**
   * When an automatic flush may next dial a `needs_action` entry (#1299):
   * one attempt per NEEDS_ACTION_RETRY_MS, counted from the last attempt.
   * An entry with no readable last attempt is due now.
   */
  private _needsActionRetryAt(ob: { last_attempt?: string }): number | undefined {
    const last = typeof ob.last_attempt === 'string' ? Date.parse(ob.last_attempt) : NaN
    return Number.isFinite(last) ? last + NEEDS_ACTION_RETRY_MS : undefined
  }

  /**
   * Flush the outbox — retry pushing pending engrams to their target remote
   * stores. Called automatically on session_start and plur_sync.
   *
   * On success: removes the local copy (remote is source of truth).
   * On failure: updates attempt metadata for next retry.
   * After 7 days: includes warning in expired_warnings.
   *
   * `timeoutMs` (#1269) bounds the NETWORK part of the flush, for callers that
   * run under a harness timeout (editor session-end and stop hooks). The clock
   * starts after the local store load, so a large store does not spend the
   * budget on disk. When it runs out, the in-flight push is cut and nothing
   * further is started; every entry not delivered is counted in `deferred`
   * and left queued. A cut is not a strike against the host — running out of
   * OUR time says nothing about THEIRS. The merge-back after is not covered:
   * it must run to completion or a delivered entry would be pushed again.
   *
   * Decision C4: a push that was cut, timed out or threw is simply retried
   * on the next flush — there is no "maybe delivered" state and no lookup
   * before a re-post. What makes the retry safe is the idempotency key: a
   * random UUID minted when the write is queued, persisted on the outbox row
   * BEFORE the first POST (a row from an older client gets one minted and
   * persisted here, before it is posted), and sent on every retry. A
   * key-honouring server collapses the retry; a key-ignoring one may see at
   * most one duplicate per write (docs/remote-store-contract.md).
   *
   * Decision C3: each entry is claimed before it is pushed, so two writers —
   * two flushes, or a flush and learn()'s background push — never push it at
   * once. Claims are released when the flush ends, also when it throws; the
   * key is on the row, so nothing about the next retry depends on them.
   *
   * `skipped` counts entries not attempted because their host's circuit
   * breaker is open; the reason is in `expired_warnings`.
   *
   * #1299: an entry whose last failure retrying cannot fix (`needs_action`:
   * 401/403/404/422 or a write refusal) is re-dialled at most once per
   * NEEDS_ACTION_RETRY_MS by this automatic path. Those skipped are counted in
   * `held` and left exactly as they were. `force: true` — the explicit
   * `plur outbox --flush` / `plur_outbox { flush: true }` — retries them
   * anyway, for the user who has just fixed the cause. Nothing is ever
   * dropped or rescoped for being `needs_action`.
   */
  async flushOutbox(options: { timeoutMs?: number; force?: boolean } = {}): Promise<{ flushed: number; failed: number; deferred: number; held: number; skipped: number; expired_warnings: string[] }> {
    this._assertWritable()
    // #1269: the network budget. Started by the flush itself once the local
    // load is done (review of #1277), so a large store does not spend it on disk.
    const budget = new AbortController()
    let budgetTimer: NodeJS.Timeout | undefined
    const startBudget = () => {
      if (options.timeoutMs !== undefined && !budgetTimer) {
        budgetTimer = setTimeout(() => budget.abort(), Math.max(0, options.timeoutMs))
      }
    }
    // Ids this flush marks in `_outboxInFlight`, released however it ends.
    const claimed = new Set<string>()
    // #1277 per-entry claims this flush takes; released however it ends (C4).
    const entryClaims = new Set<string>()
    try {
      return await this._flushOutboxClaimed(claimed, budget.signal, options.force === true, startBudget, entryClaims)
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer)
      // Decision C4: the per-entry claims are released however the flush
      // ended — a thrown merge-back included. The idempotency key lives on the
      // outbox row, so the retry does not need the claim to remember anything.
      for (const id of entryClaims) this._releaseOutboxClaim(id)
      for (const id of claimed) this._outboxInFlight.delete(id)
    }
  }

  /**
   * A row is still waiting for delivery: it carries `_outbox` and is not
   * retired — exactly flushOutbox()'s selection predicate. The merge-back and
   * learn()'s hand-off re-check it on the FRESH row, so a cancellation that
   * landed during the network round-trip (forget #766, local rescope #848)
   * is honoured instead of overwritten.
   */
  private static _stillQueued(e: Engram | undefined): boolean {
    return !!e && !!(e as any).structured_data?._outbox && e.status !== 'retired'
  }

  /**
   * Still queued AND still queued for the store a push just went to (audit of
   * #1228, finding 1). A D4 update or a rescope can retarget `_outbox` to
   * another store while the POST to the old one is on the wire; the fresh row
   * then still carries `_outbox`, but for a store that has NOT received it.
   * Only a row whose entry still names the same url and scope is handed off.
   */
  private static _stillQueuedFor(
    e: Engram | undefined,
    target: { url: string; scope: string } | undefined,
  ): boolean {
    if (!target || !Plur._stillQueued(e)) return false
    const ob = (e as any).structured_data._outbox as { target_url?: string; target_scope?: string }
    return ob.target_scope === target.scope
      && !!ob.target_url && normalizeEndpointUrl(ob.target_url) === normalizeEndpointUrl(target.url)
  }

  /**
   * Decision D1 "queue-retire": stamp a durable "retire on remote" entry on the
   * local row — the copy a remote accepted AFTER a forget/rescope cancelled
   * its delivery. `flushOutbox()` retries it like any other queued write, as a
   * DELETE of `server_id` on the store at `target_url`/`target_scope`; it never
   * POSTs, so it cannot resurrect anything. Idempotent: an entry for the same
   * server id is left as it is. Returns whether the row changed. Mutates `row`.
   */
  private static _queueRetireRemote(
    row: Engram,
    target: { target_url: string; target_scope: string; server_id: string },
    now: string,
  ): boolean {
    if (!target.server_id || !target.target_url) return false
    const sd = ((row as any).structured_data && typeof (row as any).structured_data === 'object')
      ? { ...(row as any).structured_data as Record<string, unknown> } : {}
    const existing = sd._retireRemote as { server_id?: string } | undefined
    if (existing?.server_id === target.server_id) return false
    sd._retireRemote = { ...target, queued_at: now, last_attempt: '', attempt_count: 0, last_error: '' }
    ;(row as any).structured_data = sd
    return true
  }

  private async _flushOutboxClaimed(
    claimed: Set<string>,
    budget: AbortSignal,
    force: boolean,
    startBudget: () => void,
    entryClaims: Set<string>,
  ): Promise<{ flushed: number; failed: number; deferred: number; held: number; skipped: number; expired_warnings: string[] }> {
    // The re-guard below promises the target scope's CURRENT policy (R2-D #12);
    // without this a long-running process flushed against the config it
    // started with (core-index#9, round 2).
    this.reloadConfigIfChanged()
    let flushed = 0
    let failed = 0
    let deferred = 0
    let held = 0
    let skipped = 0
    /** Outbox metadata changed without a delivery or a failure (a cut). */
    let metadataDirty = false
    /** Warn once per host, not once per queued engram (#785). */
    const cooldownSkippedHosts = new Set<string>()
    const expired_warnings: string[] = []
    const TTL_MS = 7 * 24 * 60 * 60 * 1000
    let now = new Date()
    type OutboxEntry = {
      target_url: string; target_scope: string; queued_at: string
      last_attempt: string; attempt_count: number; last_error: string
      /** HTTP status of the last failed push (#1299). */
      last_status?: number
      /** Unique per logical write, stable across its retries (C4). */
      idempotency_key?: string
    }
    /**
     * #1299: back off an entry the store has already refused in a way a retry
     * cannot fix. Nothing about it changes; it is only not dialled. `force` —
     * the explicit flush — dials it.
     */
    const heldBack = (outbox: OutboxEntry): boolean => {
      if (force) return false
      const verdict = classifyOutboxFailure({
        last_status: typeof outbox.last_status === 'number' ? outbox.last_status : undefined,
        last_error: outbox.last_error,
      })
      const retryAt = verdict.state === 'needs_action' ? this._needsActionRetryAt(outbox) : undefined
      return retryAt !== undefined && retryAt > now.getTime()
    }
    const warnIfOld = (engram: Engram, outbox: OutboxEntry): void => {
      const ageMs = now.getTime() - new Date(outbox.queued_at).getTime()
      if (ageMs > TTL_MS) {
        expired_warnings.push(
          `${engram.id} queued ${outbox.queued_at} (${Math.floor(ageMs / 86400000)}d ago) — consider manual resolution`
        )
      }
    }
    /**
     * Will this queued row be POSTed now, and to which store? A row that will
     * not — held back, no store, host in cooldown — needs no network call, so
     * it is not claimed (audit of #1231, finding 3: a flush
     * that attempted nothing still rewrote the whole store twice). Consulted at
     * selection AND again right before the push, since this flush's own
     * failures can open a host's breaker mid-batch.
     */
    const routeFor = (engram: Engram, outbox: OutboxEntry):
      { storeEntry: StoreEntry } | { skip: 'failed' | 'skipped'; warning?: string } => {
      // Invariant `_outbox ⇒ scope === _outbox.target_scope` (formal WritePath,
      // candidate 2). Every in-process writer now keeps it: rescope() cancels
      // or retargets (#848), updateEngram() does the same (decision D4), and
      // cross-scope recurrence never widens a queued row (decision D3). Kept as
      // DEFENCE, because it is still reachable: a hand-edited engrams.yaml, an
      // older client sharing the store, or an update that keeps the scope but
      // supplies its own `_outbox`. Pushing such a row delivered it, carrying its
      // scope, to another store. Held back, loudly and non-destructively: the
      // entry stays queued, so rescoping the engram decides where it goes.
      if (engram.scope !== outbox.target_scope) {
        return {
          skip: 'failed',
          warning: `${engram.id}: NOT pushed — its scope is now "${engram.scope}" but it was queued for `
            + `"${outbox.target_scope}". Rescope it (to "${outbox.target_scope}" to deliver, or to a local `
            + `scope to cancel the delivery).`,
        }
      }
      // Resolve remote driver from current config (don't store tokens in outbox)
      const storeEntry = (this.config.stores ?? []).find(
        s => s.url && s.scope === outbox.target_scope && !s.readonly
      )
      if (!storeEntry) {
        return { skip: 'failed', warning: `${engram.id}: no matching remote store for scope ${outbox.target_scope}` }
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
      // Per credential (R2-CoreB core-policy#3): a 429 on another token for
      // this url does not park this one.
      const cooldown = isHostInCooldown(storeEntry.url!, Date.now(), healthPath, storeEntry.token)
      if (cooldown.inCooldown) {
        if (cooldownSkippedHosts.has(storeEntry.url!)) return { skip: 'skipped' }
        cooldownSkippedHosts.add(storeEntry.url!)
        const secs = Math.max(1, Math.ceil(((cooldown.until ?? 0) - Date.now()) / 1000))
        return {
          skip: 'skipped',
          warning: `${storeEntry.url}: skipped — ${cooldown.reason === 'rate_limit' ? 'rate-limited' : 'circuit breaker open'}, `
            + `retrying in ~${secs}s. Queued engrams stay queued.`,
        }
      }
      return { storeEntry }
    }
    const holdBack = (r: { skip: 'failed' | 'skipped'; warning?: string }): void => {
      if (r.warning) expired_warnings.push(r.warning)
      if (r.skip === 'failed') failed++
      else skipped++
    }
    type RetireEntry = { target_url: string; target_scope: string; server_id: string; queued_at: string; last_attempt: string; attempt_count: number; last_error: string }
    const retireStoreFor = (entry: RetireEntry): StoreEntry | undefined => (this.config.stores ?? []).find(
      s => s.url && s.scope === entry.target_scope && normalizeEndpointUrl(s.url) === normalizeEndpointUrl(entry.target_url),
    )

    // Decision C3 (2026-09-29): #1277's per-entry claims are the one
    // duplicate-push guard (spec/formal/findings/outbox.md: leases alone
    // duplicate after a crash; claims alone suffice). There are no row leases,
    // so selection needs no store lock — the merge-back below still merges
    // into a fresh read under it.
    // Stamped BEFORE the load, so the rows are at least as new as the stamp
    // (review of #1277): the re-read after claiming trusts this read while
    // the store file is unchanged.
    const rowsSeen = { stamp: this._engramsFileStamp(), keys: new Map<string, string | undefined>() }
    let engrams: Engram[] = await this._primaryStore.load()
    rowsSeen.keys = queuedOutboxKeys(engrams)
    now = new Date()
    // A row this process is pushing right now (`_outboxInFlight`: learn()'s
    // immediate push, a concurrent flush) is not ours to push; another
    // process's push is kept off by the claim taken in the push loop.
    const free = (e: Engram) => !this._outboxInFlight.has(e.id)
    // #766: skip retired engrams — a retired engram must not be pushed to the
    // remote and resurrected. The cancel-outbox path in forget() strips _outbox
    // on retirement; this guard is belt-and-suspenders for any path that retires
    // without explicitly cancelling (e.g. direct YAML edits, older client versions).
    const pending: Engram[] = engrams.filter(e => {
      if (!Plur._stillQueued(e) || !free(e)) return false
      // A row owing a retire is decided in the push loop (after its retire).
      if ((e as any).structured_data._retireRemote) return true
      const outbox = (e as any).structured_data._outbox as OutboxEntry
      const route = routeFor(e, outbox)
      if ('storeEntry' in route) {
        if (!heldBack(outbox)) return true
        held++
        return false
      }
      // Finding 3: not attempted now — reported, and nothing is written.
      warnIfOld(e, outbox)
      holdBack(route)
      return false
    })
    for (const e of pending) { this._outboxInFlight.add(e.id); claimed.add(e.id) }
    // Decision D1: queued "retire on remote" entries — retired or rescoped
    // rows whose remote copy was accepted after the delivery was cancelled.
    // A row can carry both (audit of #1228, finding 1: retargeted to another
    // store while the push to the old one was in flight) — it is claimed by
    // THIS flush through `pending`, so it is not skipped as in flight: the
    // old copy is retired here, before the push to the new store below. Two
    // concurrent retirers are harmless: `removeIdempotent` treats 404/410 as done.
    const pendingClaimed = new Set(pending.map(e => e.id))
    const retiring: Engram[] = engrams.filter(e => {
      const entry = (e as any).structured_data?._retireRemote as RetireEntry | undefined
      if (!entry || !(pendingClaimed.has(e.id) || free(e))) return false
      if (retireStoreFor(entry)) return true
      // Finding 3: no store to send the DELETE to — reported, nothing written.
      expired_warnings.push(
        `${e.id}: remote copy ${entry.server_id} is queued for retirement on "${entry.target_scope}", `
        + `but no store with that url and scope is configured — still queued.`,
      )
      failed++
      return false
    })
    for (const e of retiring) { this._outboxInFlight.add(e.id); claimed.add(e.id) }
    // #1269: the network budget starts NOW, after the local load.
    startBudget()
    // Finding 3: nothing to attempt — no merge-back, no write.
    if (pending.length === 0 && retiring.length === 0) {
      return { flushed, failed, deferred, held, skipped, expired_warnings }
    }

    // Decision C4: every entry's idempotency key is ON ITS ROW before its first
    // POST. Rows queued by clients that predate keys get one minted and
    // persisted here, under the store lock, before anything is posted — so a
    // merge-back that later throws cannot cost the retry its key.
    await this._persistMissingOutboxKeys(pending)

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
    /**
     * Entries found already delivered (or re-queued) by another writer once
     * claimed. Left out of the merge-back entirely: this flush's snapshot of
     * them is stale and must not be written over the current row.
     */
    const leftToOthers = new Set<string>()

    // Decision D1: retire accepted-after-cancel remote copies. A DELETE by the
    // server id the remote assigned; 404/410 means already gone (done). The
    // outcome is merged below: `undefined` = done (entry removed), otherwise
    // the entry with its attempt bookkeeping bumped.
    const retireOutcome = new Map<string, { serverId: string; next: RetireEntry | undefined }>()
    for (const row of retiring) {
      // #1269: out of budget — leave it queued, untouched, for next time.
      if (budget.aborted) { deferred++; continue }
      const entry = (row as any).structured_data._retireRemote as RetireEntry
      const storeEntry = retireStoreFor(entry)
      if (!storeEntry) {
        expired_warnings.push(
          `${row.id}: remote copy ${entry.server_id} is queued for retirement on "${entry.target_scope}", `
          + `but no store with that url and scope is configured — still queued.`,
        )
        failed++
        continue
      }
      const driver = this._getRemoteDriver({ url: storeEntry.url!, token: storeEntry.token, scope: storeEntry.scope })
      try {
        await driver.removeIdempotent(entry.server_id)
        retireOutcome.set(row.id, { serverId: entry.server_id, next: undefined })
        flushed++
        this._appendHistory({
          event: 'engram_retired',
          engram_id: row.id,
          timestamp: now.toISOString(),
          data: { reason: 'delivery cancelled locally during the push', routed_to: 'remote', scope: entry.target_scope, server_id: entry.server_id, outbox_flush: true },
        })
      } catch (err) {
        retireOutcome.set(row.id, {
          serverId: entry.server_id,
          next: { ...entry, last_attempt: now.toISOString(), attempt_count: (entry.attempt_count ?? 0) + 1, last_error: (err as Error).message },
        })
        failed++
        logger.warning(`[plur:outbox] retiring remote copy ${entry.server_id} of ${row.id} failed: ${(err as Error).message}`)
      }
    }
    /** Where each pushed id went — for queuing a retire if it was cancelled meanwhile (D1). */
    const pushedTo = new Map<string, { url: string; scope: string }>()

    for (const engram of pending) {
      // #1269: out of budget — leave the rest queued, untouched, for next time.
      if (budget.aborted) { deferred++; continue }
      const outbox = (engram as any).structured_data._outbox as OutboxEntry

      // C4: never post without the key already on the row. Only a failed
      // key write above leaves one keyless; it waits for the next flush.
      if (!outbox.idempotency_key) {
        expired_warnings.push(`${engram.id}: its idempotency key could not be saved — left for the next flush`)
        deferred++
        continue
      }

      // C3: claim the entry before touching the network — one pusher at a
      // time (another flush in any process, or learn()'s own background push).
      const claim = this._claimOutboxEntry(engram.id, () => outbox.idempotency_key!)
      if (claim.status === 'busy') {
        expired_warnings.push(`${engram.id}: another writer is pushing it right now — left to that writer`)
        deferred++
        continue
      }
      entryClaims.add(engram.id)

      // The claim guards the ROW, not this flush's snapshot of it (review of
      // #1277). The snapshot was loaded before any network round-trip; since
      // then another writer may have pushed this entry, removed its row and
      // released its claim. Both removal paths delete the row BEFORE they
      // release, so reading it now, under our claim, sees that. Gone, or
      // re-queued under a different key: someone else owns it — leave it.
      if (!(await this._outboxRowStillQueued(engram.id, outbox.idempotency_key, rowsSeen))) {
        leftToOthers.add(engram.id)
        continue
      }

      // Audit of #1228, finding 1: a row still owing a retire of an older
      // remote copy is delivered only once that retire is done. Pushing first
      // and then losing the row on hand-off would drop the retire entry with it.
      const owedRetire = (engram as any).structured_data._retireRemote as { server_id?: string } | undefined
      if (owedRetire) {
        const r = retireOutcome.get(engram.id)
        if (!r || r.serverId !== owedRetire.server_id || r.next !== undefined) {
          expired_warnings.push(
            `${engram.id}: NOT pushed yet — its earlier remote copy ${owedRetire.server_id ?? '?'} must be retired `
            + `first (still queued; the next flush retries both).`,
          )
          failed++
          continue
        }
      }

      warnIfOld(engram, outbox)
      const route = routeFor(engram, outbox)
      if (!('storeEntry' in route)) { holdBack(route); continue }
      const { storeEntry } = route

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
        // C4: the same key on every retry of this write.
        const pushed = await driver.appendAndGetServerId(cleanEngram, { signal: budget, idempotencyKey: outbox.idempotency_key })
        // #863: remember the mapping so a later engram in this same flush can
        // point at the server id rather than the local one.
        pushedTo.set(engram.id, { url: storeEntry.url!, scope: outbox.target_scope })
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
        this._appendHistory({
          event: 'engram_created',
          engram_id: engram.id,
          timestamp: now.toISOString(),
          data: { routed_to: 'remote', outbox_flush: true, scope: engram.scope },
        })
        this._maybeWriteProvenance(engram.id)
      } catch (err) {
        // #1269: cut at the caller's budget. Not a failure of the remote, so
        // the breaker is not fed. Recorded as an attempt so `plur outbox`
        // shows it, and retried on the next flush with the same key (C4).
        // A remote timeout or any other error takes the ordinary failure
        // path below and is retried the same way.
        if (err instanceof RemoteAbortedError) {
          outbox.last_attempt = now.toISOString()
          outbox.attempt_count += 1
          outbox.last_error = 'cut at the flush time budget before the remote answered — retried on the next flush'
          // #1299: this attempt got no status; an older 403 must not keep
          // classifying the entry as needs_action.
          delete outbox.last_status
          metadataDirty = true
          deferred++
          logger.warning(`[plur:outbox] ${engram.id}: flush budget ran out mid-push — left queued for retry`)
          continue
        }
        outbox.last_attempt = now.toISOString()
        outbox.attempt_count += 1
        outbox.last_error = (err as Error).message
        // #1299: the status when the remote gave one; cleared when it did not,
        // so a stale 403 cannot outlive a later network failure.
        if (err instanceof RemoteHttpError) outbox.last_status = err.status
        else delete outbox.last_status
        // #785: and a write failure counts toward the same breaker, so a host
        // that only ever fails on writes still opens one.
        //
        // #1308: except a refusal (401/403/404/422). The host answered; it
        // said the REQUEST was wrong. Counting it let a few refused writes to
        // one scope open the breaker for every scope on the host. It neither
        // counts nor resets. Network errors, timeouts and 5xx still count.
        const refused = err instanceof RemoteHttpError && NEEDS_ACTION_STATUSES.has(err.status)
        if (!refused) recordWriteOutcome(storeEntry.url!, false, Date.now(), this.remoteHealthStatePath())
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
    if (flushed > 0 || failed > 0 || metadataDirty) {
      const consideredIds = new Set(pending.map(e => e.id).filter(id => !leftToOthers.has(id)))
      const retiredAt = new Date().toISOString()
      const survivorsById = new Map(
        engrams.filter(e => consideredIds.has(e.id)).map(e => [e.id, e] as const),
      )
      await this._withStoreLock(this.paths.engrams, async () => {
        const fresh = await this._storeAt(this.paths.engrams).load()
        const merged = fresh
          // Drop the ones this flush successfully pushed (remote now owns them)
          // — but only while the fresh row is STILL queued. A forget() or local
          // rescope that landed during the push cancelled the delivery; the
          // remote accepted it anyway (the POST was already on the wire), so
          // keep the local record and report the stray remote copy (#766).
          .filter(e => {
            if (!(consideredIds.has(e.id) && !survivorsById.has(e.id))) return true
            const dest = pushedTo.get(e.id)
            // Handed off only while still queued FOR THE STORE IT WENT TO — a
            // D4 update / rescope that retargeted it mid-push leaves it queued
            // for a store that has not received it (audit of #1228, finding 1).
            if (Plur._stillQueuedFor(e, dest)) return false
            const retargeted = Plur._stillQueued(e)
            const serverId = localToServer.get(e.id)
            // Decision D1: queue the accepted copy for retirement on the remote
            // (durable, on this kept row); the next flush DELETEs it.
            const queuedRetire = !!(serverId && dest)
              && Plur._queueRetireRemote(e, { target_url: dest!.url, target_scope: dest!.scope, server_id: serverId! }, retiredAt)
            expired_warnings.push(
              `${e.id}: delivery was ${retargeted ? 'retargeted to another store' : 'cancelled locally (forget/rescope)'} `
              + `while the push was in flight, but the remote accepted it${serverId ? ` as ${serverId}` : ''}. `
              + `The local record is kept${retargeted ? ', still queued for the new store' : ''}; `
              + (queuedRetire || (serverId && (e as any).structured_data?._retireRemote?.server_id === serverId)
                ? `the remote copy is queued for retirement (next flush).`
                : `retire the remote copy there if it should not exist.`),
            )
            return true
          })
          .map(e => {
            const survivor = survivorsById.get(e.id)
            if (!survivor) return e
            // #848: the delivery was cancelled while this flush ran (forget
            // stripped `_outbox`, a local rescope dropped it). Copying the
            // snapshot's `_outbox` back would re-queue it; leave the row alone.
            if (!Plur._stillQueued(e)) return e
            const sSd = (survivor as any).structured_data as Record<string, unknown> | undefined
            // Audit of #1228, finding 1: retargeted meanwhile (D4 update /
            // rescope to another store). The snapshot's `_outbox` names the OLD
            // store; copying it back would re-point the row there.
            const sOb = sSd?._outbox as { target_url?: string; target_scope?: string } | undefined
            if (sOb?.target_url && !Plur._stillQueuedFor(e, { url: sOb.target_url, scope: sOb.target_scope ?? '' })) return e
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
          // Decision D1: apply the retire outcomes — only to a row whose entry
          // is still the one this flush worked on (same server id).
          .map(e => {
            const r = retireOutcome.get(e.id)
            const cur = (e as any).structured_data?._retireRemote as { server_id?: string } | undefined
            if (!r || cur?.server_id !== r.serverId) return e
            const fSd = { ...((e as any).structured_data as Record<string, unknown>) }
            if (r.next) fSd._retireRemote = r.next
            else delete fSd._retireRemote
            return { ...e, structured_data: Object.keys(fSd).length > 0 ? fSd : undefined } as Engram
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

    return { flushed, failed, deferred, held, skipped, expired_warnings }
  }

  /**
   * Identity of the YAML store file's current contents (inode, size, mtime in
   * ns): any write changes it. `undefined` when the primary store is not the
   * default YAML file, or it cannot be stat'ed — the caller then reads.
   */
  private _engramsFileStamp(): string | undefined {
    if (!(this._primaryStore instanceof YamlPrimaryStore)) return undefined
    try {
      const st = fs.statSync(this._primaryStore.location, { bigint: true })
      return `${st.ino}:${st.size}:${st.mtimeNs}`
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : undefined
    }
  }

  /**
   * Is this outbox row still queued, under this key, in the store as it is
   * NOW? False when the row is gone (delivered and removed by another
   * writer), retired, no longer queued, or queued under a different key (a
   * different logical write). False also when the store cannot be read:
   * skipping costs a flush, pushing blind can cost a duplicate.
   *
   * `seen` is the newest read this flush has made and the file stamp taken
   * just before it. While the YAML file's stamp is unchanged nothing has been
   * written since, so that read is current and the store is not loaded again:
   * a large store is not re-parsed per entry inside the network budget
   * (#1269). A store supplied by the embedder has no file to stamp and is
   * read every time.
   */
  private async _outboxRowStillQueued(
    id: string,
    key: string,
    seen: { stamp: string | undefined; keys: Map<string, string | undefined> },
  ): Promise<boolean> {
    try {
      const stamp = this._engramsFileStamp()
      if (stamp === undefined) {
        const row = (await this._loadTargeted([id])).find(e => e.id === id)
        return row !== undefined && queuedOutboxKeys([row]).get(id) === key
      }
      if (stamp !== seen.stamp) {
        seen.stamp = stamp
        seen.keys = queuedOutboxKeys(await this._primaryStore.load())
      }
      return seen.keys.get(id) === key
    } catch (err) {
      logger.warning(`[plur:outbox] could not re-read ${id} before pushing it — left for the next flush: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * Mint and persist an idempotency key for every pending outbox row that has
   * none (rows queued by clients that predate keys), BEFORE any is posted
   * (decision C4). Under the store lock; a row another writer keyed in the
   * meantime keeps that key. Updates `pending` in place. Never throws: a row
   * whose key could not be saved stays keyless and is not posted this flush.
   */
  private async _persistMissingOutboxKeys(pending: Engram[]): Promise<void> {
    const keyless = pending.filter(e => !(e as any).structured_data?._outbox?.idempotency_key)
    if (keyless.length === 0) return
    try {
      await this._withStoreLock(this.paths.engrams, async () => {
        const fresh = await this._loadTargeted(keyless.map(e => e.id))
        const changed: Engram[] = []
        for (const row of fresh) {
          const ob = (row as any).structured_data?._outbox
          const mine = keyless.find(e => e.id === row.id) as any
          if (!ob || !mine) continue
          if (!ob.idempotency_key) {
            ob.idempotency_key = randomUUID()
            changed.push(row)
          }
          mine.structured_data._outbox.idempotency_key = ob.idempotency_key
        }
        await this._updateEngrams(fresh, changed)
      })
    } catch (err) {
      for (const e of keyless) delete (e as any).structured_data._outbox.idempotency_key
      logger.warning(`[plur:outbox] could not save idempotency keys for ${keyless.length} queued write(s): ${(err as Error).message}`)
    }
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

    this._appendHistory({
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
    this._appendHistory({
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

            this._appendHistory({
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
              this._appendHistory({
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
      ...(await (async () => {
        const summary = await readOrAsync('outbox', () => this.outboxSummary(), undefined as OutboxSummary | undefined)
        if (!summary) return {}
        return {
          outbox_needs_action: summary.needs_action,
          ...(summary.needs_action > 0 ? { outbox_attention: summary.scopes } : {}),
        }
      })()),
      history_events: readOr('history', () => countInjectionEvents(this.paths.root), undefined as any),
      ...(this._lastIndexError ? { index_error: this._lastIndexError } : {}),
      ...(Object.keys(storeErrors).length > 0 ? { store_errors: storeErrors } : {}),
      // Back-compat alias for the field this replaced.
      ...(storeErrors.packs ? { pack_registry_error: storeErrors.packs } : {}),
      ...(this._spreadDrops.dropped_unresolvable > 0 || this._spreadDrops.dropped_retired > 0
        ? { spread_drops: { ...this._spreadDrops } }
        : {}),
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
    this._assertWritable()
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
    this._assertWritable()
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
    this._assertWritable()
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
    // Readonly (#731): refuse BEFORE the claim below writes tensions.yaml.
    this._assertWritable()
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
      engram.updated_at = new Date().toISOString()
      if (!engram.rationale) engram.rationale = `Retired: ${reason}`
    }
    const foundInPrimary = await this._withStoreLock(this.paths.engrams, async () => {
      const engrams = await this._primaryStore.load()
      const engram = engrams.find(e => e.id === id)
      if (!engram) return false
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
    } catch (err) {
      // Fail CLOSED (formal WritePath, candidate 5). `loadTensions` throws on
      // an unreadable file precisely so it is never read as empty (#794 F1);
      // answering "no tension" here undid that and let contradicted knowledge
      // escalate into 'locked' — the one outcome this gate exists to stop.
      // Capping at 'decided' while the file is unreadable is recoverable; a
      // wrong lock is not. (A MISSING file still reads as no tensions.)
      logger.warning(
        `[plur:tensions] tensions file unreadable (${(err as Error).message}); `
        + `treating ${engramId} as possibly contradicted — lock escalation held back`,
      )
      return true
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
  getTensionsConfig(): { temporal_domains: string[]; snapshot_pairs: 'skip' | 'floor'; measured_under_pairs: 'skip' | 'floor'; temporal_discount: boolean } {
    const t = this.config.tensions ?? {}
    return {
      temporal_domains: t.temporal_domains ?? [],
      snapshot_pairs: t.snapshot_pairs ?? 'skip',
      measured_under_pairs: t.measured_under_pairs ?? 'skip',
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
   * Load config.yaml for in-memory use, dropping a LOCAL store entry only when
   * it would load engrams that are already loaded (#1319), compared by
   * canonical path:
   *
   *  - its file is the primary store: every primary engram would load a
   *    second time under namespaced ids and be injected twice; or
   *  - its file AND scope repeat an earlier entry: the same engrams again.
   *
   * One file registered under two DIFFERENT scopes keeps loading under both,
   * as it always has: each scope admits different engrams, so dropping one
   * would make that scope's engrams vanish from recall. It gets an
   * informational warning instead.
   *
   * A dropped entry is only ignored here: config.yaml is not rewritten, and
   * writebacks start from the raw file (addStore / persistScopeMetadata), so
   * nothing is deleted from disk. `ignoredDuplicateStores()` reports it.
   */
  private _loadConfig(): PlurConfig {
    const config = loadConfig(this.paths.config)
    const stores = config.stores ?? []
    if (!stores.some(s => s.path !== undefined && !s.url)) {
      this._ignoredDuplicates = []
      return config
    }
    const { kept, ignored, sharedFile } = classifyStoreDuplicates(stores, this.paths.engrams)
    const warnOnce = (key: string, message: string): void => {
      if (this._warnedDuplicateStores.has(key)) return
      this._warnedDuplicateStores.add(key)
      logger.warning(message)
    }
    for (const { entry: s, primary } of ignored) {
      warnOnce(`${s.path}\0${s.scope}`, primary
        ? `[plur:config] ignoring store "${s.scope}" (${s.path}): it is the primary store file, which is always loaded. ` +
          `Loading it again would inject every engram in it twice. The entry is left in config.yaml; run \`plur stores prune\` to remove it.`
        : `[plur:config] ignoring store "${s.scope}" (${s.path}): the same file is already registered under the same scope. ` +
          `Loading it again would inject its engrams twice. The entry is left in config.yaml; remove it to silence this warning.`)
    }
    for (const { entry: s, firstScope } of sharedFile) {
      warnOnce(`${s.path}\0${s.scope}`,
        `[plur:config] store "${s.scope}" (${s.path}) is the same file as store "${firstScope}". Both are loaded: ` +
        `each scope admits its own engrams, and engrams scoped "global" in that file appear under both.`)
    }
    this._ignoredDuplicates = ignored
    return ignored.length ? { ...config, stores: kept } : config
  }

  /** Local store entries in config.yaml that are ignored because they name the
   *  primary file, or repeat an earlier entry's file and scope (#1319). */
  ignoredDuplicateStores(): StoreEntry[] {
    return this._ignoredDuplicates.map(d => d.entry)
  }

  /**
   * Remove the config.yaml store entries that name the primary engrams file
   * (`plur stores prune`, #1356). They are already ignored at load; this stops
   * the warning for good. Only those entries are removed and the rest of
   * config.yaml is kept byte for byte — see {@link removePrimaryStoreEntries}.
   * Returns the removed entries.
   */
  removeDuplicatePrimaryStores(): StoreEntry[] {
    const removed = removePrimaryStoreEntries(this.paths.config, this.paths.engrams)
    if (removed.length) {
      this.config = this._loadConfig()
      this.configMtimeMs = this.statConfigMtime()
    }
    return removed
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
    this.config = this._loadConfig()
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
    this.config = this._loadConfig()
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
    // Local identity is the CANONICAL path (#1319): the same file spelled two
    // ways (a symlinked home, /var vs /private/var) is one store, and the
    // primary engrams.yaml is never a secondary store under any spelling —
    // registering it loads every primary engram twice.
    const canonicalStorePath = isRemote ? '' : canonicalize(storePath)
    if (!isRemote && canonicalStorePath === canonicalize(this.paths.engrams)) {
      const ignoredHere = this._ignoredDuplicates
        .filter(d => d.duplicateOf === 'the primary store')
        .map(d => `"${d.entry.scope}" (${d.entry.path})`)
      throw new Error(
        `addStore: "${storePath}" is the primary store (${this.paths.engrams}); it is always loaded and cannot be registered again as "${scope}".` +
        (ignoredHere.length
          ? ` config.yaml already lists it as ${ignoredHere.join(', ')}; that entry is ignored at load. Run \`plur stores prune\` to remove it.`
          : ''),
      )
    }
    // Local stores answer from what is LOADED (this.config, which drops
    // ignored duplicates), not the raw file: an entry that is ignored at load
    // must never be reported as the registration that covers this path. Among
    // loaded entries for the same file, one with the requested scope wins.
    const localMatches = isRemote ? [] : (this.config.stores ?? []).filter(s =>
      s.path !== undefined && !s.url && (s.path === storePath || canonicalize(s.path) === canonicalStorePath))
    const sameEntry = isRemote
      ? config.stores?.find(s => s.url !== undefined && normalizeEndpointUrl(s.url) === normalizeEndpointUrl(options!.url!) && s.scope === scope)
      : (localMatches.find(s => s.scope === scope) ?? localMatches[0])
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
   * Register a remote (url) store only after the server has vouched for it
   * (#1265). {@link addStore} is synchronous and never checks the token, so an
   * installer script using it could write a dead token, or a scope the token
   * cannot reach, and learn so only at the first failed recall.
   *
   * Order: validate the URL, ask `GET /api/v1/me` with the offered token (raced
   * against `timeoutMs`), require `scope` to be among the scopes `/me`
   * authorises, THEN delegate to `addStore`. Any refusal throws an
   * {@link AddRemoteStoreError} and config.yaml is not touched.
   *
   * Idempotency and rotation come from `addStore`'s url+scope identity: an
   * identical re-run returns `already_registered` and writes nothing; the same
   * url+scope with a different token that `/me` accepts returns
   * `token_rotated` (the old token is replaced in place). A different token
   * that `/me` rejects never reaches `addStore`, so the old entry survives.
   *
   * The token never appears in the thrown message: the `/me` error text
   * includes the server's response body, which is not ours to trust, so every
   * occurrence of the token is scrubbed before it is rethrown.
   */
  async addRemoteStore(opts: {
    url: string; token: string; scope: string
    shared?: boolean; readonly?: boolean; timeoutMs?: number
    /** Replace an entry that already holds `scope` for a DIFFERENT store.
     *  Never implied: without it such a conflict is refused (code
     *  `scope_conflict`). Applied only after /me has verified the token. */
    overwriteScope?: boolean
  }): Promise<{ status: 'added' | 'already_registered' | 'token_rotated' | 'overwritten'; scope: string; username?: string; authorised: string[] }> {
    const { username, authorised } = await this.verifyRemoteStore(opts)
    const { url, token, scope } = opts
    const { status } = this.addStore('', scope, {
      url, token, shared: opts.shared, readonly: opts.readonly,
      ...(opts.overwriteScope === true ? { overwriteScope: true } : {}),
    })
    return { status, scope, ...(username ? { username } : {}), authorised }
  }

  /**
   * Every check {@link addRemoteStore} makes, and no write (#1413): the URL,
   * the token against `/me`, `scope` among the authorised scopes, and no
   * other store already holding `scope` (unless `overwriteScope`). Throws the
   * same {@link AddRemoteStoreError}s. `plur remote --scopes a,b` runs it for
   * every scope first, so one refused scope leaves config.yaml untouched.
   */
  async verifyRemoteStore(opts: {
    url: string; token: string; scope: string; timeoutMs?: number; overwriteScope?: boolean
  }): Promise<{ scope: string; username?: string; authorised: string[] }> {
    const { url, token, scope } = opts
    const timeoutMs = opts.timeoutMs ?? 5000
    // Every encoding of the token, not only the exact string (audit of #1272).
    const scrub = (msg: string) => redactToken(msg, token)
    let parsed: URL | undefined
    try { parsed = new URL(url) } catch { /* handled below */ }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new AddRemoteStoreError('invalid_url', `invalid URL "${scrub(String(url))}" — must be a valid http(s) URL`)
    }
    if (!token) throw new AddRemoteStoreError('missing_token', 'a token is required to register a remote store')
    if (!scope) throw new AddRemoteStoreError('missing_scope', 'a scope is required to register a remote store')

    // A throwaway driver, not _getRemoteDriver: an unverified token must not
    // be cached as this url's driver.
    const driver = new RemoteStore(url, token, scope)
    let me: Awaited<ReturnType<RemoteStore['me']>>
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      me = await Promise.race([
        driver.me().finally(() => { if (timeoutHandle) clearTimeout(timeoutHandle) }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`/me timeout (${timeoutMs}ms)`)), timeoutMs)
        }),
      ])
    } catch (err) {
      const msg = scrub(err instanceof Error ? err.message : String(err))
      if (/\b40[13]\b/.test(msg)) {
        throw new AddRemoteStoreError('auth_rejected', `the server at ${url} rejected the token (${msg})`)
      }
      throw new AddRemoteStoreError('unreachable', `could not verify the token against ${url}: ${msg}`)
    }
    // The /me answer is the server's, not ours: re-apply the strict scope
    // grammar and drop any scope that carries the token in any encoding, so a
    // buggy or hostile server cannot get the token printed through the
    // `authorised` list or the username (audit of #1272).
    const authorised = me.scopes.filter(s =>
      typeof s === 'string' && s.length <= 256 && /^[\w:./-]+$/.test(s) && !containsToken(s, token))
    const withheld = me.scopes.length - authorised.length
    const username = me.username && !containsToken(me.username, token) ? me.username : undefined
    if (!authorised.includes(scope)) {
      throw new AddRemoteStoreError(
        'scope_not_authorised',
        `the token is not authorised for scope "${scope}" on ${url}. ` +
        `Authorised: ${authorised.length ? authorised.join(', ') : '(none)'}` +
        (withheld ? ` (${withheld} withheld: malformed or carrying the token)` : ''),
        authorised,
      )
    }
    // Scope held by a different store: refuse here, as a typed error, unless
    // the caller asked to replace it. Mirrors addStore's identity rule (a
    // normalized url+scope match is the SAME entry, not a conflict).
    if (opts.overwriteScope !== true) {
      this.reloadConfigIfChanged()
      const stores = loadConfig(this.paths.config).stores ?? []
      const same = stores.some(s => s.url !== undefined && s.scope === scope &&
        normalizeEndpointUrl(s.url) === normalizeEndpointUrl(url))
      const other = same ? undefined : stores.find(s => s.scope === scope)
      if (other) {
        throw new AddRemoteStoreError(
          'scope_conflict',
          `scope "${scope}" is already registered to a different store (${scrub(String(other.url ?? other.path))}). ` +
          `Nothing was changed; pass overwriteScope to replace that entry.`,
          authorised,
        )
      }
    }
    return { scope, ...(username ? { username } : {}), authorised }
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

  /**
   * True when `dir` (or an ancestor of it) has been explicitly trusted via
   * `trustDirectory` / `plur trust` (D2, 2026-09 audit).
   *
   * This is the gate an ADAPTER (opencode, claw, ...) should check before
   * adopting behaviour-changing configuration it finds on disk — a
   * `.plur.yaml` `scope`/`domain`, for instance — from a directory it did not
   * create and the user may not have vetted. It is deliberately NOT about
   * whether the scope is local or remote: a remote/team store is the
   * legitimate reason a project declares a scope at all, so the gate is on
   * the DIRECTORY, the same way `direnv allow` / `git config safe.directory`
   * / VS Code workspace trust gate on the directory rather than on what the
   * config inside it says.
   */
  isDirectoryTrusted(dir: string): boolean {
    return _isDirectoryTrusted(dir, this.paths.root)
  }

  /**
   * Grant trust to `dir` (`plur trust`). Returns the canonicalized path
   * recorded. A `nonce` must be one issued for `dir` and `{ trusted: true }` (#1378).
   */
  trustDirectory(dir: string, options?: { nonce?: string; session?: string }): string {
    return _trustDirectory(dir, this.paths.root, options)
  }

  /**
   * Revoke trust from `dir` (`plur untrust`). Returns whether an entry was
   * removed. Needs no nonce: a revocation only removes trust (#1477 review).
   */
  untrustDirectory(dir: string): boolean {
    return _untrustDirectory(dir, this.paths.root)
  }

  /** List every directory this user has explicitly trusted. */
  listTrustedDirectories(): string[] {
    return _listTrustedDirectories(this.paths.root)
  }

  /**
   * Find the trusted entry — `dir` itself or a covering ancestor — that
   * makes `isDirectoryTrusted(dir)` true. `null` when nothing covers it.
   * See trust.ts's `coveringTrustedAncestor` (E3, 2026-09 audit): this is
   * what `plur untrust` uses to avoid claiming a directory is untrusted
   * when an ancestor's grant still covers it.
   */
  coveringTrustedAncestor(dir: string): string | null {
    return _coveringTrustedAncestor(dir, this.paths.root)
  }

  /**
   * What PLUR does in `dir` according to the folder map, `.plur.yaml` and
   * project MCP configs (#1347, design r2). Keyed on this instance's root.
   */
  resolveFolderPolicy(dir: string, options?: { home?: string }): FolderPolicy {
    return _resolveFolderPolicy(dir, { root: this.paths.root, ...(options?.home ? { home: options.home } : {}) })
  }

  /** The folder map entries, in file order (#1347). */
  listFolders(): FolderEntry[] {
    return _loadFolderMap(this.paths.root).folders
  }

  /**
   * Record a decision for `folder` (`plur folders set`). A shared scope must
   * name a store configured in config.yaml; a `nonce` (from the ask flow)
   * must be the one issued for this folder. Throws FolderMapError on refusal.
   */
  setFolder(
    folder: string, change: FolderChange,
    options?: { nonce?: string; session?: string; home?: string; literal?: boolean; refuseCoveringHome?: boolean },
  ): FolderEntry {
    this.reloadConfigIfChanged()
    const configuredScopes = (this.config.stores ?? []).map(s => s.scope)
    return _setFolderEntry(this.paths.root, folder, change, { configuredScopes, ...options })
  }

  /** Remove the exact entry for `folder` (`plur folders rm`); `nonce` as for setFolder. */
  removeFolder(folder: string, options?: { nonce?: string; session?: string }): boolean {
    return _removeFolderEntry(this.paths.root, folder, undefined, options)
  }

  /**
   * Issue a single-use nonce for the ask flow of `sessionId` that authorises
   * exactly `answer` on exactly `folder` (#1378). The ask flow issues one per
   * answer it offers; see folders.ts issueFolderNonce.
   */
  issueFolderNonce(sessionId: string, folder: string, answer: FolderAnswer, options?: { home?: string; literal?: boolean; bindSession?: boolean }): string {
    return _issueFolderNonce(this.paths.root, sessionId, folder, answer, undefined, options)
  }

  /** Expire every folder nonce of `sessionId` (call at session end). */
  endFolderNonceSession(sessionId: string): void {
    _endFolderNonceSession(this.paths.root, sessionId)
  }

  autoDiscoverStores(cwd?: string): Array<{ path: string; scope: string }> {
    const startDir = cwd || process.cwd()
    const discovered: Array<{ path: string; scope: string }> = []

    // Skip discovery if Plur storage is in a temp directory (test scenario)
    const tmpDir = tmpdir()
    if (this.paths.root.startsWith(tmpDir) || this.paths.root.startsWith('/tmp/')) {
      return discovered
    }

    // Canonical paths (#1319): the walk sees kernel-canonical cwd spellings
    // while PLUR_PATH / $HOME are taken verbatim, so a raw string compare
    // missed the primary under a symlinked home and registered it as
    // `project:<home>`. Compare canonical forms; the primary is excluded here
    // and again in addStore.
    const knownPaths = new Set(
      (this.config.stores ?? []).filter(s => s.path !== undefined && !s.url).map(s => canonicalize(s.path!)),
    )
    const primaryStore = canonicalize(this.paths.engrams)

    let dir = startDir
    const visited = new Set<string>()

    while (dir && !visited.has(dir)) {
      visited.add(dir)
      const candidate = join(dir, '.plur', 'engrams.yaml')

      const candidateKey = canonicalize(candidate)

      // Skip primary store
      if (candidateKey === primaryStore) {
        dir = dirname(dir)
        continue
      }

      if (fs.existsSync(candidate) && !knownPaths.has(candidateKey)) {
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
        knownPaths.add(candidateKey)
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
        this._noteMeIdentity(url, token, me)
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
        this._noteMeIdentity(url, token, null)
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
        this._noteMeIdentity(url, token, me)
        return { url, scopes, status: 'ok' as const, ok: true,
          ...(me.username ? { username: me.username } : {}),
          ...(me.org_id ? { orgId: me.org_id } : {}),
          grantedScopes: me.scopes.length,
          ...expiryFields }
      } catch (err) {
        this._noteMeIdentity(url, token, null)
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
    this.config = this._loadConfig()
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
    // Raw config, not this.config: the in-memory list drops ignored duplicate
    // local entries (#1319), and writing it back would delete them from disk.
    const stores = loadConfig(this.paths.config).stores ?? []
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
    this._appendHistory({
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
