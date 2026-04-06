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
}

/** Extended context for async learn with LLM dedup. */
export interface LearnAsyncContext extends LearnContext {
  /** LLM function for deduplication decisions. */
  llm?: LlmFunction
  budget?: RecallBudget
  caller_session_id?: string
}

/** LLM dedup decision. */
export type DedupDecision = 'ADD' | 'UPDATE' | 'MERGE' | 'NOOP'

/** Dedup configuration from config.yaml. */
export interface DedupConfig {
  enabled?: boolean
  threshold?: number
  mode?: 'llm' | 'cosine' | 'off'
}

/** Result from learnAsync including dedup decision metadata. */
export interface LearnAsyncResult {
  engram: Engram
  decision: DedupDecision
  existing_id?: string
  tensions?: string[]
}

/** Result from learnBatch. */
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
