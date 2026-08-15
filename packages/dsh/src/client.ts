/**
 * The slice of `@plur-ai/core` this plugin depends on.
 *
 * Declared structurally so tests can supply a plain object without a store on
 * disk, but every signature here MUST match the real `Plur` class. An invented
 * contract type-checks fine and then fails silently at runtime against the real
 * engine — `test/conformance.test.ts` instantiates the real `Plur` and asserts
 * it satisfies this interface, so drift is caught by CI rather than by a user.
 *
 * @module
 */
import type { InjectionLike } from './memory-section.js'

/** One candidate statement core's `ingest()` extracted from text. */
export interface IngestCandidateLike {
  readonly statement: string
  readonly type?: string
  readonly source?: string
}

/** One engram as the store returns it. */
export interface EngramLike {
  readonly id: string
  readonly statement: string
}

/**
 * Context core accepts on `capture()` — a subset of core's `CaptureContext`.
 *
 * Note what is NOT here: `scope`. Core writes every episode to one timeline per
 * store; episodes are not scoped. Passing `{ scope }` was silently discarded,
 * so the scope an episode came from was simply lost. It travels in `tags` now.
 */
export interface CaptureContextLike {
  agent?: string
  channel?: string
  session_id?: string
  tags?: string[]
}

/** Context accepted alongside a stored statement (a subset of core's `LearnContext`). */
export interface LearnContextLike {
  scope?: string
  domain?: string
  source?: string
}

/** The rating vocabulary core accepts. Note: NOT a number. */
export type FeedbackSignal = 'positive' | 'negative' | 'neutral'

/** Everything the plugin may call on PLUR, matching the real `Plur` signatures. */
export interface PlurClient {
  /**
   * Hybrid (BM25 + embedding) injection. The primary path: returns the same
   * pre-rendered directives/constraints/consider strings that @plur-ai/mcp and
   * @plur-ai/claw render, so every host shows the user the same block.
   */
  injectHybrid?(task: string, options?: { scope?: string }): Promise<InjectionLike>
  /** BM25-only injection, used when the hybrid path is unavailable. */
  inject?(task: string, options?: { scope?: string }): Promise<InjectionLike>
  /** Targeted list lookup, backing the `plur_recall` tool. */
  recall?(query: string, options?: { scope?: string; limit?: number }): Promise<readonly EngramLike[]>
  /** Store one assertion. Positional statement, NOT an options object. */
  learn?(statement: string, context?: LearnContextLike): Promise<unknown>
  /** Retire one engram by id. */
  forget?(id: string, reason?: string, options?: { scope?: string }): Promise<unknown>
  /** Rate one engram. Takes the signal word, NOT a number. */
  feedback?(id: string, signal: FeedbackSignal, scope?: string): Promise<unknown>
  /**
   * Record an episode summary. Positional summary, NOT an options object, and
   * SYNCHRONOUS in core — it returns the episode, not a promise.
   */
  capture?(summary: string, context?: CaptureContextLike): unknown
  /**
   * Rule-based extraction of engram candidates from free text.
   *
   * The compaction path is built on this plus {@link PlurClient.learn}. An
   * earlier version called a `compactLearn()` that core has never implemented,
   * so `plur?.compactLearn?.()` was always undefined and every compaction
   * silently learned nothing.
   */
  ingest?(content: string, options?: { source?: string }): Promise<readonly IngestCandidateLike[]>
  /** Every engram in scope, backing the memory viewer. */
  list?(options?: { scope?: string }): Promise<readonly unknown[]>
  /** Store diagnostics — the viewer shows `storage_root` and `engram_count`. */
  status?(): Promise<{ storage_root?: unknown; engram_count?: unknown }>
}
