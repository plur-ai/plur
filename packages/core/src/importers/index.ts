/**
 * Migration importers (issue #441): `plur import --from <source> --path <file>`.
 *
 * Registry of import sources + the file → parse → learn pipeline. See
 * engine.ts for the dedup/conflict semantics and each adapter for its
 * source-format mapping.
 */
import { existsSync, readFileSync } from 'fs'
import { basename } from 'path'
import type { Plur } from '../index.js'
import type { FieldMapping, ImportInput, ImportSource, MigrationReport } from './types.js'
import { parseGenericContent } from './generic.js'
import { parseMem0Content } from './mem0.js'
import { parseGpEngramDb } from './gp-engram.js'
import { runImport } from './engine.js'
import { zepSource, lettaSource } from './stubs.js'

export type {
  ImportEngramType, ImportRecord, ImportInput, ImportSource,
  FieldMapping, MappableField, ImportRecordResult, MigrationReport,
} from './types.js'
export type { RunImportOptions } from './engine.js'
export { runImport } from './engine.js'
export { parseGenericContent, parseCsv } from './generic.js'
export { parseMem0Content } from './mem0.js'
export { parseGpEngramDb } from './gp-engram.js'
export { normalizeImportType, normalizeTimestamp, normalizeConfidence, normalizeTags } from './normalize.js'

function readText(input: ImportInput): string {
  if (input.content !== undefined) return input.content
  if (!existsSync(input.path)) throw new Error(`Input file not found: ${input.path}`)
  return readFileSync(input.path, 'utf-8')
}

export const IMPORT_SOURCES: ImportSource[] = [
  {
    name: 'generic',
    description: 'Generic JSON / JSONL / CSV export with optional --mapping field-mapping config',
    implemented: true,
    parse: (input) => parseGenericContent(readText(input), { filename: basename(input.path), mapping: input.mapping }),
  },
  {
    name: 'gp-engram',
    description: 'Gentleman-Programming/engram SQLite database (~/.engram/engram.db)',
    implemented: true,
    parse: (input) => {
      if (!existsSync(input.path)) throw new Error(`Input file not found: ${input.path}`)
      return parseGpEngramDb(input.path)
    },
  },
  {
    name: 'mem0',
    description: 'mem0 JSON export (Memory.get_all() {"results": [...]} shape)',
    implemented: true,
    parse: (input) => parseMem0Content(readText(input), { filename: basename(input.path) }),
  },
  zepSource,
  lettaSource,
]

export function listImportSources(): ImportSource[] {
  return IMPORT_SOURCES
}

export function getImportSource(name: string): ImportSource {
  const source = IMPORT_SOURCES.find(s => s.name === name)
  if (!source) {
    const implemented = IMPORT_SOURCES.filter(s => s.implemented).map(s => s.name).join(', ')
    const stubbed = IMPORT_SOURCES.filter(s => !s.implemented).map(s => s.name).join(', ')
    throw new Error(`Unknown import source "${name}". Available: ${implemented} (stubbed: ${stubbed}).`)
  }
  return source
}

export interface ImportFromOptions {
  from: string
  path: string
  mapping?: FieldMapping
  dryRun?: boolean
  scope?: string
}

/** File → parse → dedup-gated learn, in one call. Used by the CLI command. */
export function importFrom(plur: Plur, opts: ImportFromOptions): MigrationReport {
  const source = getImportSource(opts.from)
  const records = source.parse({ path: opts.path, mapping: opts.mapping })
  return runImport(plur, records, {
    from: opts.from,
    path: opts.path,
    dryRun: opts.dryRun,
    scope: opts.scope,
    defaultSource: `import:${opts.from}:${basename(opts.path)}`,
  })
}
