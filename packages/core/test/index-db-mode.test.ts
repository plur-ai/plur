/**
 * The SQLite index (engrams.db) is never readable by more accounts than the
 * store files it mirrors (security audit 2026-11-06).
 *
 * syncFromYaml copies every engram of engrams.yaml and of every file-backed
 * secondary store into engrams.db, which SQLite used to create at its default
 * 0644 (minus umask) beside an owner-tightened 0600 store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { IndexedStorage, prepareIndexFiles } from '../src/storage-indexed.js'

const require = createRequire(import.meta.url)
let hasSqlite = false
try { new (require('better-sqlite3'))(':memory:').close(); hasSqlite = true } catch { /* native binding not built here */ }

const isPosix = process.platform !== 'win32'

let root: string
let storePath: string
let dbPath: string

const mode = (p: string) => fs.statSync(p).mode & 0o777

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-index-mode-'))
  storePath = path.join(root, 'engrams.yaml')
  dbPath = path.join(root, 'engrams.db')
  fs.writeFileSync(storePath, 'engrams: []\n')
  fs.chmodSync(storePath, 0o600)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!isPosix)('engrams.db mode follows the store', () => {
  it('a new index file is created owner-only beside a 0600 store', () => {
    prepareIndexFiles(dbPath, [storePath])
    expect(mode(dbPath)).toBe(0o600)
  })

  it('an existing wider index (and its WAL/SHM) is tightened to the store', () => {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      fs.writeFileSync(f, '')
      fs.chmodSync(f, 0o664)
    }
    prepareIndexFiles(dbPath, [storePath])
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) expect(mode(f)).toBe(0o600)
  })

  it('a tighter secondary store narrows the index too', () => {
    fs.chmodSync(storePath, 0o644)
    const secondary = path.join(root, 'other.yaml')
    fs.writeFileSync(secondary, 'engrams: []\n')
    fs.chmodSync(secondary, 0o600)
    prepareIndexFiles(dbPath, [storePath, secondary])
    expect(mode(dbPath)).toBe(0o600)
  })

  it.skipIf(!hasSqlite)('IndexedStorage.syncFromYaml leaves engrams.db owner-only', () => {
    const s = new IndexedStorage(storePath, dbPath)
    s.syncFromYaml()
    s.close()
    expect(mode(dbPath)).toBe(0o600)
    for (const f of [`${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) expect(mode(f) & 0o077).toBe(0)
  })
})
