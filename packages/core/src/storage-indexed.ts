import { existsSync } from 'fs'
import { createRequire } from 'module'
import { loadEngrams } from './engrams.js'
import type { Engram } from './schemas/engram.js'

const require = createRequire(import.meta.url)

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
  private db: any = null

  constructor(engramsPath: string, dbPath: string) {
    this.engramsPath = engramsPath
    this.dbPath = dbPath
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
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_status ON engrams(status);
        CREATE INDEX IF NOT EXISTS idx_scope ON engrams(scope);
        CREATE INDEX IF NOT EXISTS idx_domain ON engrams(domain);
      `)
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
      conditions.push("(scope = 'global' OR scope = ? OR scope LIKE ? || '%')")
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

  /** Sync SQLite index from YAML source of truth. */
  syncFromYaml(): void {
    const engrams = loadEngrams(this.engramsPath)
    const db = this.getDb()
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO engrams (id, status, scope, domain, last_accessed, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const deleteStmt = db.prepare('DELETE FROM engrams WHERE id = ?')

    const yamlIds = new Set(engrams.map(e => e.id))
    const dbIds = new Set(
      (db.prepare('SELECT id FROM engrams').all() as { id: string }[]).map((r: { id: string }) => r.id)
    )

    const tx = db.transaction(() => {
      for (const e of engrams) {
        upsert.run(e.id, e.status, e.scope, e.domain ?? null, e.activation.last_accessed, JSON.stringify(e))
      }
      for (const id of dbIds) {
        if (!yamlIds.has(id)) deleteStmt.run(id)
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
