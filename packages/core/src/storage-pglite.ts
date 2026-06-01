/**
 * PGLiteAdapter — PGLite-backed storage adapter (ADR-0001, Sprint 0 PR 2).
 *
 * Substrate: PGLite (WASM Postgres) + pgvector + Apache AGE. YAML on disk is
 * the source of truth; this adapter is a rebuildable index.
 *
 * Write order (invariant):
 *   1. caller writes YAML
 *   2. caller calls syncFromYaml() to mirror into PGLite
 * If step 2 fails, YAML still wins on next `plur sync`.
 *
 * Vector storage: when pgvector loads cleanly, we use a `vector(N)` column
 * with a cosine-similarity ORDER BY. When pgvector isn't available (rare —
 * the extension ships in PGLite as of 0.4.x), we fall back to BYTEA storage
 * and compute cosine in TypeScript. Same external behavior either way.
 *
 * Concurrency: PGLite is single-writer per process. We serialize through a
 * lightweight async mutex on this adapter so concurrent `reindex()` /
 * `upsertEmbedding()` calls from the same process see a consistent final
 * state.
 *
 * Graph (AGE / Cypher): loaded if available; the engram graph schema lands
 * in a future PR. We initialize the extension so it's ready for #200, but
 * the public adapter surface in this PR is relational + vector.
 */
import { existsSync } from 'fs'
import type { Engram } from './schemas/engram.js'
import { loadEngrams } from './engrams.js'
import { searchEngrams } from './fts.js'
import { logger } from './logger.js'
import type { StorageAdapter, StorageFilter, VectorSearchHit } from './storage-adapter.js'
import type { EmbedderAdapter } from './embedders/types.js'

/**
 * Default vector dimension when no PLUR_EMBEDDER is set. Matches the dim of
 * the default embedder (bge-small, 384d). EmbeddingGemma was briefly the
 * default (PR 5 / #219 — 768d) but iter-2 audit B-2 reverted the default to
 * bge-small pending Phase C evidence. Construction-time overrides via
 * PGLiteAdapterOptions.vectorDim take precedence — the integration path in
 * index.ts always passes the active adapter.dim so this default is only the
 * bare-PGLite-adapter fallback.
 */
const DEFAULT_VECTOR_DIM = 384

/**
 * Test-only embedder override. Set via `_setEmbedderForTests()` so reembed
 * migration tests can inject a deterministic fake embedder without loading a
 * real ONNX model. Null means "use the real active embedder".
 */
let testEmbedder: EmbedderAdapter | null = null

/** Test-only: inject a fake embedder for migration tests. */
export function _setEmbedderForTests(adapter: EmbedderAdapter | null): void {
  testEmbedder = adapter
}

/** Minimal async mutex — serializes writes inside the adapter. */
class AsyncMutex {
  private queue: Promise<void> = Promise.resolve()
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void
    const wait = new Promise<void>((res) => { release = res })
    const prev = this.queue
    this.queue = wait
    await prev
    try {
      return await fn()
    } finally {
      release!()
    }
  }
}

/** Lazy import wrapper so the PGLite WASM bundle only loads when needed. */
async function loadPglite(): Promise<any> {
  const mod = await import('@electric-sql/pglite')
  return mod.PGlite
}

async function loadPgliteVector(): Promise<unknown | null> {
  try {
    const mod = await import('@electric-sql/pglite/vector')
    return (mod as { vector: unknown }).vector
  } catch (err) {
    logger.debug(`[pglite] vector extension unavailable: ${(err as Error).message}`)
    return null
  }
}

async function loadPgliteAge(): Promise<unknown | null> {
  try {
    const mod = await import('@electric-sql/pglite/age')
    return (mod as { age: unknown }).age
  } catch (err) {
    logger.debug(`[pglite] AGE extension unavailable: ${(err as Error).message}`)
    return null
  }
}

export interface PGLiteAdapterOptions {
  /**
   * Vector dimension for the embedding column. Default: 384 (matches the
   * v0.10 default embedder bge-small per iter-2 audit B-2 revert). The
   * integration path in `Plur` always passes the active embedder's dim
   * explicitly, so this default only applies to bare-adapter usage in tests.
   */
  vectorDim?: number
}

export class PGLiteAdapter implements StorageAdapter {
  private yamlPath: string
  private dbPath: string
  private vectorDim: number
  private db: any = null
  private initialized = false
  private hasVector = false
  private hasAge = false
  private mutex = new AsyncMutex()

  constructor(yamlPath: string, dbPath: string, opts?: PGLiteAdapterOptions) {
    this.yamlPath = yamlPath
    this.dbPath = dbPath
    this.vectorDim = opts?.vectorDim ?? DEFAULT_VECTOR_DIM
  }

  /** Open the PGLite DB and create schema if needed. */
  private async getDb(): Promise<any> {
    if (this.db && this.initialized) return this.db
    if (!this.db) {
      const PGlite = await loadPglite()
      const extensions: Record<string, unknown> = {}
      const vector = await loadPgliteVector()
      if (vector) extensions.vector = vector
      const age = await loadPgliteAge()
      if (age) extensions.age = age
      // PGLite persists to a filesystem directory when given a path; falls
      // back to in-memory when called with no path.
      this.db = new PGlite(`file://${this.dbPath}`, { extensions })
      await this.db.waitReady
      this.hasVector = !!vector
      this.hasAge = !!age
    }
    if (!this.initialized) {
      await this.initSchema()
      this.initialized = true
    }
    return this.db
  }

  private async initSchema(): Promise<void> {
    const db = this.db
    if (this.hasVector) {
      try {
        await db.exec('CREATE EXTENSION IF NOT EXISTS vector')
      } catch (err) {
        logger.debug(`[pglite] CREATE EXTENSION vector failed: ${(err as Error).message}`)
        this.hasVector = false
      }
    }
    if (this.hasAge) {
      try {
        await db.exec('CREATE EXTENSION IF NOT EXISTS age')
        await db.exec("LOAD 'age'")
        await db.exec('SET search_path = ag_catalog, public')
      } catch (err) {
        logger.debug(`[pglite] AGE init failed: ${(err as Error).message}`)
        this.hasAge = false
      }
    }
    // Engram table: mirrors YAML rows for fast filtered reads.
    // The `data` JSONB column holds the full engram body; the other columns
    // index the hot filter paths (status / scope / domain).
    await db.exec(`
      CREATE TABLE IF NOT EXISTS engrams (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        scope TEXT NOT NULL,
        domain TEXT,
        last_accessed TEXT,
        data JSONB NOT NULL,
        source TEXT NOT NULL DEFAULT 'primary'
      );
      CREATE INDEX IF NOT EXISTS idx_engrams_status ON engrams(status);
      CREATE INDEX IF NOT EXISTS idx_engrams_scope ON engrams(scope);
      CREATE INDEX IF NOT EXISTS idx_engrams_domain ON engrams(domain);
      CREATE INDEX IF NOT EXISTS idx_engrams_source ON engrams(source);
    `)
    // Embedding table: separate so adding/replacing embeddings is cheap and
    // doesn't churn engram rows. Use vector when available, BYTEA fallback.
    if (this.hasVector) {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS engram_embeddings (
          engram_id TEXT PRIMARY KEY,
          embedding vector(${this.vectorDim}) NOT NULL
        );
      `)
      // HNSW approximate-cosine index. Without this, pgvector falls back
      // to sequential scan (O(N) per query) which makes recall on a 30k+
      // engram store catastrophically slow. Discovered during Q2 Run A
      // — the unindexed scan on real LongMemEval-S (30k engrams + 500
      // queries) ran for 28h without producing results.
      //
      // m=16, ef_construction=64 are pgvector defaults. Index build cost
      // is one-time and amortised across many queries. ef_search (query
      // time) stays at the default 40 — bump to 200 if recall regresses.
      try {
        await db.exec(`
          CREATE INDEX IF NOT EXISTS engram_embeddings_hnsw_cosine
          ON engram_embeddings
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
        `)
      } catch (err) {
        logger.warning(`[pglite] HNSW index creation failed: ${(err as Error).message}. Falling back to sequential scan — vector recall will be slow on large stores.`)
      }
    } else {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS engram_embeddings (
          engram_id TEXT PRIMARY KEY,
          embedding BYTEA NOT NULL
        );
      `)
    }
    // AGE engram graph (#200 lands the actual edges; we just create the
    // graph here so the schema is ready).
    if (this.hasAge) {
      try {
        const exists = await db.query("SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'engram_graph'")
        if (exists.rows.length === 0) {
          await db.exec("SELECT create_graph('engram_graph')")
        }
      } catch (err) {
        logger.debug(`[pglite] AGE graph init skipped: ${(err as Error).message}`)
      }
    }
  }

  /** Apply a filter to a SELECT query. */
  private buildFilterClause(filter: StorageFilter): { where: string; params: any[] } {
    const conditions: string[] = []
    const params: any[] = []
    let i = 1
    if (filter.status) {
      conditions.push(`status = $${i++}`)
      params.push(filter.status)
    }
    if (filter.scope) {
      conditions.push(`(scope = 'global' OR scope = $${i++} OR scope LIKE $${i++} || '%')`)
      params.push(filter.scope, filter.scope)
    }
    if (filter.domain) {
      conditions.push(`domain LIKE $${i++} || '%'`)
      params.push(filter.domain)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return { where, params }
  }

  /** Parse a `data` row back to an Engram. PGLite returns JSONB as parsed JSON. */
  private parseRow(row: { data: any }): Engram {
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  }

  async loadFiltered(filter: StorageFilter): Promise<Engram[]> {
    const db = await this.getDb()
    const { where, params } = this.buildFilterClause(filter)
    const res = await db.query(`SELECT data FROM engrams ${where}`, params)
    return res.rows.map((r: any) => this.parseRow(r))
  }

  async count(filter?: { status?: string }): Promise<number> {
    const db = await this.getDb()
    if (filter?.status) {
      const res = await db.query('SELECT COUNT(*)::int as c FROM engrams WHERE status = $1', [filter.status])
      return Number(res.rows[0].c)
    }
    const res = await db.query('SELECT COUNT(*)::int as c FROM engrams')
    return Number(res.rows[0].c)
  }

  /**
   * Reindex: drop all engram rows and rebuild from YAML.
   * Idempotent. Embeddings table is left intact unless the caller wipes the
   * PGLite dir on disk (which is what nukeDerivedState in the rebuild test
   * does).
   */
  async reindex(): Promise<void> {
    return this.mutex.run(async () => {
      const db = await this.getDb()
      await db.exec('BEGIN')
      try {
        await db.exec('DELETE FROM engrams')
        await this.insertEngramsTx(db)
        await db.exec('COMMIT')
      } catch (err) {
        await db.exec('ROLLBACK').catch(() => {})
        throw err
      }
    })
  }

  /**
   * syncFromYaml: incremental — upsert what YAML says exists, delete
   * primary-source rows that YAML no longer contains.
   *
   * This is the steady-state write path called after every YAML mutation
   * (see Plur._syncIndex).
   */
  async syncFromYaml(): Promise<void> {
    return this.mutex.run(async () => {
      const db = await this.getDb()
      await db.exec('BEGIN')
      try {
        const ids = new Set<string>()
        if (existsSync(this.yamlPath)) {
          const engrams = loadEngrams(this.yamlPath)
          for (const e of engrams) {
            await this.upsertEngramTx(db, e, 'primary')
            ids.add(e.id)
          }
        }
        // Drop primary-source rows that no longer exist in YAML.
        if (ids.size > 0) {
          const idArr = Array.from(ids)
          // Use a JSONB array to avoid the parameterized-IN size limit.
          await db.query(
            `DELETE FROM engrams
             WHERE source = 'primary'
               AND id NOT IN (SELECT jsonb_array_elements_text($1::jsonb))`,
            [JSON.stringify(idArr)],
          )
        } else {
          await db.exec("DELETE FROM engrams WHERE source = 'primary'")
        }
        await db.exec('COMMIT')
      } catch (err) {
        await db.exec('ROLLBACK').catch(() => {})
        throw err
      }
    })
  }

  private async insertEngramsTx(db: any): Promise<void> {
    if (!existsSync(this.yamlPath)) return
    const engrams = loadEngrams(this.yamlPath)
    for (const e of engrams) {
      await this.upsertEngramTx(db, e, 'primary')
    }
  }

  private async upsertEngramTx(db: any, e: Engram, source: string): Promise<void> {
    await db.query(
      `INSERT INTO engrams (id, status, scope, domain, last_accessed, data, source)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         scope = EXCLUDED.scope,
         domain = EXCLUDED.domain,
         last_accessed = EXCLUDED.last_accessed,
         data = EXCLUDED.data,
         source = EXCLUDED.source`,
      [
        e.id,
        e.status,
        e.scope,
        e.domain ?? null,
        e.activation?.last_accessed ?? null,
        JSON.stringify(e),
        source,
      ],
    )
  }

  /**
   * BM25 search. PGLite has full-text search, but at the corpus sizes we care
   * about (a few thousand to a hundred thousand engrams) it's cheaper and
   * yields identical results to load the candidate set into JS and run the
   * existing BM25 scorer. This also keeps fts.ts as the single ranking
   * authority (one tokenizer, one IDF computation).
   */
  async searchBM25(query: string, opts: { limit: number }): Promise<Engram[]> {
    const candidates = await this.loadFiltered({ status: 'active' })
    return searchEngrams(candidates, query, opts.limit)
  }

  /**
   * Vector search. Uses pgvector when available, JS cosine otherwise.
   * Returns scored results so callers can fuse with BM25 via RRF.
   */
  async searchVector(query: Float32Array, limit: number): Promise<VectorSearchHit[]> {
    const db = await this.getDb()
    const totalRes = await db.query('SELECT COUNT(*)::int AS c FROM engram_embeddings')
    if (Number(totalRes.rows[0].c) === 0) return []
    if (this.hasVector) {
      // pgvector path. Cosine distance = 1 - cosine similarity.
      const literal = vectorLiteral(query)
      const res = await db.query(
        `SELECT e.data, 1 - (em.embedding <=> $1::vector) AS score
         FROM engram_embeddings em
         JOIN engrams e ON e.id = em.engram_id
         WHERE e.status = 'active'
         ORDER BY em.embedding <=> $1::vector
         LIMIT $2`,
        [literal, limit],
      )
      return res.rows.map((r: any) => ({
        engram: this.parseRow(r),
        score: Number(r.score),
      }))
    }
    // BYTEA fallback: read all embeddings, compute cosine in JS.
    const res = await db.query(
      `SELECT e.data, em.embedding
       FROM engram_embeddings em
       JOIN engrams e ON e.id = em.engram_id
       WHERE e.status = 'active'`,
    )
    const scored: VectorSearchHit[] = res.rows.map((r: any) => {
      const vec = bytesToFloat32(r.embedding)
      return { engram: this.parseRow(r), score: cosine(query, vec) }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  async upsertEmbedding(engramId: string, vector: Float32Array): Promise<void> {
    return this.mutex.run(async () => {
      const db = await this.getDb()
      if (this.hasVector) {
        const literal = vectorLiteral(vector)
        await db.query(
          `INSERT INTO engram_embeddings (engram_id, embedding)
           VALUES ($1, $2::vector)
           ON CONFLICT (engram_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [engramId, literal],
        )
      } else {
        const buf = float32ToBytes(vector)
        await db.query(
          `INSERT INTO engram_embeddings (engram_id, embedding)
           VALUES ($1, $2)
           ON CONFLICT (engram_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [engramId, buf],
        )
      }
    })
  }

  /**
   * Return the dim of the `engram_embeddings.embedding` column when the
   * pgvector path is in use, or null when the table doesn't exist or the
   * adapter is on the BYTEA fallback. Used by `plur doctor` and the reembed
   * migration to detect a dim mismatch between the indexed column and the
   * configured embedder.
   */
  async getVectorColumnDim(): Promise<number | null> {
    const db = await this.getDb()
    if (!this.hasVector) return null
    // format_type(atttypid, atttypmod) on a `vector(N)` column returns the
    // literal string "vector(N)" — parse the N back out.
    const res = await db.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'engram_embeddings' AND a.attname = 'embedding' AND a.attnum > 0`,
    )
    if (res.rows.length === 0) return null
    const t = String(res.rows[0].t)
    const m = t.match(/vector\((\d+)\)/i)
    return m ? Number(m[1]) : null
  }

  /** Count rows in `engram_embeddings`. Used by the reembed migration tests. */
  async countEmbeddings(): Promise<number> {
    const db = await this.getDb()
    const res = await db.query('SELECT COUNT(*)::int AS c FROM engram_embeddings')
    return Number(res.rows[0].c)
  }

  /**
   * Cheap "do we already have an embedding for this engram" check. Used by
   * the auto-embed path in `Plur._autoEmbedNewEngrams` (iter-2 audit B-1) to
   * skip engrams whose vector is already indexed.
   */
  async hasEmbedding(engramId: string): Promise<boolean> {
    const db = await this.getDb()
    const res = await db.query(
      'SELECT 1 FROM engram_embeddings WHERE engram_id = $1 LIMIT 1',
      [engramId],
    )
    return res.rows.length > 0
  }

  /**
   * Drop the embedding table and recreate it with a new vector dim. Used by
   * the reembed migration (`plur sync --reembed --full`) when the active
   * embedder produces a different dim than the indexed column.
   *
   * YAML is never touched — only the derived index column type changes.
   */
  async recreateVectorColumn(newDim: number): Promise<void> {
    return this.mutex.run(async () => {
      const db = await this.getDb()
      this.vectorDim = newDim
      await db.exec('DROP TABLE IF EXISTS engram_embeddings')
      if (this.hasVector) {
        await db.exec(`
          CREATE TABLE engram_embeddings (
            engram_id TEXT PRIMARY KEY,
            embedding vector(${newDim}) NOT NULL
          );
        `)
      } else {
        await db.exec(`
          CREATE TABLE engram_embeddings (
            engram_id TEXT PRIMARY KEY,
            embedding BYTEA NOT NULL
          );
        `)
      }
    })
  }

  /**
   * Re-embed every engram in YAML using the supplied embedder, replacing the
   * contents of `engram_embeddings`.
   *
   * - `full=true`: builds a new table `engram_embeddings_new` at the
   *   embedder's dim, populates it with every engram, then atomically swaps
   *   it for the live `engram_embeddings` (DROP + RENAME). If the embed
   *   loop fails partway through, the live table is untouched and the
   *   partial scratch table is cleaned up — no half-built index, no
   *   destructive failure mode. Iter-2 audit M-6 (CTO F-CTO-007,
   *   Data F-DATA-001).
   * - `full=false`: only re-embeds when the column dim already matches the
   *   embedder. If dims differ, this is a no-op and the caller is expected
   *   to surface the mismatch as a doctor warning.
   *
   * Idempotent. Returns the number of engrams that were re-embedded.
   */
  async reembedAll(opts?: { full?: boolean; embedder?: EmbedderAdapter }): Promise<{ reembedded: number; skipped: boolean; reason?: string }> {
    // testEmbedder takes precedence when set so reembed-migration tests can
    // inject a deterministic fake without loading a real ONNX model.
    const embedder = testEmbedder ?? opts?.embedder
    if (!embedder) {
      return { reembedded: 0, skipped: true, reason: 'no embedder supplied' }
    }
    const currentDim = await this.getVectorColumnDim()
    if (!opts?.full && currentDim !== null && currentDim !== embedder.dim) {
      return {
        reembedded: 0,
        skipped: true,
        reason: `column dim ${currentDim} differs from embedder dim ${embedder.dim} — run with full=true to migrate`,
      }
    }
    if (!existsSync(this.yamlPath)) {
      return { reembedded: 0, skipped: true, reason: 'yaml not present' }
    }
    const engrams = loadEngrams(this.yamlPath)

    if (opts?.full) {
      // Build-new-then-swap path. Failure during embed leaves the live
      // engram_embeddings untouched and the scratch table dropped.
      return this._reembedFullAtomic(embedder, engrams)
    }

    // Incremental path: upsert into the existing column.
    let count = 0
    for (const e of engrams) {
      const vec = await embedder.embed(e.statement)
      await this.upsertEmbedding(e.id, vec)
      count++
    }
    return { reembedded: count, skipped: false }
  }

  /**
   * Build a scratch `engram_embeddings_new` table, populate it via the
   * supplied embedder, then atomically swap it for the live table inside
   * a transaction. If embedding fails partway through, the scratch table is
   * dropped and the live table is untouched.
   *
   * Iter-2 audit M-6 — replaces the previous drop-then-populate flow that
   * left a half-built index on any mid-loop failure.
   */
  private async _reembedFullAtomic(
    embedder: EmbedderAdapter,
    engrams: Engram[],
  ): Promise<{ reembedded: number; skipped: boolean; reason?: string }> {
    const newDim = embedder.dim
    const db = await this.getDb()
    // Mutex serialises with concurrent learn() / upsertEmbedding so we can
    // perform the swap without racing the index mirror.
    return this.mutex.run(async () => {
      // 1. Prepare the scratch table. Always start clean.
      await db.exec('DROP TABLE IF EXISTS engram_embeddings_new')
      if (this.hasVector) {
        await db.exec(`
          CREATE TABLE engram_embeddings_new (
            engram_id TEXT PRIMARY KEY,
            embedding vector(${newDim}) NOT NULL
          );
        `)
      } else {
        await db.exec(`
          CREATE TABLE engram_embeddings_new (
            engram_id TEXT PRIMARY KEY,
            embedding BYTEA NOT NULL
          );
        `)
      }
      // 2. Populate. On any error, drop the scratch and bubble up — the
      //    live engram_embeddings is untouched.
      let count = 0
      try {
        for (const e of engrams) {
          const vec = await embedder.embed(e.statement)
          if (!Number.isFinite(vec[0])) {
            // vectorLiteral will throw anyway; surface it earlier with a
            // clearer migration-context message.
            for (let i = 0; i < vec.length; i++) {
              if (!Number.isFinite(vec[i])) {
                throw new Error(`reembedAll: embedder returned non-finite at index ${i} for engram ${e.id}`)
              }
            }
          }
          if (this.hasVector) {
            const literal = vectorLiteral(vec)
            await db.query(
              `INSERT INTO engram_embeddings_new (engram_id, embedding) VALUES ($1, $2::vector)`,
              [e.id, literal],
            )
          } else {
            const buf = float32ToBytes(vec)
            await db.query(
              `INSERT INTO engram_embeddings_new (engram_id, embedding) VALUES ($1, $2)`,
              [e.id, buf],
            )
          }
          count++
        }
      } catch (err) {
        await db.exec('DROP TABLE IF EXISTS engram_embeddings_new').catch(() => undefined)
        throw err
      }
      // 3. Atomic swap. Inside a transaction so a concurrent reader never
      //    sees an in-between state. PGLite supports DDL in transactions.
      await db.exec(`
        BEGIN;
        DROP TABLE IF EXISTS engram_embeddings;
        ALTER TABLE engram_embeddings_new RENAME TO engram_embeddings;
        COMMIT;
      `)
      // 4. Update the adapter's cached dim so subsequent inserts size right.
      this.vectorDim = newDim
      return { reembedded: count, skipped: false }
    })
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close()
      } catch {
        // ignore — PGLite occasionally throws on shutdown when the WASM worker
        // has already terminated. The on-disk state is durable.
      }
      this.db = null
      this.initialized = false
    }
  }
}

function vectorLiteral(v: Float32Array): string {
  // pgvector text format: "[0.1, 0.2, 0.3]"
  //
  // Iter-2 audit M-4 (Dijkstra F-DIJK-001, Data F-DATA-008): throw on
  // NaN / Infinity instead of substituting 0. A vector containing non-finite
  // floats is a bug upstream (usually a pooling/normalisation degenerate case
  // on empty text). Substituting 0 produced a perfectly cosine-able vector
  // that gave wrong recall results forever with no signal. The throw
  // surfaces the bug at the storage layer where it's most actionable.
  const parts: string[] = []
  for (let i = 0; i < v.length; i++) {
    const n = v[i]
    if (!Number.isFinite(n)) {
      throw new Error(`vectorLiteral: non-finite value at index ${i} (value=${n}). Embedders must return finite Float32Array values.`)
    }
    parts.push(String(n))
  }
  return '[' + parts.join(',') + ']'
}

function float32ToBytes(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

function bytesToFloat32(b: Uint8Array | ArrayBuffer): Float32Array {
  const arr = b instanceof Uint8Array ? b : new Uint8Array(b)
  // Ensure 4-byte alignment for Float32Array view.
  if ((arr.byteOffset % 4) === 0 && arr.byteLength % 4 === 0) {
    return new Float32Array(arr.buffer, arr.byteOffset, arr.byteLength / 4)
  }
  const copy = new Uint8Array(arr)
  return new Float32Array(copy.buffer)
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
