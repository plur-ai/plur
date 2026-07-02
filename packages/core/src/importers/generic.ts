/**
 * Generic JSON / JSONL / CSV importer (issue #441).
 *
 * The foundation importer: any memory store that can export rows can be
 * imported. Field names are resolved in three steps:
 *   1. explicit `FieldMapping.fields` dot-paths (e.g. "domain": "meta.area"),
 *   2. the engram field name itself (statement, type, domain, ...) with
 *      common aliases for `statement` (text, memory, content, note, fact),
 *   3. `FieldMapping.defaults` constants.
 */
import type { FieldMapping, ImportRecord, MappableField } from './types.js'
import { getPath, normalizeConfidence, normalizeImportType, normalizeTags, normalizeTimestamp } from './normalize.js'

const STATEMENT_ALIASES = ['statement', 'text', 'memory', 'content', 'note', 'fact']
const WRAPPER_KEYS = ['results', 'memories', 'records', 'engrams', 'items', 'data']

export interface ParseGenericOptions {
  /** Used for format detection (.json/.jsonl/.ndjson/.csv). */
  filename?: string
  mapping?: FieldMapping
}

export function parseGenericContent(content: string, opts: ParseGenericOptions = {}): ImportRecord[] {
  const name = (opts.filename ?? '').toLowerCase()
  let rows: Record<string, unknown>[]
  if (name.endsWith('.csv')) {
    rows = parseCsv(content)
  } else if (name.endsWith('.jsonl') || name.endsWith('.ndjson')) {
    rows = parseJsonl(content)
  } else {
    rows = parseJsonRows(content)
  }
  return rows.map(row => mapRow(row, opts.mapping))
}

function parseJsonRows(content: string): Record<string, unknown>[] {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    // Not a single JSON document — a .json extension on line-delimited
    // exports is common, so fall back to JSONL before giving up.
    try {
      return parseJsonl(content)
    } catch {
      throw new Error('Failed to parse input as JSON (or JSONL). Check the file or pass a supported format (.json, .jsonl, .csv).')
    }
  }
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    for (const key of WRAPPER_KEYS) {
      const inner = (data as Record<string, unknown>)[key]
      if (Array.isArray(inner)) return inner as Record<string, unknown>[]
    }
    return [data as Record<string, unknown>]
  }
  throw new Error('Failed to parse input: expected a JSON array of records (or a {results|memories|records: [...]} wrapper).')
}

function parseJsonl(content: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      throw new Error(`Failed to parse JSONL line ${i + 1}.`)
    }
  }
  return rows
}

/** Minimal RFC 4180 CSV parser: quoted fields, "" escapes, embedded commas/newlines. */
export function parseCsv(content: string): Record<string, string>[] {
  const table: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => {
    // Skip fully empty trailing rows.
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) table.push(row)
    row = []
  }
  while (i < content.length) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { pushField(); i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { pushField(); pushRow(); i++; continue }
    field += ch; i++
  }
  if (field.length > 0 || row.length > 0) { pushField(); pushRow() }

  if (table.length === 0) return []
  const header = table[0].map(h => h.trim())
  return table.slice(1).map(cells => {
    const obj: Record<string, string> = {}
    header.forEach((h, idx) => { obj[h] = cells[idx] ?? '' })
    return obj
  })
}

function resolveField(row: Record<string, unknown>, field: MappableField, mapping?: FieldMapping): unknown {
  const path = mapping?.fields?.[field]
  let value: unknown
  if (path) {
    value = getPath(row, path)
  } else if (field === 'statement') {
    for (const alias of STATEMENT_ALIASES) {
      const v = row[alias]
      if (v !== undefined && v !== null && v !== '') { value = v; break }
    }
  } else {
    value = row[field]
  }
  if (value === undefined || value === null || value === '') {
    value = mapping?.defaults?.[field]
  }
  if (value === '') return undefined
  return value ?? undefined
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s.length > 0 ? s : undefined
}

export function mapRow(row: Record<string, unknown>, mapping?: FieldMapping): ImportRecord {
  const get = (field: MappableField) => resolveField(row, field, mapping)
  const rawType = str(get('type'))
  const pinnedRaw = get('pinned')
  const record: ImportRecord = {
    statement: str(get('statement')) ?? '',
  }
  if (rawType) record.type = normalizeImportType(rawType)
  const domain = str(get('domain'))
  if (domain) record.domain = domain
  const scope = str(get('scope'))
  if (scope) record.scope = scope
  const tags = normalizeTags(get('tags'))
  if (tags) record.tags = tags
  const confidence = normalizeConfidence(get('confidence'))
  if (confidence !== undefined) record.confidence = confidence
  const source = str(get('source'))
  if (source) record.source = source
  const createdAt = normalizeTimestamp(get('created_at'))
  if (createdAt) record.created_at = createdAt
  const lastAccessed = normalizeTimestamp(get('last_accessed'))
  if (lastAccessed) record.last_accessed = lastAccessed
  const validFrom = str(get('valid_from'))
  if (validFrom) record.valid_from = validFrom
  const validUntil = str(get('valid_until'))
  if (validUntil) record.valid_until = validUntil
  if (pinnedRaw === true || pinnedRaw === 1 || pinnedRaw === '1' || pinnedRaw === 'true') record.pinned = true
  return record
}
