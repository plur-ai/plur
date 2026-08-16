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
import { guard, type WriteQueue } from './guard.js'
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
  /** Resolves the scope of the session the event came from. */
  /** The ONE shared write queue. Must not be created per-module. */
  queue: WriteQueue
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
  const opts = { timeoutMs: config.timeoutMs, onError: () => counters.bump('errors_swallowed') }

  // The payload is `{ agent, turn, signal }`, NOT the agent. Reading
  // `.session` off the payload always produced undefined, so `events` was
  // always [] and `autoCapture: true` captured nothing, ever — on every
  // install, silently. The unit tests emitted the shape the code expected.
  ctx.on('agent/turn-stopping', (payload: { agent?: AgentLike }) => {
    const events = payload?.agent?.session?.events ?? []
    const summary = lastAssistantText(events)
    if (!summary) return
    const session = payload?.agent?.session
    void queue(() => guard(async () => {
      const scope = await resolveScope(session)
      // `scope` is not a CaptureContext field — core keeps one timeline per
      // store and silently dropped it. A tag is where the scope survives, so a
      // mixed timeline can still say which project an episode came from.
      await plur?.capture?.(summary.slice(0, SUMMARY_MAX_CHARS), {
        tags: [`scope:${scope}`],
        ...(session?.id === undefined ? {} : { session_id: session.id }),
      })
    }, opts))
  })

  // NO learn-before-compaction in 0.1.0.
  //
  // The idea is right — a compaction boundary is the last moment the discarded
  // range can still be read — but the only extractor available is core's
  // rule-based `ingest()`, and it is not safe to run unattended:
  //
  //   * `ingest()` WRITES unless `extract_only: true`, and defaults the scope
  //     to `global`. Called from a hook whose whole point is running while
  //     nobody watches, that puts one project's conversation into the store
  //     every other project reads from.
  //   * Its patterns capture only the tail after a trigger word, so
  //     `(?:always|never|must|should)\s+(.+?)` turns "Never mention that Acme
  //     is churning" into the engram "mention that Acme is churning" — a
  //     prohibition stored as an instruction, rendered under CONSTRAINTS.
  //   * `learn()` dedups on exact content hash only, so near-duplicates from
  //     repeated compactions of one growing session accumulate.
  //
  // Those are acceptable for `plur ingest`, where a human reads the candidates
  // before anything is written. They are not acceptable here. This previously
  // called a `compactLearn()` core has never implemented, so it has always
  // been a no-op — leaving it out is not a regression, and doing it properly
  // needs an extractor that understands negation.
}
