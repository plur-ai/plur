import { AsyncLocalStorage } from 'node:async_hooks'
import { getEmbedder, resolveEmbedderName } from './embedders/index.js'
import { setEmbeddingsEnabled } from './embeddings.js'
import { logger } from './logger.js'
import { configStoresMethods, type ConfigStoresMethods } from './plur/config-stores.js'
import { discoveryMethods, type DiscoveryMethods } from './plur/discovery.js'
import { feedbackPinMethods, type FeedbackPinMethods } from './plur/feedback-pin.js'
import { foldersPolicyMethods, type FoldersPolicyMethods } from './plur/folders-policy.js'
import { forgetRescopeMethods, type ForgetRescopeMethods } from './plur/forget-rescope.js'
import { isPlainObject, REMOTE_PROBE_TIMEOUT_MS } from './plur/helpers.js'
import { injectionMethods, type InjectionMethods } from './plur/injection.js'
import { learnDedupMethods, type LearnDedupMethods } from './plur/learn-dedup.js'
import { learnMethods, type LearnMethods } from './plur/learn.js'
import { maintenanceMethods, type MaintenanceMethods } from './plur/maintenance.js'
import { outboxMethods, type OutboxMethods } from './plur/outbox.js'
import { provenanceIdentityMethods, type ProvenanceIdentityMethods } from './plur/provenance-identity.js'
import { recallMethods, type RecallMethods } from './plur/recall.js'
import { remoteResultsMethods, type RemoteResultsMethods } from './plur/remote-results.js'
import { routingMethods, type RoutingMethods } from './plur/routing.js'
import { scopeGuardsMethods, type ScopeGuardsMethods } from './plur/scope-guards.js'
import { statusReportMethods, type StatusReportMethods } from './plur/status-report.js'
import { storeIoMethods, type StoreIoMethods } from './plur/store-io.js'
import { tensionsMethods, type TensionsMethods } from './plur/tensions.js'
import { type IndexSyncError } from './plur/types.js'
import { type RerankerAdapter } from './rerankers/index.js'
import { ServerStoreEntrySchema } from './schemas/config.js'
import { IndexedStorage } from './storage-indexed.js'
import { PGLiteAdapter } from './storage-pglite.js'
import { detectPlurStorage, type PlurPaths } from './storage.js'
import type { DegradedReason } from './types.js'
export { engramContentFields, LEARN_CONTENT_FIELDS, LEARN_CONTEXT_FIELD_ROLES, learnContextContent } from './content-fields.js'
export { ENTERPRISE_SETUP_COMMAND, enterpriseRecoveryHint } from './enterprise.js'
export { gitDefaultScope, loadGitScopeSources, type GitScopeOutcome, type GitScopeSource } from './git-origin.js'
export { AddRemoteStoreError, DEFAULT_REMOTE_WRITE_TIMEOUT_MS } from './plur/helpers.js'
export type { CheckResult, IndexSyncError, IngestCandidate, IngestOptions, LearnDelivery, LearnRoutedOptions, MutationOutcome, OutboxReasonCode, RegisterDiscoveredResult, RemoteHealth, RemoteScopeDiscovery, RescopeOptions, RescopeResult, ServerDiscoveryOutcome, ServerStoreCheck, StatusResult, StoreSummary } from './plur/types.js'
export { formatSaveDestination, formatServerSessionLine, type SaveDestinationInput, type ServerSessionState } from './save-destination.js'
import { type BackendSelection } from './backend-selection.js'
import { type GitScopeOutcome, type OriginRead } from './git-origin.js'
import { isRemoteOnlyQueued } from './remote-only-rows.js'
import {
    type RemoteOnlyBinding,
    type RemoteOnlyRefusal
} from './remote-only.js'
import {
    type HostRecallOutcome
} from './remote-recall.js'
import type { PlurConfig, StoreEntry } from './schemas/config.js'
import type { Engram } from './schemas/engram.js'
import { isLocalOnlyScope } from './scope-target.js'
import { isSharedScope } from './scope-util.js'
import { SessionScopeRegistry } from './session-scopes.js'
import { resolveScopeTarget } from './store-resolver.js'
import { withAsyncLock, type AsyncLockOptions } from './store/async-lock.js'
import type { AsyncPrimaryStore } from './store/primary-store.js'
import { ReadonlyStoreError, ReadonlyStoreGuard } from './store/readonly-store-guard.js'
import { QueueHoldStore, RemoteOnlyStoreGuard } from './store/remote-only-store-guard.js'
import { normalizeEndpointUrl, RemoteStore } from './store/remote-store.js'
import { YamlPrimaryStore } from './store/yaml-primary-store.js'
import type {
    LearnContext
} from './types.js'

export { AsyncMutex, KeyedAsyncMutex } from './async-mutex.js'
export { computeConfidence, computeMetaConfidence, confidenceBand } from './confidence.js'
export * from './meta/index.js'
export { classifyPolarity } from './polarity.js'
export { canonicalize, findProjectConfigPath, readProjectConfig, readProjectConfigFromPath, type ProjectConfig } from './project-config.js'
export { NO_SESSION, SessionScopeRegistry } from './session-scopes.js'
export { SessionBreadcrumbs } from './session-state.js'
export { pendingStoreLockOps } from './store/async-lock.js'
// The trust gate a project's REMOTE settings must pass before an adapter may
// route prompt text to the host they name. Lives in core, not the CLI, so
// out-of-package adapters (@plur-ai/opencode) take the capability and the gate
// together rather than copying one without the other. See project-remote.ts.
export {
    projectRemoteRefusalNotice, resolveProjectRemote,
    resolveProjectRemoteFromConfig, type ProjectRemote,
    type TrustChecker
} from './project-remote.js'
// Directory trust — a one-time per-directory grant
// (`plur trust`) an adapter should require before adopting behaviour-changing
// configuration it finds on disk (a `.plur.yaml` scope, say) from a directory
// the user opened but never explicitly vetted. See trust.ts for the model.
export { coveringTrustedAncestor, isDirectoryTrusted, listTrustedDirectories, trustDirectory, untrustDirectory } from './trust.js'
// Folder map — the user's on/off/ask, default scope and trust
// decisions per folder, in <PLUR home>/folders.yaml. See folders.ts.
export {
    answerFolderNotNow, clearFolderTrust, consumeFolderNonce, coversHomeOrRoot, endFolderNonceSession, findPlurMarker, FOLDER_HOST_START_TOLERANCE_MS, FOLDER_NONCE_TTL_MS, FolderMapError, folderMapPath, folderMapProblem, folderNonceOutstanding, folderOffEntries, folderPatternMatches,
    folderPatternSpecificity, hasOwnFolderDecision, hostFolderNonces, issueFolderNonce, loadFolderMap, removeFolderEntry, removeLegacyTrustEntry, repairFolderMap, resolveFolderPolicy, safeSessionKey, sameFolderPath, saveFolderMap, setFolderEntry, sweepFolderNonces, verifyFolderNonce, workspaceFolderScope,
    workspaceScopeDecision, type FolderAnswer, type FolderAskHost, type FolderChange, type FolderEntry,
    type FolderMap, type FolderMapErrorCode,
    type FolderMapFault,
    type FolderMapProblem,
    type FolderMapRepairResult, type FolderMode, type FolderPolicy,
    type FolderPolicySource, type WorkspaceScopeDecision
} from './folders.js'
// remote-only folders: what a bound instance
// refuses and how it says so. See remote-only.ts and Plur.bindFolder.
export { FOLDER_MAP_TEMPLATE, renderFolderMapText } from './folder-map-text.js'
export { isRemoteOnlyQueued, withoutRemoteOnlyQueued } from './remote-only-rows.js'
export {
    remoteOnlyRefusalMessage, remoteOnlySessionLine, remoteOnlyUnservedNotice, RemoteOnlyWriteError, type RemoteOnlyBinding, type RemoteOnlyRefusal, type RemoteOnlyStatus
} from './remote-only.js'
// Pinpointing and repairing a broken folders.yaml: pure text checks.
export {
    checkFolderMapText, describeFolderMapIssues, planFolderMapRepair, unifiedDiff, type FolderMapCheck, type FolderMapIssue, type FolderMapRepairPlan
} from './folder-map-check.js'
// The one-time folder question and an `on` folder's session settings,
// shared by the CLI's editor hooks and the opencode plugin. See folder-ask.ts.
export {
    claimSkippedStoreHint, clearFolderAsk, folderAsk, folderAskOnce, escapedPath as folderEscapedPath, folderMarkerDir, quoted as folderQuoted, folderRepairCommand,
    folderSetOnCommand, hostFolderAsk, isFolderAskText, sessionSettings, skippedStoreHintClaimed, skippedStoreHintLine,
    skippedStoreNotice, type FolderAsk,
    type FolderAskAnswer, type FolderAskOptions,
    type FolderAskScopeRanker
} from './folder-ask.js'
export { generateGuardrails } from './guardrails.js'
// Shared memory system-prompt renderer: one
// implementation so @plur-ai/claw and @plur-ai/opencode render the PLUR
// memory block byte-identically instead of each vendoring a copy.
export { SHIPPED_CLAW_SECTIONS, SHIPPED_CURSOR_RULES, SHIPPED_PLUR_SECTIONS } from './instruction-history.js'
export { backupFile, hasStandaloneMarker, InstructionWriteRefused, isShippedText, upsertInstructionSection, writeWithBackup, type InstructionSectionOptions, type InstructionSectionResult } from './instruction-section.js'
export { PLUR_MEMORY_INSTRUCTIONS, renderMemoryBlock } from './memory-block.js'
// Shared learning-extraction heuristics: one
// implementation so @plur-ai/claw and @plur-ai/opencode derive learning
// candidates identically instead of each vendoring a copy.
export { EngramStoreShrinkError, EngramStoreUnreadableError } from './engrams.js'
export { computeIdf, engramSearchText, termMatches, type CorpusStats } from './fts.js'
export { extractLearnings, extractSelfReportedLearnings, isCorrection, type LearnableMessage, type LearnCandidate } from './learner.js'
export { detectCorrectionPrompt, type DetectionResult } from './correction.js'
export { DomainCoverageSchema, EvidenceEntrySchema, FalsificationSchema, HierarchyPositionSchema, MetaConfidenceSchema, MetaFieldSchema, StructuralTemplateSchema } from './schemas/meta-engram.js'
export type { DomainCoverage, EvidenceEntry, Falsification, HierarchyPosition, MetaConfidence, MetaField, StructuralTemplate } from './schemas/meta-engram.js'
// Exported for store-repair tooling, which must read the RAW store rows.
// `Plur.list()` goes through `_filterEngrams`, which merges packs in and drops
// inactive/expired engrams — fine for recall, wrong for a repair pass, which
// would then miss stale rows and try to "fix" pack entries it does not own.
export { loadEngrams, saveEngrams } from './engrams.js'
export {
    BACKUP_DIR, listBackups, maybeDailyBackup, planRestore,
    restoreBackup,
    validateStore
} from './backup.js'
export type { BackupEntry, BackupOutcome, RestorePlan, RestoreResult, StoreValidity } from './backup.js'
export { computeContentHash, isHashable, normalizeStatement } from './content-hash.js'
export { buildBatchDedupPrompt, buildDedupPrompt, parseDedupResponse } from './dedup.js'
export { bareEngramId, legacyStorePrefix, namespaceEngramId, parseNamespacedId, storePrefix } from './engrams.js'
export { freshTailBoost } from './fresh-tail.js'
export { appendHistory, appendHistoryStamped, attestStore, canonicalEventBytes, clearChainHeadMemCache, computeEventHash, computeQueryHash, countEngramsInStore, countInjectionEvents, emitCheckpoint, findLatestInjectionFor, generateEventId, generateInjectionId, hashEngramsFile, listHistoryMonths, readChainHead, readCoInjections, readHistory, readHistoryForEngram, sortKeysDeep, tailSeekLastHash, type CheckpointData, type CheckpointSigningOptions, type CoInjectionData, type CoInjectionEvent, type CoInjectionReadResult, type HistoryEvent, type InjectionEventCounts, type InjectionSource } from './history.js'
export { assignLayer, formatLayer1, formatLayer2, formatLayer3, formatWithLayer, type InjectionLayer } from './inject.js'
export { scanForInversions, type InversionSuspect } from './inversion-scan.js'
export { ALL_MIGRATIONS, CURRENT_SCHEMA_VERSION, getSchemaVersion, rollbackMigrations, runMigrations, setSchemaVersion, type Migration, type MigrationResult } from './migrations/index.js'
export { resolveOperationTier, selectModel, selectModelForOperation, type LlmTierConfig, type ModelTier } from './model-routing.js'
export {
    classifyOutboxFailure, credentialChanged, describeHeld, describeNeedsAction, NEEDS_ACTION_RETRY_MS, NEEDS_ACTION_STATUSES, OUTBOX_CLAIM_ERROR_PREFIX, statusFromErrorText, summarizeOutbox, type OutboxFailureInput, type OutboxState, type OutboxSummary, type OutboxVerdict
} from './outbox-health.js'
export { orderBySupersedes } from './outbox-order.js'
export { generateProfile, getProfileForInjection, loadProfileCache, markProfileDirty, profileNeedsRegeneration, saveProfileCache, type ProfileCache } from './profile.js'
export { computeReceipt } from './receipt.js'
export type { Receipt, ReceiptInput, ReceiptTopEntry } from './receipt.js'
export { ScopeMetadataSchema, ScopeSensitivitySchema, SENSITIVITY_CATEGORIES, type ScopeMetadata, type ScopeSensitivity, type SensitivityCategory } from './schemas/scope-metadata.js'
export { decideAutoRoute, rankScopes, SCOPE_MATCH_THRESHOLD, SUGGEST_DISPLAY_MIN_CONFIDENCE, WEIGHT_TAG, type AutoRouteDecision, type DecideAutoRouteOptions, type RankScopesOptions, type ScopeCandidate, type ScopeSignals, type ScopeSource } from './scope-routing.js'
export { assertScopeNamesATarget, isLocalOnlyScope, personalStoreEntry } from './scope-target.js'
export { recallAuto, type AutoSearchResult, type SearchStrategy } from './search-orchestrator.js'
export { detectPromptInjection, detectSecrets, detectSensitive, sensitivityCategory } from './secrets.js'
export { buildSessionManifest, canonicalManifestBytes, computeRecordHash, RECORD_HASH_FIELDS, SESSION_MANIFEST_SCHEMA, verifySessionManifest, type ManifestCheck, type ManifestEntry, type ManifestRole, type ManifestVerification, type SessionManifest, type WormPutResult, type WormStore } from './session-manifest.js'
export { resolveScopeTarget, ScopeConflictError, type ScopeTarget } from './store-resolver.js'
export { RemoteHttpError, TOKEN_ENV_UNSET_RE, tokenEnvUnsetDetail, TokenEnvUnsetError, tokenEnvUnsetFix, tokenEnvUnsetMessage } from './store/remote-store.js'
export { autoSummary, generateSummary, needsSummary } from './summary.js'

// Scope-family predicates live in the leaf module `scope-util.ts` to break a
// module cycle: `inject.ts` (imported by index.ts) needs `isPersonalScope`, and
// importing it from here would form index → inject → index. They are imported
// above for internal use and re-exported here so the public `@plur-ai/core` API
// (`isSharedScope`, `isPersonalScope`, `SHARED_SCOPE_PREFIXES`) is unchanged.
export { isPersonalScope, isSharedScope, makeVisibilityPredicate, scopeAllowFilter, SHARED_SCOPE_PREFIXES } from './scope-util.js'
export { detectPlurStorage, type PlurPaths } from './storage.js'
export { pruneBackups, registerClaudeUserMcp, type RegisterClaudeUserMcpOptions, type RegisterClaudeUserMcpResult } from './claude-user-config.js'
export { loadConfig, storeEntryForDisk, tokenFromEnv } from './config.js'
export {
    asDerivedIndex, DERIVED_INDEX_DEFAULTS, EF_SEARCH_FILTER_HEADROOM,
    efSearchFor, EXACT_VECTOR_INDEX,
    PGVECTOR_DEFAULT_EF_SEARCH, requiresIndexSync, type VectorElementFormat, type VectorIndexKind,
    type VectorIndexStrategy
} from './storage-adapter.js'
export type {
    DerivedIndexAdapter, ScopeRestriction,
    StorageAdapter, StorageAdapterRole, StorageFilter,
    VectorSearchHit
} from './storage-adapter.js'
export { IndexedStorage } from './storage-indexed.js'
export { PGLiteAdapter, type PGLiteAdapterOptions, type VectorPrecision } from './storage-pglite.js'
export { classifyStoreDuplicates, removePrimaryStoreEntries, type IgnoredStoreEntry, type StoreDuplicateReport } from './store-duplicates.js'
// Server-Postgres backend (ADR-0005): store AND index in one engine.
export {
    BACKEND_TIERS, PGLITE_MIN_ENGRAMS,
    POSTGRES_MIN_ENGRAMS, resolveBackendTier, SQLITE_MIN_ENGRAMS, type BackendSelection,
    type BackendSelectionInput,
    type BackendSelectionReason, type BackendTier
} from './backend-selection.js'
export { exportPgliteEmbeddingsToCache, type PgliteEmbeddingsExportReport } from './pglite-embeddings-export.js'
export {
    DEFAULT_POSTGRES_SCHEMA, HNSW_DEFAULT_EF_CONSTRUCTION, HNSW_DEFAULT_M, HNSW_MIN_ROWS, HNSW_RECALL_TARGET, PostgresAdapter, redactDsn, type PostgresAdapterOptions,
    type PostgresVectorIndexMode
} from './storage-postgres.js'
export { asyncAtomicWrite, MemoryPrimaryStore, ReadonlyStoreError, ReadonlyStoreGuard, withAsyncLock, YamlPrimaryStore, type AsyncPrimaryStore, type PrimaryStore, type PrimaryStoreKind } from './store/index.js'
// Embedding primitive — public so alternative store backends can compute
// vectors identically to core's hybrid search (same model + EMBED_DIM). The
// model identity and EMBED_DIM are a stable contract; changing them is breaking
// for any consumer that persists vectors. See embeddings.ts.
export { DEFAULT_EMBEDDER, EMBEDDER_NAMES, resolveEmbedderName, type EmbedderAdapter, type EmbedderName } from './embedders/index.js'
export { _appendEmbeddingCacheEntries, activeEmbedderDim, allowBackgroundModelLoad, cosineSimilarity, embed, EMBED_DIM, embedderStatus, semanticModelState, type EmbedderStatus } from './embeddings.js'
// Reranker surface — factory + runtime status so MCP/CLI can
// probe reranker health (plur_doctor) and surface non-engagement on recall.
// _setCachedReranker/_resetRerankerCache are test seams for exercising
// failure paths without downloading the real ~300 MB model.
export { checkRerankerFit, type FitCheckEngram, type FitCheckResult } from './rerankers/fit-check.js'
export {
    _resetRerankerCache, _setCachedReranker, classifyRerankerFailure, DEFAULT_RERANKER, getReranker, hfCacheDirName, isRerankerOff, RERANKER_NAMES, rerankerStatus, resetRerankerStatus, resolveRerankerName, type RerankerFailureKind, type RerankerName, type RerankerRuntimeStatus
} from './rerankers/index.js'
export type { RerankerAdapter } from './rerankers/types.js'
// Per-store reranker eval gate — the self-check that must pass before
// anyone flips reranking on by default for a store. Advisory only.
export type { SimilarityResult } from './embeddings.js'
export {
    isRerankerEvalStale, loadRerankerEvalCache, RERANKER_EVAL_BENEFIT_THRESHOLD, RERANKER_EVAL_COUNT_DRIFT, RERANKER_EVAL_HARM_THRESHOLD, RERANKER_EVAL_MIN_PROBES, RERANKER_EVAL_STALENESS_MS, rerankerEvalAdvisory, rerankerEvalCachePath, runRerankerSelfEval, saveRerankerEvalResult, synthesizeProbeQuery, type RerankerEvalOptions, type RerankerEvalResult, type RerankerEvalVerdict
} from './reranker-eval.js'
export type { SyncRemoteType, SyncResult, SyncStatus } from './sync.js'
/**
 * File-write primitives, exported so packages OUTSIDE core write files the same
 * way core does (lock + atomic replace) instead of re-implementing them and
 * drifting in the unsafe direction.
 */
export { initActorKey, keyFingerprint, keysDirFor, keysRegistryPath, loadKeysRegistry, loadPrivateKeyBuffer, lookupPublicKey, privateKeyPath, registerPublicKey, safeFileName, signWithActorKey, verifySignature, type KeysRegistry, type PublicKeyEntry } from './actor-keys.js'
export { withLock } from './file-lock.js'
export { atomicWrite } from './atomic-write.js'
export { withDeadline, DEADLINE_MISSED } from './deadline.js'
export { hashStoreFile, verifyChain, type BreakReason, type ChainBreak, type ChainFork, type ChainVerifyOutcome, type ChainVerifyResult, type SignatureResult, type SignatureVerdict, type VerifyChainOptions } from './verify-chain.js'
/**
 * Owner-only protection: `writeConfigFile` is how config.yaml is
 * written; `protectOwnerOnly` / `checkOwnerOnly` are the one rule for files
 * that hold a secret (the installer's backups and key file reuse them).
 */
export { writeConfigFile } from './config-file.js'
export { offlineByEnv, offlineInferred, offlineNow, updateCheckDisabledByEnv } from './offline.js'
export { checkOwnerOnly, currentWindowsAccount, currentWindowsSid, defaultOwnerOnlyExec, protectOwnerOnly, windowsSystemRoot, windowsSystemTool, type OwnerOnlyCheck, type OwnerOnlyExec, type OwnerOnlyOptions, type OwnerOnlyResult } from './owner-only.js'
export { _resetRemoteCapabilityCache, _resetRemoteHostBreaker, clearRemoteHostDown, FEEDBACK_SOURCE_CAPABILITY, markRemoteHostDown, remoteHostDownRemainingMs, salvageRemoteRow } from './store/remote-store.js'
export { buildBatchContradictionPrompt, buildContradictionPrompt, daysApart, domainSegmentsOverlap, engramDate, engramOrigin, getCandidatePairs, getCandidatePairsDetailed, inTemporalDomain, MEASURED_UNDER_CONFIDENCE_CAP, MEASURED_UNDER_DIMENSIONS, measuredUnderDiffers, measuredUnderGateApplies, parseBatchContradictionResponse, parseContradictionResponse, scanForTensions, scopesOverlap, SNAPSHOT_CONFIDENCE_CAP, statementOverlap, subjectsOverlap, temporalDiscountFactor, type CandidatePairOptions, type CandidatePairs, type ContradictionVerdict, type JudgeStatement, type TemporalGateOptions, type TensionPair, type TensionScanOptions, type TensionScanResult } from './tensions.js'
export { checkForUpdate, clearVersionCache, getCachedUpdateCheck, minorVersionsBehind, settleVersionChecks, updateCheckOffline, VERSION_CHECK_FAILURE_TTL_MS, VERSION_CHECK_SUCCESS_TTL_MS, type VersionCheckResult } from './version-check.js'
// Tension lifecycle persistence
export { TensionCategorySchema, TensionRecordSchema, TensionStatusSchema, type TensionCategory, type TensionRecord, type TensionStatus } from './schemas/tension.js'
export { categorizeTension, generateTensionId, loadTensions, saveTensions, tensionPairKey } from './tension-store.js'
// Migration importers — `plur import --from <source> --path <file>`.
export { CapabilityCanary, type CanaryStatus, type Capability } from './capability-canary.js'
export { readCapsule, verifyCapsuleIntegrity, writeCapsule } from './capsule.js'
export type { ReadCapsuleResult, WriteCapsuleOptions } from './capsule.js'
export {
    getImportSource, IMPORT_SOURCES, importFrom, listImportSources, normalizeConfidence, normalizeImportType, normalizeTags, normalizeTimestamp, parseCsv, parseGenericContent, parseGpEngramDb, parseMem0Content, runImport, type FieldMapping, type ImportEngramType, type ImportFromOptions, type ImportInput, type ImportRecord, type ImportRecordResult, type ImportSource, type MappableField, type MigrationReport,
    type RunImportOptions
} from './importers/index.js'
export { isTransientPackDir, shortPackIntegrity } from './packs.js'
export type { InstallResult, NeutralizedCounts, PackIntegrityMigrationReport, PackProvenanceView, PreviewResult, PrivacyIssue, PrivacyScanResult, RegistryEntry } from './packs.js'
export {
    CAPSULE_FLAG_RESERVED_MASK, CAPSULE_FLAGS, CAPSULE_MAGIC,
    CAPSULE_MAGIC_HEX, CAPSULE_SIZE_LIMITS, CapsuleHeaderSchema, ED25519_SIG_LEN, FORMAT_VERSION_V1, hasFlag, ManifestSummarySchema, parseCapsulePreamble, PayloadDescriptorSchema, PREAMBLE_LEN, ProducerSchema, serializeCapsulePreamble, SignerSchema, SUPPORTED_FORMAT_VERSIONS
} from './schemas/capsule.js'
export type { CapsuleHeader, CapsulePreamble, ManifestSummary, PayloadDescriptor, Producer, Signer } from './schemas/capsule.js'
export { ServerStoreEntrySchema } from './schemas/config.js'
export type { PlurConfig, ScopeRoutingConfig, StoreEntry } from './schemas/config.js'
export { ExtractionProvenanceSchema, getExtractionProvenance, MeasuredUnderSchema, type ExtractionProvenance } from './schemas/engram.js'
export type { Engram, MeasuredUnder, PreviousVersionRef } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PackManifest } from './schemas/pack.js'

// Opt-in, content-free telemetry. Exported so wrappers (@plur-ai/mcp,
// @plur-ai/claw) reuse one implementation instead of vendoring copies.
export { getCounters, readOrCreateInstallId, recordEvent, resetCounters, type CounterEvent, type CounterSnapshot, type CountersOpts } from './telemetry-counters.js'
export { buildHeartbeatPayload, flushIfNeeded, registerFlushOnExit, sendHeartbeat, type FlushOpts, type HeartbeatPayload } from './telemetry-flush.js'
export { isTelemetryEnabled, resolveTelemetry, type TelemetryResolution, type TelemetrySource, type TelemetryState } from './telemetry.js'
// Failed-recall miss signal (opt-in, content-free).
export {
    buildMissSignalPayload, classifyMiss, DEFAULT_MISS_SCORE_THRESHOLD, emitMissSignal, fingerprintQuery, type MissReason,
    type MissSignalInput,
    type MissSignalOpts,
    type MissSignalPayload
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
// Server-authoritative remote recall — client, health persistence,
// degradation string table, and env knobs. The MCP server and CLI hook
// consume these so all three surfaces share ONE state vocabulary + strings.
export {
    applyFeedbackSignal, NEGATIVE_STRENGTH_DELTA, nextCommitment,
    POSITIVE_STRENGTH_DELTA, type ApplyFeedbackOptions, type FeedbackSignal, type FeedbackSource
} from './feedback.js'
export { BREAKER_COOLDOWN_MS, BREAKER_FAILURE_THRESHOLD, BREAKER_HALF_OPEN_AFTER_MS, BUDGET_TICK_MS, buildRecallRemoteReport, claimHookDegradationLines, DEFAULT_RECALL_DEADLINE_MS, DEFAULT_REMOTE_RECALL_TIMEOUT_MS, doctorRemoteRemediation, HOOK_HEADER_REPEAT_MS, hookRemoteHeaderLine, isRemoteRecallDisabled, MAX_REMOTE_QUERY_CHARS, MAX_REMOTE_RESPONSE_BYTES, MAX_STARVATION_CREDIT_MS, mcpRemoteWarningLine, PROBE_CLEARABLE_STATES, readRemoteHealth, RECALL_BOOKKEEPING_LOCK_WAIT_MS, REMOTE_STATUS_TTL_MS, remoteHealthPath, remoteRecall, resolveRecallDeadlineMs, resolveRemoteRecallTimeoutMs, scopeOrg, startBudgetTimer, UNSUPPORTED_TTL_MS, type BudgetExpiry, type HostRecallOutcome, type RecallRemoteHostReport, type RecallRemoteReport, type RemoteHostState, type RemoteRecallHost, type RemoteRecallOptions, type RemoteRecallResult, type RemoteStoreStatusEntry } from './remote-recall.js'
// Automatic rating of injected engrams from the reply text.
export { AUTO_FEEDBACK_MIN_CONFIDENCE, detectInjectionSignal, rateInjectedEngrams, type InjectionSignal, type InjectionSignalResult, type RatedEngram } from './injection-signal.js'
// Client-side token inspection — expiry + display-only payload
// claims, no signature verification — and the endpoint-identity normalizer,
// so CLI surfaces (login --status) compare hosts the same way the core does.
export { decodeJwtExpiry, decodeJwtPayload, type JwtExpiry } from './jwt.js'
export { containsToken, redactToken, redactTokenDeep, tokenForms } from './redact-token.js'
export { normalizeEndpointUrl } from './store/remote-store.js'

export * from './types.js'

export { acceptDiscoveredScopes, foldStoresIntoServerEntry, PersonalScopeTakenError, SignInHeldError } from './server-discovery.js'
export type { AcceptedDiscovery, DiscoveryStatus, FoldKeptReason, FoldReport, ScopeHolder, ScopeRejection } from './server-discovery.js'
export type { WriteCheckResult } from './store/remote-store.js'

import { type ProvenanceStore } from './provenance-store.js'

export {
    FileProvenanceStore,
    MemoryProvenanceStore,
    provenanceMode, type ProvenanceMode, type ProvenanceStore
} from './provenance-store.js'

export {
    assertDomainFields, buildPackProvenanceRecord, buildProvenanceRecord, LICENSE_SOURCES, renderProvenanceSummary, serializeProvenanceRecord,
    summariseProvenance, type DomainExtension, type LicenseSource, type PackProvenanceInput, type ProvenanceOptions, type ProvenanceSummary
} from './provenance.js'

export class Plur {
  /** Engrams a url store confirmed on write — the only evidence a write left the machine; per object, never persisted. */
  /** @internal */ _remoteDelivered = new WeakSet<object>()
  /** Which server holds a returned engram, kept per object, never on the row (row fields are content-scanned). */
  /** @internal */ _heldBy = new WeakMap<object, string>()
  /** @internal */ paths: PlurPaths
  /** @internal */ config: PlurConfig
  /** @internal */ indexedStorage: IndexedStorage | null = null
  /**
   * PGLite adapter, chosen via `PLUR_BACKEND=pglite` or automatically for large
   * stores (ADR-0005, `backend-selection.ts`). Mirrors every YAML mutation via
   * syncFromYaml; YAML remains the source of truth.
   */
  /** @internal */ pgliteAdapter: PGLiteAdapter | null = null
  /** @internal */ _pgliteInitPromise: Promise<void> | null = null
  /**
   * In-flight primary-store auto-embed pass, or null. One at a time: a write
   * during a pass sets `_primaryEmbedRerun`, coalescing into one follow-up sweep.
   */
  /** @internal */ _primaryEmbedPass: Promise<void> | null = null
  /** @internal */ _primaryEmbedRerun = false
  /** One-shot latch for the embeddings-disabled notice on the primary-store auto-embed path. */
  /** @internal */ _primaryEmbedDisabledNoticeDone = false
  /** Last background index failure (set by the index chains' .catch, reset per new chain); see lastIndexError()/status(). */
  /** @internal */ _lastIndexError: IndexSyncError | null = null
  /** Constructor-initiated async work — see `ready()`. */
  /** @internal */ _readyPromise: Promise<void> = Promise.resolve()

  /** The primary store as opened; all primary engram state goes through a store, never `loadEngrams`/`saveEngrams` directly. */
  /** @internal */ _basePrimaryStore: AsyncPrimaryStore
  /**
   * The primary store every engine path uses. While bound to a remote-only
   * folder it is wrapped in RemoteOnlyStoreGuard (reads and writes see only the
   * folder's queued saves) as a backstop to the method guards.
   */
  /** @internal */ get _primaryStore(): AsyncPrimaryStore {
    // Every internal access goes through the queue hold, the write choke point
    // that keeps remote-only queued saves deliverable. While bound, the
    // remote-only guard sits on top, using the locked operation's binding.
    if (!this._holdStore || this._holdStore.inner !== this._basePrimaryStore) {
      this._holdStore = new QueueHoldStore(this._basePrimaryStore, sc => this._isDeliverableTeamScope(sc))
    }
    const ro = this._activeBinding()
    return ro ? new RemoteOnlyStoreGuard(this._holdStore, ro, true, sc => this._isDeliverableTeamScope(sc)) : this._holdStore
  }
  /** @internal */ _holdStore: QueueHoldStore | null = null
  /**
   * A history event's `data` with only metadata kept (remote-only): numbers,
   * booleans and null; strings only under keys that hold ids, scopes, states
   * or kinds; arrays of such strings under those keys. Anything else is left
   * out, so a new free-text field is never recorded by default.
   */
  /** @internal */ static _metadataOnly(data: Record<string, unknown>): Record<string, unknown> {
    const SAFE = /^(id|ids|engram_id|engram_ids|.*_id|.*_ids|scope|scopes|.*_scope|.*_scopes|store|stores|signal|status|.*_status|state|kind|type|mode|event|operation|op|hash|.*_hash)$/
    // `source` is an enum-like tag on most events ('inject', 'session_start'),
    // but free text on some: kept only when it is one token.
    const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v
      else if (SAFE.test(k) && typeof v === 'string' && v.length <= 200 && !/[\r\n]/.test(v)) out[k] = v
      else if (k === 'source' && typeof v === 'string' && TOKEN.test(v)) out[k] = v
      else if (SAFE.test(k) && Array.isArray(v) && v.every(x => typeof x === 'string' && x.length <= 200 && !/[\r\n]/.test(x))) out[k] = v
    }
    return out
  }

  /** The binding a locked store operation captured at its start. */
  /** @internal */ static _lockBinding = new AsyncLocalStorage<{ plur: Plur; binding: RemoteOnlyBinding | null; git?: GitScopeOutcome }>()
  /** @internal */ _activeBinding(): RemoteOnlyBinding | null {
    const ctx = Plur._lockBinding.getStore()
    return ctx && ctx.plur === this ? ctx.binding : this._boundFolder
  }

  /**
   * remote-only: whether a walk over url stores for a BARE id may contact
   * the store serving `scope` — only the folder's own team store. An explicit
   * team scope is checked by its caller instead.
   */
  /** @internal */ _remoteOnlyWalkAllows(scope: string, requested?: string): boolean {
    const ro = this._remoteOnly
    if (!ro || ro.blocked) return false
    // The scope the caller named, when it is a deliverable team scope (its
    // rows are checked by _remoteOnlyRefuseLocalRow); else the folder's own.
    const allowed = requested && this._isDeliverableTeamScope(requested) ? requested : ro.scope
    if (!allowed || !this._isDeliverableTeamScope(scope)) return false
    if (scope === allowed) return true
    const target = resolveScopeTarget(allowed, this.config.stores ?? [])
    return target.kind === 'remote' && target.entry?.scope === scope
  }

  /**
   * remote-only: true only when the host positively holds the row the id names
   * and that row is in a deliverable team scope. Unknown —
   * a failed probe, or a row the host says it holds but does not hand over —
   * is false, as is a personal row.
   */
  /** @internal */ async _remoteRowOwnedByTeam(driver: RemoteStore, serverId: string): Promise<boolean> {
    try {
      const ownership = driver.probeById
        ? await driver.probeById(serverId, { signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS) })
        : 'assumed'
      if (ownership === 'unknown' || ownership === 'absent') return false
      const row = await driver.getById(serverId)
      return !!row && this._isDeliverableTeamScope(row.scope)
    } catch {
      return false
    }
  }

  /**
   * The ONE rule for "a deliverable team scope": a
   * shared, non-personal, non-local-family scope with a writable url store in
   * the config. Used by the store guard, the queue hold, learn routing in a
   * remote-only folder, the flush, and the remote walks while bound.
   */
  /** @internal */ _isDeliverableTeamScope(scope: string): boolean {
    if (!scope || !isSharedScope(scope)) return false
    const stores = this.config.stores ?? []
    if (isLocalOnlyScope(scope, stores)) return false
    if (scope.toLowerCase().startsWith('user:')) return false
    // Where a write goes is the shared resolver's answer: one writable
    // server for exactly this scope. A scope two servers claim (`conflict`) or
    // one not granted (`unauthorized`) is not deliverable.
    const target = resolveScopeTarget(scope, stores)
    return target.kind === 'remote' && target.writable
  }
  /** File-backed secondary stores (config `stores:` and packs), memoised by path; always YAML. */
  /** @internal */ _secondaryStores: Map<string, AsyncPrimaryStore> = new Map()
  /** The storage-tier decision (ADR-0005), so `backendSelection()` can report the tier and the reason. */
  /** @internal */ _backendSelection: BackendSelection
  /** engram_id → latest co_injection id (fast path for feedback linking; findLatestInjectionFor covers cross-process). */
  /** @internal */ _lastInjectionByEngram: Map<string, string> = new Map()
  /** Spreading-activation drop counters — accumulated in-memory, reset on process restart. */
  /** @internal */ _spreadDrops = { dropped_unresolvable: 0, dropped_retired: 0 }
  /**
   * Timestamps (ms) of recent LLM failures, newest last. A window, not a counter
   * reset on success: a reset across an `await` would erase other in-flight
   * failures and the breaker would never trip.
   */
  /** @internal */ _llmFailures: number[] = []
  /** @internal */ _llmDisabledUntil: number | null = null
  /** Per-session default write scopes; see `session-scopes.ts`. */
  /** @internal */ _sessionScopes = new SessionScopeRegistry()
  /** @internal */ _gitOrigins = new Map<string, { at: number; origin: OriginRead }>()
  /**
   * Set when bound to a `remote-only` folder: writes go only to its team scope
   * (or another writable team scope), and recall/inject read only that scope
   * plus installed packs. Null everywhere else.
   */
  /** @internal */ _boundFolder: RemoteOnlyBinding | null = null
  /** @internal */ _boundGit?: GitScopeOutcome
  /** @internal */ _gitFolderScope(): string | null {
    const ctx = Plur._lockBinding.getStore()
    const git = ctx?.plur === this ? ctx.git : this._boundGit
    return git?.kind === 'scope' ? git.scope
      : git?.kind === 'local' || git?.kind === 'unknown' ? 'local' : null
  }
  /**
   * The binding in effect for THIS operation: the
   * one a public mutator captured when it started, else the current one. A
   * rebind while an operation waits on the network does not change it.
   */
  /** @internal */ get _remoteOnly(): RemoteOnlyBinding | null { return this._activeBinding() }

  /** Run `fn` with the binding captured now, unless an outer operation of this instance already captured one. */
  /** @internal */ _captured<T>(fn: () => T): T {
    const ctx = Plur._lockBinding.getStore()
    if (ctx?.plur === this) return fn()
    return Plur._lockBinding.run({ plur: this, binding: this._boundFolder, git: this._boundGit }, fn)
  }
  /** Cross-encoder reranker, resolved lazily on first `rerank: true` recall; "off" when PLUR_RERANKER is unset. */
  /** @internal */ _reranker: RerankerAdapter | null = null
  /** Logged once per instance if a reranker's cached self-eval is 'harmful'; advisory only, never auto-disables. */
  /** @internal */ _rerankerEvalAdvisoryDone = false
  /** mtime (ms) of config.yaml at last load — drives reloadConfigIfChanged. */
  /** @internal */ configMtimeMs = 0
  /** Local store entries dropped at load because they name the primary file
   *  or a store already registered under another spelling. Kept on
   *  disk; see {@link _loadConfig}. */
  /** @internal */ _ignoredDuplicates: Array<{ entry: StoreEntry; duplicateOf: string }> = []
  /** @internal */ _warnedDuplicateStores = new Set<string>()
  /** url\0scope of pinned scopes already warned as unlisted by /me. */
  /** @internal */ _warnedPinnedUnlisted = new Set<string>()
  /** Whether constructor-time cwd store discovery is enabled for this instance. */
  /** @internal */ _autoDiscover = true
  /**
   * Read-only instance. Guards three write surfaces: the primary store
   * ({@link ReadonlyStoreGuard}), secondary file stores (wrapped in `_storeAt`),
   * and remote stores (mutators call {@link _assertWritable} before routing).
   */
  /** @internal */ readonly _readonly: boolean = false
  /** Unsubscribes this instance from its store's id-rename reports; see `close()`. */
  /** @internal */ _unsubscribeRenames: (() => void) | null = null

  /**
   * Detach this instance from resources it subscribed to on a store it does
   * not own: the id-rename reports of a shared primary store (a Postgres
   * `save` that renames a clashing id reports it to every attached instance,
   * which records it in its own history). Does NOT close the store: the caller
   * passed it in and owns its lifecycle. Idempotent.
   */
  close(): void {
    this._unsubscribeRenames?.()
    this._unsubscribeRenames = null
  }

  /**
   * @param options.path  Root directory (defaults to `PLUR_PATH` or `~/.plur`).
   * @param options.store Source of truth for primary engram state (default
   *   `YamlPrimaryStore(paths.engrams)`); nothing touches `engrams.yaml` directly.
   * @param options.autoDiscover Run cwd project-store discovery in the
   *   constructor (default true; `PLUR_AUTO_DISCOVER=0` flips it).
   * @param options.cwd Directory discovery walks up from (default cwd).
   * @param options.readonly Every mutation throws {@link ReadonlyStoreError};
   *   reads work, but recall's activation refresh is skipped.
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
    this._basePrimaryStore = this._readonly ? new ReadonlyStoreGuard(baseStore) : baseStore
    // A store that renames a clashing id on write (Postgres `save`) reports the
    // rename here, and it is recorded in THIS instance's history like every
    // other rename — nothing lost or hidden, never log-only. Every instance on
    // a shared store subscribes (a Set on the store side), and `close()`
    // unsubscribes.
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
    // whole-corpus load/replace path). A split is almost certainly an
    // implementation mistake, so warn at attachment time where the implementor
    // is looking. A warning rather than a throw: a split store still writes
    // correctly, so this is a performance mistake, not an outage.
    if (options?.store) {
      const s = options.store as Partial<AsyncPrimaryStore>
      // Contract check: a store that can under-report on `load()` and has no
      // per-row write primitive defeats every write-path guard, because a
      // whole-corpus `save()` of a short read is indistinguishable from a real
      // shrink. This THROWS (the pair check below only warns) so the
      // implementor sees it at construction, not the user after data loss.
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
      // The `learn()` seams are a SET, and a partial set is silent:
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
    this._autoDiscover = Plur.resolveAutoDiscover(options?.autoDiscover, this._readRawStores().some(
      entry => isPlainObject(entry) && isPlainObject(entry.enterprise) && ServerStoreEntrySchema.safeParse(entry).success,
    ))
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
    // A network-backed store CAN be this process's primary store (the store
    // interface is async and `PostgresAdapter` implements it), but selection
    // does not construct one implicitly: a connection is a resource with
    // credentials and a lifecycle, and manufacturing one from a config string
    // inside a constructor would make failure modes appear at surprising
    // moments. The caller passes the adapter in
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
    // index alongside it. For such a deployment engrams.yaml is not the source
    // of truth and need not exist, so a PGLite index synced from it would be
    // built from nothing and shadow the store that holds the data.
    //
    // The condition is the injected store, not the size-based tier: the tier can
    // read 'postgres' while the caller passed no Postgres store at all (the
    // warning above covers that case), and then PGLite is still the right index.
    const hasPrimaryQueryStore = this._primaryQueryAdapter() !== null
    const indexTier = hasPrimaryQueryStore
      ? 'none'
      : selection.tier === 'postgres' ? 'pglite' : selection.tier
    if (indexTier === 'pglite' && selection.reason !== 'size') {
      // PGLite is opt-in. Say so on the way in, so an operator can see which
      // engine they are on when a command feels slow — it boots Postgres in
      // WASM on every process.
      logger.warning(
        `[plur] backend=pglite (${selection.reason}). PGLite boots Postgres in WASM per process; ` +
        'it is for pgvector/AGE capabilities, not speed. Unset PLUR_BACKEND / backend: to use SQLite.',
      )
    }
    if (indexTier === 'pglite') {
      // PGLite path. Keep SQLite indexedStorage null so we don't double-index.
      // vector.precision: unset = keep the store's existing column
      // type; 'halfvec' opts in to fp16 storage (lazy in-place migration).
      this.pgliteAdapter = new PGLiteAdapter(this.paths.engrams, this.paths.pglite, {
        // Size the vector column from the ACTIVE embedder (PLUR_EMBEDDER),
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
      // `PlurConfigSchema` is `.partial()`, which NEUTRALISES Zod defaults, so
      // `config.index` is `undefined` on a default install and a plain
      // `if (this.config.index)` would silently build nothing — every recall
      // would then brute-force cosine over the whole corpus (see ADR-0005 §1).
      //
      // When selection ASKED for sqlite, an absent config value means "not
      // configured", not "disabled" — only an explicit `index: false` opts
      // out. Tiers that were never size-selected need an explicit `index: true`.
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
    // Wire config-level embeddings opt-out into the embedder module. The env
    // var PLUR_DISABLE_EMBEDDINGS takes precedence at import time; this
    // honors an explicit config override too. Default (undefined or true)
    // leaves embeddings enabled.
    if (this.config.embeddings?.enabled === false) {
      setEmbeddingsEnabled(false, 'embeddings disabled in config.yaml (embeddings.enabled = false)')
    }
    // One-time auto-purge of tension false positives left by an older dedup
    // prompt that created conflicts, guarded by a sentinel file. A constructor
    // cannot await, and this must never take the constructor down, so callers
    // that need it finished await `ready()`.
    const startDir = options?.cwd || process.cwd()
    this._readyPromise = this._autoPurgeLegacyTensions(startDir).catch((err: unknown) => {
      logger.warning(`[plur] legacy tension auto-purge failed: ${(err as Error).message}`)
    })
  }

  get storageRoot(): string {
    return this.paths.root
  }

  /**
   * Per-instance pool of RemoteStore drivers, keyed by url+scope, each with its
   * own TTL cache. `_loadRemoteCached` is a synchronous PEEK that NEVER fires
   * a load: it returns [] until `warmRemoteCaches()` warms the driver.
   * Live recall uses `remoteRecall` instead; this peek serves only non-recall
   * duties (stores_list counts, feedback/getById resolution).
   */
  /** @internal */ _remoteStores = new Map<string, RemoteStore>()
  /**
   * Ids whose outbox delivery THIS instance is pushing right now; a second
   * pusher skips them so a row is not POSTed twice. Across processes the
   * per-entry claim file does the same job (`_claimOutboxEntry`).
   */
  /** @internal */ _outboxInFlight = new Set<string>()

  /**
   * Run a read-modify-write under exclusive access to the store that owns `path`.
   * Load → mutate → save is only safe under mutual exclusion, and `save()`
   * replaces the whole corpus, so a lost race deletes committed rows. A store
   * that spans processes serializes itself (`PostgresAdapter`: advisory lock);
   * otherwise fall back to the in-process mutex plus `O_EXCL` file lock.
   * @see AsyncPrimaryStore.withExclusiveAccess
   */
  /** @internal */ async _withStoreLock<T>(path: string, fn: () => Promise<T>, lockOptions?: AsyncLockOptions): Promise<T> {
    // One binding per locked operation, used for every store access inside it,
    // so a mid-operation rebind cannot turn a guarded read into an unguarded
    // write. A nested lock keeps the outer binding.
    const ctx = Plur._lockBinding.getStore()
    if (ctx?.plur === this) return await this._withStoreLockBound(path, fn, lockOptions)
    return await Plur._lockBinding.run({ plur: this, binding: this._boundFolder, git: this._boundGit }, () => this._withStoreLockBound(path, fn, lockOptions))
  }

  /** @internal */ async _withStoreLockBound<T>(path: string, fn: () => Promise<T>, lockOptions?: AsyncLockOptions): Promise<T> {
    const store = this._storeAt(path)
    // Lock the store's PHYSICAL location, not the conventional path. An
    // INJECTED store can own bytes somewhere other than `paths.engrams`; two
    // Plur instances with different roots sharing one injected
    // YamlPrimaryStore must take the SAME lock file, or one write can
    // overwrite the other with both reporting success.
    // Falls back to `path` when the store reports no location: an in-memory
    // store has no file to contend over, and a network store answers with
    // `withExclusiveAccess` before this line is reached.
    const lockKey = store.location ?? path
    const guarded = async (): Promise<T> => {
      this._maybeDailyBackup(path)
      return await fn()
    }
    if (store.withExclusiveAccess) return await store.withExclusiveAccess(guarded)
    return await withAsyncLock(lockKey, guarded, lockOptions)
  }

  /** @internal */ _mintedCache: { day: string; ids: Set<string> } | null = null

  /**
   * The store of record for this instance's own engrams.
   *
   * Public so callers can ask what they are actually persisting to
   * (`plur.primaryStore.kind`) instead of assuming `engrams.yaml`.
   */
  get primaryStore(): AsyncPrimaryStore {
    // The store as passed in (or the YAML default), by identity. It is NOT
    // guarded: in a remote-only folder, PLUR's own paths go through the
    // guarded internal access, and a caller writing through this handle
    // directly bypasses that.
    return this._basePrimaryStore
  }

  /**
   * The `/me` identity each remote token
   * last reported, keyed `normalizedUrl::token`. Filled by every successful
   * `/me` this instance makes (`discoverRemoteScopes`, `checkRemoteHealth`);
   * DROPPED when a later `/me` for the same key fails, so "unknown" — never
   * fetched, offline, token rejected — is the fail-closed state. In memory only.
   */
  /** @internal */ _meIdentities = new Map<string, { username: string; org_id: string }>()

  /** @internal */ _provenanceStoreInstance?: ProvenanceStore

  /**
   * Fold a personal `user:` scope to its configured store's scope BEFORE the
   * async/batch hash dedup runs, so dedup looks in the namespace the write
   * will land in. Same rule as `_guardSensitiveScope`.
   */
  /** @internal */ _canonicalLearnContext<C extends { scope?: string } | undefined>(context: C): C {
    if (!context?.scope) return context
    const scope = this._canonicalPersonalScope(context.scope)
    return scope === context.scope ? context : { ...context, scope } as C
  }

  // -------------------------------------------------------------------------
  // Server-authoritative remote recall
  // -------------------------------------------------------------------------

  /** Last per-host recall outcomes (in-process), keyed by normalized URL —
   *  feeds `remoteStoreStatus()`. Each entry carries the time it was observed:
   *  the map is written ONLY by hosts a recall actually dialed, so without an
   *  age the newest entry is indistinguishable from one made days ago by a
   *  process that has since been idle. */
  /** @internal */ _lastRemoteOutcomes = new Map<string, { outcome: HostRecallOutcome; observed_at: number }>()

  /** Token of each claim this instance holds, so a release removes only its own. */
  /** @internal */ _outboxClaimTokens = new Map<string, string>()

  /** Background embedding-cache fills this instance started (0 or 1). */
  /** @internal */ _embeddingFillStarts = 0
  /** @internal */ _embeddingFillChecking = false

  /** Why a hybrid recall or injection answered without its semantic leg, in
   *  words, with the next step where there is one. */
  /** @internal */ static readonly DEGRADED_MESSAGES: Record<DegradedReason, string> = {
    embedding_model_missing: 'the embedding model is not downloaded yet — keyword results only. Run `plur doctor` once to download it (~133 MB).',
    semantic_deadline: 'semantic search did not finish within the recall deadline — keyword results only',
    reranker_deadline: 'the reranker did not finish within the recall deadline — results are in fusion order',
  }

  /** How long past the deadline to wait for a remote leg that is already
   *  settling (it aborts its own requests just before the deadline). */
  /** @internal */ static readonly REMOTE_SETTLE_GRACE_MS = 100

  /** One operator log line per process for a degraded injectHybrid. */
  /** @internal */ static _injectDegradedLogged = false

  /**
   * A row is still waiting for delivery: it carries `_outbox` and is not
   * retired — exactly flushOutbox()'s selection predicate. The merge-back and
   * learn()'s hand-off re-check it on the FRESH row, so a cancellation that
   * landed during the network round-trip (forget, local rescope) is honoured
   * instead of overwritten.
   */
  /** @internal */ static _stillQueued(e: Engram | undefined): boolean {
    return !!e && !!(e as any).structured_data?._outbox && e.status !== 'retired'
  }

  /**
   * Still queued AND still queued for the store a push just went to. An update
   * or a rescope can retarget `_outbox` to
   * another store while the POST to the old one is on the wire; the fresh row
   * then still carries `_outbox`, but for a store that has NOT received it.
   * Only a row whose entry still names the same url and scope is handed off.
   */
  /** @internal */ static _stillQueuedFor(
    e: Engram | undefined,
    target: { url: string; scope: string } | undefined,
  ): boolean {
    if (!target || !Plur._stillQueued(e)) return false
    const ob = (e as any).structured_data._outbox as { target_url?: string; target_scope?: string }
    return ob.target_scope === target.scope
      && !!ob.target_url && normalizeEndpointUrl(ob.target_url) === normalizeEndpointUrl(target.url)
  }

  /**
   * Queue-retire: stamp a durable "retire on remote" entry on the
   * local row — the copy a remote accepted AFTER a forget/rescope cancelled
   * its delivery. `flushOutbox()` retries it like any other queued write, as a
   * DELETE of `server_id` on the store at `target_url`/`target_scope`; it never
   * POSTs, so it cannot resurrect anything. Idempotent: an entry for the same
   * server id is left as it is. Returns whether the row changed. Mutates `row`.
   */
  /** @internal */ static _queueRetireRemote(
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

  /**
   * Resolve whether constructor-time discovery should run.
   *
   * Explicit option wins; otherwise `PLUR_AUTO_DISCOVER=0` / `=false` disables
   * it. The env var exists so a deployment that does not own the construction
   * call site (an embedded consumer, a wrapper binary) can still turn off a
   * cwd-derived disk side effect it never asked for.
   */
  static resolveAutoDiscover(explicit?: boolean, enterprise = false): boolean {
    if (explicit !== undefined) return explicit
    const env = process.env.PLUR_AUTO_DISCOVER
    if (env === '0' || env === 'false') return false
    if (env === '1' || env === 'true') return true
    return !enterprise
  }

  /** A queued save made in a remote-only folder (bound or not, it stays remote-bound). */
  /** @internal */ static _isRemoteOnlyQueued(e: Engram | undefined): boolean {
    return isRemoteOnlyQueued(e)
  }

  /**
   * The write context a remote-only instance accepts for `context`, with the
   * folder's team scope filled in when none is given. Throws
   * RemoteOnlyWriteError for anything that would stay on this machine.
   */
  /** @internal */ _remoteOnlyContext<T extends LearnContext>(context: T | undefined): T | undefined {
    const ro = this._remoteOnly
    if (!ro) return context
    this.reloadConfigIfChanged()
    const requested = context?.scope ?? undefined
    const refuse = (why: RemoteOnlyRefusal): never => { throw this._remoteOnlyError(why, requested) }
    // An unreadable map / unresolvable folder writes NOTHING, an explicit team
    // scope included.
    if (ro.blocked) refuse('blocked')
    if (context?.visibility === 'private') refuse('private')
    const target = requested ?? ro.scope
    if (!target) refuse('no-scope')
    // A scope two servers claim is refused by the shared resolver's own error,
    // before any remote-only reason.
    this._refuseScopeConflict(target!)
    if (requested !== undefined && requested !== ro.scope) {
      if (!isSharedScope(requested)) refuse('personal-scope')
      if (!this._isDeliverableTeamScope(requested)) refuse('local-only-scope')
    } else if (!this._isDeliverableTeamScope(target!)) {
      refuse('no-store')
    }
    return { ...(context ?? {}), scope: target! } as T
  }
}

export interface Plur extends StoreIoMethods, RoutingMethods, ProvenanceIdentityMethods, LearnDedupMethods, ScopeGuardsMethods, LearnMethods, RecallMethods, OutboxMethods, RemoteResultsMethods, InjectionMethods, FeedbackPinMethods, ForgetRescopeMethods, MaintenanceMethods, StatusReportMethods, TensionsMethods, ConfigStoresMethods, FoldersPolicyMethods, DiscoveryMethods {}

for (const methods of [storeIoMethods, routingMethods, provenanceIdentityMethods, learnDedupMethods, scopeGuardsMethods, learnMethods, recallMethods, outboxMethods, remoteResultsMethods, injectionMethods, feedbackPinMethods, forgetRescopeMethods, maintenanceMethods, statusReportMethods, tensionsMethods, configStoresMethods, foldersPolicyMethods, discoveryMethods]) {
  for (const [name, fn] of Object.entries(methods)) {
    Object.defineProperty(Plur.prototype, name, { value: fn, writable: true, enumerable: false, configurable: true })
  }
}

// One folder binding per public call. Every public method of Plur, sync or
// async, runs its ORIGINAL body inside the captured binding context, which
// records the remote-only binding in effect when the call starts and keeps it
// until the call settles (including any promise it returns). A rebind of the
// same instance while a call waits cannot change what it reads, refuses or
// queues. The wrapper never calls the public name again, so a spy on a method
// counts each call once. A call made inside another one of the same instance
// keeps the outer call's binding. Each wrapper carries BINDING_CAPTURED, which
// a test checks on every public method.
export const BINDING_CAPTURED: unique symbol = Symbol('plur.bindingCaptured')
for (const name of Object.getOwnPropertyNames(Plur.prototype)) {
  if (name === 'constructor' || name.startsWith('_')) continue
  const d = Object.getOwnPropertyDescriptor(Plur.prototype, name)
  if (!d || typeof d.value !== 'function') continue
  const original = d.value as (...args: unknown[]) => unknown
  // The capture itself is inline (no method of the instance is called), so a
  // call is exactly one call on the instance: the folder-off test counts them.
  const als = (Plur as unknown as { _lockBinding: AsyncLocalStorage<{ plur: Plur; binding: RemoteOnlyBinding | null; git?: GitScopeOutcome }> })._lockBinding
  const wrapped = function (this: Plur, ...args: unknown[]) {
    const ctx = als.getStore()
    if (ctx?.plur === this) return original.apply(this, args)
    return als.run({ plur: this, binding: (this as unknown as { _boundFolder: RemoteOnlyBinding | null })._boundFolder, git: (this as unknown as { _boundGit?: GitScopeOutcome })._boundGit }, () => original.apply(this, args))
  }
  Object.defineProperty(wrapped, BINDING_CAPTURED, { value: true })
  Object.defineProperty(Plur.prototype, name, { ...d, value: wrapped })
}
