/**
 * StorageAdapter — shared interface for derived-index backends.
 *
 * YAML on disk is the source of truth (#226 / ADR-0001 / Sprint 0 PR 1).
 * The adapter is the index over YAML, never the primary store. Anything an
 * adapter holds must be rebuildable by calling `reindex()` with no observable
 * change in query results.
 *
 * Backends:
 *   - IndexedStorage  (legacy, better-sqlite3, in-process WAL)
 *   - PGLiteAdapter   (PGLite WASM, pgvector + AGE — ADR-0001)
 *
 * Both expose the same operations the Plur class calls today (`loadFiltered`,
 * `count`, `reindex`, `syncFromYaml`, `close`). The PGLite path adds
 * `searchBM25`, `searchVector`, and `upsertEmbedding` to support the Wave 1
 * retrieval upgrades; the legacy SQLite path leaves those undefined and the
 * caller falls back to the in-memory `fts`/`embeddings` modules.
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

/** Async-style storage adapter. */
export interface StorageAdapter {
  /** Load all engrams from the index, applying a filter. */
  loadFiltered(filter: StorageFilter): Promise<Engram[]>
  /** Count engrams with optional status filter. */
  count(filter?: { status?: string }): Promise<number>
  /** Apply a YAML-to-index delta (incremental). */
  syncFromYaml(): Promise<void>
  /** Drop the index and rebuild from YAML. */
  reindex(): Promise<void>
  /** BM25 keyword search. */
  searchBM25(query: string, opts: { limit: number }): Promise<Engram[]>
  /** Vector similarity search (cosine). */
  searchVector(query: Float32Array, limit: number): Promise<VectorSearchHit[]>
  /** Upsert an embedding for a specific engram. */
  upsertEmbedding(engramId: string, vector: Float32Array): Promise<void>
  /** Release resources. */
  close(): Promise<void>
}
