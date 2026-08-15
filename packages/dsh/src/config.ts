import z from '@deepseek-ai/schemastery'

/** Plugin configuration, surfaced under the `plur` namespace in `$DSH_HOME/settings.yaml`. */
export interface Config {
  /** PLUR store location. Omitted means `@plur-ai/core`'s own default (`~/.plur`). */
  path?: string
  /**
   * Which PLUR scope this harness may read and write.
   *
   * Omitted, it is DERIVED per workspace (`project:<directory name>`), matching
   * @plur-ai/core's own store discovery. Deriving rather than defaulting to one
   * literal matters: a single shared default would put every unconfigured
   * repository into the same engram pool, which is a cross-project leak
   * affecting exactly the users least likely to notice it.
   *
   * What this DOES guarantee: everything this plugin writes goes to the
   * workspace's own scope, never to `global`.
   *
   * What it does NOT guarantee, and an earlier version of this comment wrongly
   * claimed: that reads are confined to that scope. `global` is a personal
   * scope in core's model (`isPersonalScope`), and personal scopes pass every
   * project-scoped read filter by design — a scoped `recall()` deliberately
   * includes global engrams. So whatever is already in the user's global store
   * IS visible to this harness. That is PLUR's intended behaviour, not a defect
   * here, but it is not the same as isolation and must not be sold as such.
   */
  scope?: string
  /**
   * Whether global engrams accompany the workspace scope.
   *
   * Core separates two filters. `scope` is VISIBILITY, and it deliberately
   * passes the whole personal family (`local`, `global`, `user:*`, `agent:*`)
   * — it is not isolation. `scopes` is AUTHORIZATION: exact membership, no
   * hierarchy expansion. Passing only `scope`, as this plugin did, let one
   * project's engrams into another project's prompt; verified against the real
   * engine, `project:alpha` surfaced in a `project:beta` injection.
   *
   * This plugin now always passes `scopes`, so other projects are excluded
   * unconditionally. This flag controls only whether `global` joins the list.
   * Default true, because most stores keep the majority of their engrams there
   * and excluding it would leave the plugin recalling almost nothing. Set false
   * for strict per-workspace isolation.
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
   * Reranker tier. Stays `off` by default: the bge reranker peaks around 2GB RSS
   * and runs in the HOST's process, where a native OOM cannot be caught by a JS
   * try/catch and would take the user's agent down with it.
   */
  reranker: 'off' | 'ms-marco-minilm-l6' | 'bge-reranker-v2-m3'
  /** Hard bound on any single PLUR call. */
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
  reranker: z.union(['off', 'ms-marco-minilm-l6', 'bge-reranker-v2-m3']).default('off'),
  timeoutMs: z.natural().min(1).default(5000),
  viewerEnabled: z.boolean().default(true),
})
