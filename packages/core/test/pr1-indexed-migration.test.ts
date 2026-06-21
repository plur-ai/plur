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
    // R2-D (#13): a completed migration stamps the user_version sentinel so it
    // does not re-backfill on every subsequent open.
    expect(db2.pragma('user_version', { simple: true })).toBe(1)
    db2.close()
  })

  // R2-D (#13): a crash between the ADD COLUMN (DDL auto-commits) and the
  // separate backfill transaction left the column present with EVERY row at
  // DEFAULT 0, and the old ALTER-success gate would NOT re-run the backfill on
  // the next open (the ALTER now throws). The user_version sentinel makes the
  // migration self-heal: any open observing user_version < 1 with stale rows
  // re-runs the backfill, so a purely read-only consumer is never stuck in the
  // transient personal-invisible window.
  it('self-heals a crash-interrupted backfill (column present, rows at DEFAULT 0, sentinel unstamped)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-pr1-crash-'))
    dirs.push(dir)
    const dbPath = join(dir, 'engrams.db')
    const yamlPath = join(dir, 'engrams.yaml')

    // Seed schema-valid YAML (a local + a global engram) via a real Plur.
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    const seed = new Plur({ path: dir })
    const localE = seed.learn('crash-window local engram', { scope: 'local' })
    const globalE = seed.learn('crash-window global engram', { scope: 'global' })

    // Build a DB that simulates the post-crash state: the `personal` column
    // EXISTS (ALTER committed) but every row is at the DEFAULT 0 and the
    // user_version sentinel was never stamped (backfill never completed).
    if (existsSync(dbPath)) unlinkSync(dbPath)
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE engrams (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, scope TEXT NOT NULL,
      domain TEXT, last_accessed TEXT, data TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'primary',
      personal INTEGER NOT NULL DEFAULT 0);`)
    const ins = db.prepare('INSERT INTO engrams (id,status,scope,domain,last_accessed,data,source,personal) VALUES (?,?,?,?,?,?,?,0)')
    ins.run(localE.id, 'active', 'local', null, localE.activation.last_accessed, JSON.stringify(localE), 'primary')
    ins.run(globalE.id, 'active', 'global', null, globalE.activation.last_accessed, JSON.stringify(globalE), 'primary')
    // user_version stays 0 — the crash sentinel signal.
    expect(db.pragma('user_version', { simple: true })).toBe(0)
    db.close()

    // Open via IndexedStorage — must detect the unstamped sentinel and re-backfill.
    const store = new IndexedStorage(yamlPath, dbPath, [])
    const visible = store.loadFiltered({ status: 'active', scope: 'project:myapp' })
    // Both personal-family engrams are visible again under a project-scope filter.
    expect(visible.some(e => e.id === localE.id)).toBe(true)
    expect(visible.some(e => e.id === globalE.id)).toBe(true)
    store.close()

    // Flags corrected AND the sentinel is now stamped (won't re-heal needlessly).
    const db2 = new Database(dbPath)
    expect((db2.prepare('SELECT personal FROM engrams WHERE id = ?').get(localE.id) as any).personal).toBe(1)
    expect((db2.prepare('SELECT personal FROM engrams WHERE id = ?').get(globalE.id) as any).personal).toBe(1)
    expect(db2.pragma('user_version', { simple: true })).toBe(1)
    db2.close()
  })
})
