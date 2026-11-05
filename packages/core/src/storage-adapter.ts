/**
 * StorageAdapter — query backends only; persistence lives on `PrimaryStore`.
 * - `role: 'index'` — a DERIVED index; must be rebuildable by `reindex()` with no
 *   observable change (ADR-0001). `syncFromYaml()`/`reindex()` are REQUIRED (`DerivedIndexAdapter`).
 * - `role: 'primary'` — backed by the source-of-truth engine (`PostgresAdapter`); MUST NOT
 *   implement `syncFromYaml()`/`reindex()`. Call them via `asDerivedIndex()`/`requiresIndexSync()`.
 * - `vectorIndex` declares exact vs approximate vector search (ADR-0005).
 * Backends: PGLiteAdapter (index, exact), PostgresAdapter (primary, exact or HNSW);
 * without `searchBM25`/`searchVector` the caller falls back to in-memory `fts`/`embeddings`.
 */
import type { Engram } from './schemas/engram.js'
import type { CorpusStats } from './fts.js'

/**
 * Permitted-scope allow-list — the authorization filter, pushed down into the
 * query (post-filtering a k-NN list lets `LIMIT` count rows the caller cannot see).
 *   - `undefined` → NO scope restriction.
 *   - `[]`        → matches NOTHING; never widen it to "unrestricted" (privilege escalation).
 *   - non-empty   → EXACT set membership (`scope = ANY(list)`): no hierarchy expansion,
 *     no personal-family pass-through; callers expand descendants themselves.
 * AND-ed with every other filter field, so it can only narrow results.
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
  /**
   * Mounted-scope VISIBILITY grants (scopes mounted in `config.yaml` `stores:`).
   * Each passes the `scope` visibility filter like the personal family, with
   * segment-aware containment (`= g`, `LIKE g||':%'`, `LIKE g||'/%'`), never a string prefix.
   * NOT AUTHORIZATION: it only widens the `scope` clause and MUST NEVER be OR-ed into
   * the `scopes` allow-list ({@link ScopeRestriction}) — doing so is a privilege escalation.
   * Absent and `[]` are equivalent: no extra scopes pass.
   */
  visibilityGrants?: readonly string[]
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
 * On-disk element format of the embedding column. A REAL difference in
 * stored values, not just a size knob: `halfvec` rounds every element to fp16,
 * so two tiers running different precisions answer the same query with
 * slightly different scores. Part of the strategy so a caller comparing two
 * deployments can see it.
 */
export type VectorElementFormat = 'float32' | 'halfvec'

/**
 * What a caller gets from `searchVector()` — DECLARED, not inferred.
 *
 * The in-memory path is exact (cosine over the whole corpus). At Postgres
 * scale an approximate index is the only way to answer in bounded time, and
 * its recall is a tuning outcome. So that this does not differ silently
 * between deployments, every adapter declares it. See ADR-0005 for the decision and the measurement
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
  /** Element format of the stored vectors. */
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
 * Headroom multiplier on top of the hard `ef_search >= limit` floor. A predicate the
 * index cannot evaluate (status, scope) post-filters the `ef_search` candidates, so
 * 2x absorbs a filter rejecting up to half the neighbourhood.
 */
export const EF_SEARCH_FILTER_HEADROOM = 2

/**
 * pgvector's hard ceiling on `hnsw.ef_search`. Setting a larger value is not
 * clamped by the server — it raises an error and the whole query fails.
 */
export const PGVECTOR_MAX_EF_SEARCH = 1000

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
  const raised = Math.max(wanted, configured, Math.max(1, limit))
  // Clamp to pgvector's maximum. Above it the server REJECTS the SET rather
  // than clamping, so an unclamped value turns a large-`limit` vector search
  // into a hard failure instead of a slightly-degraded one — with headroom 2
  // that is any limit above 500. Degrading recall is the correct trade here;
  // failing the query is not.
  return Math.min(raised, PGVECTOR_MAX_EF_SEARCH)
}

/**
 * Defaults for an out-of-tree adapter: a derived index over YAML with exact
 * vector search. `role` and `vectorIndex` are REQUIRED on purpose (ADR-0005).
 * If your vector search is approximate, do not take these — a wrong `vectorIndex`
 * is a claim callers act on.
 */
export const DERIVED_INDEX_DEFAULTS = {
  role: 'index',
  vectorIndex: EXACT_VECTOR_INDEX,
} as const satisfies { role: StorageAdapterRole; vectorIndex: VectorIndexStrategy }


/**
 * Escape LIKE metacharacters in a caller-supplied value, so `%` cannot widen
 * `filter.scope`/`filter.domain` matches past segment-aware containment.
 * Shared by every adapter on purpose: scope-rule drift between adapters is an
 * authorization bypass. Callers must pair it with `ESCAPE '\'` on the LIKE.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, c => `\\${c}`)
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
   * rather than assume exactness.
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
  /**
   * BM25 keyword search.
   *
   * `opts.scopes` restricts the candidate set BEFORE ranking — see
   * {@link ScopeRestriction}. An implementation that accepts `scopes` and does
   * not apply it is a silent-wrong-results bug, not a missing optimization.
   */
  searchBM25(query: string, opts: { limit: number } & StorageFilter): Promise<Engram[]>
  /**
   * `searchBM25`, plus whether the candidate set was EXHAUSTED. Optional and
   * additive; when undefined core's widening loop re-queries as usual. Core cannot
   * infer exhaustion from `rows.length === limit`, and for a full-candidate adapter
   * like `PostgresAdapter` the re-query is a pure 2-3x cost.
   */
  searchBM25Exhaustive?(
    query: string,
    opts: { limit: number } & StorageFilter,
  ): Promise<{ rows: Engram[]; exhausted: boolean }>
  /**
   * Corpus-wide `N` and per-term `df` for BM25 scoring. Optional; when undefined the
   * caller derives them from the (truncated) candidate set, which skews IDF.
   * `df` must be counted EXACTLY under `termMatches` from `fts.ts` over the same scope
   * restriction as the search; return `undefined` rather than an approximation.
   *
   * @param queryTokens Tokens from `ftsTokenize` — already lowercased and
   *   stop-word filtered, so the store must not re-tokenize.
   */
  corpusStats?(queryTokens: string[], opts?: ScopeRestriction): Promise<CorpusStats | undefined>
  /**
   * Vector similarity search (cosine). `opts.scopes`, the `scope` visibility filter
   * and `visibilityGrants` must be applied IN the k-NN query, not to returned rows,
   * or `limit` is spent on discarded rows ({@link ScopeRestriction}).
   */
  searchVector(
    query: Float32Array,
    limit: number,
    opts?: ScopeRestriction & Pick<StorageFilter, 'scope' | 'visibilityGrants'>,
  ): Promise<VectorSearchHit[]>
  /**
   * Upsert an embedding for a specific engram.
   *
   * `contentHash` is `embeddingContentHash(engram)` for the engram the vector
   * was computed from — the store persists it beside the vector so it can
   * later tell a current vector from a stale one. Optional for compatibility
   * with callers that do not track staleness; omitting it stores a NULL hash, which reads as "unknown" and makes the engram a
   * candidate for one re-embed.
   */
  upsertEmbedding(engramId: string, vector: Float32Array, contentHash?: string): Promise<void>
  /**
   * Active engrams with no stored embedding, up to `limit`, as ONE set-based query
   * (an indexed anti-join, not scan-and-diff; probed with `limit: 1`).
   * - The backfill passes `includeStale: true` (stale vectors are work to do).
   * - The semantic read path's completeness gate must NOT: a stale vector still
   *   returns the engram, and counting it would push all recall onto the O(N) path (ADR-0005).
   * Optional: core only enables primary-store auto-embed for adapters that implement
   * it; leave it undefined if you cannot answer as a set.
   */
  listEngramsMissingEmbeddings?(limit: number, opts?: { includeStale?: boolean }): Promise<Engram[]>
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
