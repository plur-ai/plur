/**
 * Episode capture, and learning from content about to be dropped.
 *
 * NOTE: `compaction/start` is a `SessionEventMap` entry, NOT a Cordis event —
 * `ctx.on('compaction/start', ...)` does not exist and would silently never
 * fire. It is filtered out of the `session/event` feed instead. It fires before
 * summarisation, so the pre-shadow content is still readable at that point.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { Counters } from './counters.js'
import type { PlurClient } from './client.js'
import { createWriteQueue, guard } from './guard.js'
import { lastAssistantText, type LogEvent } from './session-log.js'

/** Cap on a captured episode summary, so one long turn cannot bloat the store. */
const SUMMARY_MAX_CHARS = 2000

/** Dependencies for the capture subscriptions. */
export interface CaptureDeps {
  config: Config
  counters: Counters
  plur?: PlurClient
  /** Resolves the scope of the session the event came from. */
  resolveScope: (session?: { id?: string; header?: { cwd?: string } }) => Promise<string>
}

/**
 * Subscribe episode capture and learn-before-compaction.
 *
 * Both paths are fire-and-forget through the shared write queue: a turn must
 * never wait on a store write, and two live sessions must not interleave.
 *
 * @param ctx - the Cordis context whose scope owns the subscriptions.
 * @param deps - config, counters, the PLUR client, and scope resolution.
 */
export function registerCapture(ctx: Context, deps: CaptureDeps): void {
  const { config, counters, plur, resolveScope } = deps
  if (!config.autoCapture) return
  const queue = createWriteQueue()
  const opts = { timeoutMs: config.timeoutMs, onError: () => counters.bump('errors_swallowed') }

  ctx.on('agent/turn-stopping', (agent: unknown) => {
    const events = (agent as { session?: { events?: readonly LogEvent[] } } | null)?.session?.events ?? []
    const summary = lastAssistantText(events)
    if (!summary) return
    const session = (agent as { session?: { id?: string; header?: { cwd?: string } } } | null)?.session
    void queue(() => guard(async () => {
      const scope = await resolveScope(session)
      await plur?.capture?.({ summary: summary.slice(0, SUMMARY_MAX_CHARS), scope })
    }, opts))
  })

  ctx.on('session/event', (session: unknown, event: unknown) => {
    if ((event as { type?: string } | null)?.type !== 'compaction/start') return
    const events = (session as { events?: readonly LogEvent[] } | null)?.events ?? []
    const owner = session as { id?: string; header?: { cwd?: string } } | null
    void queue(() => guard(async () => {
      const scope = await resolveScope(owner ?? undefined)
      await plur?.compactLearn?.({ events, scope })
    }, opts))
  })
}
