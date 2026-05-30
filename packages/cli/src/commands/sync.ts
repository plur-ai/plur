import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

/**
 * `plur sync [remote] [--full]`
 *
 * Default: git pull/push + incremental syncFromYaml on the active index.
 * --full: git pull/push + drop-and-rebuild the derived index from YAML.
 *
 * YAML is the source of truth. `--full` is the recovery path: it deletes
 * every row in the index (SQLite or PGLite) and replays the YAML file. Use
 * after upgrading the embedder, after a schema migration, or whenever the
 * index looks out of sync with what `list()` and `recall()` report.
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let remote: string | undefined
  let full = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--full') { full = true; i++ }
    else if (!remote && !arg.startsWith('--')) { remote = arg; i++ }
    else { i++ }
  }

  const result = plur.sync(remote, { full })
  // Block on any background PGLite work so the CLI returns a quiescent state.
  if (typeof (plur as { waitForIndex?: () => Promise<void> }).waitForIndex === 'function') {
    await (plur as { waitForIndex: () => Promise<void> }).waitForIndex()
  }

  if (shouldOutputJson(flags)) {
    outputJson({ ...result, full })
  } else {
    outputText(`Sync: ${result.action}${full ? ' (full reindex)' : ''}`)
    if (result.message) outputText(`  ${result.message}`)
    if (result.files_changed > 0) outputText(`  Files changed: ${result.files_changed}`)
    if (full) outputText('  Index rebuilt from YAML.')
  }
}
