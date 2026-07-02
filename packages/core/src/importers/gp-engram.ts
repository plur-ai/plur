/**
 * Gentleman-Programming/engram importer (issue #441) — the flagship importer.
 *
 * gp-engram is a Go + SQLite(FTS5) memory tool for AI coding agents. Its
 * source of truth is the `observations` table (internal/store/store.go):
 *
 *   observations(id, sync_id, session_id, type, title, content, tool_name,
 *                project, scope['project'|'personal'|'global'], topic_key,
 *                normalized_hash, revision_count, duplicate_count,
 *                last_seen_at, review_after, pinned, created_at, updated_at,
 *                deleted_at)
 *
 * Mapping:
 *   title + content → statement ("title: content")
 *   type            → PLUR type via normalizeImportType (decision→architectural,
 *                     config/setup/ci→procedural, pattern/learning→behavioral, ...)
 *                     with the original type preserved as a tag
 *   topic_key       → domain (slashes → dots, e.g. decision/storage → decision.storage)
 *   scope+project   → 'global' → global; 'project' → project:<name>;
 *                     'personal' (or projectless) → unset, so core routing applies
 *   pinned          → pinned
 *   created_at      → temporal.learned_at (SQLite datetimes are UTC → normalized to ISO Z)
 *   last_seen_at    → activation.last_accessed (updated_at fallback)
 *   expires_at      → temporal.valid_until (a real expiry; upstream keeps it
 *                     NULL in "Phase 1" but the migration column exists)
 *   row id          → source `gp-engram:<file>#<id>`
 *
 * Deliberately NOT mapped: `review_after` (gp-engram's decay "review by" date —
 * mapping it to valid_until would make PLUR hard-skip the engram after that
 * date, which is stronger than the source semantics), soft-deleted rows
 * (deleted_at IS NOT NULL), sessions/user_prompts/memory_relations tables.
 *
 * Reuses the workspace's existing better-sqlite3 (already an optional
 * dependency of @plur-ai/core) via the same createRequire pattern as
 * store/sqlite-store.ts — no new dependencies.
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
