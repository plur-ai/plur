import { openSync, readSync, fstatSync, closeSync } from 'fs'

/**
 * Signal detection for the Stop-hook memory check (hook-learn-check).
 *
 * The memory check forces one extra model turn. Fired blindly every 3rd
 * response, that turn usually ended in a bare "ok" — noise for the user. It
 * now fires when the user's LAST message carries a correction, preference or
 * decision signal, plus a rare fallback (every PLUR_LEARN_FALLBACK_INTERVAL-th
 * Stop) so a session with no explicit signal still gets an occasional check.
 *
 * Signals (case-insensitive). Whole-message:
 *   - leading "no" / "nope" (not "no problem", "no worries", "no thanks", ...)
 *   - "that's wrong", "that is not right", "not what I asked/meant/wanted/said"
 *   - "from now on", "going forward"
 *   - a decision-board answer: a "*.decisions.json" path, or "apply (the) decisions"
 * Per sentence, skipped when the sentence is a question (ends in "?"):
 *   - starts with (please) don't / do not / never / always / stop / actually /
 *     prefer / instead — "never mind" excluded
 *   - "I prefer", "I'd prefer", "I would prefer", "I'd rather", "I would rather"
 *   - "you / we / it / this / that should / shouldn't / should not / must"
 *   - "instead"
 *
 * The list is deliberately small: a missed correction costs one nudge (the
 * fallback catches some), a false positive costs an extra turn every time.
 */

const LEADING_NO = /^\s*(no|nope|nah)\b(?![\s,.!-]*(problem|worries|worry|thanks|thank|rush|need|idea)\b)/i
const WHOLE_MESSAGE = [
  /\bthat('?s| is| was)\s+(wrong|incorrect|not (right|correct|it))\b/i,
  /\bnot what i (asked|meant|wanted|said|want)\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\.decisions\.json\b/i,
  /\bapply (the |these |my )?decisions\b/i,
]
const SENTENCE_START = /^(please\s+)?(don'?t|do not|never(?!\s+mind)|always|stop|actually|prefer|instead)\b/i
const IN_SENTENCE = [
  /\bi('d| would)? (prefer|rather)\b/i,
  /\b(you|we|it|this|that) (should|shouldn'?t|must|mustn'?t)\b/i,
  /\binstead\b/i,
  /(^|,\s*)actually\b/i,
]

export function hasLearnSignal(text: string): boolean {
  if (!text || !text.trim()) return false
  const t = text.slice(0, 4000) // a long paste is not a correction; bound the work
  if (LEADING_NO.test(t)) return true
  if (WHOLE_MESSAGE.some((re) => re.test(t))) return true
  // Sentences keep their terminator so a question can be told apart.
  const sentences = t.match(/[^.!?\n]+[.!?]*/g) ?? []
  for (const raw of sentences) {
    const s = raw.trim().replace(/^[-–—*>\s]+/, '')
    if (!s || s.endsWith('?')) continue
    if (SENTENCE_START.test(s)) return true
    if (IN_SENTENCE.some((re) => re.test(s))) return true
  }
  return false
}

/** How much of the transcript tail is read. A Stop hook runs on every response. */
export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024

export interface UserMessage { id: string; text: string }

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content
    .filter((b): b is { type: string; text: string } =>
      !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
  return parts.length ? parts.join('\n') : null // tool_result-only lines are not the user speaking
}

/**
 * The last message the human typed, from a Claude Code transcript (JSONL;
 * the Stop payload's `transcript_path`). Skips tool results, meta lines,
 * sidechains and lines whose `origin.kind` is not "human" (task
 * notifications, peer messages). Reads at most the trailing
 * TRANSCRIPT_TAIL_BYTES; anything unreadable or unparseable is null, never an
 * error.
 */
export function lastUserMessage(transcriptPath: unknown): UserMessage | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  let raw: string
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, TRANSCRIPT_TAIL_BYTES)
      if (len <= 0) return null
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, size - len)
      raw = buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"user"')) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue } // torn first line, garbage
    if (!d || typeof d !== 'object' || d.type !== 'user') continue
    if (d.isMeta === true || d.isSidechain === true) continue
    const origin = d.origin as { kind?: unknown } | undefined
    if (origin && typeof origin === 'object' && origin.kind !== 'human') continue
    const message = d.message as { content?: unknown } | undefined
    const text = textOf(message?.content)
    if (text === null) continue
    const id = typeof d.uuid === 'string' && d.uuid ? d.uuid : `len:${text.length}:${text.slice(0, 64)}`
    return { id, text }
  }
  return null
}

/** Every Nth Stop without a signal still gets a check. 0 turns the fallback off. */
export function learnFallbackInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PLUR_LEARN_FALLBACK_INTERVAL
  if (raw === undefined || raw === '') return 20
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 20
}
