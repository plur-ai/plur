import type { Engram, MeasuredUnder } from './schemas/engram.js'
import type { InjectionSource } from './history.js'
export type { Engram, KnowledgeAnchor, Association, MeasuredUnder } from './schemas/engram.js'
export type { Episode } from './schemas/episode.js'
export type { PlurConfig } from './schemas/config.js'
export type { PackManifest } from './schemas/pack.js'

export interface LearnContext {
  type?: 'behavioral' | 'terminological' | 'procedural' | 'architectural'
  scope?: string
  domain?: string
  source?: string
  tags?: string[]
  rationale?: string
  visibility?: 'private' | 'public' | 'template'
  knowledge_anchors?: Array<{ path: string; relevance?: string; snippet?: string }>
  dual_coding?: { example?: string; analogy?: string }
  abstract?: string | null
  derived_from?: string | null
  /** Commitment level. Defaults to 'leaning' for new engrams. */
  commitment?: 'exploring' | 'leaning' | 'decided' | 'locked' | 'draft'
  /** Reason for locking (required when commitment='locked'). */
  locked_reason?: string
  /** Explicit memory_class override (SP2 Idea 3). Auto-set from type if not provided. */
  memory_class?: 'semantic' | 'episodic' | 'procedural' | 'metacognitive'
  /** Current session episode ID for episodic anchoring (SP2 Idea 24). */
  session_episode_id?: string
  /**
   * Who is answerable for this engram (#961). Every field optional. A caller
   * that does not know a value omits it rather than guessing — a record with no
   * agent is valid, a record with a guessed agent is worse than one with none.
   */
  attribution?: {
    asserted_by?: string
    runtime?: { name: string; version?: string }
    model?: { name: string; prompt_id?: string; prompt_version?: string; prompt_sha256?: string }
    tool?: { name: string; version?: string }
    on_behalf_of?: string
  }
  /**
   * What kind of claim this is (#963): observed, documented, structural,
   * asserted, inferred or revised. Omitted when it cannot be determined.
   */
  claim_class?: 'observed' | 'documented' | 'structural' | 'asserted' | 'inferred' | 'revised'
  /**
   * Which licence governs reuse of this engram's content (#970).
   *
   * Omit it and the schema default applies. That default is not a decision
   * anybody made, and a provenance record says so rather than presenting it
   * beside recorded facts — so a caller who cares about reuse terms has to
   * say which ones. Before this existed there was no way to say, which made
   * a complete provenance record unreachable through the public API.
   */
  license?: string
  /** Always-load flag — bypass keyword-relevance gate during injection. */
  pinned?: boolean
  /**
   * Start of the knowledge's validity window (ISO YYYY-MM-DD, #347). Stored in
   * `temporal.valid_from`; inject/recall skip the engram before this date.
   */
  valid_from?: string
  /**
   * Expiry of the knowledge (ISO YYYY-MM-DD, #347). Stored in
   * `temporal.valid_until`; inject/recall skip the engram after this date.
   * When omitted, an explicit expiry phrase in the statement ("valid until
   * 31 May 2026", "expires 2026-12-01") is auto-extracted — the parsed date
   * is echoed back via `structured_data._expiry_extracted`, never guessed.
   */
  valid_until?: string
  /**
   * IDs of engrams this one intentionally replaces (#240). Writes
   * `relations.supersedes` on the new engram and the reverse
   * `relations.superseded_by` edge on each target found in the local
   * primary store (best-effort -- remote-store targets are not patched).
   * Supersedes-linked pairs are skipped by the tension scanner: an
   * intentional update is not a contradiction.
   */
  supersedes?: string[]
  /**
   * Measurement context for numeric or benchmark-derived claims (#869).
   * Records model, source_type, hardware, dataset, and/or date under which
   * the asserted value was measured. When omitted, the field is absent from
   * the stored engram (not null). See MeasuredUnderSchema for field details.
   */
  measured_under?: MeasuredUnder
  /**
   * Session key this write belongs to (convergence Phase 2).
   *
   * Resolves the session default scope from the per-session registry instead of
   * the process-wide slot. Supply it whenever one `Plur` instance serves more
   * than one session concurrently — without it, `setSessionScope()` is a single
   * shared field and one session's scope silently becomes another's (see
   * `session-scopes.ts`). Never persisted on the engram; it selects a scope, it
   * is not part of one.
   */
  session?: string
}

/** Extended context for async learn with LLM dedup. */
export interface LearnAsyncContext extends LearnContext {
  llm?: LlmFunction
  budget?: RecallBudget
  caller_session_id?: string
}

export type DedupDecision = 'ADD' | 'UPDATE' | 'MERGE' | 'NOOP'

export interface DedupConfig {
  enabled?: boolean
  threshold?: number
  mode?: 'llm' | 'cosine' | 'off'
}

export interface LearnAsyncResult {
  engram: Engram
  decision: DedupDecision
  existing_id?: string
  tensions?: string[]
  /**
   * What the dedup pass was actually able to do, and what it saw (#854).
   *
   * Before this existed, a write on an install with no LLM configured took the
   * `decision = 'ADD'` default and reported success identically to a write that
   * had been semantically checked. The two are not the same claim, and the
   * difference was invisible: 131 near-duplicates accumulated across five months
   * before anyone ran a similarity scan.
   *
   *  - 'llm'       — an LLM judged it
   *  - 'cosine'    — local embeddings judged it, no API call
   *  - 'hash-only' — neither was available; only exact content-hash ran, so an
   *                  ADD here means "not identical", NOT "not a duplicate"
   */
  dedup?: {
    mode: 'llm' | 'cosine' | 'hash-only'
    /** Closest candidates and their scores — present whenever similarity ran. */
    near_duplicates?: Array<{ id: string; score: number }>
  }
  /**
   * Position of this result's statement in the original learnBatch input array
   * (#281). `results` is compacted (failed statements are absent), so callers
   * must NOT assume `results[i]` corresponds to `inputs[i]` — read `input_index`
   * to map a result back to its input. Undefined for a single (non-batch)
   * learnAsync call, where there is no input array to index into.
   */
  input_index?: number
}

/**
 * A single statement that threw while being processed by learnBatch. Carrying
 * the original array index lets callers correlate the failure back to their
 * input; `results` only holds the statements that succeeded.
 */
export interface LearnBatchFailure {
  index: number
  statement: string
  error: string
}

export interface LearnBatchResult {
  /** Successful outcomes, in input order (excludes failed statements). */
  results: LearnAsyncResult[]
  stats: { added: number; updated: number; merged: number; noops: number; failed: number }
  /** Per-statement failures — a bad item does not abort the whole batch. */
  failures: LearnBatchFailure[]
}

/**
 * Function that calls an LLM. Model-agnostic — consumer provides this.
 * Takes a prompt, returns the LLM's text response.
 */
export type LlmFunction = (prompt: string) => Promise<string>

/** Budget constraints for bounded sub-agent expansion (Idea 16). */
export interface RecallBudget {
  max_tokens?: number
  max_results?: number
  ttl_seconds?: number
}

/**
 * Project-level remote endpoint from `.plur.yaml` (#776). Its presence IS the
 * org context for dialing on the hook path: the project explicitly names this
 * host as part of the current work, so it is dialed even when the org-affinity
 * heuristic alone would not implicate it. Project config wins over
 * `config.stores` for the hook path (matching-URL group dials with the
 * project's token when one is supplied).
 */
export interface RemoteProjectConfig {
  url: string
  token?: string
  scopes?: string[]
}

export interface RecallOptions {
  scope?: string
  /**
   * Permitted-scope allow-list — an AUTHORIZATION filter, distinct from the
   * `scope` visibility filter above (see `ScopeRestriction` in
   * storage-adapter.ts for the full contract).
   *
   * Absent = unrestricted. `[]` = matches NOTHING (a principal with no
   * permitted scopes must see nothing — never widened to "no filter").
   * Non-empty = EXACT membership: no hierarchy expansion, no personal-family
   * pass-through, because the caller has already resolved identity to a
   * complete set of permitted scopes.
   *
   * Pushed into the query on the indexed paths so `limit` counts permitted
   * results rather than being spent on rows the caller may not see.
   */
  scopes?: string[]
  domain?: string
  limit?: number
  min_strength?: number
  /** Search mode: 'fast' (BM25, default) or 'agentic' (LLM-assisted semantic search) */
  mode?: 'fast' | 'agentic'
  /** LLM function for agentic mode. Required when mode='agentic'. */
  llm?: LlmFunction
  budget?: RecallBudget
  caller_session_id?: string
  /**
   * Force a query intent for routing (#224) instead of letting the classifier
   * decide. 'general' is the neutral baseline (no re-ranking perturbation).
   */
  intentOverride?: 'entity' | 'temporal' | 'event' | 'general'
  /**
   * Cross-encoder rerank stage (#220), applies to hybrid/semantic recall:
   *   - `true`  → opt in for this call (loads the configured reranker, or
   *     bge-reranker-v2-m3 if PLUR_RERANKER is unset/off).
   *   - `false` → skip the rerank stage even if PLUR_RERANKER is set.
   *   - omitted → respect PLUR_RERANKER (default off → zero cost).
   *
   * Two reranker tiers exist (#451): `ms-marco-minilm-l6` (tiny, ~ms-scale
   * on CPU — hot-path candidate) and `bge-reranker-v2-m3` (quality,
   * seconds-scale on CPU — offline/batch). Select via PLUR_RERANKER.
   */
  rerank?: boolean
  /**
   * Server-authoritative remote recall leg (#776). Default true: recall dials
   * every configured remote host implicated by the current project/work (see
   * the strict scope-relevance dialing rule in remote-recall.ts) in parallel
   * with the local pipeline and RRF-merges the results.
   *
   * INTERNAL CALLERS MUST PASS false: learn-dedup, forget-by-search and
   * self-eval probes derive queries from statements/prompts — without the
   * opt-out every plur_learn fires prompt-derived POSTs to all hosts, and a
   * namespaced remote row can silently suppress a local write as a "dedup
   * match".
   */
  remote?: boolean
  /** Per-call remote budget in ms (env PLUR_REMOTE_RECALL_TIMEOUT_MS wins).
   *  Hook path passes 1500; MCP recall defaults to 2000; session_start warm
   *  passes 5000. */
  remote_timeout_ms?: number
  /** `.plur.yaml` remote endpoint — establishes the org context for dialing
   *  on the hook path (#776). See {@link RemoteProjectConfig}. */
  remote_project?: RemoteProjectConfig
  /**
   * Session key this recall belongs to (#243). Used ONLY to resolve the
   * session default scope as the dialing context for the remote leg when no
   * explicit `scope` is passed: a session whose default scope names org X
   * dials org-X hosts (see `_remoteRecallHosts`). An explicit `scope` always
   * wins. Same registry key as {@link LearnContext.session} — thread the same
   * value through both when one `Plur` serves concurrent sessions.
   */
  session?: string
}

export interface InjectOptions {
  budget?: number
  scope?: string
  /**
   * Permitted-scope allow-list — the AUTHORIZATION filter, same contract as
   * {@link RecallOptions.scopes}: absent = unrestricted, `[]` = matches
   * NOTHING, non-empty = exact membership with no hierarchy expansion.
   *
   * `RecallOptions` gained this in Phase 3 and `InjectOptions` did not, which
   * left `inject()` — the surface a session actually calls on every prompt —
   * with no way to be authorization-scoped at all. Its only scope input was
   * `scope` above, a VISIBILITY filter that deliberately passes the entire
   * personal family through (`local`, `global`, `user:*`, `agent:*`). For a
   * multi-tenant caller that means every principal's personal engrams land in
   * every other principal's context: the visibility filter is doing what it is
   * designed to do, and there was simply no authorization filter above it.
   */
  scopes?: string[]
  boost_recent?: boolean
  /** Force a query intent for routing (#224); omitted → classifier decides. */
  intentOverride?: 'entity' | 'temporal' | 'event' | 'general'
  /** Cross-encoder rerank stage (#220): true=opt in, false=skip, omitted=respect PLUR_RERANKER. */
  rerank?: boolean
  /** Session ID (from plur_session_start) recorded on the co_injection provenance event (#452). */
  session_id?: string
  /** Which surface asked for this injection. Recorded on the co_injection event. */
  source?: InjectionSource
  /**
   * Server-authoritative remote recall leg for `injectHybrid` (#776).
   * Default true. Same contract as {@link RecallOptions.remote}; BM25-only
   * `inject()` NEVER dials regardless of this flag.
   */
  remote?: boolean
  /** Per-call remote budget in ms — see {@link RecallOptions.remote_timeout_ms}. */
  remote_timeout_ms?: number
  /** `.plur.yaml` remote endpoint (hook path org context) — see
   *  {@link RemoteProjectConfig}. */
  remote_project?: RemoteProjectConfig
}

export interface InjectionResult {
  directives: string
  constraints: string
  consider: string
  count: number
  tokens_used: number
  injected_ids: string[]
  /**
   * Per-pack engram counts for this injection. Key is pack name or '__personal__'
   * for engrams from the user's personal store. Used for session activation-rate
   * telemetry at plur_session_end. Only present when at least one engram was injected.
   */
  injected_packs?: Record<string, number>
  /**
   * Persisted-tension warnings (#181): present when an injected engram
   * participates in an unresolved tension (confirmed → either side injected;
   * detected → both sides injected together). Surface, don't adjudicate.
   */
  warnings?: string[]
}

export interface CaptureContext {
  agent?: string
  channel?: string
  session_id?: string
  tags?: string[]
}

export interface TimelineQuery {
  since?: Date
  until?: Date
  agent?: string
  channel?: string
  search?: string
}
