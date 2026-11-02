/**
 * Gentleman-Programming/engram importer: reads its `observations` table (SQLite).
 * Mapping: title + content → statement; type → normalizeImportType (original kept as
 * a tag); topic_key → domain (slashes → dots); scope 'global' → global, 'project' →
 * project:<name>, 'personal'/projectless → unset (core routing); pinned → pinned;
 * created_at → temporal.learned_at (UTC → ISO Z); last_seen_at (else updated_at) →
 * activation.last_accessed; expires_at → temporal.valid_until; source `gp-engram:<file>#<id>`.
 * NOT mapped: `review_after` (valid_until would hard-skip, stronger than the source),
 * soft-deleted rows, other tables. Loads better-sqlite3 as store/sqlite-store.ts does.
 */
import { existsSync } from 'fs'
import { basename } from 'path'
import { createRequire } from 'module'
import type { ImportRecord } from './types.js'
import { normalizeImportType, normalizeTimestamp } from './normalize.js'

const require = createRequire(import.meta.url)

let Database: any = null

function getDatabase(): any {
  if (!Database) {
    try {
      Database = require('better-sqlite3')
    } catch {
      throw new Error(
        'better-sqlite3 is required to import a gp-engram .db. Install it with: npm install better-sqlite3'
      )
    }
  }
  return Database
}

/** Columns beyond the base set that later gp-engram migrations added — select only what exists. */
const OPTIONAL_COLUMNS = [
  'tool_name', 'project', 'scope', 'topic_key', 'pinned',
  'last_seen_at', 'updated_at', 'deleted_at', 'expires_at',
] as const

export function parseGpEngramDb(path: string): ImportRecord[] {
  if (!existsSync(path)) {
    throw new Error(`gp-engram database not found: ${path}`)
  }
  const DB = getDatabase()
  const db = new DB(path, { readonly: true, fileMustExist: true })
  try {
    const cols = new Set<string>(
      (db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>).map(c => c.name),
    )
    for (const required of ['id', 'type', 'title', 'content', 'created_at']) {
      if (!cols.has(required)) {
        throw new Error(`Not a gp-engram database (observations table missing column '${required}'): ${path}`)
      }
    }
    const select = ['id', 'type', 'title', 'content', 'created_at', ...OPTIONAL_COLUMNS.filter(c => cols.has(c))]
    const where = cols.has('deleted_at') ? 'WHERE deleted_at IS NULL' : ''
    const rows = db.prepare(`SELECT ${select.join(', ')} FROM observations ${where} ORDER BY id`).all() as Array<Record<string, unknown>>
    const file = basename(path)
    return rows.map(row => mapObservation(row, file))
  } finally {
    db.close()
  }
}

function mapObservation(row: Record<string, unknown>, file: string): ImportRecord {
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  const content = typeof row.content === 'string' ? row.content.trim() : ''
  const statement = title && content ? `${title}: ${content}` : (content || title)

  const record: ImportRecord = {
    statement,
    source: `gp-engram:${file}#${row.id}`,
  }

  const rawType = typeof row.type === 'string' ? row.type.trim() : ''
  record.type = normalizeImportType(rawType)
  if (rawType) record.tags = [rawType]

  const topicKey = typeof row.topic_key === 'string' ? row.topic_key.trim() : ''
  if (topicKey) record.domain = topicKey.replace(/\//g, '.')

  const gpScope = typeof row.scope === 'string' ? row.scope.trim().toLowerCase() : 'project'
  const project = typeof row.project === 'string' ? row.project.trim() : ''
  if (gpScope === 'global') record.scope = 'global'
  else if (gpScope !== 'personal' && project) record.scope = `project:${project}`
  // 'personal' (and projectless 'project' rows) stay unset → core scope routing.

  if (row.pinned === 1 || row.pinned === true) record.pinned = true

  const createdAt = normalizeTimestamp(row.created_at)
  if (createdAt) record.created_at = createdAt
  const lastAccessed = normalizeTimestamp(row.last_seen_at) ?? normalizeTimestamp(row.updated_at)
  if (lastAccessed) record.last_accessed = lastAccessed
  const expiresAt = normalizeTimestamp(row.expires_at)
  if (expiresAt) record.valid_until = expiresAt

  return record
}
