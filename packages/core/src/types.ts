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
   * Force a specific query intent for intent-aware ranking (#224).
   * Bypasses the deterministic classifier. Use for testing or when the
   * caller knows the intent better than the classifier can infer.
   * Default: classifier auto-detects from the query.
   */
  intentOverride?: 'entity' | 'temporal' | 'event' | 'general'
  /**
   * Cross-encoder reranker stage (Sprint 0, #220). Applies to
   * `recallHybrid` / `recallSemantic` / `injectHybrid`.
   *
   *   - `true`  → opt in for this call. Loads bge-reranker-v2-m3 if no
   *               PLUR_RERANKER is set, otherwise the env-selected adapter.
   *   - `false` → skip the rerank stage even if PLUR_RERANKER is set.
   *   - undefined → respect PLUR_RERANKER (default: off).
   *
   * Adds ~50-500ms per query depending on candidate count.
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
  /**
   * Force a specific query intent for intent-aware ranking (#224).
   * Bypasses the deterministic classifier. Use for testing or when the
   * caller knows the intent better than the classifier can infer.
   */
  intentOverride?: 'entity' | 'temporal' | 'event' | 'general'
  /**
   * Cross-encoder reranker stage (Sprint 0, #220). Applies to
   * `injectHybrid`. See `RecallOptions.rerank` for semantics.
   */
  rerank?: boolean
}

export interface InjectionResult {
  directives: string
  constraints: string
  consider: string
  count: number
  tokens_used: number
  injected_ids: string[]
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
