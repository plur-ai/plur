/**
 * PostgresAdapter — server Postgres as BOTH the store and the index (ADR-0005).
 *
 * This is the case ADR-0003's `role` flag was introduced to express. Every
 * other backend in the repo is a *derived index*: YAML owns the bytes, the
 * backend holds a rebuildable copy, and a write to YAML leaves it stale until
 * `syncFromYaml()` runs. Here there is nothing to derive from — the rows in
 * Postgres ARE the source of truth, and the same engine answers the queries.
 * So this class implements two interfaces at once:
 *
 *   - {@link AsyncPrimaryStore} — persistence. `load` / `loadCached` / `save`.
 *   - {@link StorageAdapter} with `role: 'primary'` — query. `loadFiltered` /
 *     `count` / `searchBM25` / `searchVector` / `upsertEmbedding`.
 *
 * It deliberately does NOT implement `syncFromYaml()` / `reindex()`. Calling
 * either would be asking a store to rebuild itself from a file it does not
 * have; `requiresIndexSync()` returns false for this role precisely so no
 * caller tries.
 *
 * ## Why `AsyncPrimaryStore` and not `PrimaryStore`
 *
 * `PrimaryStore` is synchronous (ADR-0003, on purpose and temporarily). Node
 * has no synchronous Postgres client, and the ways to fake one — blocking on a
 * promise, shelling out per query — trade a documented limitation for an
 * undocumented hazard. So the adapter implements the async successor and is not
 * yet accepted by `new Plur({ store })`. Convergence Phase 2 makes `Plur`'s
 * write path async, and this adapter becomes injectable with no changes here.
 * Until then, a deployment that wants a Postgres-backed store drives the
 * adapter directly.
 *
 * ## Vector search is the one place behaviour can differ
 *
 * Core has always been exact. At server scale exact is not on the menu, so this
 * adapter can run an approximate HNSW index — and says so through
 * {@link StorageAdapter.vectorIndex}, which is a declared property rather than
 * an implementation detail. Two things follow, both handled here:
 *
 *   1. `hnsw.ef_search` is set per query to at least the requested limit (see
 *      {@link efSearchFor}). pgvector's default is 40, which is BELOW most
 *      useful limits — an HNSW scan visits at most `ef_search` candidates, so
 *      the default silently caps a `LIMIT 50` query at 40 rows.
 *   2. The scan is followed by a `status = 'active'` predicate the index cannot
 *      evaluate, which removes candidates *after* the fact. `efSearchFor`
 *      carries headroom for that.
 *
 * See ADR-0005 for the recall target and how it would be measured.
 *
 * ## Schema
 *
 * Mirrors the PGLite adapter's on purpose — `engrams` (hot filter columns +
 * `data` JSONB) and `engram_embeddings` (one vector per engram, cascading on
 * delete). Keeping them the same is what lets a corpus move between tiers and
 * lets the two adapters be tested against each other.
 *
 * `pg` is an OPTIONAL dependency, imported lazily: a personal install must not
 * pay for a driver it will never open.
 */
import type { Engram } from './schemas/engram.js'
import { searchEngrams } from './fts.js'
import { logger } from './logger.js'
import {
  EXACT_VECTOR_INDEX,
  PGVECTOR_DEFAULT_EF_SEARCH,
  efSearchFor,
  type StorageAdapter,
  type StorageFilter,
  type VectorElementFormat,
  type VectorIndexStrategy,
  type VectorSearchHit,
} from './storage-adapter.js'
import type { AsyncPrimaryStore, PrimaryStoreKind } from './store/primary-store.js'

/** Vector dimension of the default BGE-small-en-v1.5 embedder. */
const DEFAULT_VECTOR_DIM = 384

/** Default schema. Named so a PLUR deployment never squats on `public`. */
export const DEFAULT_POSTGRES_SCHEMA = 'plur'

/**
 * pgvector HNSW build parameters. These ARE pgvector's own defaults, restated
 * here so they are visible at the call site instead of inherited silently —
 * the point of ADR-0005 is that an approximate tier's parameters are part of
 * its contract.
 *
 * `m` = 16 (graph out-degree), `ef_construction` = 64 (build-time candidate
 * list). Raising either raises recall and build cost; neither is tuned for
 * PLUR's corpus yet.
 */
export const HNSW_DEFAULT_M = 16
export const HNSW_DEFAULT_EF_CONSTRUCTION = 64

/**
 * Recall@k the HNSW tier is TARGETED at, at the defaults above.
 *
 * A target, not a measurement. ADR-0005 defines the harness that would confirm
 * or refute it (same corpus, same embedder, exact scan as ground truth,
 * mean |approx ∩ exact| / k over a fixed query set). Reported through
 * `vectorIndex.recallTarget` so a caller comparing an exact tier against this
 * one sees a number rather than a shrug.
 */
export const HNSW_RECALL_TARGET = 0.95

/**
 * Rows at or above which `vectorIndex: 'auto'` builds the HNSW index.
 *
 * Below this an exact scan is both faster (no graph traversal, no build) and
 * lossless, so approximating would cost recall to buy nothing. Deliberately
 * the same number as the PGLite tier boundary — the corpus size at which
 * scanning everything stops being free does not change because the engine did.
 */
export const HNSW_MIN_ROWS = 5_000

/** Name of the HNSW index this adapter creates. */
const HNSW_INDEX_NAME = 'engram_embeddings_hnsw'

/** Rows per INSERT round trip in `save()`. */
const SAVE_CHUNK_SIZE = 500

/** Postgres identifiers this adapter will interpolate into DDL. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/

export type PostgresVectorIndexMode = 'auto' | 'exact' | 'hnsw'

export interface PostgresAdapterOptions {
  /** libpq connection string, e.g. `postgres://user:pass@host:5432/db`. */
  connectionString: string
  /**
   * Schema to own the PLUR tables. Created if absent. Defaults to
   * {@link DEFAULT_POSTGRES_SCHEMA}. Must be a plain identifier — it is
   * interpolated into DDL and is validated, not escaped.
   */
  schema?: string
  /** Embedding dimension for new stores (default 384 — BGE-small). */
  vectorDim?: number
  /**
   * `halfvec` stores fp16 (#223): half the bytes, and genuinely different
   * stored values. Unset keeps whatever an existing store already uses, and
   * creates new stores as `vector` (fp32).
   */
  precision?: VectorElementFormat
  /**
   * Vector index strategy. `auto` (default) builds HNSW once the store holds
   * at least {@link HNSW_MIN_ROWS} embeddings and stays exact below that;
   * `exact` never builds one; `hnsw` always does.
   */
  vectorIndex?: PostgresVectorIndexMode
  /** HNSW `m` (default {@link HNSW_DEFAULT_M}). */
  hnswM?: number
  /** HNSW `ef_construction` (default {@link HNSW_DEFAULT_EF_CONSTRUCTION}). */
  hnswEfConstruction?: number
  /**
   * Floor for `hnsw.ef_search`. Raised per query to at least the requested
   * limit — see {@link efSearchFor}. Defaults to pgvector's own 40.
   */
  efSearch?: number
  /** Max pooled connections (default 10 — node-postgres's own default). */
  maxConnections?: number
}

/** Lazy import so the driver is only loaded by deployments that use it. */
async function loadPg(): Promise<any> {
  try {
    return await import('pg')
  } catch (err) {
    throw new Error(
      `[postgres] the 'pg' driver is required for the Postgres backend but could not be loaded: `
      + `${(err as Error).message}. Install it with 'npm install pg'.`,
    )
  }
}

/** Strip credentials from a DSN so it is safe to log. */
export function redactDsn(dsn: string): string {
  try {
    const u = new URL(dsn)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    // Not URL-shaped (key=value libpq form). Redact any password= token.
    return dsn.replace(/password=([^\s]+)/gi, 'password=***')
  }
}

function assertIdentifier(name: string, what: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`[postgres] refusing to use ${what} "${name}": not a plain SQL identifier`)
  }
  return name
}

function assertPositiveInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[postgres] ${what} must be a positive integer, got ${value}`)
  }
  return value
}

export class PostgresAdapter implements StorageAdapter, AsyncPrimaryStore {
  /**
   * The store of record, not a copy of one. `requiresIndexSync()` reads this
   * and answers false: a write already landed in the engine that answers
   * queries, so there is no delta to catch up on and no `syncFromYaml()` to
   * call.
   */
  readonly role = 'primary' as const
  readonly kind: PrimaryStoreKind = 'postgres'

  private readonly connectionString: string
  private readonly schema: string
  private readonly vectorDim: number
  private readonly precision: VectorElementFormat | undefined
  private readonly indexMode: PostgresVectorIndexMode
  private readonly hnswM: number
  private readonly hnswEfConstruction: number
  private readonly efSearch: number
  private readonly maxConnections: number

  private pool: any = null
  private initPromise: Promise<void> | null = null
  /** Actual element type of the embedding column after init. */
  private activeVecType: 'vector' | 'halfvec' = 'vector'
  /** Actual dim of the embedding column after init; writes are checked against reality. */
  private activeVecDim: number | null = null
  /** Whether an HNSW index exists after init — what `vectorIndex` reports. */
  private hnswActive = false
  private closed = false

  constructor(opts: PostgresAdapterOptions) {
    if (!opts.connectionString) {
      throw new Error('[postgres] connectionString is required')
    }
    this.connectionString = opts.connectionString
    this.schema = assertIdentifier(opts.schema ?? DEFAULT_POSTGRES_SCHEMA, 'schema')
    this.vectorDim = assertPositiveInt(opts.vectorDim ?? DEFAULT_VECTOR_DIM, 'vectorDim')
    this.precision = opts.precision
    this.indexMode = opts.vectorIndex ?? 'auto'
    this.hnswM = assertPositiveInt(opts.hnswM ?? HNSW_DEFAULT_M, 'hnswM')
    this.hnswEfConstruction = assertPositiveInt(
      opts.hnswEfConstruction ?? HNSW_DEFAULT_EF_CONSTRUCTION, 'hnswEfConstruction',
    )
    this.efSearch = assertPositiveInt(opts.efSearch ?? PGVECTOR_DEFAULT_EF_SEARCH, 'efSearch')
    this.maxConnections = assertPositiveInt(opts.maxConnections ?? 10, 'maxConnections')
  }

  /** Credential-free DSN — safe to log, safe to put in `status()`. */
  get location(): string {
    return redactDsn(this.connectionString)
  }

  /**
   * What this adapter's `searchVector()` actually does, right now.
   *
   * A getter, not a constant: whether HNSW is active is decided at init from
   * the store's real row count (`vectorIndex: 'auto'`), and the element format
   * comes from the column that actually exists. Reporting the requested
   * configuration instead of the resolved one would defeat the purpose.
   */
  get vectorIndex(): VectorIndexStrategy {
    const format: VectorElementFormat = this.activeVecType === 'halfvec' ? 'halfvec' : 'float32'
    if (!this.hnswActive) {
      return { ...EXACT_VECTOR_INDEX, format }
    }
    return {
      kind: 'hnsw',
      exact: false,
      recallTarget: HNSW_RECALL_TARGET,
      format,
      params: {
        m: this.hnswM,
        efConstruction: this.hnswEfConstruction,
        efSearch: this.efSearch,
      },
    }
  }

  /**
   * `hnsw.ef_search` this adapter would use for a given limit. Exposed so the
   * guarantee "never below the requested limit" is directly testable rather
   * than inferred from query behaviour.
   */
  efSearchForLimit(limit: number): number {
    return efSearchFor(limit, this.efSearch)
  }

  // ---------------------------------------------------------------- lifecycle

  private async getPool(): Promise<any> {
    if (this.closed) throw new Error('[postgres] adapter is closed')
    if (!this.pool) {
      const pg = await loadPg()
      const Pool = pg.Pool ?? pg.default?.Pool
      if (!Pool) throw new Error("[postgres] 'pg' loaded but exposes no Pool export")
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: this.maxConnections,
      })
      // No `search_path` is set, deliberately. Every statement this adapter
      // issues fully qualifies its tables, and the `vector` extension is
      // installed into `public` — which is on the default path — so the type
      // and its operators resolve without one. The alternative (a `SET
      // search_path` fired from the pool's `connect` event) is not awaited by
      // node-postgres, so the first query on a fresh connection can race ahead
      // of it and read the wrong schema. Correct-by-construction beats a
      // convenience that is right most of the time.
      //
      // An idle-client error must not become an unhandled rejection that takes
      // the process down; the pool discards the client and the next query gets
      // a fresh one.
      this.pool.on('error', (err: unknown) => {
        logger.warning(`[postgres] idle client error: ${(err as Error).message}`)
      })
    }
    if (!this.initPromise) {
      this.initPromise = this.initSchema().catch((err: unknown) => {
        // Let the next call retry rather than caching a failed init forever.
        this.initPromise = null
        throw err
      })
    }
    await this.initPromise
    return this.pool
  }

  private async initSchema(): Promise<void> {
    const pool = this.pool
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`)
    // Extensions are per-database. Installing into `public` (the conventional
    // home) keeps one copy shared by every PLUR schema in the database; the
    // search_path above is what makes the type resolvable from ours.
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public')
    } catch (err) {
      throw new Error(
        `[postgres] pgvector is required but could not be enabled: ${(err as Error).message}. `
        + `Install the extension (CREATE EXTENSION vector) as a superuser, or grant the PLUR role rights to create it.`,
      )
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${this.schema}".engrams (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        scope TEXT NOT NULL,
        domain TEXT,
        last_accessed TEXT,
        data JSONB NOT NULL,
        source TEXT NOT NULL DEFAULT 'primary'
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_engrams_status ON "${this.schema}".engrams(status)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_engrams_scope ON "${this.schema}".engrams(scope)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_engrams_domain ON "${this.schema}".engrams(domain)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_engrams_source ON "${this.schema}".engrams(source)`)

    const wantType = this.precision === 'halfvec' ? 'halfvec' : 'vector'
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${this.schema}".engram_embeddings (
        engram_id TEXT PRIMARY KEY REFERENCES "${this.schema}".engrams(id) ON DELETE CASCADE,
        embedding ${wantType}(${this.vectorDim}) NOT NULL
      )
    `)
    await this.readEmbeddingColumnInfo()
    await this.ensureVectorIndex()
  }

  /** Read the actual type + dim of the embedding column from the catalog. */
  private async readEmbeddingColumnInfo(): Promise<{ type: 'vector' | 'halfvec'; dim: number } | null> {
    const res = await this.pool.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'engram_embeddings'
         AND a.attname = 'embedding' AND a.attnum > 0`,
      [this.schema],
    )
    if (res.rows.length === 0) return null
    const m = String(res.rows[0].t).match(/^(vector|halfvec)\((\d+)\)$/i)
    if (!m) return null
    const info = { type: m[1].toLowerCase() as 'vector' | 'halfvec', dim: Number(m[2]) }
    this.activeVecType = info.type
    this.activeVecDim = info.dim
    return info
  }

  /**
   * Decide and materialise the vector index.
   *
   * `auto` looks at the store's real row count: below {@link HNSW_MIN_ROWS} an
   * exact scan is faster AND lossless, so building an approximate index would
   * spend recall on nothing. At or above it, build.
   *
   * `hnswActive` is set from what the catalog actually contains afterwards, not
   * from what we asked for — `vectorIndex` must not claim HNSW if the CREATE
   * failed.
   */
  private async ensureVectorIndex(): Promise<void> {
    let want: boolean
    if (this.indexMode === 'exact') {
      want = false
    } else if (this.indexMode === 'hnsw') {
      want = true
    } else {
      const res = await this.pool.query(`SELECT COUNT(*)::int AS c FROM "${this.schema}".engram_embeddings`)
      want = Number(res.rows[0].c) >= HNSW_MIN_ROWS
    }
    if (want) {
      const opclass = this.activeVecType === 'halfvec' ? 'halfvec_cosine_ops' : 'vector_cosine_ops'
      try {
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS ${HNSW_INDEX_NAME}
           ON "${this.schema}".engram_embeddings
           USING hnsw (embedding ${opclass})
           WITH (m = ${this.hnswM}, ef_construction = ${this.hnswEfConstruction})`,
        )
      } catch (err) {
        // Non-fatal: an exact scan still answers correctly, just slower. Loud,
        // because "silently exact at 500k rows" is a performance cliff someone
        // needs to know about.
        logger.warning(
          `[postgres] HNSW index creation failed (falling back to exact scan): ${(err as Error).message}`,
        )
      }
    }
    this.hnswActive = await this.hnswIndexExists()
  }

  private async hnswIndexExists(): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_am am ON am.oid = i.relam
       WHERE n.nspname = $1 AND t.relname = 'engram_embeddings' AND am.amname = 'hnsw'
       LIMIT 1`,
      [this.schema],
    )
    return res.rows.length > 0
  }

  /**
   * Re-evaluate `vectorIndex: 'auto'` against the current row count and build
   * the HNSW index if the store has since crossed {@link HNSW_MIN_ROWS}.
   *
   * Not automatic on every write: index creation is expensive and a write path
   * that might spend minutes building a graph is a worse surprise than a scan
   * that stays exact a bit longer. A deployment calls this after a bulk load.
   */
  async refreshVectorIndex(): Promise<VectorIndexStrategy> {
    await this.getPool()
    await this.ensureVectorIndex()
    return this.vectorIndex
  }

  async close(): Promise<void> {
    if (this.pool) {
      const pool = this.pool
      this.pool = null
      this.initPromise = null
      this.closed = true
      await pool.end().catch(() => { /* pool already torn down */ })
    }
    this.closed = true
  }

  // ------------------------------------------------------- AsyncPrimaryStore

  async load(): Promise<Engram[]> {
    const pool = await this.getPool()
    const res = await pool.query(`SELECT data FROM "${this.schema}".engrams ORDER BY id`)
    return res.rows.map((r: any) => parseRow(r))
  }

  /**
   * Delegates to `load()`, deliberately.
   *
   * `YamlPrimaryStore` can cache because a file has an mtime it can prove is
   * unchanged. A shared Postgres has no equivalent that is both cheap and
   * honest — any other process may have written since. In the multi-writer
   * deployment this adapter exists for, serving a snapshot we cannot prove is
   * current is a correctness bug wearing a performance costume.
   */
  async loadCached(): Promise<Engram[]> {
    return this.load()
  }

  /**
   * Replace the store's contents with `engrams`.
   *
   * Upsert-then-prune rather than truncate-then-insert, for one specific
   * reason: `engram_embeddings` cascades on delete, so deleting every engram
   * row would destroy every embedding and force a full re-embed of an unchanged
   * corpus. Upserting leaves surviving engrams' embeddings in place and lets
   * the cascade remove exactly the ones whose engram genuinely went away.
   *
   * Atomic: one transaction, so a concurrent reader sees the old corpus or the
   * new one, never a half-applied replace.
   */
  async save(engrams: Engram[]): Promise<void> {
    const pool = await this.getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < engrams.length; i += SAVE_CHUNK_SIZE) {
        const chunk = engrams.slice(i, i + SAVE_CHUNK_SIZE)
        await client.query(
          `INSERT INTO "${this.schema}".engrams (id, status, scope, domain, last_accessed, data, source)
           SELECT t.id, t.status, t.scope, t.domain, t.last_accessed, t.data, 'primary'
           FROM jsonb_to_recordset($1::jsonb)
             AS t(id text, status text, scope text, domain text, last_accessed text, data jsonb)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             scope = EXCLUDED.scope,
             domain = EXCLUDED.domain,
             last_accessed = EXCLUDED.last_accessed,
             data = EXCLUDED.data,
             source = EXCLUDED.source`,
          [JSON.stringify(chunk.map(toRow))],
        )
      }
      const ids = engrams.map(e => e.id)
      if (ids.length > 0) {
        await client.query(
          `DELETE FROM "${this.schema}".engrams
           WHERE id NOT IN (SELECT jsonb_array_elements_text($1::jsonb))`,
          [JSON.stringify(ids)],
        )
      } else {
        await client.query(`DELETE FROM "${this.schema}".engrams`)
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already broken */ })
      throw err
    } finally {
      client.release()
    }
  }

  /** No read cache to drop — `loadCached()` always goes to the server. */
  invalidate(): void {
    // Intentionally empty. See loadCached().
  }

  // ----------------------------------------------------------- StorageAdapter

  async loadFiltered(filter: StorageFilter): Promise<Engram[]> {
    const pool = await this.getPool()
    const { where, params } = buildFilterClause(filter)
    const res = await pool.query(`SELECT data FROM "${this.schema}".engrams ${where}`, params)
    return res.rows.map((r: any) => parseRow(r))
  }

  async count(filter?: { status?: string }): Promise<number> {
    const pool = await this.getPool()
    if (filter?.status) {
      const res = await pool.query(
        `SELECT COUNT(*)::int AS c FROM "${this.schema}".engrams WHERE status = $1`, [filter.status],
      )
      return Number(res.rows[0].c)
    }
    const res = await pool.query(`SELECT COUNT(*)::int AS c FROM "${this.schema}".engrams`)
    return Number(res.rows[0].c)
  }

  /**
   * BM25 over the active set, scored in `fts.ts`.
   *
   * Same shape as the PGLite adapter on purpose: one tokenizer and one IDF
   * computation across every backend, so BM25 ranking cannot drift between
   * tiers. Pushing BM25 into Postgres is convergence Phase 4 and is
   * deliberately not attempted here — a second ranking authority is exactly the
   * kind of silent divergence this programme exists to remove.
   */
  async searchBM25(query: string, opts: { limit: number }): Promise<Engram[]> {
    const candidates = await this.loadFiltered({ status: 'active' })
    return searchEngrams(candidates, query, opts.limit)
  }

  /**
   * Cosine vector search over active engrams.
   *
   * The `SET LOCAL hnsw.ef_search` is the load-bearing line. pgvector defaults
   * it to 40; an HNSW scan visits at most that many candidates, so without this
   * a `limit` above 40 comes back short — and the `status = 'active'` join
   * predicate, which the index cannot evaluate, trims the result further after
   * the scan. {@link efSearchFor} covers both: never below `limit`, with
   * headroom for the post-filter.
   *
   * `SET LOCAL` scopes the setting to the transaction, so a pooled connection
   * is never left with another query's tuning on it.
   */
  async searchVector(query: Float32Array, limit: number): Promise<VectorSearchHit[]> {
    const pool = await this.getPool()
    const t = this.activeVecType
    const literal = vectorLiteral(query)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (this.hnswActive) {
        await client.query(`SET LOCAL hnsw.ef_search = ${this.efSearchForLimit(limit)}`)
      }
      const res = await client.query(
        `SELECT e.data, 1 - (em.embedding <=> $1::${t}) AS score
         FROM "${this.schema}".engram_embeddings em
         JOIN "${this.schema}".engrams e ON e.id = em.engram_id
         WHERE e.status = 'active'
         ORDER BY em.embedding <=> $1::${t}
         LIMIT $2`,
        [literal, limit],
      )
      await client.query('COMMIT')
      return res.rows.map((r: any) => ({ engram: parseRow(r), score: Number(r.score) }))
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection already broken */ })
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Store one embedding.
   *
   * The dim check is a storage-boundary contract (#335): a wrong-shape vector
   * must never be persisted, and the message names the real cause — the active
   * embedder and the store disagree — rather than surfacing pgvector's own
   * error.
   */
  async upsertEmbedding(engramId: string, vector: Float32Array): Promise<void> {
    const pool = await this.getPool()
    const expectedDim = this.activeVecDim ?? this.vectorDim
    if (vector.length !== expectedDim) {
      throw new Error(
        `[postgres] Refusing to persist a ${vector.length}-dim embedding for "${engramId}": `
        + `this store's embedding column is ${expectedDim}-dim (#335). `
        + `The active embedder (PLUR_EMBEDDER) and the store must agree.`,
      )
    }
    await pool.query(
      `INSERT INTO "${this.schema}".engram_embeddings (engram_id, embedding)
       VALUES ($1, $2::${this.activeVecType})
       ON CONFLICT (engram_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [engramId, vectorLiteral(vector)],
    )
  }

  // ------------------------------------------------------------- diagnostics

  /** True when `engramId` already has an embedding. */
  async hasEmbedding(engramId: string): Promise<boolean> {
    const pool = await this.getPool()
    const res = await pool.query(
      `SELECT 1 FROM "${this.schema}".engram_embeddings WHERE engram_id = $1 LIMIT 1`, [engramId],
    )
    return res.rows.length > 0
  }

  /** Rows in `engram_embeddings`. */
  async countEmbeddings(): Promise<number> {
    const pool = await this.getPool()
    const res = await pool.query(`SELECT COUNT(*)::int AS c FROM "${this.schema}".engram_embeddings`)
    return Number(res.rows[0].c)
  }

  /** Actual element type of the embedding column. */
  async getVectorColumnType(): Promise<'vector' | 'halfvec' | null> {
    await this.getPool()
    const info = await this.readEmbeddingColumnInfo()
    return info?.type ?? null
  }

  /** Actual dim of the embedding column. */
  async getVectorColumnDim(): Promise<number | null> {
    await this.getPool()
    const info = await this.readEmbeddingColumnInfo()
    return info?.dim ?? null
  }

  /**
   * Drop this adapter's schema. Test/teardown helper — destructive by design,
   * and scoped to the schema the adapter owns so it cannot take out a
   * neighbouring deployment sharing the database.
   */
  async dropSchema(): Promise<void> {
    if (this.closed) throw new Error('[postgres] adapter is closed')
    if (!this.pool) {
      // Open a pool without running initSchema — dropping does not need it.
      const pg = await loadPg()
      const Pool = pg.Pool ?? pg.default?.Pool
      this.pool = new Pool({ connectionString: this.connectionString, max: 1 })
    }
    await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`)
    this.initPromise = null
  }
}

/**
 * Filter → SQL WHERE clause.
 *
 * Lifted verbatim from `PGLiteAdapter.buildFilterClause` so the two backends
 * cannot answer the same filter differently — in particular the two scope
 * rules, which are the ones with teeth:
 *
 *   (1) personal-family pass-through — ALL non-shared scopes (`local`,
 *       `global`, `user:*`, `agent:*`, …), not just `global` (#402).
 *   (2) segment-aware membership (#383) — the requested scope exactly, or a
 *       descendant on a REAL delimiter (`:` / `/`), never a sibling that merely
 *       shares a string prefix.
 *
 * The two copies must move together until the shared extraction lands; the
 * cross-adapter parity test is what enforces that.
 */
export function buildFilterClause(filter: StorageFilter): { where: string; params: any[] } {
  const conditions: string[] = []
  const params: any[] = []
  let i = 1
  if (filter.status) {
    conditions.push(`status = $${i++}`)
    params.push(filter.status)
  }
  if (filter.scope) {
    conditions.push(
      `((NOT (scope LIKE 'group:%' OR scope LIKE 'project:%' OR scope LIKE 'space:%' OR scope LIKE 'team:%' OR scope LIKE 'org:%' OR scope = 'public' OR scope LIKE 'public:%' OR scope LIKE 'public/%'))`
      + ` OR scope = $${i++} OR scope LIKE $${i++} || ':%' OR scope LIKE $${i++} || '/%')`,
    )
    params.push(filter.scope, filter.scope, filter.scope)
  }
  if (filter.domain) {
    conditions.push(`domain LIKE $${i++} || '%'`)
    params.push(filter.domain)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { where, params }
}

/** node-postgres returns JSONB already parsed; tolerate a string anyway. */
function parseRow(row: { data: any }): Engram {
  return typeof row.data === 'string' ? JSON.parse(row.data) : row.data
}

function toRow(e: Engram): Record<string, unknown> {
  return {
    id: e.id,
    status: e.status,
    scope: e.scope,
    domain: e.domain ?? null,
    last_accessed: e.activation?.last_accessed ?? null,
    data: e,
  }
}

/** pgvector text format: `[0.1,0.2,0.3]`. NaN/Infinity are not accepted by pgvector. */
function vectorLiteral(v: Float32Array): string {
  const parts: string[] = []
  for (let i = 0; i < v.length; i++) {
    const n = v[i]
    parts.push(Number.isFinite(n) ? String(n) : '0')
  }
  return '[' + parts.join(',') + ']'
}
