/**
 * Correction detection off the durable event feed.
 *
 * Ported from `@plur-ai/claw`'s learner. Deliberately conservative: a false
 * positive is an engram that is wrong forever, whereas a false negative is
 * usually caught by the user's next correction.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PlurClient } from './client.js'
import type { Config } from './config.js'
import type { Counters } from './counters.js'
import { guard, type WriteQueue } from './guard.js'

/**
 * High-precision correction and rule patterns.
 *
 * Precision matters more than recall here, because these fire unattended and
 * what they write is permanent. Two patterns were measurably too loose and
 * turned ordinary conversation into engrams — every one of these became a
 * stored memory:
 *
 *   "I never got the confirmation email from them."
 *   "Actually I think we already shipped that last week."
 *   "It always takes forever to build on this machine."
 *   "Hmm, actually never mind, ignore that."
 *
 * So `always`/`never` must now open a sentence or follow `we`/`you` — the
 * shapes a rule actually takes — rather than appearing anywhere in it; and
 * bare `actually`, which is mostly a discourse marker, is gone. `correction`
 * stays, because nobody says it by accident.
 */
const PATTERNS: readonly RegExp[] = [
  /\bno,?\s+(?:use|do|it'?s|that'?s|the)\b/i,
  // `(?!mind\b)`: "Never mind that, let's move on" is a discourse marker, and
  // it is sentence-initial by construction, so the anchor alone cannot reject it.
  /(?:^|[.!?]\s*)(?:(?:we|you)\s+(?:should\s+|must\s+)?)?(?:always|never)\s+(?!mind\b)\w+/i,
  /\buse\s+\S+.*\bnot\s+\S+/i,
  /\bthe right way (?:to|is)\b/i,
  /\bcorrection,?\s+\w+/i,
  /\bdon'?t\s+\w+.*\binstead\b/i,
]

/** Below this a sentence is chatter; above it, a wall of text we should not store. */
const MIN_LENGTH = 10
const MAX_LENGTH = 500

/** A detected candidate worth storing. */
export interface LearningCandidate {
  readonly statement: string
  readonly confidence: number
}

/**
 * Decide whether one message states something worth remembering.
 *
 * Scans sentence by sentence rather than whole-message, so one correction
 * buried in a long turn is still caught — and only that sentence is stored,
 * not the surrounding chatter.
 *
 * @param text - the message text.
 * @returns the candidate, or `undefined` when nothing qualifies.
 */
export function detectLearning(text: string): LearningCandidate | undefined {
  const trimmed = text.trim()
  if (trimmed.endsWith('?')) return undefined
  for (const sentence of trimmed.split(/(?<=[.!])\s+/)) {
    const candidate = sentence.trim()
    // The length gate belongs HERE, on the sentence being stored — not on the
    // whole message. Applied to the message it contradicted this function's
    // own promise: a real "No, use pnpm rather than npm here." inside a
    // 524-character turn was dropped silently, with no counter bumped. That is
    // exactly the "I told it and it forgot" report, and it was undiagnosable.
    if (candidate.length < MIN_LENGTH || candidate.length > MAX_LENGTH) continue
    if (PATTERNS.some(pattern => pattern.test(candidate))) {
      return { statement: candidate, confidence: 0.75 }
    }
  }
  return undefined
}

/** The slice of the originating session scope resolution needs. */
export interface CallerSession {
  readonly id?: string
  readonly header?: { readonly cwd?: string }
}

/** Dependencies for the learning subscription. */
export interface LearnDeps {
  config: Config
  counters: Counters
  plur?: PlurClient
  /** Resolves the scope of the session the event came from. */
  /** The ONE shared write queue. Must not be created per-module. */
  queue: WriteQueue
  resolveScope: (session?: CallerSession) => Promise<string>
}

interface TextBlock {
  readonly type?: string
  readonly text?: string
}

/**
 * Subscribe correction detection to the durable event feed.
 *
 * `session/event` is an emit-mode feed whose listener failures dsh contains, and
 * writes go through a queue so two live sessions cannot interleave a
 * read-modify-write against the same store. Nothing here is ever awaited by the
 * turn.
 *
 * @param ctx - the Cordis context whose scope owns the subscription.
 * @param deps - config, counters, the PLUR client, and scope resolution.
 */
export function registerLearning(ctx: Context, deps: LearnDeps): void {
  const { config, counters, plur, resolveScope, queue } = deps
  if (!config.autoLearn) return

  ctx.on('session/event', (session: unknown, event: unknown) => {
    const record = event as { type?: string; data?: unknown } | null
    if (record?.type !== 'user/message') return
    const data = record.data as
      | { source?: { kind?: string }; content?: unknown }
      | null
      | undefined
    if (data?.source?.kind !== 'user') return
    if (!Array.isArray(data.content)) return

    const text = (data.content as readonly TextBlock[])
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')

    const candidate = detectLearning(text)
    if (!candidate) return

    void queue(() => guard(async () => {
      const scope = await resolveScope(session as CallerSession)
      // Only count a write that a real engine actually performed. Bumping
      // before checking meant an absent `learn` — the whole engine missing —
      // still reported captures.
      if (typeof plur?.learn !== 'function') return
      await plur.learn(candidate.statement, { scope })
      counters.bump('learn_captured')
    }, { timeoutMs: config.timeoutMs, onError: () => counters.bump('errors_swallowed') }))
  })
}
