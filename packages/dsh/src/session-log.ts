/**
 * Shared helpers for walking a dsh session log.
 *
 * Four call sites need to read `agent.session.events`, and log-walking is
 * exactly where the design review found bugs. Centralised here so the rules live
 * in one place and are unit-tested once, without needing a Cordis context.
 *
 * @module
 */

/** The structural subset of a dsh `SessionEvent` these helpers read. */
export interface LogEvent {
  readonly type: string
  readonly time: number
  readonly data: unknown
}

interface TextBlock {
  readonly type?: string
  readonly text?: string
}

interface MessageLike {
  readonly content?: unknown
  readonly source?: { readonly kind?: string }
}

/** Concatenate the text blocks of one message-like value. Never throws. */
function textOf(message: unknown): string {
  const content = (message as MessageLike | null | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as readonly TextBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Build the recall query for one turn: the human text entered in that turn.
 *
 * Plugin-sourced context is excluded deliberately. Including our own injected
 * block would make each recall query drift toward whatever we last recalled,
 * so memory would progressively retrieve itself instead of the user's actual ask.
 *
 * @param events - the session's append-only log.
 * @param turn - the turn number currently being prepared.
 * @param proposed - messages the pre-step decision is about to enter, not yet logged.
 * @returns the joined query text, or `''` when the turn carries no human text.
 */
export function recallQueryFrom(
  events: readonly LogEvent[],
  turn: number,
  proposed: readonly unknown[],
): string {
  if (!Array.isArray(events)) return ''
  const start = events.findLastIndex(
    event => event?.type === 'turn/start' && (event.data as { turn?: number } | null)?.turn === turn,
  )
  const parts: string[] = []
  if (start >= 0) {
    for (const event of events.slice(start + 1)) {
      // A log array can contain junk: this runs against a live host's data, not
      // a fixture, so an element may be null/undefined/a primitive.
      if (event?.type !== 'user/message') continue
      const data = event.data as MessageLike | null
      if (data?.source?.kind !== 'user') continue
      const value = textOf(data)
      if (value) parts.push(value)
    }
  }
  // `proposed` comes from a PreStepDecision another plugin may have rewritten;
  // it is not guaranteed to be an array, and it may contain that plugin's own
  // injected scaffolding. Apply the SAME user-source filter as logged events, or
  // another plugin's context becomes our recall query.
  if (Array.isArray(proposed)) {
    for (const message of proposed) {
      const source = (message as MessageLike | null)?.source
      // An absent source is an ordinary prompt the loop has not stamped yet;
      // an explicitly non-user source is somebody else's injected content.
      if (source !== undefined && source?.kind !== 'user') continue
      const value = textOf(message)
      if (value) parts.push(value)
    }
  }
  return parts.join('\n').trim()
}

/**
 * The most recent assistant message carrying text, for episode capture.
 *
 * An empty-content `assistant/message` is skipped: dsh records one to hold a
 * max-tokens step's usage, and it is not something worth remembering.
 *
 * @param events - the session's append-only log.
 * @returns the text, or `undefined` when the session has produced none.
 */
export function lastAssistantText(events: readonly LogEvent[]): string | undefined {
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const value = textOf((event.data as { message?: unknown } | null)?.message)
    if (value) return value
  }
  return undefined
}
