/**
 * mem0 importer (issue #441).
 *
 * Parses mem0's JSON export shape — the `{"results": [...]}` envelope that
 * `Memory.get_all()` returns (v1.1+, mem0 OSS `mem0/memory/main.py`) and the
 * platform export equivalents. Each memory item carries:
 *   id, memory (the text), hash, created_at, updated_at, plus promoted payload
 *   keys user_id / agent_id / run_id / actor_id / role / expiration_date, an
 *   optional metadata object, and (platform) categories.
 *
 * Mapping:
 *   memory          → statement
 *   user_id         → scope `user:<id>`   (agent_id → `agent:<id>` fallback)
 *   categories      → tags
 *   created_at      → temporal.learned_at (via ImportRecord.created_at)
 *   updated_at      → activation.last_accessed (via ImportRecord.last_accessed)
 *   expiration_date → temporal.valid_until
 *   id              → source `mem0:<id>`
 * Graph `relations` arrays and free-form `metadata` are not imported.
 */
import type { ImportRecord } from './types.js'
import { normalizeTags, normalizeTimestamp } from './normalize.js'

export interface ParseMem0Options {
  filename?: string
}

export function parseMem0Content(content: string, opts: ParseMem0Options = {}): ImportRecord[] {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    throw new Error('Failed to parse mem0 export: not valid JSON.')
  }

  let rows: unknown[]
  if (Array.isArray(data)) {
    rows = data
  } else if (data && typeof data === 'object' && Array.isArray((data as any).results)) {
    rows = (data as any).results
  } else if (data && typeof data === 'object' && Array.isArray((data as any).memories)) {
    rows = (data as any).memories
  } else {
    throw new Error('Failed to parse mem0 export: expected {"results": [...]} (Memory.get_all() shape) or a bare array of memories.')
  }

  return rows.map((raw, idx) => {
    const m = (raw ?? {}) as Record<string, unknown>
    const statement = firstString(m.memory, m.text, m.data) ?? ''
    const record: ImportRecord = { statement }

    const userId = firstString(m.user_id)
    const agentId = firstString(m.agent_id)
    if (userId) record.scope = `user:${userId}`
    else if (agentId) record.scope = `agent:${agentId}`

    const tags = normalizeTags(m.categories)
    if (tags) record.tags = tags

    const createdAt = normalizeTimestamp(m.created_at)
    if (createdAt) record.created_at = createdAt
    const updatedAt = normalizeTimestamp(m.updated_at)
    if (updatedAt) record.last_accessed = updatedAt
    const expiration = firstString(m.expiration_date)
    if (expiration) record.valid_until = expiration

    const id = firstString(m.id)
    record.source = id ? `mem0:${id}` : `mem0:${opts.filename ?? 'export'}#${idx}`
    return record
  })
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return undefined
}
