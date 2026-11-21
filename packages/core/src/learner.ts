/**
 * Learning-extraction heuristics shared by `@plur-ai/claw` and
 * `@plur-ai/opencode`, so both use exactly the same matching. Claw is a
 * shipped package: changes here change its behaviour.
 */

/**
 * Minimal shape `extractLearnings` needs from a message. Structurally
 * compatible with claw's `AgentMessage` (`{ role: string; content: string;
 * [key: string]: unknown }`) and with any similarly-shaped message type, so
 * callers can pass their own message type without casting.
 */
export interface LearnableMessage {
  role: string
  content: unknown
}

/**
 * Extract text from message content, handling both string and array-of-blocks formats.
 * OpenClaw wraps messages as [{type: "text", text: "..."}] with metadata prepended.
 */
function extractText(content: unknown): string {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
      .map((block: any) => block.text)
      .join('\n')
  }
  // Strip OpenClaw metadata prefix (Conversation info + Sender blocks)
  text = text.replace(/^Conversation info \(untrusted metadata\):[\s\S]*?```\n*/g, '')
  text = text.replace(/^Sender \(untrusted metadata\):[\s\S]*?```\n*/g, '')
  return text.trim()
}

export interface LearnCandidate {
  statement: string
  type: 'behavioral' | 'terminological' | 'procedural' | 'architectural'
  confidence: number // 0-1, how confident we are this is a real learning
}

/**
 * Extract text from message content — handles string and array-of-blocks
 * formats. Deliberately distinct from `extractText` above: that one strips
 * OpenClaw's metadata-wrapper prefixes for the correction-pattern path; this
 * one returns the text verbatim for self-report extraction.
 */
function extractMessageText(message: LearnableMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as any[])
      .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
      .map((block: any) => block.text)
      .join('\n')
  }
  return ''
}

/**
 * A bullet that is WHOLLY a bracketed placeholder is template scaffolding, never a learning:
 * `PLUR_MEMORY_INSTRUCTIONS` (memory-block.ts) contains such example bullets, and without
 * this filter any turn echoing that block would harvest them as engrams.
 */
const PLACEHOLDER_BULLET_RE = /^\[.+\]$/

/**
 * The per-reply memory line (`Memory — recalled N · used: ENG-… · written: ENG-…`, or
 * `Memory — none`) in any common markup; it reports on the turn and is never a learning.
 * The WHOLE line must have the footer's shape, so "Memory: recalled 3 times faster…" stays a
 * learning. Mirrored exactly by `_MEMORY_LINE_RE` in packages/hermes/plur_hermes/learner.py;
 * both are tested on packages/core/test/fixtures/memory-line-cases.json. Whitespace is
 * `[ \t]` and a leading BOM is stripped, because JS and Python `\s` differ.
 */
const ML_MARK = '[*_`]*'
/**
 * Case-insensitive for ASCII letters only, written out (`[Mm][Ee]…`) rather
 * than with a flag: JavaScript's `i` and Python's IGNORECASE fold different
 * letters (Turkish İ and ı fold to I/i in Python only), so neither side uses a
 * flag and both stay identical.
 */
const ci = (word: string) => [...word].map(ch => /[a-z]/i.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : ch).join('')
const ML_ID = 'ENG-[A-Za-z0-9…-]*'
const ML_IDS = `${ML_ID}(?:[ \\t]*,[ \\t]*${ML_ID})*`
const ML_PART =
  `(?:${ci('recalled')}${ML_MARK}[ \\t]*(?:\\p{Nd}+|:[ \\t]*${ML_MARK}[ \\t]*(?:${ML_IDS}|${ci('none')})|${ci('none')})` +
  `|(?:${ci('used')}|${ci('written')})${ML_MARK}[ \\t]*:[ \\t]*${ML_MARK}[ \\t]*(?:${ML_IDS}|${ci('none')})` +
  `|${ci('none')}(?:[ \\t]+${ci('recalled')})?)`
export const MEMORY_LINE_RE = new RegExp(
  '^[ \\t>*_`~•-]*(?:\\p{Nd}+[.)][ \\t]*)?(?:🧠[ \\t]*)?(?:<[A-Za-z][^>]*>[ \\t]*)*' + ML_MARK +
  ci('memory') + ML_MARK + '[ \\t]*(?:[—–-]+|:)[ \\t]*' + ML_MARK +
  ML_PART + ML_MARK + `(?:[ \\t]*[·•][ \\t]*${ML_MARK}${ML_PART}${ML_MARK})*` +
  '[ \\t]*(?:</[A-Za-z]+>[ \\t]*)*[.]?[ \\t]*$',
  'u',
)

/** True when `line` is the memory line (see MEMORY_LINE_RE). */
export function isMemoryLine(line: string): boolean {
  return MEMORY_LINE_RE.test(line.replace(/^\uFEFF/, '').replace(/\r$/, ''))
}

/**
 * Extract self-reported learnings from a message.
 * Looks for the 🧠 I learned: section and parses bullet points.
 *
 * The caller decides which message to pass (claw passes only the last
 * assistant message) — this function does not filter by role.
 */
export function extractSelfReportedLearnings(message: LearnableMessage): string[] {
  const content = extractMessageText(message)
  // Match the learning section: ---\n🧠 I learned:\n- item\n- item
  // The per-reply memory line may follow the last bullet with no blank line,
  // so it can land inside the block; it is filtered out below, line by line,
  // so a real learning after it is never lost.
  const match = content.match(/---\s*\n🧠 I learned:\s*\n([\s\S]*?)(?:\n---|\n\n[^-]|$)/)
  if (!match) return []

  return match[1]
    .split('\n')
    .filter(line => !isMemoryLine(line))
    .map(line => line.replace(/^[-•*]\s*/, '').trim())
    .filter(line => line.length >= 10 && !PLACEHOLDER_BULLET_RE.test(line)) // skip empty, trivial, or placeholder lines
}

// Patterns that indicate corrections or preferences.
// Applied per-sentence (not per-message) to handle long conversational messages.

const DECISION_PATTERNS = [
  { re: /(?:we decided|the decision is|let'?s go with|agreed to)\s+(.+)/i, type: 'architectural' as const, confidence: 0.8 },
  { re: /(?:the convention is|the rule is|the pattern is|the standard is)\s+(.+)/i, type: 'procedural' as const, confidence: 0.7 },
]

const PREFERENCE_PATTERNS = [
  { re: /(?:i prefer|i like)\s+(.+?)(?:\s+(?:for|over|instead|rather)\s+.+)?$/i, type: 'behavioral' as const, confidence: 0.6 },
  // The whole match is captured, directive word included: `always`/`never`
  // are polarity-bearing, and storing only the tail ("never commit the API
  // key" -> "commit the API key") inverts the instruction. The directive word
  // needs word boundaries ("Whenever" is not "never"), and a directly
  // preceding negation is captured with it ("Don't always rerun…"). Negation
  // covers every contracted form (`\w+n't`), the same forms typed without the
  // apostrophe, and `cannot`; a word merely ending in -nt ("want") is not one.
  { re: /((?:\b(?:\w+n['\u2019]t|(?:do|does|did|ca|wo|sha|should|could|would|must|need|is|are|was|were|has|have|had|ai)nt|cannot|do not|not)\s+)?\b(?:always|never)\b\s+.+)/i, type: 'behavioral' as const, confidence: 0.7 },
  { re: /((?:you should|you must|don't|do not)\s+.+)/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:your purpose is|you are)\s+(.{15,})/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:i want you to)\s+(.+)/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:remember that)\s+(.+)/i, type: 'behavioral' as const, confidence: 0.7 },
]

const CORRECTION_PATTERNS = [
  { re: /(?:no[,.]|actually[,.])\s+(.+)/i, type: 'behavioral' as const, confidence: 0.7 },
  // Matches only the corrective "X, not Y" shape ("use pnpm, not npm"), which
  // reliably has a comma directly before "not"; plain prohibitions ("is not
  // allowed", "should not commit") do not, and storing a fragment of one
  // would invert it. Refusing to match is always safe — the sentence simply
  // yields no candidate. `isCorrection` accepts the no-comma phrasing too,
  // because it only decides yes/no; this pattern also decides what text to
  // store. The whole sentence is captured so the stored statement keeps both
  // halves of the contrast.
  { re: /(.+,\s+not\s+.+)/i, type: 'behavioral' as const, confidence: 0.8 },
]

const IDENTITY_PATTERNS = [
  { re: /(?:you are|you were)\s+((?:Data|inspired|an android|a living|not just).{10,})/i, type: 'terminological' as const, confidence: 0.7 },
  { re: /(?:your name is|call (?:you|yourself))\s+(.+)/i, type: 'terminological' as const, confidence: 0.8 },
  { re: /(?:we are building|we built|I built)\s+(.{15,})/i, type: 'architectural' as const, confidence: 0.7 },
]

// All pattern groups in priority order (most specific first).
//
// PREFERENCE_PATTERNS runs before CORRECTION_PATTERNS: its keyword anchors
// (`never`, `always`, `you should`, `don't`, …) are the narrower shapes, and
// the comma-based "X, not Y" is the broader net. Every polarity-bearing
// pattern captures its full match, so order does not change what is stored,
// but narrow-before-broad keeps a broad high-confidence pattern from claiming
// a sentence a careful one should handle.
const ALL_PATTERN_GROUPS = [IDENTITY_PATTERNS, DECISION_PATTERNS, PREFERENCE_PATTERNS, CORRECTION_PATTERNS]

/**
 * Split a message into sentences for per-sentence pattern matching.
 * Handles periods, question marks, exclamation marks, and newlines as delimiters.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= 10)
}

/**
 * Check if a single message contains a correction. Used for real-time
 * gating before extraction runs — claw's `ingest()` and
 * `@plur-ai/opencode`'s `learnFromUserText` both call this before running
 * `extractLearnings`, so a plain preference or decision doesn't get treated
 * as an urgent real-time write. Much tighter than the pattern groups below:
 * it requires an explicit correction shape ("no,", "actually,", "wrong", or
 * an "X, not Y" construction), not just any learning-shaped sentence.
 *
 * `packages/claw/src/learner.ts` re-exports this.
 */
export function isCorrection(message: LearnableMessage): boolean {
  if (message.role !== 'user') return false
  const content = extractText(message.content)

  // Check per-sentence for multi-line or long messages
  const sentences = (content.includes('\n') || content.length > 200) ? splitSentences(content) : [content]

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase().trim()
    if (
      lower.startsWith('no,') ||
      lower.startsWith('no.') ||
      lower.startsWith('actually,') ||
      lower.startsWith('actually ') ||
      lower.startsWith('wrong') ||
      lower.startsWith("that's wrong") ||
      lower.startsWith("that's incorrect") ||
      /\buse\s+\w+[,.]?\s+not\s+\w+/i.test(lower) ||
      /\bit(?:'s| is)\s+\w+[,.]?\s+not\s+\w+/i.test(lower)
    ) {
      return true
    }
  }
  return false
}

/**
 * Extract learning candidates from messages.
 * Only processes user messages (role === 'user').
 * Splits long messages into sentences for per-sentence pattern matching.
 * Returns candidates — the caller decides whether to persist them.
 */
export function extractLearnings(messages: LearnableMessage[]): LearnCandidate[] {
  const candidates: LearnCandidate[] = []
  const seenStatements = new Set<string>()

  for (const msg of messages) {
    if (msg.role !== 'user') continue
    const content = extractText(msg.content)
    if (content.length < 10) continue // too short

    // Split into sentences for per-sentence matching
    const sentences = splitSentences(content)

    for (const sentence of sentences) {
      // Try each pattern group; take the first match per sentence
      let matched = false
      for (const patterns of ALL_PATTERN_GROUPS) {
        if (matched) break
        for (const { re, type, confidence } of patterns) {
          const match = sentence.match(re)
          if (match && match[1]) {
            const statement = match[1].trim().replace(/[.!?]+$/, '')
            if (statement.length >= 10 && !seenStatements.has(statement.toLowerCase())) {
              seenStatements.add(statement.toLowerCase())
              candidates.push({ statement, type, confidence })
              matched = true
              break
            }
          }
        }
      }
    }
  }

  return candidates
}
