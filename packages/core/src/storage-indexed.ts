import { existsSync } from 'fs'
import { createRequire } from 'module'
import { loadEngrams, storePrefix } from './engrams.js'
import { isPersonalScope } from './scope-util.js'
import type { Engram } from './schemas/engram.js'
import type { StoreEntry } from './schemas/config.js'

const require = createRequire(import.meta.url)

/**
 * Schema-migration sentinel stored in SQLite's `PRAGMA user_version` (R2-D #13).
 * Bumped to 1 only AFTER the `personal`-column backfill completes successfully,
 * so a crash between the ADD COLUMN and the backfill self-heals on the next open
 * instead of being silently skipped by the old ALTER-success gate.
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
      // Add `personal` column to pre-0.10.0 DBs (#353 read-side fix). The new
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
      // R2-D (#13): make the backfill atomic + self-healing. The ALTER is DDL
      // that auto-commits immediately while syncFromYaml runs in its OWN
      // transaction; a crash in the gap left the column present with EVERY row at
      // DEFAULT 0, and the old `addedPersonalColumn` gate would NOT re-run the
      // backfill on the next open (the ALTER now throws, so the flag stays
      // false) — a silent, self-perpetuating read-side regression. We instead
      // gate the backfill on a `PRAGMA user_version` sentinel set ONLY after a
      // successful backfill: any open observing user_version < 1 (a fresh ADD, a
      // crash-interrupted backfill, or a brand-new empty DB) re-runs it
      // idempotently and stamps the sentinel, so the migration self-heals on the
      // next open rather than only on the next write.
      const userVersion = this.db.pragma('user_version', { simple: true }) as number
      if (userVersion < PERSONAL_BACKFILL_VERSION) {
        // A successful ADD COLUMN means an old DB whose existing rows are all at
        // DEFAULT 0 and must be backfilled. Otherwise (column already present)
        // only backfill when rows actually exist — an empty/fresh DB has nothing
        // to fix and reindex()/the next write will populate it. This keeps the
        // common fresh-open path from doing a redundant full sync while still
        // re-healing a crash-interrupted backfill (column present, rows present,
        // sentinel not yet stamped).
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
    }
    return this.db
  }

  /** Load all engrams from SQLite index. Auto-rebuilds if db missing. */
  loadAll(): Engram[] {
    if (!existsSync(this.dbPath)) {
      this.reindex()
    }
    const db = this.getDb()
    const rows = db.prepare('SELECT data FROM engrams').all() as { data: string }[]
    return rows.map((r: { data: string }) => JSON.parse(r.data) as Engram)
  }

  /** Load engrams with SQL-level filtering. */
  loadFiltered(filter: { status?: string; scope?: string; domain?: string }): Engram[] {
    if (!existsSync(this.dbPath)) {
      this.reindex()
    }
    const db = this.getDb()
    const conditions: string[] = []
    const params: any[] = []

    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.scope) {
      // Read-side scope filter (#353). `personal = 1` passes ALL personal-family
      // scopes (local, global, user:*, agent:*) — set at index time from
      // isPersonalScope — not just global, so a project-scope recall sees personal
      // engrams. The two `scope` params (exact + LIKE prefix) are unchanged.
      conditions.push("(personal = 1 OR scope = ? OR scope LIKE ? || '%')")
      params.push(filter.scope, filter.scope)
    }
    if (filter.domain) {
      conditions.push("domain LIKE ? || '%'")
      params.push(filter.domain)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db.prepare(`SELECT data FROM engrams ${where}`).all(...params) as { data: string }[]
    return rows.map((r: { data: string }) => JSON.parse(r.data) as Engram)
  }

  /** Count engrams with optional status filter. */
  count(filter?: { status?: string }): number {
    if (!existsSync(this.dbPath)) {
      this.reindex()
    }
    const db = this.getDb()
    if (filter?.status) {
      return (db.prepare('SELECT COUNT(*) as c FROM engrams WHERE status = ?').get(filter.status) as any).c
    }
    return (db.prepare('SELECT COUNT(*) as c FROM engrams').get() as any).c
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
      const primaryEngrams = loadEngrams(this.engramsPath)
      for (const e of primaryEngrams) {
        // `personal` mirrors isPersonalScope of the stored scope so loadFiltered
        // can pass personal-family scopes under any project-scope filter (#353).
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
        const storeEngrams = loadEngrams(store.path)
        const prefix = storePrefix(store.scope)
        for (const e of storeEngrams) {
          // Scope validation: skip mismatched scopes
          if (e.scope !== 'global' && e.scope !== store.scope && !e.scope.startsWith(store.scope)) {
            continue
          }
          const nsId = e.id.replace(/^(ENG|ABS|META)-/, `$1-${prefix}-`)
          // Cross-store narrowing (UNCHANGED, intentional): a global-scoped
          // secondary-store engram is renamed to the store's scope on load (#353
          // documents this as preserved behavior). `personal` reflects the FINAL
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
