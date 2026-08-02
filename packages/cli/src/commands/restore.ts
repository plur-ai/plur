/**
 * `plur restore` — list, inspect and restore validity-gated store snapshots
 * (audit #794, issue #799).
 *
 * Restoring is itself a whole-corpus overwrite, which is the exact operation
 * the #794 guards exist to constrain. So the default is to SHOW the plan, not
 * to perform it: `plur restore` prints what would happen, and only
 * `--yes` actually writes.
 */
import type { GlobalFlags } from '../plur.js'
import { detectPlurStorage, listBackups, planRestore, restoreBackup } from '@plur-ai/core'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

function usage(): never {
  exit(1, [
    'Usage:',
    '  plur restore --list                 Show available snapshots',
    '  plur restore [--date <YYYY-MM-DD>]  Show what restoring would do (default: newest)',
    '  plur restore --yes [--date <D>]     Actually restore',
    '',
    'Options:',
    '  --force   Restore even if the snapshot fails verification (inspect it first)',
  ].join('\n'))
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  // Paths are resolved directly rather than through a Plur instance: this
  // command exists for the case where the store is unreadable, and constructing
  // an engine would be the very thing that fails.
  const paths = detectPlurStorage(flags.path || process.env.PLUR_PATH || undefined)
  const root = paths.root
  const storePath = paths.engrams

  let list = false
  let confirm = false
  let force = false
  let date: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--list') list = true
    else if (arg === '--yes') confirm = true
    else if (arg === '--force') force = true
    else if (arg === '--date' && i + 1 < args.length) date = args[++i]
    else if (arg === '--help' || arg === '-h') usage()
    else usage()
  }

  if (list) {
    const backups = listBackups(root)
    if (shouldOutputJson(flags)) return outputJson({ backups })
    if (backups.length === 0) {
      return outputText(`No snapshots yet in ${root}/backups.\nOne is taken on the first store write each day.`)
    }
    outputText(
      backups
        .map(b => `${b.stamp}  ${String(b.count ?? '?').padStart(6)} engrams  ${(b.size / 1024).toFixed(1)} KiB${b.sha256 ? '' : '  (no sidecar — unverifiable)'}`)
        .join('\n'),
    )
    return
  }

  let plan
  try {
    plan = planRestore(root, storePath, date)
  } catch (err) {
    return exit(1, (err as Error).message)
  }

  if (!confirm) {
    if (shouldOutputJson(flags)) return outputJson({ dry_run: true, ...plan })
    const lines = [
      `Would restore: ${plan.backup.path}`,
      `  taken:     ${plan.backup.stamp}`,
      `  engrams:   ${plan.validity.count ?? '?'}`,
      `  integrity: ${plan.integrityOk ? 'sha256 matches sidecar' : 'FAILED — ' + (plan.backup.sha256 ? 'bytes do not match sidecar' : 'no sidecar')}`,
      `  validity:  ${plan.validity.ok ? 'passes all checks' : 'FAILED — ' + plan.validity.reasons.join('; ')}`,
    ]
    if (plan.wouldLose.length > 0) {
      lines.push(
        '',
        `${plan.wouldLose.length} engram(s) in the CURRENT store are not in this snapshot and would be replaced:`,
        ...plan.wouldLose.slice(0, 20).map(id => `  ${id}`),
        ...(plan.wouldLose.length > 20 ? [`  … and ${plan.wouldLose.length - 20} more`] : []),
      )
    }
    if (plan.unrecoverable.length > 0) {
      lines.push(
        '',
        `History records ${plan.unrecoverable.length} engram(s) created after this snapshot that it does not contain:`,
        ...plan.unrecoverable.slice(0, 20).map(id => `  ${id}`),
      )
    }
    lines.push('', 'Nothing has been changed. Re-run with --yes to restore.')
    return outputText(lines.join('\n'))
  }

  try {
    const result = restoreBackup(root, storePath, { stamp: date, force })
    if (shouldOutputJson(flags)) return outputJson(result)
    outputText(
      [
        `Restored ${result.backup.path} (${result.validity.count} engrams).`,
        `Previous store kept at ${result.supersededPath}.`,
        ...(result.wouldLose.length > 0
          ? [`${result.wouldLose.length} engram(s) from the previous store are not in this snapshot — see that file.`]
          : []),
      ].join('\n'),
    )
  } catch (err) {
    exit(1, (err as Error).message)
  }
}
