/**
 * StorageAdapter — shared interface for query backends.
 *
 * ## Roles (convergence Phase 1)
 *
 * An adapter declares a `role` saying what it is relative to the source of
 * truth:
 *
 *   - `'index'`   — a DERIVED index. Something else owns the data (today: a
 *                   `PrimaryStore`, by default YAML on disk). Everything the
 *                   adapter holds must be rebuildable by calling `reindex()`
 *                   with no observable change in query results (ADR-0001 /
 *                   #226 / Sprint 0 PR 1). `syncFromYaml()` and `reindex()` are
 *                   REQUIRED for this role — see `DerivedIndexAdapter`.
 *
 *   - `'primary'` — the adapter is backed by the same engine that IS the source
 *                   of truth, so there is no external delta to apply. It MUST
 *                   NOT implement `syncFromYaml()` / `reindex()`; a caller that
 *                   invokes them would be asking a store to rebuild itself from
 *                   a file it does not have. (Reserved for Phase 5's
 *                   `PostgresAdapter`; no in-repo implementation yet.)
 *
 * `syncFromYaml()` and `reindex()` are therefore OPTIONAL on the base
 * interface. Call them through `asDerivedIndex()` / `requiresIndexSync()`
 * rather than assuming they exist — that assumption is exactly what made this
 * interface an index-only contract.
 *
 * ## Why the write path is not here
 *
 * `StorageAdapter` has no `save` / `append` / `remove`. It never did. A
 * capability flag alone could not promote it to a primary store, because there
 * is nothing to promote — the write half does not exist on this interface.
 * Persistence lives on `PrimaryStore` (`store/primary-store.ts`); this
 * interface stays about *querying*. A Phase 5 Postgres backend implements both,
 * and declares `role: 'primary'` here to say "my query index and my store are
 * the same engine".
 *
 * ## Why the vector-index strategy is on the interface
 *
 * Core has always answered `searchVector()` exactly — a brute-force cosine
 * scan over every candidate, so recall was 1.0 by construction and nobody had
 * to ask. A server-scale backend cannot do that; it needs an approximate index
 * whose recall is a tuning outcome. `vectorIndex` makes that a DECLARED
 * property of the adapter rather than a silent difference between deployments:
 * a caller can ask what it is getting. See ADR-0005.
 *
 * Backends today:
 *   - IndexedStorage   (legacy, better-sqlite3, in-process WAL — synchronous,
 *                       does not implement this interface)
 *   - PGLiteAdapter    (PGLite WASM, pgvector + AGE — ADR-0001, `role: 'index'`,
 *                       exact vector search)
 *   - PostgresAdapter  (server Postgres + pgvector — ADR-0005,
 *                       `role: 'primary'`, exact or HNSW)
 *
 * The PGLite path adds `searchBM25`, `searchVector`, and `upsertEmbedding` to
 * support the Wave 1 retrieval upgrades; the legacy SQLite path leaves those
 * undefined and the caller falls back to the in-memory `fts`/`embeddings`
 * modules.
 */
import type { Engram } from './schemas/engram.js'

/** Filter shape shared by all adapters. */
export interface StorageFilter {
  status?: string
  scope?: string
  domain?: string
}

/** Scored vector-search result. */
export interface VectorSearchHit {
  engram: Engram
  score: number
}

/**
 * What an adapter is relative to the source of truth.
 * See the module docstring for the contract each role carries.
 */
export type StorageAdapterRole = 'index' | 'primary'

/**
 * How an adapter answers `searchVector()` (ADR-0005).
 *
 *   - `exact`   — brute-force scan of every candidate vector. Returns the true
 *                 top-k: recall is 1.0 by construction, not by tuning.
 *   - `hnsw`    — pgvector's graph index. APPROXIMATE: recall depends on
 *                 `m` / `ef_construction` (build time) and `ef_search`
 *                 (query time).
 *   - `ivfflat` — pgvector's inverted-list index. Also approximate; listed for
 *                 completeness, not implemented in-repo.
 */
export type VectorIndexKind = 'exact' | 'hnsw' | 'ivfflat'

/**
 * On-disk element format of the embedding column (#223). A REAL difference in
 * stored values, not just a size knob: `halfvec` rounds every element to fp16,
 * so two tiers running different precisions answer the same query with
 * slightly different scores. Part of the strategy so a caller comparing two
 * deployments can see it.
 */
export type VectorElementFormat = 'float32' | 'halfvec'

/**
 * What a caller gets from `searchVector()` — DECLARED, not inferred.
 *
 * Core has always been exact (in-memory cosine over the whole corpus), so
 * "100% recall" was a property nobody had to ask about. At Postgres scale that
 * stops being free: an approximate index is the only way to answer in
 * bounded time, and its recall is a tuning outcome. Rather than let that
 * become an implementation detail that differs silently between deployments,
 * every adapter declares it. See ADR-0005 for the decision and the measurement
 * protocol behind `recallTarget`.
 */
export interface VectorIndexStrategy {
  readonly kind: VectorIndexKind
  /** True iff `searchVector()` returns the true top-k (recall 1.0 by construction). */
  readonly exact: boolean
  /**
   * Recall@k the approximate tier is tuned to hit, as a fraction in (0, 1].
   * `null` for exact strategies — there is nothing to target. Measured, not
   * assumed: ADR-0005 defines the harness (same corpus, same queries, exact
   * scan as ground truth, |approx ∩ exact| / k averaged over the query set).
   */
  readonly recallTarget: number | null
  /** Element format of the stored vectors (#223). */
  readonly format: VectorElementFormat
  /**
   * Tuning parameters actually in force, e.g. `{ m, efConstruction, efSearch }`
   * for HNSW. Empty for exact. Reported so two deployments can be diffed
   * without reading either one's source.
   */
  readonly params: Readonly<Record<string, number>>
}

/** The strategy every exact (brute-force) backend reports. */
export const EXACT_VECTOR_INDEX: VectorIndexStrategy = Object.freeze({
  kind: 'exact' as const,
  exact: true,
  recallTarget: null,
  format: 'float32' as const,
  params: Object.freeze({}),
})

/**
 * pgvector's built-in `hnsw.ef_search` default. Below most useful result
 * limits — an HNSW scan visits at most `ef_search` candidates, so a query with
 * `LIMIT 50` on the default returns at most 40 rows. Exported because it is the
 * number the guard below exists to defeat.
 */
export const PGVECTOR_DEFAULT_EF_SEARCH = 40

/**
 * Headroom multiplier applied on top of the hard `>= limit` floor.
 *
 * The floor is a correctness requirement: `ef_search < limit` cannot return
 * `limit` rows at all. The multiplier covers the *second* failure mode — a
 * post-filter. When a vector scan is followed by a predicate the index cannot
 * evaluate (`status = 'active'`, a scope restriction), pgvector yields
 * `ef_search` candidates and the filter then removes some of them, so a query
 * asking for `k` rows can come back short even with `ef_search = k`. Fetching
 * 2x candidates absorbs a filter that rejects up to half the neighbourhood.
 */
export const EF_SEARCH_FILTER_HEADROOM = 2

/**
 * The `hnsw.ef_search` a query must run with to be able to return `limit` rows.
 *
 * Never below `limit` — that is the whole point. `configured` raises the floor
 * (an operator who tuned recall upward keeps their value) but never lowers it.
 *
 * @param limit      rows the caller asked for
 * @param configured operator-configured ef_search (defaults to pgvector's own)
 * @param headroom   post-filter headroom multiplier
 */
export function efSearchFor(
  limit: number,
  configured: number = PGVECTOR_DEFAULT_EF_SEARCH,
  headroom: number = EF_SEARCH_FILTER_HEADROOM,
): number {
  const wanted = Math.ceil(Math.max(1, limit) * Math.max(1, headroom))
  return Math.max(wanted, configured, Math.max(1, limit))
}

/** Async-style storage adapter. */
export interface StorageAdapter {
  /**
   * Whether this adapter is a derived index over some other source of truth
   * (`'index'`) or is itself backed by the store of record (`'primary'`).
   */
  readonly role: StorageAdapterRole
  /**
   * What `searchVector()` actually does — exact or approximate, with which
   * parameters. REQUIRED: a caller must be able to ask what it is getting
   * rather than assume the exactness core happened to have historically.
   * Exact backends report {@link EXACT_VECTOR_INDEX}.
   */
  readonly vectorIndex: VectorIndexStrategy
  /** Load all engrams from the backend, applying a filter. */
  loadFiltered(filter: StorageFilter): Promise<Engram[]>
  /** Count engrams with optional status filter. */
  count(filter?: { status?: string }): Promise<number>
  /**
   * Apply a source-to-index delta (incremental).
   * Derived indexes only — absent when `role === 'primary'`.
   */
  syncFromYaml?(): Promise<void>
  /**
   * Drop the index and rebuild it from the source of truth.
   * Derived indexes only — absent when `role === 'primary'`.
   */
  reindex?(): Promise<void>
  /** BM25 keyword search. */
  searchBM25(query: string, opts: { limit: number }): Promise<Engram[]>
  /** Vector similarity search (cosine). */
  searchVector(query: Float32Array, limit: number): Promise<VectorSearchHit[]>
  /** Upsert an embedding for a specific engram. */
  upsertEmbedding(engramId: string, vector: Float32Array): Promise<void>
  /** Release resources. */
  close(): Promise<void>
}

/**
 * A `StorageAdapter` that is a derived index — `syncFromYaml()` and
 * `reindex()` are guaranteed present. Narrow to this with `asDerivedIndex()`
 * before calling either.
 */
export interface DerivedIndexAdapter extends StorageAdapter {
  readonly role: 'index'
  syncFromYaml(): Promise<void>
  reindex(): Promise<void>
}

/**
 * True when a write to the source of truth must be followed by an index sync.
 *
 * `null` (no adapter configured) and `role: 'primary'` both answer false: in the
 * first case there is no index, in the second the write already landed in the
 * backend that answers queries. Only a derived index has a delta to catch up on.
 */
export function requiresIndexSync(adapter: Pick<StorageAdapter, 'role'> | null | undefined): boolean {
  return adapter != null && adapter.role === 'index'
}

/**
 * Narrow an adapter to `DerivedIndexAdapter`, or `null` when it is a primary
 * store (or an `'index'` adapter that failed to implement the contract, which
 * is a programming error we refuse to call into rather than crash on).
 */
export function asDerivedIndex<T extends StorageAdapter>(
  adapter: T | null | undefined,
): (T & DerivedIndexAdapter) | null {
  if (!adapter || adapter.role !== 'index') return null
  if (typeof adapter.syncFromYaml !== 'function' || typeof adapter.reindex !== 'function') return null
  return adapter as T & DerivedIndexAdapter
}
