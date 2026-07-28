/**
 * Backend selection — which storage tier a deployment gets, and why.
 *
 * ## The problem this replaces
 *
 * `Plur._resolveBackend()` used to read an env var, then a config field, then
 * return `'sqlite'`. Nothing about the actual corpus entered the decision, and
 * the `'sqlite'` default combined with `config.index` being undefined-by-default
 * meant the common case built **no index at all**: every recall loaded the whole
 * corpus into the process and brute-forced cosine over it. That is fine at a few
 * hundred engrams and ruinous at a few thousand — measured ~350 MB resident per
 * process at ~4,700 engrams, paid again by every process that opens the store.
 *
 * ## The tiers
 *
 * | Tier       | Store        | Query                         | Fits |
 * |------------|--------------|-------------------------------|------|
 * | `yaml`     | YAML file    | in-memory BM25 + exact cosine | a personal store |
 * | `sqlite`   | YAML file    | better-sqlite3 metadata index | legacy, explicit only |
 * | `pglite`   | YAML file    | PGLite (WASM pg + pgvector)   | a large single-user store |
 * | `postgres` | Postgres     | Postgres + pgvector           | a multi-process / multi-tenant deployment |
 *
 * `yaml`, `sqlite` and `pglite` all keep YAML as the source of truth (ADR-0001);
 * they differ only in how queries are answered. `postgres` is the first tier
 * where the store itself moves (ADR-0005).
 *
 * ## The thresholds, and why these numbers
 *
 * {@link PGLITE_MIN_ENGRAMS} = 5,000. The brute-force tier's cost is linear in
 * corpus size and paid per process, and the measured pain point is ~4,700
 * engrams / ~350 MB. 5,000 sits just past it: below, an index costs more (WASM
 * boot, a second copy of the data on disk) than the scan it replaces; above, the
 * scan is the dominant cost.
 *
 * {@link POSTGRES_MIN_ENGRAMS} = 50,000. Not a performance cliff — PGLite is
 * still competent there — but the point past which a *single-process WASM*
 * engine is the wrong shape: PGLite is one writer, in one process, with no
 * shared buffer cache, so N agent processes pay the index cost N times. A
 * server hands all of them one engine. 10x the PGLite threshold, chosen as an
 * order of magnitude rather than a measurement, and deliberately conservative:
 * escalating to a network store is a much bigger operational change than
 * building a local index, so the automatic path should be reluctant.
 *
 * Both are round numbers standing in for a range. They are not tuned constants
 * and should not be treated as if a 10% move either way mattered.
 *
 * ## Overrides always win
 *
 * `PLUR_BACKEND` beats `config.backend`, which beats the size estimate. An
 * operator who names a tier gets that tier — the automatic path exists to make
 * the default sane, not to overrule a decision someone made on purpose.
 */

/** Storage tier. See the table in the module docstring. */
export type BackendTier = 'yaml' | 'sqlite' | 'pglite' | 'postgres'

/** Every tier name, for validating env/config input. */
export const BACKEND_TIERS: readonly BackendTier[] = ['yaml', 'sqlite', 'pglite', 'postgres'] as const

/** Estimated engram count at or above which the PGLite index earns its cost. */
export const PGLITE_MIN_ENGRAMS = 5_000

/** Estimated engram count at or above which a server Postgres is the right shape. */
export const POSTGRES_MIN_ENGRAMS = 50_000

/** Why a tier was chosen. */
export type BackendSelectionReason =
  /** `PLUR_BACKEND` named it. */
  | 'env-override'
  /** `config.backend` named it. */
  | 'config-override'
  /** Chosen from the estimated corpus size. */
  | 'size'

export interface BackendSelectionInput {
  /** Raw `PLUR_BACKEND` value, if set. Unknown values are ignored, not fatal. */
  env?: string | undefined
  /** Raw `config.backend` value, if set. Unknown values are ignored, not fatal. */
  config?: string | undefined
  /**
   * Estimated engram count in the primary store — see
   * `PrimaryStore.estimateCount`. Non-finite or negative input is treated as 0.
   */
  engramCount: number
  /**
   * Whether a Postgres connection string is configured. The size estimate can
   * ask for the `postgres` tier; without somewhere to connect it cannot have it.
   */
  postgresConfigured: boolean
}

export interface BackendSelection {
  /** The tier to use. */
  tier: BackendTier
  reason: BackendSelectionReason
  /**
   * Set when the size estimate asked for a tier that could not be given, and
   * names the tier it wanted. Today the only case is `'postgres'` with no
   * connection string configured, which falls back to `'pglite'`. A caller
   * SHOULD surface this — it is the difference between "this deployment is
   * sized for a server" and "this deployment is fine".
   */
  wanted?: BackendTier
  /** The estimate the decision was made from, echoed for logging. */
  engramCount: number
}

function asTier(value: string | undefined): BackendTier | null {
  if (!value) return null
  return (BACKEND_TIERS as readonly string[]).includes(value) ? (value as BackendTier) : null
}

/**
 * Resolve the storage tier.
 *
 * Pure and total: no filesystem, no env access, no throwing. Every input that
 * cannot be honoured degrades to a documented lower tier and says so via
 * `wanted`, because a backend that silently is not the one you asked for is the
 * failure mode this whole phase exists to remove.
 */
export function resolveBackendTier(input: BackendSelectionInput): BackendSelection {
  const count = Number.isFinite(input.engramCount) && input.engramCount > 0
    ? Math.floor(input.engramCount)
    : 0

  const fromEnv = asTier(input.env)
  if (fromEnv) return { tier: fromEnv, reason: 'env-override', engramCount: count }

  const fromConfig = asTier(input.config)
  if (fromConfig) return { tier: fromConfig, reason: 'config-override', engramCount: count }

  if (count >= POSTGRES_MIN_ENGRAMS) {
    if (input.postgresConfigured) {
      return { tier: 'postgres', reason: 'size', engramCount: count }
    }
    // Sized for a server, told about no server. PGLite is the best available
    // answer and the caller is told what it missed.
    return { tier: 'pglite', reason: 'size', wanted: 'postgres', engramCount: count }
  }

  if (count >= PGLITE_MIN_ENGRAMS) {
    return { tier: 'pglite', reason: 'size', engramCount: count }
  }

  return { tier: 'yaml', reason: 'size', engramCount: count }
}
