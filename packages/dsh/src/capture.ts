/**
 * Episode capture.
 *
 * One episode per finished turn, into core's timeline. Learning from content
 * about to be dropped at a compaction boundary is deliberately NOT here — see
 * the note in `registerCapture`.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { Counters } from './counters.js'
import type { PlurClient } from './client.js'
import { contain, type WriteQueue } from './guard.js'
import { lastAssistantText, type LogEvent } from './session-log.js'

/** The structural slice of a live dsh Agent this module reads. */
interface AgentLike {
  readonly id?: string
  readonly session?: {
    readonly id?: string
    readonly events?: readonly LogEvent[]
    readonly header?: { readonly cwd?: string }
  }
}

/** Cap on a captured episode summary, so one long turn cannot bloat the store. */
const SUMMARY_MAX_CHARS = 2000


/** Dependencies for the capture subscriptions. */
export interface CaptureDeps {
  config: Config
  counters: Counters
  plur?: PlurClient
  /** The ONE shared write queue. Must not be created per-module. */
  queue: WriteQueue
  /** Resolves the scope of the session the event came from. */
  resolveScope: (session?: { id?: string; header?: { cwd?: string } }) => Promise<string>
}

/**
 * Subscribe episode capture.
 *
 * Fire-and-forget through the shared write queue: a turn must never wait on a
 * store write, and two live sessions must not interleave.
 *
 * @param ctx - the Cordis context whose scope owns the subscriptions.
 * @param deps - config, counters, the PLUR client, and scope resolution.
 */
export function registerCapture(ctx: Context, deps: CaptureDeps): void {
  const { config, counters, plur, resolveScope, queue } = deps
  if (!config.autoCapture) return
  const onError = () => counters.bump('errors_swallowed')

  // The payload is `{ agent, turn, signal }`, NOT the agent: the session
  // lives on `payload.agent`.
  ctx.on('agent/turn-stopping', (payload: { agent?: AgentLike }) => {
    const events = payload?.agent?.session?.events ?? []
    const summary = lastAssistantText(events)
    if (!summary) return
    const session = payload?.agent?.session
    // Holds the queue slot until settled or the queue's hard cap.
    void queue(() => contain(async () => {
      const scope = await resolveScope(session)
      // `scope` is not a CaptureContext field — core keeps one timeline per
      // store and would drop it. A tag is where the scope survives, so a
      // mixed timeline can still say which project an episode came from.
      await plur?.capture?.(summary.slice(0, SUMMARY_MAX_CHARS), {
        tags: [`scope:${scope}`],
        ...(session?.id === undefined ? {} : { session_id: session.id }),
      })
    }, onError))
  })

  // NO learn-before-compaction. The only extractor, core's rule-based `ingest()`,
  // is unsafe unattended: it writes to `global` by default (cross-project leak),
  // its tail-after-trigger patterns turn prohibitions into instructions
  // ("Never mention X" → "mention X"), and exact-hash dedup lets repeated
  // compactions pile up near-duplicates. Fine for `plur ingest` with a human
  // reviewing; here it needs a negation-aware extractor.
}
