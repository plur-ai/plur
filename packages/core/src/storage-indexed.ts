import { existsSync } from 'fs'
import { createRequire } from 'module'
import { loadEngrams, storePrefix, namespaceEngramId } from './engrams.js'
import { withoutRemoteOnlyQueued } from './remote-only-rows.js'
import { isPersonalScope, isScopeWithin } from './scope-util.js'
import type { Engram } from './schemas/engram.js'
import type { StoreEntry } from './schemas/config.js'
import type { StorageFilter } from './storage-adapter.js'

const require = createRequire(import.meta.url)

/**
 * Schema-migration sentinel stored in SQLite's `PRAGMA user_version`.
 * Set to 1 only AFTER the `personal`-column backfill completes successfully,
 * so a crash between the ADD COLUMN and the backfill self-heals on the next open.
 */
const PERSONAL_BACKFILL_VERSION = 1

let Database: any = null

function getDatabase(): any {
  if (!Database) {
    try {
      Database = require('better-sqlite3')
    } catch {
      throw new Error(
        'better-sqlite3 is required for index: true. Install it with: npm install better-sqlite3'
      )
    }
  }
  return Database
}

export class IndexedStorage {
  private dbPath: string
  private engramsPath: string
  private stores: StoreEntry[]
  private db: any = null

  constructor(engramsPath: string, dbPath: string, stores?: StoreEntry[]) {
    this.engramsPath = engramsPath
    this.dbPath = dbPath
    this.stores = stores ?? []
  }

  private getDb(): any {
    if (!this.db) {
      const DB = getDatabase()
      this.db = new DB(this.dbPath)
      this.db.pragma('journal_mode = WAL')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS engrams (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          scope TEXT NOT NULL,
          domain TEXT,
          last_accessed TEXT,
          data TEXT NOT NULL,
          personal INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_status ON engrams(status);
        CREATE INDEX IF NOT EXISTS idx_scope ON engrams(scope);
        CREATE INDEX IF NOT EXISTS idx_domain ON engrams(domain);
      `)
      // Add source column if not exists (multi-store support)
      try {
        this.db.exec("ALTER TABLE engrams ADD COLUMN source TEXT NOT NULL DEFAULT 'primary'")
      } catch {
        // Column already exists — expected on subsequent opens
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_source ON engrams(source)')
      // Add the `personal` column to DBs that lack it. The
      // DEFAULT 0 leaves existing rows wrong until repopulated, so the ADD COLUMN
      // must be followed by a one-time backfill that rewrites every row's
      // `personal` flag from its scope.
      let addedPersonalColumn = false
      try {
        this.db.exec('ALTER TABLE engrams ADD COLUMN personal INTEGER NOT NULL DEFAULT 0')
        addedPersonalColumn = true
      } catch {
        // Column already exists — expected on subsequent opens / fresh DBs.
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_personal ON engrams(personal)')
      // The ALTER auto-commits while syncFromYaml runs in its own transaction,
      // so a crash in between leaves the column present with every row at
      // DEFAULT 0, and `addedPersonalColumn` alone would not re-run the
      // backfill (the ALTER then throws). The backfill is therefore gated on a
      // `PRAGMA user_version` sentinel set only after it succeeds: any open
      // seeing user_version < 1 re-runs it idempotently and stamps the sentinel.
      const userVersion = this.db.pragma('user_version', { simple: true }) as number
      if (userVersion < PERSONAL_BACKFILL_VERSION) {
        // A successful ADD COLUMN means an old DB whose existing rows are all at
        // DEFAULT 0 and must be backfilled. Otherwise (column already present)
        // only backfill when rows actually exist — an empty/fresh DB has nothing
        // to fix and reindex()/the next write will populate it. This avoids a
        // redundant full sync on a fresh open while still re-healing a
        // crash-interrupted backfill.
        const rowCount = this.db.prepare('SELECT COUNT(*) AS n FROM engrams').get() as { n: number }
        if (addedPersonalColumn || rowCount.n > 0) {
          // syncFromYaml is a full upsert+prune from YAML, so it is idempotent —
          // safe to re-run after a partial prior backfill.
          this.syncFromYaml()
        }
        // Stamp the sentinel unconditionally: a fresh empty DB is "migrated" by
        // construction (CREATE TABLE already has the column), so it should not
        // re-enter this branch on every subsequent open.
        this.db.pragma(`user_version = ${PERSONAL_BACKFILL_VERSION}`)
      }
      this.resyncStalePrefixes()
    }
    return this.db
  }

  /** Load all engrams from SQLite index. Auto-rebuilds if db missing. */
  async loadAll(): Promise<Engram[]> {
    if (!existsSync(this.dbPath)) {
      await this.reindex()
    }
    const db = this.getDb()
    const rows = db.prepare('SELECT data FROM engrams').all() as { data: string }[]
    return rows.map((r: { data: string }) => JSON.parse(r.data) as Engram)
  }

  /** Load engrams with SQL-level filtering. */
  async loadFiltered(filter: StorageFilter): Promise<Engram[]> {
    if (!existsSync(this.dbPath)) {
      await this.reindex()
    }
    const db = this.getDb()
    const conditions: string[] = []
    const params: any[] = []

    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.scopes !== undefined) {
      // Permitted-scope allow-list (SQLite twin of pglite's `scope = ANY(...)`):
      // EXACT membership, no hierarchy and no `personal = 1` pass-through.
      // An EMPTY list must match NOTHING, so it compiles to `1 = 0`, never a
      // dropped clause. One placeholder per scope is fine for tens of scopes;
      // near SQLITE_MAX_VARIABLE_NUMBER switch to `json_each(?)`.
      if (filter.scopes.length === 0) {
        conditions.push('1 = 0')
      } else {
        conditions.push(`scope IN (${filter.scopes.map(() => '?').join(', ')})`)
        params.push(...filter.scopes)
      }
    }
    if (filter.scope) {
      // Read-side scope filter: `personal = 1` (all personal-family scopes, set
      // at index time) OR the scope / a descendant on a real `:`/`/` delimiter,
      // never a sibling prefix (mirrors isScopeWithin). Mounted-scope grants add
      // the same triple per grant as OR-clauses; VISIBILITY ONLY, never widening
      // the `scopes` allow-list. Keep in lockstep with makeVisibilityPredicate
      // and the pglite/postgres arms. Prefixes are tested with `instr(...) = 1`,
      // not LIKE: SQLite LIKE is case-insensitive, so it would admit
      // `PROJECT:a:x` under `project:a`, which isScopeWithin does not.
      const within = ['scope = ?', "instr(scope, ? || ':') = 1", "instr(scope, ? || '/') = 1"]
      const clauses = ['personal = 1', ...within]
      params.push(filter.scope, filter.scope, filter.scope)
      for (const g of filter.visibilityGrants ?? []) {
        clauses.push(...within)
        params.push(g, g, g)
      }
      conditions.push(`(${clauses.join(' OR ')})`)
    }
    if (filter.domain) {
      // Exact, case-sensitive prefix like the in-memory `startsWith`; LIKE would
      // case-fold and treat `_` / `%` in the filter as wildcards.
      conditions.push('instr(domain, ?) = 1')
      params.push(filter.domain)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db.prepare(`SELECT data FROM engrams ${where}`).all(...params) as { data: string }[]
    return rows.map((r: { data: string }) => JSON.parse(r.data) as Engram)
  }

  /** Count engrams with optional status filter. */
  async count(filter?: { status?: string }): Promise<number> {
    if (!existsSync(this.dbPath)) {
      await this.reindex()
    }
    const db = this.getDb()
    if (filter?.status) {
      return (db.prepare('SELECT COUNT(*) as c FROM engrams WHERE status = ?').get(filter.status) as any).c
    }
    return (db.prepare('SELECT COUNT(*) as c FROM engrams').get() as any).c
  }

  /**
   * Rebuild the index once when it holds a store row under a prefix that is
   * no longer that store's. Without this an index written with an older prefix
   * keeps serving the old ids until some store file happens to change.
   * Reads only the store rows' ids; a no-op on an index that is current.
   */
  private resyncStalePrefixes(): void {
    const prefixBySource = new Map<string, string>()
    for (const store of this.stores) if (store.path) prefixBySource.set(store.path, storePrefix(store.scope))
    if (prefixBySource.size === 0) return
    const rows = this.db.prepare("SELECT id, source FROM engrams WHERE source != 'primary'").all() as { id: string; source: string }[]
    const stale = rows.some(r => {
      const want = prefixBySource.get(r.source)
      return want !== undefined && !new RegExp(`^(ENG|ABS|META)-${want}-`).test(r.id)
    })
    if (stale) this.syncFromYaml()
  }

  /** Sync SQLite index from YAML source of truth (primary + all stores). */
  syncFromYaml(): void {
    const db = this.getDb()
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO engrams (id, status, scope, domain, last_accessed, data, source, personal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const allSyncedIds = new Set<string>()
    const validSources = new Set<string>(['primary'])

    const tx = db.transaction(() => {
      // Sync primary store
      // A queued remote-only save is never mirrored here.
      const primaryEngrams = withoutRemoteOnlyQueued(loadEngrams(this.engramsPath))
      for (const e of primaryEngrams) {
        // `personal` mirrors isPersonalScope of the stored scope so loadFiltered
        // can pass personal-family scopes under any project-scope filter.
        upsert.run(e.id, e.status, e.scope, e.domain ?? null, e.activation.last_accessed, JSON.stringify(e), 'primary', isPersonalScope(e.scope) ? 1 : 0)
        allSyncedIds.add(e.id)
      }

      // Sync additional stores with namespaced IDs.
      // Remote (url) stores are skipped here — the SQLite index only
      // tracks file-backed stores; remote engrams are queried live
      // through the in-memory _loadAllEngrams path.
      for (const store of this.stores) {
        if (!store.path) continue
        validSources.add(store.path)
        // A queued remote-only save is never mirrored here.
        const storeEngrams = withoutRemoteOnlyQueued(loadEngrams(store.path))
        for (const e of storeEngrams) {
          // Scope validation: skip mismatched scopes. Segment-aware so a
          // sibling string-prefix scope can't be indexed under this store.
          if (e.scope !== 'global' && !isScopeWithin(e.scope, store.scope)) {
            continue
          }
          // Same rule as every other loader (idempotent, upgrades an old-form id).
          const nsId = namespaceEngramId(e.id, store.scope)
          // Cross-store narrowing (intentional): a global-scoped secondary-store
          // engram is renamed to the store's scope on load. `personal` reflects the FINAL
          // written scope — a global engram renamed to a shared store scope is
          // correctly indexed as non-personal.
          const scope = e.scope === 'global' ? store.scope : e.scope
          upsert.run(nsId, e.status, scope, e.domain ?? null, e.activation.last_accessed, JSON.stringify({ ...e, id: nsId, scope }), store.path, isPersonalScope(scope) ? 1 : 0)
          allSyncedIds.add(nsId)
        }
      }

      // Delete rows not in any current source
      const dbRows = db.prepare('SELECT id, source FROM engrams').all() as { id: string; source: string }[]
      const deleteStmt = db.prepare('DELETE FROM engrams WHERE id = ?')
      for (const row of dbRows) {
        if (!allSyncedIds.has(row.id)) {
          deleteStmt.run(row.id)
        }
      }
    })
    tx()
  }

  /** Drop and rebuild the entire index from YAML. */
  reindex(): void {
    // Close any existing connection so the db file is released before potential deletion
    this.close()
    const db = this.getDb()
    db.exec('DELETE FROM engrams')
    this.syncFromYaml()
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}
