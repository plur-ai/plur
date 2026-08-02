import { runMigrations, rollbackMigrations, getSchemaVersion, CURRENT_SCHEMA_VERSION } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import { detectPlurStorage } from '@plur-ai/core'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const path = flags.path || process.env.PLUR_PATH || undefined
  const paths = detectPlurStorage(path)
  const subcommand = args[0] || 'up'

  if (subcommand === 'status') {
    const version = getSchemaVersion(paths.config)
    const result = {
      schema_version: version,
      latest_version: CURRENT_SCHEMA_VERSION,
      pending: CURRENT_SCHEMA_VERSION - version,
    }
    if (shouldOutputJson(flags)) {
      outputJson(result)
    } else {
      outputText(`Schema version: ${version}/${CURRENT_SCHEMA_VERSION}`)
      if (result.pending > 0) {
        outputText(`${result.pending} migration(s) pending. Run 'plur migrate' to apply.`)
      } else {
        outputText('Up to date.')
      }
    }
    return
  }

  if (subcommand === 'up' || subcommand === undefined) {
    try {
      const result = runMigrations(paths.engrams, paths.config)
      if (shouldOutputJson(flags)) {
        outputJson(result)
      } else {
        // Confirmation of a requested mutation → suppressed by --quiet (#730).
        if (result.applied.length === 0) {
          outputInfo('Already up to date.', flags)
        } else {
          outputInfo(`Applied ${result.applied.length} migration(s):`, flags)
          for (const id of result.applied) {
            outputInfo(`  - ${id}`, flags)
          }
          outputInfo(`Schema version: ${result.schema_version}`, flags)
          if (result.backup_path) {
            outputInfo(`Backup: ${result.backup_path}`, flags)
          }
        }
      }
    } catch (err: any) {
      exit(1, err.message)
    }
    return
  }

  if (subcommand === 'down') {
    const targetStr = args[1]
    if (!targetStr) {
      exit(1, 'Usage: plur migrate down <target-version>')
    }
    const target = parseInt(targetStr, 10)
    if (isNaN(target) || target < 0) {
      exit(1, 'Target version must be a non-negative integer')
    }
    try {
      const result = rollbackMigrations(paths.engrams, paths.config, target)
      if (shouldOutputJson(flags)) {
        outputJson(result)
      } else {
        if (result.applied.length === 0) {
          outputInfo('Nothing to roll back.', flags)
        } else {
          outputInfo(`Rolled back ${result.applied.length} migration(s):`, flags)
          for (const id of result.applied) {
            outputInfo(`  - ${id}`, flags)
          }
          outputInfo(`Schema version: ${result.schema_version}`, flags)
        }
      }
    } catch (err: any) {
      exit(1, err.message)
    }
    return
  }

  exit(1, `Unknown subcommand: ${subcommand}. Use 'up', 'down <version>', or 'status'.`)
}
