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
 * ### Why asynchronous (convergence Phase 2, landed)
 *
 * This interface was synchronous when Phase 1 introduced it — deliberately and
 * temporarily. Every `Plur` write path was synchronous (`withLock` +
 * `readFileSync`), so a sync contract was a faithful description of the caller.
 * It was also a hard ceiling: there is no synchronous Postgres client for Node,
 * so no network-backed store could ever satisfy it, and manufacturing one
 * (block-on-promise, a sync subprocess) would have traded a documented
 * limitation for an undocumented hazard.
 *
 * Phase 2 flipped the write path, so the ceiling is gone and the two interfaces
 * this file used to carry have collapsed into one, exactly as planned:
 * `PrimaryStore` IS the async contract, and {@link AsyncPrimaryStore} is now an
 * alias kept only so existing imports keep resolving.
 *
 * `invalidate()` stays synchronous. It drops a local cache; it does not touch
 * the backing medium, and making it async would add an interleaving point that
 * buys nothing.
 */
import type { Engram } from '../schemas/engram.js'

/** Identifier for the backing medium of a primary store. */
export type PrimaryStoreKind = 'yaml' | 'memory' | 'postgres'

export interface PrimaryStore {
  /** Backing medium — for diagnostics and `status()` reporting. */
  readonly kind: PrimaryStoreKind

  /**
   * Human-readable location of the store (a file path for YAML, a schema
   * identifier for Postgres). Used for diagnostics and for lock keys while
   * locking is still path-based. `null` when the store has no such location.
   */
  readonly location: string | null

  /**
   * Authoritative read — always goes to the backing medium, never a cache.
   * Used inside write transactions where a stale snapshot would lose data.
   */
  load(): Promise<Engram[]>

  /**
   * Cached read. May return a previously-loaded snapshot when the backing
   * medium is provably unchanged. An implementation with no cheap
   * change-detection MUST delegate to `load()` rather than serve a snapshot it
   * cannot prove is current.
   */
  loadCached(): Promise<Engram[]>

  /** Replace the entire contents of the store, and drop any read cache. */
  save(engrams: Engram[]): Promise<void>

  /** Drop any read cache without writing. Synchronous — see the note above. */
  invalidate(): void

  /**
   * Cheap, approximate size of the store — for choosing a backend, never for
   * reporting a count to a user.
   *
   * MUST NOT load or parse the corpus: the whole point is to decide which
   * backend to build *before* paying the cost the wrong backend would impose.
   * `YamlPrimaryStore` derives it from the file size; an in-memory store knows
   * it exactly. Optional so an implementation with no cheap estimate can stay
   * silent, in which case backend selection treats the store as small.
   *
   * @see resolveBackendTier in `../backend-selection.js`
   */
  estimateCount?(): number
}

/**
 * @deprecated Use {@link PrimaryStore}. This is now an alias for it.
 *
 * Phase 1 shipped two structurally identical interfaces — a synchronous
 * `PrimaryStore` describing what `Plur` could actually call, and this async
 * successor that only `PostgresAdapter` could satisfy — with the explicit plan
 * that Phase 2 would collapse them. Phase 2 has landed, so it has: there is one
 * contract, and the distinction the two names drew no longer exists.
 *
 * The alias stays because the name is used across `packages/core/src` and by
 * out-of-tree consumers; removing it would be a breaking change that buys
 * nothing. Prefer `PrimaryStore` in new code.
 */
export type AsyncPrimaryStore = PrimaryStore
