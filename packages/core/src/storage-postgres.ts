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
import { searchEngrams, ftsTokenize, engramSearchText, type CorpusStats } from './fts.js'
import { logger } from './logger.js'
import {
  EXACT_VECTOR_INDEX,
  PGVECTOR_DEFAULT_EF_SEARCH,
  efSearchFor,
  type StorageAdapter,
  type StorageFilter,
  type ScopeRestriction,
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
  /**
   * Whether pg_trgm is installed, decided once at schema setup.
   *
   * `undefined` means schema setup has not run yet, which is distinct from
   * "checked and absent" — a query must not read this as "no pushdown" before
   * the answer exists.
   */
  private trigramAvailable: boolean | undefined
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

    // --- BM25 pushdown (Phase 4, #711) ---
    //
    // Two columns, because the matching rule has two arms and they need
    // different indexes:
    //
    //   forward  t.includes(qt)   -> `search_text LIKE '%qt%'`, served by a GIN
    //                               trigram index. This is the arm that finds
    //                               `transferWithAuthorization` from `auth`, and
    //                               it is why this needs pg_trgm rather than
    //                               tsvector: a prefix query cannot express an
    //                               infix match.
    //   reverse  qt.startsWith(t) -> `tokens && ARRAY[<prefixes of qt>]`, served
    //                               by a GIN array index. The prefixes are
    //                               enumerable at query time because qt is
    //                               known, which is exactly what #721's change
    //                               from `qt.includes(t)` bought.
    await pool.query(`ALTER TABLE "${this.schema}".engrams ADD COLUMN IF NOT EXISTS tokens TEXT[]`)
    await pool.query(`ALTER TABLE "${this.schema}".engrams ADD COLUMN IF NOT EXISTS search_text TEXT`)
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public')
      this.trigramAvailable = true
    } catch (err) {
      // Not fatal: without pg_trgm the adapter falls back to loading candidates
      // and scoring in core, which is what it did before this phase. Say so
      // once, loudly, rather than let a deployment silently lose the pushdown
      // and wonder why recall got slow.
      this.trigramAvailable = false
      logger.warning(
        `[postgres] pg_trgm is unavailable (${(err as Error).message}). BM25 narrowing will not be pushed `
        + `into the database; queries will load candidates and score in core. Install the extension to enable it.`,
      )
    }
    if (this.trigramAvailable) {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_engrams_search_trgm
         ON "${this.schema}".engrams USING GIN (search_text gin_trgm_ops)`,
      )
    }
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_engrams_tokens ON "${this.schema}".engrams USING GIN (tokens)`,
    )

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
          `INSERT INTO "${this.schema}".engrams (id, status, scope, domain, last_accessed, data, source, tokens, search_text)
           SELECT t.id, t.status, t.scope, t.domain, t.last_accessed, t.data, 'primary', t.tokens, t.search_text
           FROM jsonb_to_recordset($1::jsonb)
             AS t(id text, status text, scope text, domain text, last_accessed text, data jsonb,
                  tokens text[], search_text text)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             scope = EXCLUDED.scope,
             domain = EXCLUDED.domain,
             last_accessed = EXCLUDED.last_accessed,
             data = EXCLUDED.data,
             source = EXCLUDED.source,
             tokens = EXCLUDED.tokens,
             search_text = EXCLUDED.search_text`,
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
  /**
   * Escape a query token for use inside a `LIKE` pattern.
   *
   * `ftsTokenize` splits on non-`\w`, and `_` IS a `\w` character, so it
   * survives tokenization and arrives here as LIKE's single-character wildcard.
   * Unescaped, the token `snake_case` matches `snakeXcase` — verified: in
   * Postgres, `'snakeXcase' LIKE '%snake_case%'` is true. Worse, `_` can match
   * the space that separates two tokens in `search_text`, so the predicate
   * matches across a token boundary, which `termMatches` never does.
   *
   * That makes `df` count under a different rule than `tf`, which is not BM25
   * and which nothing would report. `%` cannot survive tokenization today, but
   * it is escaped anyway so this does not depend on that staying true.
   */
  private static escapeLike(qt: string): string {
    return qt.replace(/[\\%_]/g, c => `\\${c}`)
  }

  /**
   * Prefixes of a query token that could legally match a document token under
   * the reverse arm (`qt.startsWith(t)`).
   *
   * Bounded below by 3 because `ftsTokenize` discards anything shorter, so no
   * stored token can be 1 or 2 characters and testing for them would be dead
   * work. `qt` itself is included — a token equal to the query is a prefix of
   * it, and that is the exact-match case.
   */
  private static reversePrefixes(qt: string): string[] {
    const out: string[] = []
    for (let n = 3; n <= qt.length; n++) out.push(qt.slice(0, n))
    return out
  }

  /**
   * Corpus-wide N and per-term df (Phase 4, #711).
   *
   * Counted under exactly `termMatches` from fts.ts, expressed as SQL:
   *
   *   forward  t.includes(qt)    ->  search_text LIKE '%' || qt || '%'
   *   reverse  qt.startsWith(t)  ->  tokens && ARRAY[<prefixes of qt>]
   *
   * The equivalence of the first line holds because `search_text` is the
   * tokens joined by a space and a query token can never contain a space —
   * `ftsTokenize` splits on it. So a substring hit in the joined string implies
   * a substring hit in some token, and conversely.
   *
   * Returns `undefined` rather than an approximation when the pushdown cannot
   * be answered exactly. Per the interface contract, an approximate df is worse
   * than the local fallback.
   */
  async corpusStats(queryTokens: string[], opts?: ScopeRestriction): Promise<CorpusStats> {
    const pool = await this.getPool()
    if (queryTokens.length === 0) {
      // Still honours `scopes`: an empty token list is "no query terms", not
      // "no restriction". Counting the whole corpus here would report a corpus
      // size the caller is not permitted to see — including for `scopes: []`,
      // which must yield 0.
      const p0: unknown[] = []
      let clause0 = ''
      if (opts?.scopes !== undefined) {
        p0.push(opts.scopes)
        clause0 = ` AND scope = ANY($${p0.length}::text[])`
      }
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n, COALESCE(AVG(COALESCE(array_length(tokens, 1), 0)), 0)::float8 AS avg_len
         FROM "${this.schema}".engrams WHERE status = 'active'${clause0}`,
        p0,
      )
      return { N: rows[0]?.n ?? 0, df: new Map(), avgDocLength: rows[0]?.avg_len ?? 0 }
    }

    // A row written before this column existed has NULL tokens and would count
    // as matching nothing, quietly deflating every df. Refuse rather than
    // report a number that is wrong in an invisible direction.
    const { rows: stale } = await pool.query(
      `SELECT count(*)::int AS n FROM "${this.schema}".engrams WHERE status = 'active' AND tokens IS NULL`,
    )
    if ((stale[0]?.n ?? 0) > 0) {
      throw new Error(
        `[postgres] ${stale[0].n} active engram(s) have no tokens column populated, so corpus statistics `
        + `would undercount document frequency. Re-save the store (PostgresAdapter.save) to backfill before `
        + `using BM25 pushdown.`,
      )
    }

    const params: unknown[] = []
    let scopeClause = ''
    if (opts?.scopes !== undefined) {
      params.push(opts.scopes)
      scopeClause = ` AND scope = ANY($${params.length}::text[])`
    }

    // N and avgdl together: BM25 needs both to be corpus-wide, and computing
    // them in one statement means they cannot describe different row sets.
    // `array_length` on an empty array is NULL, hence the inner COALESCE.
    const { rows: totals } = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(AVG(COALESCE(array_length(tokens, 1), 0)), 0)::float8 AS avg_len
       FROM "${this.schema}".engrams WHERE status = 'active'${scopeClause}`,
      params,
    )
    const N = totals[0]?.n ?? 0
    const avgDocLength = totals[0]?.avg_len ?? 0

    const df = new Map<string, number>()
    for (const qt of queryTokens) {
      const p = [...params]
      p.push(`%${PostgresAdapter.escapeLike(qt)}%`)
      const likeIdx = p.length
      p.push(PostgresAdapter.reversePrefixes(qt))
      const prefixIdx = p.length
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM "${this.schema}".engrams
         WHERE status = 'active'${scopeClause}
           AND (search_text LIKE $${likeIdx} ESCAPE '\\' OR tokens && $${prefixIdx}::text[])`,
        p,
      )
      df.set(qt, rows[0]?.n ?? 0)
    }
    return { N, df, avgDocLength }
  }

  /**
   * BM25 over Postgres.
   *
   * Narrows in the database when pg_trgm is present, then scores in core with
   * corpus-wide statistics so the narrowing cannot change the ranking — see
   * {@link StorageAdapter.corpusStats}. Falls back to loading the active set
   * and scoring locally when it is not, which is what this method did before
   * Phase 4.
   */
  async searchBM25(query: string, opts: { limit: number } & ScopeRestriction): Promise<Engram[]> {
    const queryTokens = ftsTokenize(query)
    if (queryTokens.length === 0) return []

    // Resolve the pool FIRST. `trigramAvailable` is only assigned inside
    // `initSchema`, which `getPool` drives; reading it beforehand on a freshly
    // constructed adapter sees `undefined` and sends the very first query of
    // every process down the fallback path — the one case where the difference
    // is invisible, because both paths return correct rows and only the plan
    // differs.
    const pool = await this.getPool()

    if (this.trigramAvailable !== true) {
      const candidates = await this.loadFiltered({ status: 'active', scopes: opts.scopes })
      return searchEngrams(candidates, query, opts.limit)
    }

    const params: unknown[] = []
    let scopeClause = ''
    if (opts.scopes !== undefined) {
      params.push(opts.scopes)
      scopeClause = ` AND scope = ANY($${params.length}::text[])`
    }
    const perToken: string[] = []
    for (const qt of queryTokens) {
      params.push(`%${PostgresAdapter.escapeLike(qt)}%`)
      const likeIdx = params.length
      params.push(PostgresAdapter.reversePrefixes(qt))
      const prefixIdx = params.length
      perToken.push(`(search_text LIKE $${likeIdx} ESCAPE '\\' OR tokens && $${prefixIdx}::text[])`)
    }

    // Deliberately unbounded by `limit`: the candidate set is every row that
    // could score above zero, because BM25 ranks them and a row cut here can
    // never be recovered. `limit` is applied after scoring, in core.
    const { rows } = await pool.query(
      `SELECT data FROM "${this.schema}".engrams
       WHERE status = 'active'${scopeClause} AND (${perToken.join(' OR ')})`,
      params,
    )
    const candidates = rows.map((r: { data: Engram }) => r.data)
    const stats = await this.corpusStats(queryTokens, { scopes: opts.scopes })
    return searchEngrams(candidates, query, opts.limit, stats)
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
  async searchVector(query: Float32Array, limit: number, opts?: ScopeRestriction): Promise<VectorSearchHit[]> {
    const pool = await this.getPool()
    const t = this.activeVecType
    const literal = vectorLiteral(query)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (this.hnswActive) {
        await client.query(`SET LOCAL hnsw.ef_search = ${this.efSearchForLimit(limit)}`)
      }
      // The scope restriction goes IN the k-NN predicate, never on the rows
      // that come back. Post-filtering measures LIMIT against the unrestricted
      // neighbour list, so a principal permitted a small share of the corpus
      // asks for N and silently gets far fewer, with permitted rows sitting
      // just below the cut.
      //
      // This method previously omitted the `opts` parameter entirely. TypeScript
      // accepts a narrower arity than the interface declares, so a caller
      // passing `scopes` compiled, ran, and got an unrestricted search with no
      // error — on an authorization filter.
      const params: unknown[] = [literal, limit]
      let scopeClause = ''
      if (opts?.scopes !== undefined) {
        params.push(opts.scopes)
        scopeClause = ` AND e.scope = ANY($${params.length}::text[])`
      }
      const res = await client.query(
        `SELECT e.data, 1 - (em.embedding <=> $1::${t}) AS score
         FROM "${this.schema}".engram_embeddings em
         JOIN "${this.schema}".engrams e ON e.id = em.engram_id
         WHERE e.status = 'active'${scopeClause}
         ORDER BY em.embedding <=> $1::${t}
         LIMIT $2`,
        params,
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
  if (filter.scopes !== undefined) {
    // Permitted-scope allow-list (Phase 3) — the AUTHORIZATION filter, distinct
    // from `filter.scope` below, which is a visibility filter with hierarchy
    // expansion and personal-family pass-through. This one is exact membership
    // and expands nothing: the caller has already resolved an identity to a
    // complete set of permitted scopes.
    //
    // The guard is `!== undefined`, NOT truthiness. An empty array is a
    // MEANINGFUL value — a principal with zero permitted scopes must see zero
    // engrams — and `scope = ANY('{}')` is false for every row, which is
    // exactly right. Testing `if (filter.scopes)` would let `[]` fall through
    // to no clause at all and return the whole corpus, which is the privilege
    // escalation this comment exists to prevent.
    //
    // This branch was MISSING here while present in PGLiteAdapter, so every
    // permitted-scope query against Postgres silently returned every scope.
    // The docstring above claimed the two were lifted from each other; they had
    // diverged, and no test compared them.
    conditions.push(`scope = ANY($${i++}::text[])`)
    params.push(filter.scopes)
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
  // Tokens are computed HERE, in TypeScript, with the same `ftsTokenize` the
  // scorer uses — not by a Postgres text-search configuration.
  //
  // That is the whole reason the pushdown can claim exactness. `corpusStats`
  // has to count `df` under precisely the rule `ftsScore` counts `tf` under; a
  // SQL-side tokenizer would be a second implementation of stop-words, the
  // length floor, and the non-word split, free to drift from this one with
  // nothing to report the drift. Deriving the tokens once, on write, makes the
  // two impossible to disagree.
  const tokens = ftsTokenize(engramSearchText(e))
  return {
    id: e.id,
    status: e.status,
    scope: e.scope,
    domain: e.domain ?? null,
    last_accessed: e.activation?.last_accessed ?? null,
    data: e,
    tokens,
    // Joined form for the trigram index. `t.includes(qt)` at token level is
    // equivalent to a substring test over this string because query tokens
    // never contain the separator — `ftsTokenize` splits on it.
    search_text: tokens.join(' '),
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
