/**
 * Outbox entry classification (#1299).
 *
 * A queued team write fails for one of two kinds of reason, and they want
 * opposite treatment:
 *
 *   - `retrying`     — the network, a 5xx, a 429, a timeout. The next flush
 *                      may well succeed, so it keeps retrying as before.
 *   - `needs_action` — 401, 403, 404, 422, an explicit "cannot write to scope"
 *                      refusal, or no writable store registered for the scope.
 *                      Retrying cannot fix any of these; a person has to.
 *
 * Observed before this existed: ten writes refused with `403 Cannot write to
 * scope ...` on every attempt for twelve days, one at 103 attempts, and no
 * surface said so. Classifying the entry is what lets session start, `plur
 * status`, `plur doctor` and `plur outbox` say it in one line.
 *
 * Pure: reads the entry's recorded failure, never the network, and never
 * changes the entry. When the evidence is ambiguous the answer is `retrying`
 * — the old behaviour — because a false `needs_action` would turn doctor red
 * and back an entry off that may be about to succeed.
 */

export type OutboxState = 'retrying' | 'needs_action'

/** HTTP statuses a retry cannot change. */
export const NEEDS_ACTION_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 422])

/**
 * How long an automatic flush waits before re-dialling a `needs_action`
 * entry: at most one attempt per day. An explicit flush (`plur outbox
 * --flush`, `plur_outbox { flush: true }`) ignores it, so a user who has just
 * fixed the cause does not wait. Entries are never dropped for backing off.
 */
export const NEEDS_ACTION_RETRY_MS = 24 * 60 * 60 * 1000

/**
 * Text a server sends when it refuses a write to a scope outright. Matched only
 * when no status was recorded (entries queued before #1299 stored one).
 */
const REFUSAL_TEXT = /cannot write to scope|not (?:allowed|permitted|authori[sz]ed) to write/i

/**
 * Pull an HTTP status out of an error message this client wrote: `Remote
 * store append failed: 403 ...` or `HTTP 403 from ...`. Deliberately narrow —
 * a number elsewhere in a message is not a status.
 */
export function statusFromErrorText(text: string | undefined): number | undefined {
  if (!text) return undefined
  const m = /\bfailed: (\d{3})\b/.exec(text) ?? /\bHTTP (\d{3})\b/.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  return n >= 100 && n <= 599 ? n : undefined
}

export interface OutboxFailureInput {
  /** HTTP status of the last failed push, when one was recorded. */
  last_status?: number
  /** Message of the last failed push. */
  last_error?: string
  /** False when config has no writable url store for the entry's scope. */
  has_store?: boolean
  /** Entry scope, used to word the next step. */
  scope?: string
}

export interface OutboxVerdict {
  state: OutboxState
  /** One line: why retrying will not help. Only for `needs_action`. */
  reason?: string
  /** One line: a real command or change that would. Only for `needs_action`. */
  next_step?: string
}

export function classifyOutboxFailure(input: OutboxFailureInput): OutboxVerdict {
  const scope = input.scope ?? '<scope>'
  // The id is not embedded: the same line is shown once per scope, over
  // several entries, next to the listing that names them.
  const rescope = '`plur rescope <id> --to <other scope>`'
  const retry = 'then `plur outbox --flush`'

  if (input.has_store === false) {
    return {
      state: 'needs_action',
      reason: `no writable store is registered for ${scope}`,
      next_step: `register a writable store for ${scope} in config.yaml (\`plur stores list\` shows what is registered), ${retry}; or move it with ${rescope}`,
    }
  }

  const status = typeof input.last_status === 'number'
    ? input.last_status
    : statusFromErrorText(input.last_error)

  if (status === 401) {
    return {
      state: 'needs_action',
      reason: `the store rejected the credentials (401)`,
      next_step: `refresh the token for the ${scope} store in config.yaml, ${retry}`,
    }
  }
  if (status === 403 || (status === undefined && REFUSAL_TEXT.test(input.last_error ?? ''))) {
    return {
      state: 'needs_action',
      reason: `the store refused writes to ${scope}${status ? ` (${status})` : ''}`,
      next_step: `get write access to ${scope} from the store's admin, ${retry}; or move it with ${rescope}`,
    }
  }
  if (status === 404) {
    return {
      state: 'needs_action',
      reason: `the store does not know ${scope} (404)`,
      next_step: `check the url and scope registered for ${scope} (\`plur stores list\`), ${retry}; or move it with ${rescope}`,
    }
  }
  if (status === 422) {
    return {
      state: 'needs_action',
      reason: `the store rejected the engram as invalid (422)`,
      next_step: `read the error with \`plur outbox\`; move it with ${rescope}, or retire it with \`plur forget <id>\``,
    }
  }
  return { state: 'retrying' }
}

export interface OutboxEntryLike {
  id: string
  target_scope: string
  state: OutboxState
  reason?: string
  next_step?: string
}

export interface OutboxSummary {
  pending: number
  retrying: number
  needs_action: number
  /** One row per scope with needs_action entries: the first entry's reason and next step. */
  scopes: Array<{ scope: string; count: number; reason: string; next_step: string }>
}

export function summarizeOutbox(entries: readonly OutboxEntryLike[]): OutboxSummary {
  const byScope = new Map<string, { scope: string; count: number; reason: string; next_step: string }>()
  let needs = 0
  for (const e of entries) {
    if (e.state !== 'needs_action') continue
    needs++
    const row = byScope.get(e.target_scope)
    if (row) row.count++
    else byScope.set(e.target_scope, {
      scope: e.target_scope, count: 1, reason: e.reason ?? 'retrying cannot fix it', next_step: e.next_step ?? 'run `plur outbox`',
    })
  }
  return { pending: entries.length, retrying: entries.length - needs, needs_action: needs, scopes: [...byScope.values()] }
}

/** One human line per needs_action scope, for status/doctor/session_start. */
export function describeNeedsAction(summary: OutboxSummary): string[] {
  return summary.scopes.map(s =>
    `${s.count} queued write(s) for ${s.scope} will not deliver: ${s.reason}. Next: ${s.next_step}.`)
}
