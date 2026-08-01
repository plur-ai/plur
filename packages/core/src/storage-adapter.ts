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
import type { CorpusStats } from './fts.js'

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
  /**
   * Mounted-scope VISIBILITY grants (#775) — scopes explicitly mounted in
   * `config.yaml` `stores:` (path and url entries alike). Each grant passes
   * the `scope` visibility filter above exactly like the personal family:
   * segment-aware containment (`scope = g OR scope LIKE g||':%' OR scope
   * LIKE g||'/%'`), never a sibling string-prefix (#383).
   *
   * NOT AUTHORIZATION — read this twice before touching it. `scopes` (see
   * {@link ScopeRestriction}) is the authorization allow-list: exact
   * membership, AND-ed with everything, an empty list means NOTHING.
   * `visibilityGrants` is the opposite kind of field: it only ever widens
   * the `scope` VISIBILITY clause, is meaningless without `scope`, and MUST
   * NEVER be consulted by (or OR-ed into) the `scopes` clause — an engram
   * outside the `scopes` allow-list stays invisible no matter how many
   * grants cover it. Confusing the two is a privilege escalation, not a
   * styling choice.
   *
   * Absent and `[]` are equivalent: no extra scopes pass (prior behavior).
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
 * Defaults for an out-of-tree adapter adopting the 0.16 interface.
 *
 * `role` and `vectorIndex` are REQUIRED, deliberately — the point of ADR-0005
 * is that a caller can ask what it is getting instead of assuming the exactness
 * core happened to have historically. That makes them a breaking change for
 * anyone who implemented this interface before 0.16, so here is the one-line
 * adoption:
 *
 * ```ts
 * class MyAdapter implements StorageAdapter {
 *   readonly role = DERIVED_INDEX_DEFAULTS.role
 *   readonly vectorIndex = DERIVED_INDEX_DEFAULTS.vectorIndex
 *   // ...
 * }
 * ```
 *
 * These describe the historical behaviour every pre-0.16 adapter had: a derived
 * index over YAML, answering `searchVector` with an exact scan. If yours is
 * approximate, say so rather than taking these — a wrong `vectorIndex` is worse
 * than none, because it is a claim a caller may act on.
 */
export const DERIVED_INDEX_DEFAULTS = {
  role: 'index',
  vectorIndex: EXACT_VECTOR_INDEX,
} as const satisfies { role: StorageAdapterRole; vectorIndex: VectorIndexStrategy }


/**
 * Escape LIKE metacharacters in a caller-supplied value.
 *
 * `buildFilterClause` puts `filter.scope` and `filter.domain` straight into
 * LIKE patterns. Unescaped, a `%` from the caller widens the match instead of
 * narrowing it — `{ domain: '%' }` returns every domain, and `{ scope: '%' }`
 * returns engrams from unrelated groups, which is exactly the segment-aware
 * containment the #383 guard exists to enforce. Both verified against a live
 * database before this was added.
 *
 * Shared by every adapter on purpose: the scope rules have already drifted once
 * between the Postgres and PGLite copies, and that drift was an authorization
 * bypass. One implementation, or it happens again.
 *
 * Callers must pair this with `ESCAPE '\'` on the LIKE, so the escape
 * character does not depend on the server's `standard_conforming_strings`.
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
  /**
   * BM25 keyword search.
   *
   * `opts.scopes` restricts the candidate set BEFORE ranking — see
   * {@link ScopeRestriction}. An implementation that accepts `scopes` and does
   * not apply it is a silent-wrong-results bug, not a missing optimization.
   */
  searchBM25(query: string, opts: { limit: number } & StorageFilter): Promise<Engram[]>
  /**
   * Corpus-wide `N` and per-term `df` for BM25 scoring (convergence Phase 4,
   * #711). OPTIONAL — a store that cannot compute these exactly must leave it
   * undefined, and the caller falls back to deriving them from the candidate
   * set.
   *
   * ## Why this exists
   *
   * `searchBM25` returns a ranked, truncated candidate list. Scoring in core
   * over that list means `computeIdf` sees `N = candidates.length`, so a term
   * that is rare across 50,000 engrams but common among the 200 that came back
   * is scored as common — IDF inverted, precisely for the terms it exists to
   * privilege. Nothing errors; the ranking is just quietly wrong.
   *
   * So narrowing in the store and scoring in core is only sound if the store
   * ALSO reports what the corpus looks like beyond the candidates.
   *
   * ## The exactness requirement
   *
   * `df` must be counted under `termMatches` from `fts.ts` —
   * `t.includes(qt) || qt.startsWith(t)` — over the same scope restriction the
   * search used. Not "close enough": an approximate `df` is worse than the
   * local fallback, because local `df` is at least wrong in a way that
   * correlates with the candidate set and can be reasoned about, whereas an
   * approximation is wrong in a way that varies per term with no pattern.
   *
   * An implementation that cannot reproduce the rule should return `undefined`
   * rather than a best effort.
   *
   * @param queryTokens Tokens from `ftsTokenize` — already lowercased and
   *   stop-word filtered, so the store must not re-tokenize.
   */
  corpusStats?(queryTokens: string[], opts?: ScopeRestriction): Promise<CorpusStats>
  /**
   * Corpus-wide `N` and per-term `df` for BM25 scoring (convergence Phase 4,
   * #711). OPTIONAL — a store that cannot compute these exactly must leave it
   * undefined, and the caller falls back to deriving them from the candidate
   * set.
   *
   * ## Why this exists
   *
   * `searchBM25` returns a ranked, truncated candidate list. Scoring in core
   * over that list means `computeIdf` sees `N = candidates.length`, so a term
   * that is rare across 50,000 engrams but common among the 200 that came back
   * is scored as common — IDF inverted, precisely for the terms it exists to
   * privilege. Nothing errors; the ranking is just quietly wrong.
   *
   * So narrowing in the store and scoring in core is only sound if the store
   * ALSO reports what the corpus looks like beyond the candidates.
   *
   * ## The exactness requirement
   *
   * `df` must be counted under `termMatches` from `fts.ts` —
   * `t.includes(qt) || qt.startsWith(t)` — over the same scope restriction the
   * search used. Not "close enough": an approximate `df` is worse than the
   * local fallback, because local `df` is at least wrong in a way that
   * correlates with the candidate set and can be reasoned about, whereas an
   * approximation is wrong in a way that varies per term with no pattern.
   *
   * An implementation that cannot reproduce the rule should return `undefined`
   * rather than a best effort.
   *
   * @param queryTokens Tokens from `ftsTokenize` — already lowercased and
   *   stop-word filtered, so the store must not re-tokenize.
   */
  corpusStats?(queryTokens: string[], opts?: ScopeRestriction): Promise<CorpusStats>
  /**
   * Vector similarity search (cosine).
   *
   * `opts.scopes` must be applied IN the query (as part of the k-NN
   * predicate), not to the returned rows — otherwise `limit` is measured
   * against the unrestricted neighbour list and in-scope results are diluted
   * away. See {@link ScopeRestriction}.
   */
  searchVector(query: Float32Array, limit: number, opts?: ScopeRestriction): Promise<VectorSearchHit[]>
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
