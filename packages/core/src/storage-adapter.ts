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

/**
 * Permitted-scope allow-list — the authorization filter (Phase 3, scope
 * pushdown).
 *
 * This exists so a caller that has ALREADY resolved an identity to a concrete
 * set of permitted scopes — typically in an identity/permission layer sitting
 * above core — can push that decision INTO the query, instead of filtering the
 * result set afterwards.
 *
 * Post-filtering an unrestricted nearest-neighbour list is the dilution bug
 * this type exists to prevent: `LIMIT` counts rows the caller may not be
 * allowed to see, so with a fixed overfetch factor a caller whose permitted
 * scopes are a small share of the corpus asks for N results and silently gets
 * far fewer, while relevant permitted rows sit just below the cut.
 *
 * Semantics — all three cases are load-bearing:
 *   - `undefined` (absent) → NO scope restriction. Identical behaviour to
 *     before this field existed.
 *   - `[]` (empty array)   → matches NOTHING. A principal with zero permitted
 *     scopes must see zero engrams. An empty list is never widened to
 *     "unrestricted"; that would be a privilege-escalation bug.
 *   - non-empty            → EXACT set membership (`scope = ANY(list)`).
 *
 * Exactness is deliberate. Unlike `StorageFilter.scope` (a *visibility* filter
 * that is hierarchy-aware and passes personal-family scopes through), `scopes`
 * is an *authorization* filter: the list is already the complete answer. It
 * performs NO hierarchy expansion and NO personal-family pass-through, so
 * `scopes: ['project:a']` admits `project:a` alone — not `project:a:sub`, not
 * `global`, not `local`. A caller who wants descendants must expand them into
 * the list itself.
 *
 * Composition: `scopes` is AND-ed with every other filter field (`status`,
 * `scope`, `domain`), so combining them can only ever narrow the result set.
 */
export interface ScopeRestriction {
  /** Permitted-scope allow-list. Absent = unrestricted, `[]` = nothing. */
  scopes?: string[]
}

/** Filter shape shared by all adapters. */
export interface StorageFilter extends ScopeRestriction {
  status?: string
  /**
   * Visibility scope (hierarchy-aware, personal-family pass-through).
   * Distinct from `scopes` — see {@link ScopeRestriction}.
   */
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
  /**
   * BM25 keyword search.
   *
   * `opts.scopes` restricts the candidate set BEFORE ranking — see
   * {@link ScopeRestriction}. An implementation that accepts `scopes` and does
   * not apply it is a silent-wrong-results bug, not a missing optimization.
   */
  searchBM25(query: string, opts: { limit: number } & ScopeRestriction): Promise<Engram[]>
  /**
   * Vector similarity search (cosine).
   *
   * `opts.scopes` must be applied IN the query (as part of the k-NN
   * predicate), not to the returned rows — otherwise `limit` is measured
   * against the org-wide neighbour list and in-scope results are diluted away.
   * See {@link ScopeRestriction}.
   */
  searchVector(query: Float32Array, limit: number, opts?: ScopeRestriction): Promise<VectorSearchHit[]>
  /** Upsert an embedding for a specific engram. */
  upsertEmbedding(engramId: string, vector: Float32Array): Promise<void>
  /** Release resources. */
  close(): Promise<void>
}
