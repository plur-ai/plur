/**
 * PGLiteAdapter (ADR-0001): WASM Postgres + pgvector + Apache AGE as a
 * rebuildable index; YAML on disk is the source of truth.
 * - Write order (invariant): caller writes YAML, then calls syncFromYaml();
 *   if the sync fails, YAML still wins on the next `plur sync`.
 * - Vectors: `vector(N)`/`halfvec(N)`, or BYTEA + JS cosine without pgvector.
 * - Concurrency: PGLite is single-writer; an async mutex serializes writes.
 * - AGE graph is initialized if available; the public surface is relational + vector.
 */
import { existsSync, statSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import type { Engram } from './schemas/engram.js'
import { EngramSchemaPassthrough } from './schemas/engram.js'
import { normalizeEngramInput } from './normalize-engram.js'
import { loadEngrams, resolveDuplicateIds } from './engrams.js'
import { withoutRemoteOnlyQueued } from './remote-only-rows.js'
import { searchEngrams } from './fts.js'
import { logger } from './logger.js'
import type {
  DerivedIndexAdapter,
  ScopeRestriction,
  StorageAdapter,
  StorageFilter,
  VectorIndexStrategy,
  VectorSearchHit,
} from './storage-adapter.js'
import { escapeLikePattern } from './storage-adapter.js'

/** Vector dimension used by the default BGE-small-en-v1.5 model. */
const DEFAULT_VECTOR_DIM = 384

/**
 * Minimal async mutex — serializes writes inside the adapter.
 *
 * The class lives in the leaf module `async-mutex.ts` so the locking layer can
 * use it without importing this adapter; re-exported here for existing
 * importers.
 */
import { AsyncMutex } from './async-mutex.js'

/**
 * A YAML fingerprint whose timestamps were within this window of the moment it
 * was recorded is "racy": the file could change again inside the same timestamp
 * tick without changing its stat identity (FAT: 2 s; HFS+: 1 s). Such a match is
 * confirmed by hashing the bytes.
 */
const RACY_FINGERPRINT_MS = 3_000

/** What `sync_state.yaml_fingerprint` records: stat identity, content hash, racy flag. */
interface YamlFingerprint { stat: string; hash: string; racy: boolean }
export { AsyncMutex }

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

/**
 * Precision tier for the embedding column.
 *   - `float32` → pgvector `vector(N)` (4 bytes/dim, default)
 *   - `halfvec` → pgvector `halfvec(N)` (2 bytes/dim, slight recall loss;
 *      pgvector >= 0.7). Exact scans are ~3-10x slower in WASM (no F16C), so
 *      it trades CPU for storage and float32 stays the default.
 */
export type VectorPrecision = 'float32' | 'halfvec'

/** Map precision tier → pgvector column type name. */
const PRECISION_TYPE: Record<VectorPrecision, 'vector' | 'halfvec'> = {
  float32: 'vector',
  halfvec: 'halfvec',
}

export interface PGLiteAdapterOptions {
  /** Vector dimension for the embedding column (default: 384 — BGE-small). */
  vectorDim?: number
  /**
   * Desired embedding-column precision. UNSET keeps the store's existing type
   * (option-less constructors must never migrate a store). When set and
   * different, the column is cast in place on init (embeddings preserved,
   * existing dim kept). `plur sync --full` rebuilds from YAML at the
   * configured precision (ADR-0001).
   */
  precision?: VectorPrecision
}

export class PGLiteAdapter implements DerivedIndexAdapter {
  /**
   * This adapter is a DERIVED index — YAML (the `PrimaryStore`) owns the data
   * and every row here is rebuildable via `reindex()`. `requiresIndexSync()`
   * reads this field to decide whether a write needs a follow-up sync, so a
   * `role: 'primary'` backend needs no caller changes.
   */
  readonly role = 'index' as const
  /**
   * PGLite answers `searchVector()` with an EXACT scan — there is no vector
   * index on `engram_embeddings`, so pgvector computes the distance for every
   * row and `ORDER BY ... LIMIT k` returns the true top-k. Recall is 1.0 by
   * construction; there is nothing to tune and nothing to lose.
   *
   * `format` tracks the column's ACTUAL element type after init, which
   * is why this is a getter and not a frozen constant: a store migrated to
   * `halfvec` really does store fp16 and really does score marginally
   * differently from a float32 tier. See ADR-0005.
   */
  get vectorIndex(): VectorIndexStrategy {
    return {
      kind: 'exact',
      exact: true,
      recallTarget: null,
      // The BYTEA fallback stores raw fp32 bytes, so 'float32' is correct there too.
      format: this.hasVector && this.activeVecType === 'halfvec' ? 'halfvec' : 'float32',
      params: {},
    }
  }
  private yamlPath: string
  private dbPath: string
  private vectorDim: number
  /** Desired precision; undefined = keep whatever the store already has. */
  private precision: VectorPrecision | undefined
  /**
   * ACTUAL type of the embedding column after init ('vector' | 'halfvec').
   * All SQL casts use this — so even when a requested migration fails, reads
   * and writes keep matching the on-disk column instead of erroring.
   */
  private activeVecType: 'vector' | 'halfvec' = 'vector'
  /**
   * ACTUAL dim of the embedding column after init. For existing
   * stores this is the on-disk column's dim, which may differ from the
   * requested `vectorDim` — writes are enforced against reality, not the
   * request. Null on the BYTEA fallback (no column constraint), where
   * `vectorDim` is the enforcement contract instead.
   */
  private activeVecDim: number | null = null
  private db: any = null
  private initialized = false
  private hasVector = false
  private hasAge = false
  private mutex = new AsyncMutex()

  constructor(yamlPath: string, dbPath: string, opts?: PGLiteAdapterOptions) {
    this.yamlPath = yamlPath
    this.dbPath = dbPath
    this.vectorDim = opts?.vectorDim ?? DEFAULT_VECTOR_DIM
    this.precision = opts?.precision
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
      // New stores are created at the requested precision (float32 when the
      // knob is unset).
      const wantType = PRECISION_TYPE[this.precision ?? 'float32']
      await db.exec(`
        CREATE TABLE IF NOT EXISTS engram_embeddings (
          engram_id TEXT PRIMARY KEY,
          embedding ${wantType}(${this.vectorDim}) NOT NULL
        );
      `)
      await this.ensureColumnPrecision(db)
    } else {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS engram_embeddings (
          engram_id TEXT PRIMARY KEY,
          embedding BYTEA NOT NULL
        );
      `)
    }
    // The text this vector was computed from, so a changed engram gets a
    // changed vector. Additive + idempotent, so an existing store gains it on
    // next open. Deliberately NOT a foreign key to `engrams`: `reindex()`
    // deletes every engram row and re-inserts it, and ON DELETE CASCADE would
    // discard the whole embedding table, which reindex preserves on purpose.
    // Orphans left by real removals are swept set-wise in `syncFromYaml`.
    await db.exec('ALTER TABLE engram_embeddings ADD COLUMN IF NOT EXISTS content_hash TEXT;')
    // One row recording the YAML state this index was last synced from,
    // so an unchanged file can skip the whole re-upsert. See syncFromYaml.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `)
    // AGE engram graph: created here so the schema is ready; no edges are
    // written yet.
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

  /**
   * Read the actual type + dim of engram_embeddings.embedding from the
   * catalog: format_type() returns "vector(N)" or "halfvec(N)".
   */
  private async readEmbeddingColumnInfo(db: any): Promise<{ type: 'vector' | 'halfvec'; dim: number } | null> {
    const res = await db.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'engram_embeddings' AND a.attname = 'embedding' AND a.attnum > 0`,
    )
    if (res.rows.length === 0) return null
    const m = String(res.rows[0].t).match(/^(vector|halfvec)\((\d+)\)$/i)
    if (!m) return null
    return { type: m[1].toLowerCase() as 'vector' | 'halfvec', dim: Number(m[2]) }
  }

  /**
   * Lazy precision migration, once per init inside initSchema.
   * - `precision` unset → adopt the existing column type.
   * - Set and different → one transactional `ALTER TABLE ... USING
   *   embedding::<type>(dim)` cast; no re-embedding. Keeps the EXISTING dim so
   *   a precision change cannot mask a dim mismatch.
   * - Dependent hnsw/ivfflat indexes are dropped and recreated in the same
   *   transaction (their opclass is type-specific).
   * - Failure is non-fatal: activeVecType keeps tracking the on-disk column.
   */
  private async ensureColumnPrecision(db: any): Promise<void> {
    const info = await this.readEmbeddingColumnInfo(db)
    if (!info) return // BYTEA fallback or exotic column — nothing to manage
    this.activeVecType = info.type
    // Track the on-disk dim so writes are enforced against reality
    // (existing stores keep their column; see upsertEmbedding).
    this.activeVecDim = info.dim
    if (this.precision === undefined) return // keep-existing semantics
    const wantType = PRECISION_TYPE[this.precision]
    if (info.type === wantType) return
    const opclassFor = (t: 'vector' | 'halfvec', old: string): string => {
      // vector_cosine_ops → halfvec_cosine_ops (and back) — same suffix,
      // target type's prefix.
      const suffix = old.replace(/^(vector|halfvec)_/, '')
      return `${t}_${suffix}`
    }
    try {
      await db.exec('BEGIN')
      // Collect vector-opclass indexes on the embedding column; they block
      // the ALTER and need their opclass swapped to the target type's.
      const idxRes = await db.query(
        `SELECT i.relname AS name, am.amname AS method, opc.opcname AS opclass
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_am am ON am.oid = i.relam
         JOIN pg_opclass opc ON opc.oid = x.indclass[0]
         WHERE t.relname = 'engram_embeddings'
           AND am.amname IN ('hnsw', 'ivfflat')`,
      )
      for (const row of idxRes.rows) {
        await db.exec(`DROP INDEX "${row.name}"`)
      }
      await db.exec(
        `ALTER TABLE engram_embeddings
         ALTER COLUMN embedding TYPE ${wantType}(${info.dim})
         USING embedding::${wantType}(${info.dim})`,
      )
      for (const row of idxRes.rows) {
        const opclass = opclassFor(wantType, String(row.opclass))
        await db.exec(
          `CREATE INDEX "${row.name}" ON engram_embeddings USING ${row.method} (embedding ${opclass})`,
        )
      }
      await db.exec('COMMIT')
      this.activeVecType = wantType
      logger.info(`[pglite] migrated embedding column ${info.type}(${info.dim}) -> ${wantType}(${info.dim})`)
    } catch (err) {
      await db.exec('ROLLBACK').catch(() => {})
      logger.warning(
        `[pglite] precision migration to ${wantType} failed (staying on ${info.type}): ${(err as Error).message}`,
      )
    }
  }

  /**
   * Apply a filter to a SELECT query.
   *
   * `opts.alias` qualifies every column (the join in searchVector needs
   * `e.status`, not a bare `status`); `opts.startIndex` is the first free
   * placeholder number so the clause can be spliced into a query that already
   * bound `$1` (the query vector).
   */
  private buildFilterClause(
    filter: StorageFilter,
    opts?: { alias?: string; startIndex?: number },
  ): { where: string; params: any[]; nextIndex: number } {
    const col = opts?.alias ? `${opts.alias}.` : ''
    const conditions: string[] = []
    const params: any[] = []
    let i = opts?.startIndex ?? 1
    if (filter.status) {
      conditions.push(`${col}status = $${i++}`)
      params.push(filter.status)
    }
    if (filter.scopes !== undefined) {
      // Permitted-scope allow-list pushdown. EXACT membership — no
      // hierarchy expansion, no personal-family pass-through: the caller has
      // already resolved identity to a complete set of permitted scopes, so
      // widening it here would grant access the authorization layer did not.
      //
      // An EMPTY array must match NOTHING: `= ANY(ARRAY[]::text[])` is false
      // for every row, which is exactly right — a principal with no permitted
      // scopes sees nothing. This is why the guard is `!== undefined` and not
      // a truthiness/length test; `[]` is a real filter, not an absent one.
      conditions.push(`${col}scope = ANY($${i++}::text[])`)
      params.push(filter.scopes)
    }
    if (filter.scope) {
      // Read-side scope filter, three parts OR'd:
      //  (1) personal-family pass-through: every non-shared scope (SQL form of
      //      isPersonalScope; keep in sync with SHARED_SCOPE_PREFIXES). The
      //      family prefix is case-folded like isSharedScope, or `Group:x`
      //      would pass as personal (Postgres LIKE is case-sensitive).
      //  (2) the requested scope or a descendant on a real `:`/`/` delimiter,
      //      never a sibling prefix.
      //  (3) mounted-scope grants: VISIBILITY ONLY, never widening the `scopes`
      //      authorization clause. SQL twin of makeVisibilityPredicate
      //      (scope-util.ts); keep all four arms in lockstep.
      let clause =
        `((NOT (lower(${col}scope) LIKE 'group:%' OR lower(${col}scope) LIKE 'project:%' OR lower(${col}scope) LIKE 'space:%' OR lower(${col}scope) LIKE 'team:%' OR lower(${col}scope) LIKE 'org:%' OR lower(${col}scope) = 'public' OR lower(${col}scope) LIKE 'public:%' OR lower(${col}scope) LIKE 'public/%'))`
        + ` OR ${col}scope = $${i++} OR ${col}scope LIKE $${i++} || ':%' ESCAPE '\\' OR ${col}scope LIKE $${i++} || '/%' ESCAPE '\\'`
      // Escaped for the same reason as the Postgres copy — these two clauses
      // must stay identical; drift between them is an authorization bypass.
      params.push(filter.scope, escapeLikePattern(filter.scope), escapeLikePattern(filter.scope))
      for (const g of filter.visibilityGrants ?? []) {
        clause += ` OR ${col}scope = $${i++} OR ${col}scope LIKE $${i++} || ':%' ESCAPE '\\' OR ${col}scope LIKE $${i++} || '/%' ESCAPE '\\'`
        params.push(g, escapeLikePattern(g), escapeLikePattern(g))
      }
      conditions.push(clause + ')')
    }
    if (filter.domain) {
      conditions.push(`${col}domain LIKE $${i++} || '%' ESCAPE '\\'`)
      params.push(escapeLikePattern(filter.domain))
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return { where, params, nextIndex: i }
  }

  /**
   * Parse a `data` row (JSONB) back to an Engram, normalising and validating
   * like `storage-postgres.ts`'s `parseRow` (e.g. missing `associations`,
   * legacy `reference_count` → `write_count`).
   * An unparseable row is returned as-is, never silently dropped.
   */
  private parseRow(row: { data: any }): Engram {
    const raw = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    const parsed = EngramSchemaPassthrough.safeParse(normalizeEngramInput(raw))
    return parsed.success ? (parsed.data as Engram) : (raw as Engram)
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
        // reindex() is the recovery path for a suspect index, so it must not
        // inherit a fingerprint that would let the next syncFromYaml skip.
        // Clearing (rather than setting) keeps the rebuild honest: the next
        // sync re-derives it from the file it actually reads.
        //
        // NOT catch-swallowed: this statement runs
        // inside BEGIN/COMMIT, and a swallowed error here would leave the
        // transaction aborted so the following COMMIT silently acts as
        // ROLLBACK — reindex() reporting success having rebuilt nothing.
        // ensureSchema guarantees the table exists; if this ever throws, the
        // catch below rolls back loudly, which is the honest outcome.
        await db.exec("DELETE FROM sync_state WHERE k = 'yaml_fingerprint'")
        await db.exec('COMMIT')
      } catch (err) {
        await db.exec('ROLLBACK').catch(() => {})
        throw err
      }
    })
  }

  /**
   * Cheap YAML identity: size, mtime, ctime and inode, no read, so
   * {@link syncFromYaml} can skip unchanged files. Because a same-size rewrite
   * within one timestamp tick keeps every field, the fingerprint also carries a
   * content hash and a `racy` flag (timestamps within {@link RACY_FINGERPRINT_MS}
   * of recording, git's "racily clean" rule); a racy match is re-hashed first.
   */
  private yamlStat(): { key: string; mtimeMs: number; ctimeMs: number } | null {
    try {
      const st = statSync(this.yamlPath, { bigint: true })
      return {
        key: `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`,
        mtimeMs: Number(st.mtimeMs),
        ctimeMs: Number(st.ctimeMs),
      }
    } catch {
      return null // missing file — let the sync run and clear the table
    }
  }

  private async readSyncedFingerprint(db: any): Promise<YamlFingerprint | null> {
    try {
      const r = await db.query("SELECT v FROM sync_state WHERE k = 'yaml_fingerprint'")
      if (r.rows.length === 0) return null
      const v = JSON.parse(String(r.rows[0].v))
      return typeof v?.stat === 'string' && typeof v?.hash === 'string' && typeof v?.racy === 'boolean' ? v : null
    } catch {
      return null // older store without the table, or an old-format `size:mtime` row
    }
  }

  private async writeSyncedFingerprint(db: any, fp: YamlFingerprint): Promise<void> {
    await db.query(
      `INSERT INTO sync_state (k, v) VALUES ('yaml_fingerprint', $1)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
      [JSON.stringify(fp)],
    )
  }

  /**
   * syncFromYaml: upsert what YAML contains, delete primary-source rows it no
   * longer has. Runs after every YAML mutation and from the Plur constructor;
   * a changed file re-upserts every engram, which would eat a hook's budget.
   * The fingerprint guard makes the unchanged case free: a stat match is trusted
   * only when not racy, otherwise bytes are re-hashed (see {@link yamlStat}).
   */
  async syncFromYaml(): Promise<void> {
    return this.mutex.run(async () => {
      const db = await this.getDb()

      const st = this.yamlStat()
      const synced = await this.readSyncedFingerprint(db)
      if (st && synced && synced.stat === st.key && !synced.racy) {
        return // index already reflects this exact YAML file
      }
      // Stat changed, or matched only racily: look at the bytes. Stat BEFORE the
      // read, so a change landing in between is either visible in the hash or
      // leaves this fingerprint racy (its timestamps are then within the window).
      let fingerprint: YamlFingerprint | null = null
      if (st) {
        try {
          const hash = createHash('sha256').update(readFileSync(this.yamlPath)).digest('hex')
          const now = Date.now()
          const racy = now - st.mtimeMs < RACY_FINGERPRINT_MS || now - st.ctimeMs < RACY_FINGERPRINT_MS
          fingerprint = { stat: st.key, hash, racy }
        } catch {
          fingerprint = null // vanished or unreadable: run the sync, which decides
        }
      }
      if (fingerprint && synced && synced.hash === fingerprint.hash) {
        // Same bytes as last synced: only the stat identity moved (a rewrite of
        // identical content, a touch). Refresh it; the index is already right.
        await this.writeSyncedFingerprint(db, fingerprint)
        return
      }

      await db.exec('BEGIN')
      try {
        const ids = new Set<string>()
        if (existsSync(this.yamlPath)) {
          // A queued remote-only save is never mirrored here.
          const engrams = withoutRemoteOnlyQueued(loadEngrams(this.yamlPath))
          await this.upsertEngramsTx(db, engrams, 'primary')
          for (const e of engrams) ids.add(e.id)
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
        // Sweep vectors whose engram is gone. `engram_embeddings` has no
        // cascading FK on this tier (a cascade would empty the table on every
        // `reindex()`). A left-behind vector is not just wasted space:
        // `generateEngramId` mints `max(same-day id) + 1`, so a freed id can be
        // reused by an unrelated engram, which would inherit the dead vector.
        // Set-based and inside the same transaction as the deletes above.
        await db.exec('DELETE FROM engram_embeddings WHERE engram_id NOT IN (SELECT id FROM engrams)')
        // Inside the transaction: a rollback must not leave the index claiming
        // to be in sync with a file it never finished reading.
        if (fingerprint !== null) {
          await this.writeSyncedFingerprint(db, fingerprint)
        } else {
          await db.exec("DELETE FROM sync_state WHERE k = 'yaml_fingerprint'")
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
    await this.upsertEngramsTx(db, withoutRemoteOnlyQueued(loadEngrams(this.yamlPath)), 'primary')
  }

  /**
   * Upsert many engrams in chunked multi-row statements (round-trips into WASM
   * Postgres dominate). CHUNK 500 stays far below Postgres's 65,535-parameter
   * limit at 7 params per row.
   */
  private async upsertEngramsTx(db: any, engrams: Engram[], source: string): Promise<void> {
    // One row per id BEFORE batching: a multi-row `INSERT ... ON CONFLICT DO
    // UPDATE` containing the same id twice is a Postgres ERROR ("cannot affect
    // row a second time"), which would make the sync fail permanently.
    //
    // Same rule as the loader ("keep both, rename one"): the first copy keeps
    // the id, a later different copy gets the loader's fresh id, an exact
    // duplicate is kept once, so recall and YAML-path feedback/forget act on
    // the same engram. Idempotent on batches from `loadEngrams`, which are
    // already resolved.
    const { engrams: unique, renames } = resolveDuplicateIds(engrams)
    if (renames.length > 0) {
      logger.warning(
        `[plur] ${renames.length} engram(s) in an index batch shared an id with an earlier, different engram; ` +
        `indexed under fresh ids (${renames.slice(0, 5).map(r => `${r.from} -> ${r.to}`).join(', ')}${renames.length > 5 ? ', …' : ''}).`,
      )
    }

    const COLS = 7
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const batch = unique.slice(i, i + CHUNK)
      const values: unknown[] = []
      const tuples = batch.map((e, n) => {
        const b = n * COLS
        values.push(
          e.id,
          e.status,
          e.scope,
          e.domain ?? null,
          e.activation?.last_accessed ?? null,
          JSON.stringify(e),
          source,
        )
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, $${b + 7})`
      })
      await db.query(
        `INSERT INTO engrams (id, status, scope, domain, last_accessed, data, source)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           scope = EXCLUDED.scope,
           domain = EXCLUDED.domain,
           last_accessed = EXCLUDED.last_accessed,
           data = EXCLUDED.data,
           source = EXCLUDED.source`,
        values,
      )
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
   * BM25 search over a candidate set loaded into JS, so fts.ts stays the single
   * ranking authority (one tokenizer, one IDF).
   * `opts.scopes` is pushed into the SELECT (loadFiltered), so IDF and top-N are
   * computed over permitted engrams only. The FULL StorageFilter (`scope`,
   * `domain`, `visibilityGrants`) is honoured, in lockstep with Postgres `searchBM25`.
   */
  async searchBM25(query: string, opts: { limit: number } & StorageFilter): Promise<Engram[]> {
    const { limit, ...filter } = opts
    const candidates = await this.loadFiltered({ ...filter, status: filter.status ?? 'active' })
    return searchEngrams(candidates, query, limit)
  }

  /**
   * Vector search (pgvector, or JS cosine); returns scores for RRF fusion.
   * `opts.scopes`, `opts.scope` and `opts.visibilityGrants` are applied INSIDE
   * the k-NN query via buildFilterClause, never to returned rows: post-filtering
   * would spend `limit` on rows the caller cannot see and return fewer results.
   */
  async searchVector(
    query: Float32Array,
    limit: number,
    opts?: ScopeRestriction & Pick<StorageFilter, 'scope' | 'visibilityGrants'>,
  ): Promise<VectorSearchHit[]> {
    const db = await this.getDb()
    const totalRes = await db.query('SELECT COUNT(*)::int AS c FROM engram_embeddings')
    if (Number(totalRes.rows[0].c) === 0) return []
    // status defaults to 'active' but stays overridable.
    const filter: StorageFilter = {
      status: 'active',
      scopes: opts?.scopes,
      scope: opts?.scope,
      visibilityGrants: opts?.visibilityGrants,
    }
    if (this.hasVector) {
      // pgvector path. Cosine distance = 1 - cosine similarity. The query
      // param is cast to the column's ACTUAL type — pgvector's <=>
      // operators are per-type, so a halfvec column needs a halfvec operand.
      // $1 is the query vector, so the filter's placeholders start at $2 and
      // LIMIT takes whatever number is free after them.
      const t = this.activeVecType
      const literal = vectorLiteral(query)
      const { where, params, nextIndex } = this.buildFilterClause(filter, { alias: 'e', startIndex: 2 })
      const res = await db.query(
        `SELECT e.data, 1 - (em.embedding <=> $1::${t}) AS score
         FROM engram_embeddings em
         JOIN engrams e ON e.id = em.engram_id
         ${where}
         ORDER BY em.embedding <=> $1::${t}
         LIMIT $${nextIndex}`,
        [literal, ...params, limit],
      )
      return res.rows.map((r: any) => ({
        engram: this.parseRow(r),
        score: Number(r.score),
      }))
    }
    // BYTEA fallback: read all embeddings, compute cosine in JS. The scope
    // filter still runs in SQL — the JS side only does the cosine.
    const { where, params } = this.buildFilterClause(filter, { alias: 'e' })
    const res = await db.query(
      `SELECT e.data, em.embedding
       FROM engram_embeddings em
       JOIN engrams e ON e.id = em.engram_id
       ${where}`,
      params,
    )
    const scored: VectorSearchHit[] = res.rows.map((r: any) => {
      const vec = bytesToFloat32(r.embedding)
      return { engram: this.parseRow(r), score: cosine(query, vec) }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  async upsertEmbedding(engramId: string, vector: Float32Array, contentHash?: string): Promise<void> {
    return this.mutex.run(async () => {
      const db = await this.getDb()
      // Storage-boundary contract: a wrong-shape vector must never be
      // persisted. On the pgvector path this turns a cryptic pgvector error
      // into a targeted one; on the BYTEA fallback (no column constraint)
      // this is the ONLY guard — otherwise any length would be stored and
      // cosineSimilarity would return garbage over min(a, b).
      const expectedDim = this.activeVecDim ?? this.vectorDim
      if (vector.length !== expectedDim) {
        throw new Error(
          `[pglite] Refusing to persist a ${vector.length}-dim embedding for "${engramId}": ` +
          `this store's embedding ${this.hasVector ? 'column' : 'table'} is ${expectedDim}-dim (#335). ` +
          `The active embedder (PLUR_EMBEDDER) and the indexed store must agree — ` +
          `run 'plur sync --reembed --full' to rebuild the index at the active embedder's dim.`,
        )
      }
      if (this.hasVector) {
        // Cast to the column's actual type: halfvec parses the same
        // "[...]" literal and rounds to fp16 on write.
        const literal = vectorLiteral(vector)
        await db.query(
          `INSERT INTO engram_embeddings (engram_id, embedding, content_hash)
           VALUES ($1, $2::${this.activeVecType}, $3)
           ON CONFLICT (engram_id) DO UPDATE
             SET embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash`,
          [engramId, literal, contentHash ?? null],
        )
      } else {
        const buf = float32ToBytes(vector)
        await db.query(
          `INSERT INTO engram_embeddings (engram_id, embedding, content_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (engram_id) DO UPDATE
             SET embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash`,
          [engramId, buf, contentHash ?? null],
        )
      }
    })
  }

  /** True if `engram_id` already has a row in engram_embeddings. Used by the auto-embed path to skip already-indexed engrams. */
  async hasEmbedding(engramId: string): Promise<boolean> {
    const db = await this.getDb()
    const res = await db.query(
      'SELECT 1 FROM engram_embeddings WHERE engram_id = $1 LIMIT 1',
      [engramId],
    )
    return res.rows.length > 0
  }

  /**
   * True when `engramId` has an embedding computed from exactly `contentHash`
   * — the skip condition for the auto-embed pass. `hasEmbedding` only asks
   * whether SOME vector exists, which would let an edited engram keep the
   * vector of its previous text.
   *
   * Both sides are hashed in JS by `embeddingContentHash`, since this tier's
   * `engrams` table has no `search_text` column for SQL to hash. A row stored
   * before content hashing carries NULL and reports false, so it is re-embedded
   * once and correct from then on.
   */
  async embeddingIsCurrent(engramId: string, contentHash: string): Promise<boolean> {
    const db = await this.getDb()
    const res = await db.query(
      'SELECT 1 FROM engram_embeddings WHERE engram_id = $1 AND content_hash = $2 LIMIT 1',
      [engramId, contentHash],
    )
    return res.rows.length > 0
  }

  /** Dimension the embedding column was sized to (vector(N) or halfvec(N)), or null when not a pgvector column. Lets the auto-embed path skip when the active embedder dim differs from the indexed dim. */
  async getVectorColumnDim(): Promise<number | null> {
    const db = await this.getDb()
    if (!this.hasVector) return null
    const info = await this.readEmbeddingColumnInfo(db)
    return info?.dim ?? null
  }

  /** Actual pgvector type of the embedding column ('vector' | 'halfvec'), or null on the BYTEA fallback. Used by tests + diagnostics for the precision tiers. */
  async getVectorColumnType(): Promise<'vector' | 'halfvec' | null> {
    const db = await this.getDb()
    if (!this.hasVector) return null
    const info = await this.readEmbeddingColumnInfo(db)
    return info?.type ?? null
  }

  /** Number of rows in engram_embeddings. Used by tests + diagnostics to confirm the vector index is populated. */
  async countEmbeddings(): Promise<number> {
    const db = await this.getDb()
    const res = await db.query('SELECT COUNT(*)::int AS c FROM engram_embeddings')
    return Number(res.rows[0].c)
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
  // Numbers serialize at full precision; no NaN/Infinity allowed in pgvector
  // so we substitute 0 to keep writes from throwing on malformed input.
  const parts: string[] = []
  for (let i = 0; i < v.length; i++) {
    const n = v[i]
    parts.push(Number.isFinite(n) ? String(n) : '0')
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
