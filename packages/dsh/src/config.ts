import z from '@deepseek-ai/schemastery'

/** Plugin configuration, surfaced under the `plur` namespace in `$DSH_HOME/settings.yaml`. */
export interface Config {
  /** PLUR store location. Omitted means `@plur-ai/core`'s own default (`~/.plur`). */
  path?: string
  /**
   * Which PLUR scope this harness may read and write. Omitted, it is DERIVED
   * per workspace (`project:<directory name>`), never one shared default that
   * would pool every unconfigured repository.
   * Writes always go to the workspace scope, never `global`. Reads are NOT
   * isolated: `global` is personal (`isPersonalScope`) and passes scoped reads
   * by design, so it must not be sold as isolation.
   */
  scope?: string
  /**
   * Whether global engrams accompany the workspace scope. The plugin always
   * passes `scopes` (AUTHORIZATION, exact membership), since `scope`
   * (VISIBILITY) admits the whole personal family; this flag only adds `global`.
   * Default true (most engrams live there); false for strict per-workspace isolation.
   */
  includeGlobal: boolean
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
   * How long a PLUR call is waited for. A write outlives it: it holds the
   * write queue until it settles or the hard cap (`WRITE_HARD_CAP_MS`, or this
   * if larger) elapses. The 60 s cap itself is a constant, not a
   * config key: only a larger `timeoutMs` raises it.
   */
  timeoutMs: number
  /** Register the `/plur-memory` command that opens the memory viewer. */
  viewerEnabled: boolean
}

export const Config: z<Config> = z.object({
  path: z.string(),
  scope: z.string(),
  includeGlobal: z.boolean().default(true),
  injectionMode: z.union(['content', 'off']).default('content'),
  injectionBudget: z.natural().min(1).default(2000),
  refreshIntervalMs: z.natural().default(0),
  autoLearn: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  timeoutMs: z.natural().min(1).default(5000),
  viewerEnabled: z.boolean().default(true),
})
