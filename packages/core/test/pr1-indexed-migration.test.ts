/**
 * PR-1 (#353) storage-indexed migration: a pre-0.10.0 engrams.db (no `personal`
 * column) is migrated on open — ALTER TABLE ADD COLUMN personal, then a one-time
 * reindex backfills the flag from each engram's scope — so a previously-invisible
 * local engram becomes visible under a project-scope filter.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { IndexedStorage } from '../src/storage-indexed.js'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
let Database: any = null
let hasSqlite = false
try { Database = require('better-sqlite3'); hasSqlite = true } catch {}

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe.skipIf(!hasSqlite)('PR-1 indexed-storage personal-column migration (#353)', () => {
  it('migrates a pre-0.10.0 DB and makes a local engram visible under a project filter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-pr1-mig-'))
    dirs.push(dir)
    const dbPath = join(dir, 'engrams.db')
    const yamlPath = join(dir, 'engrams.yaml')

    // Seed schema-valid YAML via a real Plur (index:false so it writes only YAML).
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    const seed = new Plur({ path: dir })
    const seeded = seed.learn('old local engram about widgets', { scope: 'local' })

    // Build an OLD-schema engrams.db (no `personal` column) pointing at the YAML.
    if (existsSync(dbPath)) unlinkSync(dbPath)
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE engrams (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, scope TEXT NOT NULL,
      domain TEXT, last_accessed TEXT, data TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'primary');`)
    db.prepare('INSERT INTO engrams (id,status,scope,domain,last_accessed,data,source) VALUES (?,?,?,?,?,?,?)')
      .run(seeded.id, 'active', 'local', null, seeded.activation.last_accessed, JSON.stringify(seeded), 'primary')
    db.close()

    // Open via IndexedStorage — should ALTER TABLE ADD COLUMN personal + reindex.
    const store = new IndexedStorage(yamlPath, dbPath, [])
    const visible = store.loadFiltered({ status: 'active', scope: 'project:myapp' })
    expect(visible.some(e => e.id === seeded.id)).toBe(true)

    // Column now exists and the local engram's flag is 1.
    store.close()
    const db2 = new Database(dbPath)
    const cols = db2.prepare('PRAGMA table_info(engrams)').all().map((c: any) => c.name)
    expect(cols).toContain('personal')
    const row = db2.prepare('SELECT personal FROM engrams WHERE id = ?').get(seeded.id) as any
    expect(row.personal).toBe(1)
    db2.close()
  })
})
