/**
 * Backend selection — which storage tier a deployment gets. Tiers: `yaml` (in-memory),
 * `sqlite` (index), `pglite` (WASM pg + pgvector) keep YAML as the source of truth
 * (ADR-0001); `postgres` moves the store itself (ADR-0005).
 * - {@link SQLITE_MIN_ENGRAMS} = 5,000: past the measured brute-force pain point (~4,700).
 * - {@link POSTGRES_MIN_ENGRAMS} = 50,000, only when a connection string is configured:
 *   where a shared engine starts to matter more than a local file.
 * - PGLite is never chosen by size — only via `PLUR_BACKEND` / `backend: pglite`.
 * Round numbers, not tuned. Overrides win: `PLUR_BACKEND` > `config.backend` > size estimate.
 */

/** Storage tier. See the table in the module docstring. */
export type BackendTier = 'yaml' | 'sqlite' | 'pglite' | 'postgres'

/** Every tier name, for validating env/config input. */
export const BACKEND_TIERS: readonly BackendTier[] = ['yaml', 'sqlite', 'pglite', 'postgres'] as const

/**
 * Engram count at or above which the SQLite index earns its cost.
 *
 * SQLite pays ~1ms to open and answers indexed reads in under a millisecond
 * well past 500,000 engrams, so it is the right default everywhere the corpus
 * is large enough for a brute-force YAML scan to hurt.
 */
export const SQLITE_MIN_ENGRAMS = 5_000

/**
 * @deprecated PGLite is opt-in only and this constant selects nothing. Kept
 * exported so an external caller referencing it still compiles;
 * `resolveBackendTier` does not read it.
 */
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
   * names the tier it wanted. The only case is `'postgres'` with no
   * connection string configured, which falls back to `'sqlite'`. A caller
   * SHOULD surface this — it is the difference between "this deployment is
   * sized for a server" and "this deployment is fine".
   */
  wanted?: BackendTier
  /** The estimate the decision was made from, echoed for logging. */
  engramCount: number
}

function asTier(value: string | undefined): BackendTier | null {
  if (!value) return null
  // Normalise case and whitespace: `PLUR_BACKEND=SQLITE` or a trailing newline
  // from `export PLUR_BACKEND=$(...)` must still count as an override, since
  // overrides always win. Still total: anything unrecognised after
  // normalisation is ignored, not fatal.
  const v = value.trim().toLowerCase()
  return (BACKEND_TIERS as readonly string[]).includes(v) ? (v as BackendTier) : null
}

/**
 * Resolve the storage tier.
 *
 * Pure and total: no filesystem, no env access, no throwing. Every input that
 * cannot be honoured degrades to a documented lower tier and says so via
 * `wanted`, so a backend is never silently not the one asked for.
 */
export function resolveBackendTier(input: BackendSelectionInput): BackendSelection {
  const count = Number.isFinite(input.engramCount) && input.engramCount > 0
    ? Math.floor(input.engramCount)
    : 0

  const fromEnv = asTier(input.env)
  if (fromEnv) return { tier: fromEnv, reason: 'env-override', engramCount: count }

  const fromConfig = asTier(input.config)
  if (fromConfig) return { tier: fromConfig, reason: 'config-override', engramCount: count }

  // PGLite is NEVER selected by size, only via the overrides above: it boots Postgres in
  // WASM per process, a toll paid on every CLI/hook invocation. SQLite stays fast far past
  // its threshold (500,000 engrams: open+count 3ms, indexed filter 1ms).
  if (count >= POSTGRES_MIN_ENGRAMS) {
    if (input.postgresConfigured) {
      return { tier: 'postgres', reason: 'size', engramCount: count }
    }
    // Sized for a server, told about no server. SQLite is the best available
    // answer; `wanted` keeps the fallback loud, because falling back is fine
    // and falling back silently is the failure mode.
    return { tier: 'sqlite', reason: 'size', wanted: 'postgres', engramCount: count }
  }

  if (count >= SQLITE_MIN_ENGRAMS) {
    return { tier: 'sqlite', reason: 'size', engramCount: count }
  }

  return { tier: 'yaml', reason: 'size', engramCount: count }
}
