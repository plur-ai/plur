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
 * {@link SQLITE_MIN_ENGRAMS} = 5,000. The brute-force tier's cost is linear in
 * corpus size and paid per process, and the measured pain point is ~4,700
 * engrams / ~350 MB. 5,000 sits just past it: below, an index costs more (WASM
 * boot, a second copy of the data on disk) than the scan it replaces; above, the
 * scan is the dominant cost.
 *
 * {@link POSTGRES_MIN_ENGRAMS} = 50,000, and only when a connection string is
 * actually configured — otherwise the store stays on SQLite. This is not a
 * SQLite limit: it answers indexed reads in ~1ms at 500,000 engrams. It is the
 * point past which a SHARED engine starts to matter more than a local file —
 * many agent processes, concurrent writers, one cache.
 *
 * PGLite is deliberately absent from both rules (#1046). It is a capability
 * choice — pgvector's ANN index, Apache AGE's graph queries — reachable only
 * by setting `PLUR_BACKEND=pglite` or `backend: pglite`. Selecting it by
 * corpus size moved users onto a backend that boots a Postgres in WASM on
 * every process, which is the wrong shape for a per-invocation CLI no matter
 * how large the corpus gets.
 *
 * These are round numbers standing in for a range. They are not tuned
 * constants and should not be treated as if a 10% move either way mattered.
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
/**
 * Engram count at or above which the SQLite index earns its cost.
 *
 * This is the tier that used to be PGLite's. SQLite pays ~1ms to open and
 * answers indexed reads in under a millisecond well past 500,000 engrams, so
 * it is the right default everywhere the corpus is large enough for a
 * brute-force YAML scan to hurt.
 */
export const SQLITE_MIN_ENGRAMS = 5_000

/**
 * @deprecated Since #1046 PGLite is opt-in only and this constant selects
 * nothing. Kept exported so an external caller referencing it still compiles;
 * `resolveBackendTier` no longer reads it.
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

  // PGLite is NEVER selected by size (#1046). It is reachable only through the
  // env/config overrides handled above — a capability choice the operator makes
  // deliberately, not something a growing corpus does to them silently.
  //
  // The old rule promoted any store past 5,000 engrams onto PGLite. Measured
  // 2026-08-27 on a 5,775-engram store, `plur status` took 0.61s on sqlite and
  // over 300s on pglite. The cost is structural, not a bug we can tune away:
  // PGLite boots a real Postgres in WASM per process (~1.3s fresh, ~244ms
  // reopening), and PLUR's CLI and hooks are a fresh process every invocation,
  // so that toll is paid on every single command. Its per-query cost is
  // genuinely good — 0.135ms, faster than better-sqlite3's single-row inserts —
  // which is exactly why it suits a long-lived process and not this one.
  //
  // Nor was 5,000 near any SQLite limit. Same machine, synthetic corpora:
  //
  //     engrams   open+count   indexed filter   full scan
  //       5,000          1ms              0ms         3ms
  //      50,000          1ms              0ms        29ms
  //     200,000          1ms              1ms       217ms
  //     500,000          3ms              1ms       342ms
  //
  // SQLite is still opening in single-digit milliseconds two orders of
  // magnitude past the threshold that was promoting people off it.
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
