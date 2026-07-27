/**
 * PrimaryStore — the source-of-truth persistence seam (convergence Phase 1).
 *
 * Until now the `Plur` class called `loadEngrams()` / `saveEngrams()` directly,
 * which hard-wired "the source of truth is a YAML file at `paths.engrams`" into
 * ~40 call sites. `StorageAdapter` could not take that role: it is an *index*
 * interface (`loadFiltered` / `searchBM25` / `searchVector` / `syncFromYaml` /
 * `reindex`) with no write operations at all, so no capability flag could turn
 * it into a store. `PrimaryStore` is that missing half.
 *
 * The split is therefore:
 *
 *   PrimaryStore    — persistence. Owns the bytes. Read and write.
 *   StorageAdapter  — query. Either derived from a PrimaryStore (`role: 'index'`)
 *                     or backed by the same engine as one (`role: 'primary'`).
 *
 * YAML stays the default (`YamlPrimaryStore`), so single-user behaviour is
 * byte-for-byte unchanged. ADR-0001 (YAML as source of truth) is not repealed —
 * it is now a *choice of implementation* rather than an assumption baked into
 * the caller.
 *
 * ### Why synchronous
 *
 * Every `Plur` write path is synchronous today (`withLock` + `readFileSync`).
 * Converting them is convergence Phase 2, deliberately kept separate: flipping
 * ~20 methods to async turns every `await` into an interleaving point and
 * invalidates the implicit atomicity the current code relies on. `PrimaryStore`
 * is intentionally shaped like the *existing* async `EngramStore`
 * (`store/types.ts`) minus the `Promise`s, so Phase 2 is a mechanical
 * `sync → async` flip of one interface instead of a rewrite of 40 call sites.
 *
 * A network- or Postgres-backed primary store cannot satisfy this synchronous
 * contract — that is expected. Phase 5's `PostgresAdapter` lands *after* the
 * Phase 2 async flip, and will implement the async successor of this interface.
 */
import type { Engram } from '../schemas/engram.js'

/** Identifier for the backing medium of a primary store. */
export type PrimaryStoreKind = 'yaml' | 'memory'

export interface PrimaryStore {
  /** Backing medium — for diagnostics and `status()` reporting. */
  readonly kind: PrimaryStoreKind

  /**
   * Human-readable location of the store (a file path for YAML). Used for
   * diagnostics and for lock keys while locking is still path-based. `null`
   * when the store has no filesystem location.
   */
  readonly location: string | null

  /**
   * Authoritative read — always goes to the backing medium, never a cache.
   * Used inside write transactions where a stale snapshot would lose data.
   */
  load(): Engram[]

  /**
   * Cached read. May return a previously-loaded snapshot when the backing
   * medium is provably unchanged. Implementations that cannot detect change
   * cheaply may simply delegate to `load()`.
   */
  loadCached(): Engram[]

  /** Replace the entire contents of the store, and drop any read cache. */
  save(engrams: Engram[]): void

  /** Drop any read cache without writing. */
  invalidate(): void
}
