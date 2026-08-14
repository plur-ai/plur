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
import { createWriteQueue, guard } from './guard.js'

/** High-precision correction and rule patterns. */
const PATTERNS: readonly RegExp[] = [
  /\bno,?\s+(?:use|do|it'?s|that'?s|the)\b/i,
  /\b(?:always|never)\s+\w+/i,
  /\buse\s+\S+.*\bnot\s+\S+/i,
  /\bthe right way (?:to|is)\b/i,
  /\b(?:actually|correction),?\s+\w+/i,
  /\bdon'?t\s+\w+.*\binstead\b/i,
]

/** Below this a message is chatter; above it, a wall of text we should not store. */
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
  if (trimmed.length < MIN_LENGTH || trimmed.length > MAX_LENGTH) return undefined
  if (trimmed.endsWith('?')) return undefined
  for (const sentence of trimmed.split(/(?<=[.!])\s+/)) {
    const candidate = sentence.trim()
    if (candidate && PATTERNS.some(pattern => pattern.test(candidate))) {
      return { statement: candidate, confidence: 0.75 }
    }
  }
  return undefined
}

/** Dependencies for the learning subscription. */
export interface LearnDeps {
  config: Config
  counters: Counters
  plur?: PlurClient
  resolveScope: () => Promise<string>
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
  const { config, counters, plur, resolveScope } = deps
  if (!config.autoLearn) return
  const queue = createWriteQueue()

  ctx.on('session/event', (_session: unknown, event: unknown) => {
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
      const scope = await resolveScope()
      await plur?.learn?.({ statement: candidate.statement, scope })
      counters.bump('learn_captured')
    }, { timeoutMs: config.timeoutMs, onError: () => counters.bump('errors_swallowed') }))
  })
}
