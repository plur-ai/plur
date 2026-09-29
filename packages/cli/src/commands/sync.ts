import type { IndexSyncError } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo } from '../output.js'

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
 *
 * Then retries queued team writes (the outbox), as MCP `plur_sync` does
 * (#1269). A failed flush does not fail the sync — the repository and index
 * work already happened — but it is reported, never swallowed: entries stay
 * queued.
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

  const result = await plur.sync(remote, { full })
  // Block on any background PGLite work so the CLI returns a quiescent state.
  if (typeof (plur as { waitForIndex?: () => Promise<void> }).waitForIndex === 'function') {
    await (plur as { waitForIndex: () => Promise<void> }).waitForIndex()
  }
  // #272: the background index/reembed chain swallows its own rejection
  // (waitForIndex resolves either way) — read the recorded failure so a
  // broken index doesn't report "Sync: ok".
  const indexError =
    typeof (plur as { lastIndexError?: () => IndexSyncError | null }).lastIndexError === 'function'
      ? (plur as { lastIndexError: () => IndexSyncError | null }).lastIndexError()
      : null

  // #1269: flush after the repository sync, same order as MCP plur_sync.
  let outbox: { flushed: number; pending: number; warnings: string[] } | undefined
  let outboxError: string | undefined
  try {
    const flushed = await plur.flushOutbox()
    if (flushed.flushed > 0 || flushed.failed > 0 || flushed.deferred > 0) {
      outbox = {
        flushed: flushed.flushed,
        pending: await plur.outboxCount(),
        warnings: flushed.expired_warnings,
      }
    }
  } catch (err) {
    outboxError = (err as Error).message
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      ...result,
      full,
      ...(indexError ? { index_error: indexError } : {}),
      ...(outbox ? { outbox } : {}),
      ...(outboxError ? { outbox_error: outboxError } : {}),
    })
  } else {
    // Status/confirmation lines → suppressed by --quiet (#730)…
    outputInfo(`Sync: ${result.action}${full ? ' (full reindex)' : ''}`, flags)
    if (result.message) outputInfo(`  ${result.message}`, flags)
    if (result.files_changed > 0) outputInfo(`  Files changed: ${result.files_changed}`, flags)
    if (full) outputInfo('  Index rebuilt from YAML.', flags)
    if (indexError) {
      // …but a failed index pass is an outcome-differs warning — never suppressed.
      outputText(`  Warning: index ${indexError.op} failed — ${indexError.message}`)
      outputText("  YAML is still the source of truth. Run 'plur sync --full' to rebuild the index.")
    }
    if (outbox) {
      if (outbox.flushed > 0) outputInfo(`  Outbox: ${outbox.flushed} queued write(s) delivered.`, flags)
      // Undelivered writes are an outcome that differs from "synced" — never suppressed.
      if (outbox.pending > 0) {
        outputText(`  Outbox: ${outbox.pending} write(s) still queued — the remote store is unreachable or refused them. Run 'plur outbox' for details.`)
      }
      for (const w of outbox.warnings) outputText(`    ${w}`)
    }
    if (outboxError) {
      outputText(`  Warning: outbox flush failed — ${outboxError}. Queued writes were NOT pushed and stay queued.`)
    }
  }
}
