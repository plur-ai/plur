/**
 * The slice of `@plur-ai/core` this plugin depends on.
 *
 * Declared structurally and in one place rather than importing the concrete
 * `Plur` class, so every module agrees on one contract and tests can supply a
 * plain object without a real store on disk. Every method is optional: a host
 * may wire a partial client, and a missing method must degrade to "no memory"
 * rather than a crash.
 *
 * @module
 */
import type { InjectionLike } from './memory-section.js'
import type { LogEvent } from './session-log.js'

/** One engram as returned by the targeted `recall` path. */
export interface EngramLike {
  readonly id: string
  readonly statement: string
}

/** Everything the plugin may call on PLUR. */
export interface PlurClient {
  /**
   * Hybrid (BM25 + embedding) injection. The primary path: returns the same
   * pre-rendered directives/constraints/consider strings that @plur-ai/mcp and
   * @plur-ai/claw render, so every host shows the user the same block.
   */
  injectHybrid?(task: string, opts: { scope: string }): Promise<InjectionLike>
  /** BM25-only injection, used when the hybrid path is unavailable. */
  inject?(task: string, opts: { scope: string }): Promise<InjectionLike>
  /** Targeted list lookup, backing the `plur_recall` tool. */
  recall?(query: string, opts: { scope: string; limit?: number }): Promise<readonly EngramLike[]>
  /** Store one assertion. */
  learn?(input: { statement: string; domain?: string; scope: string }): Promise<unknown>
  /** Retire one engram by id. */
  forget?(id: string, reason?: string): Promise<unknown>
  /** Rate one engram; positive is 1, negative is -1. */
  feedback?(id: string, signal: number): Promise<unknown>
  /** Record an episode summary at turn end. */
  capture?(input: { summary: string; scope: string }): Promise<unknown>
  /** Extract learnings from a range about to be shadowed by compaction. */
  compactLearn?(input: { events: readonly LogEvent[]; scope: string }): Promise<unknown>
}
