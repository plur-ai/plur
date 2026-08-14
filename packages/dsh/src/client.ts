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
import type { LogEvent } from './session-log.js'

/** One engram as the store returns it. */
export interface EngramLike {
  readonly id: string
  readonly statement: string
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
  /** Record an episode summary. Positional summary, NOT an options object. */
  capture?(summary: string, context?: { scope?: string }): Promise<unknown>
  /** Extract learnings from a range about to be shadowed by compaction. */
  compactLearn?(input: { events: readonly LogEvent[]; scope: string }): Promise<unknown>
}
