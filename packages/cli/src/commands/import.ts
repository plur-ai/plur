/**
 * `plur import --from <source> --path <file>` (issue #441).
 *
 * FLAG SPLIT — deliberate deviation from the other commands: per the issue
 * spec, `--path` here is the INPUT FILE to import. The storage-directory
 * override (what the global `--path` means everywhere else) is `--store` for
 * this command. `$PLUR_PATH` still applies when `--store` is not given.
 *
 * All imports route through core's importFrom → runImport → plur.learn(), so
 * the content-hash dedup gate and the secret guard apply — never raw-append.
 */
import { readFileSync } from 'fs'
import { Plur, importFrom, listImportSources, type FieldMapping, type MigrationReport } from '@plur-ai/core'
import type { GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

function usage(): string {
  const implemented = listImportSources().filter(s => s.implemented).map(s => s.name).join('|')
  const stubbed = listImportSources().filter(s => !s.implemented).map(s => s.name).join(', ')
  return `Usage: plur import --from <${implemented}> --path <input-file> [--dry-run] [--scope <scope>] [--mapping <file.json>] [--store <dir>]

  --from <source>   Source system: generic (JSON/JSONL/CSV), gp-engram (SQLite .db), mem0 (JSON export)
                    Planned (stubbed): ${stubbed}
  --path <file>     Input file to import (for this command --path is the INPUT; use --store for storage)
  --dry-run         Analyze and print the migration report without writing
  --scope <scope>   Force all imported engrams into this scope
  --mapping <file>  Field-mapping config for --from generic ({"fields": {...}, "defaults": {...}})
  --store <dir>     Override the PLUR storage directory (default: $PLUR_PATH or ~/.plur)`
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let from: string | undefined
  // The global flag parser consumed `--path <value>` into flags.path — for
  // import that value is the input file (see header comment).
  let file: string | undefined = flags.path
  let store: string | undefined
  let scope: string | undefined
  let mappingPath: string | undefined
  let dryRun = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--from' && i + 1 < args.length) { from = args[++i]; i++ }
    else if (arg === '--file' && i + 1 < args.length) { file = args[++i]; i++ }
    else if (arg === '--store' && i + 1 < args.length) { store = args[++i]; i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--mapping' && i + 1 < args.length) { mappingPath = args[++i]; i++ }
    else if (arg === '--dry-run') { dryRun = true; i++ }
    else { i++ }
  }

  if (!from || !file) {
    exit(1, usage())
  }

  let mapping: FieldMapping | undefined
  if (mappingPath) {
    try {
      mapping = JSON.parse(readFileSync(mappingPath, 'utf-8'))
    } catch (err) {
      exit(1, `Failed to read mapping file ${mappingPath}: ${(err as Error).message}`)
    }
  }

  const plur = new Plur({ path: store || process.env.PLUR_PATH || undefined })
  const report = importFrom(plur, { from, path: file, mapping, dryRun, scope })

  if (shouldOutputJson(flags)) {
    outputJson(report)
    return
  }
  printReport(report)
}

function printReport(report: MigrationReport): void {
  const prefix = report.dry_run ? '[dry-run] ' : ''
  outputText(`${prefix}Migration report — ${report.from} (${report.path ?? 'stdin'})`)
  outputText(`  ${report.imported} imported, ${report.skipped} skipped (dedup), ${report.conflicts} conflict(s), ${report.errors} error(s) of ${report.total} total`)
  for (const rec of report.records) {
    if (rec.action === 'error') {
      outputText(`  ✗ error: ${truncate(rec.statement)} — ${rec.error}`)
    } else if (rec.conflicts && rec.conflicts.length > 0) {
      outputText(`  ⚠ conflict: ${truncate(rec.statement)} — potentially contradicts ${rec.conflicts.join(', ')} (review with: plur tensions --scan)`)
    }
  }
}

function truncate(s: string, max = 60): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}
