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
 * Backends today:
 *   - IndexedStorage  (legacy, better-sqlite3, in-process WAL — synchronous,
 *                      does not implement this interface)
 *   - PGLiteAdapter   (PGLite WASM, pgvector + AGE — ADR-0001, `role: 'index'`)
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

/** Async-style storage adapter. */
export interface StorageAdapter {
  /**
   * Whether this adapter is a derived index over some other source of truth
   * (`'index'`) or is itself backed by the store of record (`'primary'`).
   */
  readonly role: StorageAdapterRole
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
