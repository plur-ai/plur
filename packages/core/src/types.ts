import type { Engram } from './schemas/engram.js'
export type { Engram, KnowledgeAnchor, Association } from './schemas/engram.js'
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
  commitment?: 'exploring' | 'leaning' | 'decided' | 'locked'
  /** Reason for locking (required when commitment='locked'). */
  locked_reason?: string
  /** Explicit memory_class override (SP2 Idea 3). Auto-set from type if not provided. */
  memory_class?: 'semantic' | 'episodic' | 'procedural' | 'metacognitive'
  /** Current session episode ID for episodic anchoring (SP2 Idea 24). */
  session_episode_id?: string
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
}

export interface LearnBatchResult {
  results: LearnAsyncResult[]
  stats: { added: number; updated: number; merged: number; noops: number }
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

export interface RecallOptions {
  scope?: string
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
}

export interface BoundedRecallResult {
  results: Engram[]
  truncated: boolean
  strategy_used?: string
}

export interface InjectOptions {
  budget?: number
  scope?: string
  boost_recent?: boolean
  /** Force a query intent for routing (#224); omitted → classifier decides. */
  intentOverride?: 'entity' | 'temporal' | 'event' | 'general'
  /** Cross-encoder rerank stage (#220): true=opt in, false=skip, omitted=respect PLUR_RERANKER. */
  rerank?: boolean
  /** Session ID (from plur_session_start) recorded on the co_injection provenance event (#452). */
  session_id?: string
}

export interface InjectionResult {
  directives: string
  constraints: string
  consider: string
  count: number
  tokens_used: number
  injected_ids: string[]
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
