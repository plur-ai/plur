/**
 * `plur outbox` — see what the remote-write queue is holding (#667).
 *
 * The outbox is not a file or a queue directory. It is
 * `structured_data._outbox` nested inside ordinary engrams in `engrams.yaml`,
 * which is why it worked and was invisible: a user whose team store was
 * unreachable had queued writes with no supported way to see them, and the
 * only prose describing the mechanism lived inside an engram.
 *
 * Read-only by default. `--flush` is the explicit action, mirroring the
 * `plur_outbox` MCP tool so the two surfaces cannot drift.
 *
 * The target URL is never printed — `listOutbox` does not return it. It is the
 * one field here that names a credentialed endpoint, and `target_scope`
 * already answers "which store is behind?", which is the question being asked.
 */
import { summarizeOutbox, describeNeedsAction } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

function usage(): never {
  exit(1, [
    'Usage:',
    '  plur outbox             Show team-scoped writes queued for an unreachable store',
    '  plur outbox --flush     Retry them now (including ones marked "needs action")',
    '',
    'Writes to a remote scope queue locally when their store cannot be reached.',
    'They also retry automatically on session start and end, and on `plur sync`.',
    'An entry the store refused in a way retrying cannot fix (401, 403, 404, 422,',
    'or no writable store for its scope) is marked "needs action" and retried',
    'automatically at most once a day. Nothing is ever dropped automatically.',
  ].join('\n'))
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) usage()
  const flush = args.includes('--flush')

  // Read-only unless flushing — a command people run to LOOK at a queue must
  // not be able to modify the store it is reporting on.
  const plur = createPlur(flags, flush ? undefined : { readonly: true })

  // Read before flushing, always. After a successful flush the entries are
  // gone, so reading afterwards would report an empty outbox and say nothing
  // about what just moved — which is the interesting part.
  const entries = await plur.listOutbox()

  const summary = summarizeOutbox(entries)

  if (!flush) {
    if (shouldOutputJson(flags)) {
      outputJson({
        pending: entries.length,
        retrying: summary.retrying,
        needs_action: summary.needs_action,
        ...(summary.needs_action > 0 ? { needs_action_scopes: summary.scopes } : {}),
        entries,
      })
      return
    }
    if (entries.length === 0) {
      outputText('Outbox is empty — every team-scoped write has reached its store.')
      return
    }
    outputText(formatOutboxText(entries))
    return
  }

  // Explicit: retries needs_action entries too — the user may just have
  // fixed the cause, and should not wait out the daily back-off (#1299).
  const result = await plur.flushOutbox({ force: true })
  const stillPending = await plur.outboxCount()

  if (shouldOutputJson(flags)) {
    outputJson({
      flushed: result.flushed,
      failed: result.failed,
      pending: stillPending,
      ...(result.expired_warnings.length > 0 ? { expired_warnings: result.expired_warnings } : {}),
      attempted: entries,
    })
    return
  }

  if (entries.length === 0) {
    outputText('Outbox is empty — nothing to flush.')
    return
  }
  const lines = [`Flushed ${result.flushed} of ${entries.length}. ${result.failed} still failing.`]
  if (stillPending > 0) {
    lines.push(`${stillPending} write(s) remain queued — the store is still unreachable.`)
  }
  for (const w of result.expired_warnings) lines.push(`  ${w}`)
  outputText(lines.join('\n'))
}

type OutboxEntry = Awaited<ReturnType<ReturnType<typeof createPlur>['listOutbox']>>[number]

/**
 * The text listing. Exported for tests: a piped stdout selects JSON, so text
 * mode is only reachable in-process.
 */
export function formatOutboxText(entries: OutboxEntry[]): string {
  const summary = summarizeOutbox(entries)
  const lines = [
    summary.needs_action > 0
      ? `${entries.length} write(s) queued: ${summary.retrying} will retry, ${summary.needs_action} need action.`
      : `${entries.length} write(s) queued for a remote store that could not be reached.`,
    '',
  ]
  for (const e of entries) {
    const age = e.age_days === 0 ? 'today' : `${e.age_days}d ago`
    lines.push(`  ${e.id}  →  ${e.target_scope}${e.state === 'needs_action' ? '  [needs action]' : ''}`)
    lines.push(`      queued ${age}, ${e.attempt_count} attempt(s)`
      + (e.last_error ? `, last error: ${e.last_error}` : ''))
    if (e.state === 'needs_action') {
      lines.push(`      will not deliver: ${e.reason}`)
      if (e.next_retry_at) lines.push(`      next automatic retry after ${e.next_retry_at}`)
    }
  }
  lines.push('')
  if (summary.needs_action > 0) {
    for (const l of describeNeedsAction(summary)) lines.push(l)
    lines.push('Nothing is dropped automatically.')
  }
  lines.push('Run `plur outbox --flush` to retry now. They also retry on session start and end, and on `plur sync`.')
  return lines.join('\n')
}
