/**
 * Migration importers (issue #441) — shared types.
 *
 * Every importer parses a competitor export into normalized `ImportRecord`s;
 * the engine (`runImport`) then routes each record through `plur.learn()` so
 * the existing dedup gates (content-hash fast path, cross-scope recurrence)
 * and the secret guard apply. Imports never raw-append to the store.
 */

export type ImportEngramType = 'behavioral' | 'terminological' | 'procedural' | 'architectural'

/** Normalized intermediate representation of one source memory. */
export interface ImportRecord {
  /** The assertion to learn. Required — empty statements become report errors. */
  statement: string
  /** PLUR engram type (already normalized by the parser). */
  type?: ImportEngramType
  /** Dotted domain path, e.g. 'infra.deploy'. */
  domain?: string
  /** PLUR scope, e.g. 'global', 'project:acme', 'user:alice'. Unset → core routing. */
  scope?: string
  tags?: string[]
  /** Normalized confidence in [0,1]. Mapped onto episodic.confidence (1-10). */
  confidence?: number
  /** Free-text origin. Unset → the engine stamps `import:<from>:<file>`. */
  source?: string
  /** Source-system creation timestamp (ISO 8601) → temporal.learned_at. */
  created_at?: string
  /** Source-system last-access timestamp (ISO 8601) → activation.last_accessed. */
  last_accessed?: string
  /** Validity window start (ISO date) → temporal.valid_from. */
  valid_from?: string
  /** Validity window end / expiry (ISO date) → temporal.valid_until. */
  valid_until?: string
  pinned?: boolean
}

/** Engram fields addressable from a generic field-mapping config. */
export type MappableField =
  | 'statement' | 'type' | 'domain' | 'scope' | 'tags' | 'confidence'
  | 'source' | 'created_at' | 'last_accessed' | 'valid_from' | 'valid_until' | 'pinned'

/**
 * Field-mapping config for the generic importer. `fields` maps engram fields
 * to dot-paths into each source row (e.g. `"domain": "meta.area"`); `defaults`
 * supplies constants for rows that lack a field.
 */
export interface FieldMapping {
  fields?: Partial<Record<MappableField, string>>
  defaults?: Partial<Record<MappableField, unknown>>
}

/** Input handed to an adapter's parse(). Text adapters may receive pre-read content. */
export interface ImportInput {
  /** Path to the input file (.json/.jsonl/.csv/.db). */
  path: string
  /** Pre-read text content — parse() reads `path` when omitted. */
  content?: string
  /** Field-mapping config (generic importer only). */
  mapping?: FieldMapping
}

/** A registered import source (`plur import --from <name>`). */
export interface ImportSource {
  name: string
  description: string
  /** false for declared-but-stubbed adapters (zep, letta) — parse() throws. */
  implemented: boolean
  parse(input: ImportInput): ImportRecord[]
}

export interface ImportRecordResult {
  statement: string
  action: 'imported' | 'skipped' | 'error'
  /** New engram id when imported; the existing engram's id when skipped (dedup). */
  id?: string
  /** Pre-existing engram ids this record potentially contradicts (heuristic). */
  conflicts?: string[]
  error?: string
}

/** Migration report: N imported, M skipped (dedup), K conflicts (+ errors). */
export interface MigrationReport {
  from: string
  path?: string
  dry_run: boolean
  total: number
  imported: number
  skipped: number
  conflicts: number
  errors: number
  records: ImportRecordResult[]
}
