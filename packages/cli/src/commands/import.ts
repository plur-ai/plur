/**
 * `plur import --from <source> --path <file>`.
 *
 * FLAG SPLIT — deliberate deviation from the other commands: `--path` here is
 * the INPUT FILE to import. The storage-directory
 * override (what the global `--path` means everywhere else) is `--store` for
 * this command. `$PLUR_PATH` still applies when `--store` is not given.
 *
 * All imports route through core's importFrom → runImport → plur.learn(), so
 * the content-hash dedup gate and the secret guard apply — never raw-append.
 */
import { readFileSync } from 'fs'
import { basename } from 'path'
import { getImportSource, runImport, listImportSources, type FieldMapping, type ImportRecord, type MigrationReport } from '@plur-ai/core'
import { askPinPolicyConfirmation } from '../lib/pin-confirm.js'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

async function usage(): Promise<string> {
  const implemented = (await listImportSources()).filter(s => s.implemented).map(s => s.name).join('|')
  const stubbed = (await listImportSources()).filter(s => !s.implemented).map(s => s.name).join(', ')
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
    exit(1, await usage())
  }

  let mapping: FieldMapping | undefined
  if (mappingPath) {
    try {
      mapping = JSON.parse(readFileSync(mappingPath, 'utf-8'))
    } catch (err) {
      exit(1, `Failed to read mapping file ${mappingPath}: ${(err as Error).message}`)
    }
  }

  // Via createPlur, not `new Plur` directly: the CLI entrypoint drains
  // background index work through getLastPlurInstance() before exiting, and
  // only sees instances made by createPlur. --store is mapped onto flags.path.
  const plur = createPlur({ ...flags, path: store || flags.path })
  // The importer is whoever runs the CLI (overhaul D2): the owner, unless PLUR_ACTOR=agent.
  // Parsed here rather than through core's importFrom (same parse, same
  // runImport) so the pinned records can be counted before anything is written.
  let records: ImportRecord[] = getImportSource(from!).parse({ path: file!, mapping })
  let actor = plur.defaultActor
  let pinsNotConfirmed = 0
  let pinOutcome: 'requested' | 'unpinned' | undefined
  // H11: a pin from a file is a pin grant like `plur pin`. Under
  // pinning.agents request/deny the owner confirms at a terminal (S1);
  // PLUR_ACTOR=owner alone does not count. Unconfirmed, the records are
  // imported without their pins: as pin requests under request, plainly
  // unpinned under deny. An agent actor already gets that from core.
  const pinned = records.filter(r => r.pinned).length
  if (pinned > 0 && !dryRun && actor === 'owner') {
    const answer = await askPinPolicyConfirmation(plur, `Import ${pinned} pinned record${pinned === 1 ? '' : 's'} from ${file} as pins`)
    if (!answer.confirmed) {
      pinsNotConfirmed = pinned
      if (answer.policy === 'request') { actor = 'agent'; pinOutcome = 'requested' }
      else { records = records.map(r => { const { pinned: _drop, ...rest } = r; return rest }); pinOutcome = 'unpinned' }
    }
  }
  const report = await runImport(plur, records, {
    from: from!, path: file, dryRun, scope, defaultSource: `import:${from}:${basename(file!)}`, actor,
  })

  const pinsNote = pinsNotConfirmed === 0 ? undefined : pinOutcome === 'requested'
    ? `${pinsNotConfirmed} pinned record(s) were imported but NOT pinned: pinning.agents needs a confirmation typed at a terminal. They wait as pin requests; review with: plur pin review`
    : `${pinsNotConfirmed} pinned record(s) were imported but NOT pinned: pinning.agents is "deny" and the pins were not confirmed at a terminal. Pin them with: plur pin <id>`

  if (shouldOutputJson(flags)) {
    outputJson(pinsNote ? { ...report, pins_not_confirmed: pinsNotConfirmed, pins_outcome: pinOutcome, pins_note: pinsNote } : report)
    return
  }
  printReport(report)
  if (pinsNote) outputText(`  ${pinsNote}`)
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
