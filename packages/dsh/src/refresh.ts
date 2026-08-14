/**
 * When the memory block is recomputed.
 *
 * @module
 */

/** Decides when an out-of-band recall runs. */
export interface RefreshPolicy {
  /** True when this step should trigger a recall. */
  shouldRefresh(agentId: string, step: number): boolean
  /** Record that a refresh just ran. */
  markRefreshed(agentId: string): void
  /** Forget an agent when its session ends. */
  clear(agentId: string): void
}

/**
 * Refresh at turn boundaries only.
 *
 * Step 1 of a turn is the moment new human input has arrived, which is the only
 * time the recall query can have changed. Recalling on later steps would spend a
 * retrieval per tool-loop iteration and re-fire on every request-recovery retry
 * for no new information. `refreshIntervalMs` adds a wall-clock floor on top,
 * which bounds a retry storm that keeps re-entering step 1.
 *
 * @param opts - the interval floor, and an injectable clock for tests.
 * @returns the policy.
 */
export function createRefreshPolicy(opts: {
  refreshIntervalMs: number
  now?: () => number
}): RefreshPolicy {
  const now = opts.now ?? Date.now
  const last = new Map<string, number>()
  return {
    shouldRefresh(agentId, step) {
      if (step !== 1) return false
      if (opts.refreshIntervalMs <= 0) return true
      const previous = last.get(agentId)
      if (previous === undefined) return true
      return now() - previous >= opts.refreshIntervalMs
    },
    markRefreshed(agentId) {
      last.set(agentId, now())
    },
    clear(agentId) {
      last.delete(agentId)
    },
  }
}
