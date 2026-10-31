/**
 * PrimaryStore — the source-of-truth persistence seam.
 *   PrimaryStore    — persistence. Owns the bytes. Read and write.
 *   StorageAdapter  — query only (no writes). Either derived from a PrimaryStore
 *                     (`role: 'index'`) or backed by the same engine (`role: 'primary'`).
 *
 * YAML (`YamlPrimaryStore`) is the default; ADR-0001 is an implementation choice here.
 * The contract is async so a network-backed store can satisfy it; `invalidate()`
 * stays sync because it only drops a local cache.
 */
import type { Engram } from '../schemas/engram.js'

/** Identifier for the backing medium of a primary store. */
export type PrimaryStoreKind = 'yaml' | 'memory' | 'postgres'

/** Options for {@link PrimaryStore.save}. */
export interface SaveOptions {
  /**
   * This write is expected to remove engrams — suppress the shrink guard.
   *
   * Only the deliberate removers set it: compact, forget, retire, outbox
   * merge-back, pack uninstall. Everything else leaves it unset so that an
   * unexpectedly short corpus is refused rather than persisted.
   */
  allowShrink?: boolean
}

/**
 * ## Implementer contract: what the engine cannot protect you from
 *
 * The engine's write guards (unreadable-file refusal, shrink guard, empty-corpus
 * refusal) all trust what the store reports. A `load()` that under-reports, with
 * no `append`/`updateMany`, defeats every one of them. An implementation MUST either:
 *   - implement `append` and `updateMany` (as `PostgresAdapter`, `MemoryPrimaryStore`); or
 *   - make `load()` fail loudly rather than under-report (as `YamlPrimaryStore`
 *     via `EngramStoreUnreadableError`).
 */
export interface PrimaryStore {
  /**
   * Queue background work until the current transaction commits (optional).
   * - Register SYNCHRONOUSLY inside the `fn` of `withExclusiveAccess`; only that
   *   registration is guaranteed to run, once, after the commit, outside the transaction.
   * - Work registered after `fn` ends but before the commit is confirmed is DROPPED
   *   with a warning (indistinguishable from post-rollback). Rolled-back work never runs.
   * - Outside any protected operation, or after a confirmed commit, it runs at once.
   */
  afterCommit?(callback: () => void): void

  /** Backing medium — for diagnostics and `status()` reporting. */
  readonly kind: PrimaryStoreKind

  /**
   * This store's `load()` FAILS rather than under-reporting (e.g. `YamlPrimaryStore`
   * raises {@link EngramStoreUnreadableError}). It is the second way to satisfy the
   * implementer contract and is checked at attachment: a store declaring neither
   * this nor `append`/`updateMany` is refused. Never declare it falsely — that tells
   * the engine a short read can be trusted, which destroys corpora.
   */
  readonly refusesUnreadable?: boolean

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

  /**
   * Replace the entire contents of the store, and drop any read cache.
   *
   * File-backed implementations refuse a write that would shrink the corpus by
   * more than a tolerance unless `opts.allowShrink` is set — see the guard on
   * `saveEngrams`. Row stores have no equivalent exposure and may
   * ignore the option.
   */
  save(engrams: Engram[], opts?: SaveOptions): Promise<void>

  /** Drop any read cache without writing. Synchronous — see the note above. */
  invalidate(): void

  /**
   * Run `fn` with EXCLUSIVE access across every process sharing this store.
   * Optional; when absent the caller falls back to its path-based file lock.
   * Writes are read-modify-write of the whole corpus (even `recall()` writes
   * activation), and a local file lock protects nothing for a shared database, so a
   * cross-process store must lock with something shared (advisory lock, lease).
   * MUST allow `fn` to call `load`/`save` on the same store, and MUST release on throw.
   */
  withExclusiveAccess?<T>(fn: () => Promise<T>): Promise<T>

  /**
   * Replace exactly these engrams, leaving every other row untouched. Optional;
   * when absent the caller falls back to a whole-corpus `save()`, which would
   * rewrite the whole corpus on every `recall()` under the write lock.
   * MUST NOT delete rows absent from `engrams`; MUST be safe inside `withExclusiveAccess`.
   */
  updateMany?(engrams: Engram[]): Promise<void>

  /**
   * Insert exactly one NEW engram, leaving other rows untouched. Optional; when absent
   * the caller saves the corpus it already holds. Not `updateMany([engram])`: that is
   * an upsert and would overwrite on a duplicate id — SHOULD surface a collision as an
   * error. `YamlPrimaryStore` omits it (it rewrites the whole file anyway).
   * MUST invalidate any read cache after writing; MUST be safe inside `withExclusiveAccess`.
   */
  append?(engram: Engram): Promise<void>

  /**
   * Load exactly these engrams by id. Optional; when absent the caller falls
   * back to `load()` and filters in memory.
   *
   * The counterpart to {@link updateMany}, and needed for the same reason: a
   * read-modify-write that touches a handful of rows should not have to
   * materialise the corpus to find them. Ids absent from the store are simply
   * not returned — a missing engram is not an error here.
   */
  loadByIds?(ids: string[]): Promise<Engram[]>

  /**
   * The engram with this content hash IN THIS SCOPE and `status === 'active'`, or
   * `null`. Optional; when absent the caller scans the loaded corpus.
   * - The status filter is required: re-learning a retired statement (incl. the
   *   retired half of a rescope) must create a fresh engram, not resurrect it.
   * - MUST restrict to `scope` exactly (not prefix/parent): another scope's match is
   *   a different engram and returning it would disclose it.
   * - Implementing it skips primary-store cross-scope recurrence (graduation to `global`) by design.
   * @see nextEngramId — the other half of the `learn()` seam; both are required to skip the corpus load.
   */
  findActiveByContentHash?(hash: string, scope: string): Promise<Engram | null>

  /**
   * The next unused engram id for `datePrefix` (e.g. `'ENG-2026-08-03-'`). Optional;
   * when absent the caller derives it from the loaded corpus snapshot.
   * SHOULD allocate atomically (sequence, `INSERT ... RETURNING`): a snapshot-derived
   * id can be stale across processes.
   * - The returned id MUST begin with `datePrefix` and MUST be unused in this store.
   * - Legacy `ENG-YYYY-MMDD-` ids cannot collide with the canonical form as strings.
   * - Pack ids are not consulted; `append`'s collision check is the backstop.
   * @see findActiveByContentHash — the other half of the `learn()` seam.
   */
  nextEngramId?(datePrefix: string): Promise<string>

  /**
   * Cheap, approximate store size — for choosing a backend, never for user-facing
   * counts. MUST NOT load or parse the corpus. Optional; when absent backend
   * selection treats the store as small.
   *
   * @see resolveBackendTier in `../backend-selection.js`
   */
  estimateCount?(): number
}

/**
 * @deprecated Use {@link PrimaryStore}. This is an alias for it, kept because
 * the name is used across `packages/core/src` and by out-of-tree consumers.
 */
export type AsyncPrimaryStore = PrimaryStore
