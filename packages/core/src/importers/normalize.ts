/**
 * Normalization helpers shared by the migration importers (issue #441).
 */
import type { ImportEngramType } from './types.js'

/**
 * Map competitor type/kind names onto the 4 PLUR engram types. Unknown or
 * missing types default to 'behavioral' (the same default `learn()` applies).
 */
const TYPE_MAP: Record<string, ImportEngramType> = {
  // native
  behavioral: 'behavioral',
  terminological: 'terminological',
  procedural: 'procedural',
  architectural: 'architectural',
  // architectural family (decisions & structure)
  decision: 'architectural',
  adr: 'architectural',
  architecture: 'architectural',
  design: 'architectural',
  refactor: 'architectural',
  // procedural family (how-to & setup)
  procedure: 'procedural',
  howto: 'procedural',
  'how-to': 'procedural',
  how_to: 'procedural',
  workflow: 'procedural',
  runbook: 'procedural',
  config: 'procedural',
  setup: 'procedural',
  infra: 'procedural',
  infrastructure: 'procedural',
  ci: 'procedural',
  // terminological family (definitions)
  definition: 'terminological',
  term: 'terminological',
  glossary: 'terminological',
  concept: 'terminological',
  // behavioral family (facts, preferences, conventions, findings)
  preference: 'behavioral',
  policy: 'behavioral',
  pattern: 'behavioral',
  convention: 'behavioral',
  guideline: 'behavioral',
  fact: 'behavioral',
  learning: 'behavioral',
  learn: 'behavioral',
  bug: 'behavioral',
  bugfix: 'behavioral',
  fix: 'behavioral',
  incident: 'behavioral',
  hotfix: 'behavioral',
  discovery: 'behavioral',
  investigation: 'behavioral',
  root_cause: 'behavioral',
  'root-cause': 'behavioral',
  session_summary: 'behavioral',
  manual: 'behavioral',
}

export function normalizeImportType(raw: string | undefined): ImportEngramType {
  if (!raw) return 'behavioral'
  return TYPE_MAP[raw.trim().toLowerCase()] ?? 'behavioral'
}

/**
 * Normalize a source timestamp toward ISO 8601 without inventing precision:
 *   - SQLite `datetime('now')` values ("2025-12-01 09:15:00", UTC by contract)
 *     become "2025-12-01T09:15:00Z".
 *   - Anything already ISO-shaped (with T / timezone / date-only) passes
 *     through untouched so source fidelity is preserved.
 */
export function normalizeTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  if (!s) return undefined
  const sqliteShape = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s)
  if (sqliteShape) return `${sqliteShape[1]}T${sqliteShape[2]}Z`
  return s
}

/**
 * Normalize a confidence value into [0,1]. Accepts native 0-1 floats, 1-10
 * scales (÷10), and 0-100 scales (÷100). Non-numeric → undefined.
 */
export function normalizeConfidence(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (n < 0) return 0
  if (n <= 1) return n
  if (n <= 10) return n / 10
  if (n <= 100) return n / 100
  return 1
}

/** Coerce tag input (array or delimited string) into a clean string array. */
export function normalizeTags(raw: unknown): string[] | undefined {
  let parts: string[]
  if (Array.isArray(raw)) parts = raw.map(t => String(t))
  else if (typeof raw === 'string') parts = raw.split(/[|;,]/)
  else return undefined
  const tags = parts.map(t => t.trim()).filter(t => t.length > 0)
  return tags.length > 0 ? tags : undefined
}

/** Resolve a dot-path (e.g. "meta.area") into a nested object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}
