import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

/**
 * `plur sync [remote] [--full] [--reembed]`
 *
 * Default: git pull/push + incremental syncFromYaml on the active index.
 * --full: git pull/push + drop-and-rebuild the derived index from YAML.
 * --reembed: re-embed engrams using the active embedder. Combine with --full
 *   to also recreate the PGLite `vector(N)` column at the new dim — the
 *   migration path when switching embedders (Sprint 0 PR 5 / #219).
 *
 * YAML is the source of truth in every mode. `--reembed --full` is the
 * recovery path for "I just switched PLUR_EMBEDDER and recall returns
 * nothing": it deletes the embedding table, recreates it at the embedder's
 * dim, and re-embeds every engram from YAML.
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let remote: string | undefined
  let full = false
  let reembed = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--full') { full = true; i++ }
    else if (arg === '--reembed') { reembed = true; i++ }
    else if (!remote && !arg.startsWith('--')) { remote = arg; i++ }
    else { i++ }
  }

  const result = plur.sync(remote, { full, reembed })
  // Block on any background PGLite work so the CLI returns a quiescent state.
  if (typeof (plur as { waitForIndex?: () => Promise<void> }).waitForIndex === 'function') {
    await (plur as { waitForIndex: () => Promise<void> }).waitForIndex()
  }

  if (shouldOutputJson(flags)) {
    outputJson({ ...result, full, reembed })
  } else {
    const flags_str =
      reembed && full ? ' (reembed --full)' :
      reembed ? ' (reembed)' :
      full ? ' (full reindex)' :
      ''
    outputText(`Sync: ${result.action}${flags_str}`)
    if (result.message) outputText(`  ${result.message}`)
    if (result.files_changed > 0) outputText(`  Files changed: ${result.files_changed}`)
    if (full) outputText('  Index rebuilt from YAML.')
    if (reembed) outputText(`  Engrams re-embedded${full ? ' (vector column recreated)' : ''}.`)
  }
}
