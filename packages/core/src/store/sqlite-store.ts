/**
 * SQLite-based EngramStore implementation.
 * Promotes the existing optional SQLite index to a full store.
 * SQLite is a DERIVED store — can be rebuilt from YAML source of truth.
 */
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { EngramSchemaPassthrough, type Engram } from '../schemas/engram.js'
import type { EngramStore } from './types.js'

const require = createRequire(import.meta.url)

let Database: any = null

function getDatabase(): any {
  if (!Database) {
    try {
      Database = require('better-sqlite3')
    } catch {
      throw new Error(
        'better-sqlite3 is required for sqlite backend. Install it with: npm install better-sqlite3'
      )
    }
  }
  return Database
}

export class SqliteStore implements EngramStore {
  private dbPath: string
  private db: any = null

  constructor(dbPath: string) {
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

  async load(): Promise<Engram[]> {
    const db = this.getDb()
    const rows = db.prepare('SELECT data FROM engrams').all() as { data: string }[]
    return rows.map((r: { data: string }) => JSON.parse(r.data) as Engram)
  }

  async save(engrams: Engram[]): Promise<void> {
    const db = this.getDb()
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO engrams (id, status, scope, domain, last_accessed, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const tx = db.transaction(() => {
      db.exec('DELETE FROM engrams')
      for (const e of engrams) {
        upsert.run(e.id, e.status, e.scope, e.domain ?? null, e.activation.last_accessed, JSON.stringify(e))
      }
    })
    tx()
  }

  async append(engram: Engram): Promise<void> {
    const db = this.getDb()
    db.prepare(`
      INSERT OR REPLACE INTO engrams (id, status, scope, domain, last_accessed, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(engram.id, engram.status, engram.scope, engram.domain ?? null, engram.activation.last_accessed, JSON.stringify(engram))
  }

  async getById(id: string): Promise<Engram | null> {
    const db = this.getDb()
    const row = db.prepare('SELECT data FROM engrams WHERE id = ?').get(id) as { data: string } | undefined
    if (!row) return null
    return JSON.parse(row.data) as Engram
  }

  async remove(id: string): Promise<boolean> {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM engrams WHERE id = ?').run(id)
    return result.changes > 0
  }

  async count(filter?: { status?: string }): Promise<number> {
    const db = this.getDb()
    if (filter?.status) {
      return (db.prepare('SELECT COUNT(*) as c FROM engrams WHERE status = ?').get(filter.status) as any).c
    }
    return (db.prepare('SELECT COUNT(*) as c FROM engrams').get() as any).c
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  /** Import engrams from an array (e.g., from YAML migration). */
  async importFrom(engrams: Engram[]): Promise<void> {
    await this.save(engrams)
  }

  /** Export all engrams as an array (e.g., for YAML migration). */
  async exportAll(): Promise<Engram[]> {
    return this.load()
  }
}
