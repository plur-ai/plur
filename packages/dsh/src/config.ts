import z from '@deepseek-ai/schemastery'

/** Plugin configuration, surfaced under the `plur` namespace in `$DSH_HOME/settings.yaml`. */
export interface Config {
  /** PLUR store location. Omitted means `@plur-ai/core`'s own default (`~/.plur`). */
  path?: string
  /**
   * Which PLUR scope this harness may read and write.
   *
   * Omitted, it is DERIVED per workspace (`project:<directory name>`), matching
   * @plur-ai/core's own store discovery. It is never the ambient global store: a
   * global store accretes across every tool the user has ever pointed PLUR at —
   * server addresses, credential paths, client names — and a third-party harness
   * must not inherit all of that merely by being installed.
   *
   * Deriving rather than defaulting to one literal matters: a single shared
   * default would put every unconfigured repository into the same engram pool,
   * which is a cross-project leak affecting exactly the users least likely to
   * notice it.
   */
  scope?: string
  /** `content` injects the engrams themselves; `off` disables injection entirely. */
  injectionMode: 'content' | 'off'
  /** Token ceiling for the rendered block. */
  injectionBudget: number
  /** Floor in ms between cache refreshes. 0 means once per turn boundary. */
  refreshIntervalMs: number
  /** Detect corrections in user messages and store them. */
  autoLearn: boolean
  /** Record an episode summary at turn end. */
  autoCapture: boolean
  /**
   * Reranker tier. Stays `off` by default: the bge reranker peaks around 2GB RSS
   * and runs in the HOST's process, where a native OOM cannot be caught by a JS
   * try/catch and would take the user's agent down with it.
   */
  reranker: 'off' | 'ms-marco-minilm-l6' | 'bge-reranker-v2-m3'
  /** Hard bound on any single PLUR call. */
  timeoutMs: number
  /** Register the Web UI memory tab. */
  tabEnabled: boolean
}

export const Config: z<Config> = z.object({
  path: z.string(),
  scope: z.string(),
  injectionMode: z.union(['content', 'off']).default('content'),
  injectionBudget: z.natural().min(1).default(2000),
  refreshIntervalMs: z.natural().default(0),
  autoLearn: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  reranker: z.union(['off', 'ms-marco-minilm-l6', 'bge-reranker-v2-m3']).default('off'),
  timeoutMs: z.natural().min(1).default(5000),
  tabEnabled: z.boolean().default(true),
})
