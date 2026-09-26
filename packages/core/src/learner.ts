/**
 * Extracted from `@plur-ai/claw`'s `packages/claw/src/learner.ts` so
 * `@plur-ai/opencode` can share the exact same learning-extraction
 * heuristics instead of vendoring a second copy. Behaviour must stay
 * identical to claw's pre-extraction implementation — claw is a shipped
 * package.
 *
 * `isCorrection` moved here too (2026-09, opencode plugin task — A3 parity
 * fix), so `@plur-ai/opencode`'s user-text learning path can be gated by the
 * same real-time correction matcher claw's `ingest()` uses. See its
 * docstring below for the rest of that history.
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
 * OpenClaw's metadata-wrapper prefixes for the correction-pattern path. This
 * one is the verbatim `extractMessageText` helper that
 * `extractSelfReportedLearnings` used in `@plur-ai/claw`'s
 * `context-engine.ts`, unchanged, so self-report extraction behaviour stays
 * identical post-extraction — claw is a shipped package.
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
 * A bullet that is WHOLLY a bracketed placeholder (`[...]`, nothing else on
 * the line) is never a genuine learning — it is template scaffolding. The
 * injected instruction block (`memory-block.ts`'s `PLUR_MEMORY_INSTRUCTIONS`)
 * contains exactly this shape as literal example text:
 *
 *   - [concise statement of what you learned]
 *   - [another if applicable]
 *
 * Both placeholders are well over the 10-character floor below, so without
 * this filter, any turn that echoes or quotes that block (the model repeats
 * it, a user pastes it, a test fixture reuses it) gets its instructional
 * placeholders harvested by `learnFromTurn` as permanent engrams. Audit
 * finding A2.
 */
const PLACEHOLDER_BULLET_RE = /^\[.+\]$/

/**
 * Extract self-reported learnings from a message.
 * Looks for the 🧠 I learned: section and parses bullet points.
 *
 * Extracted from `@plur-ai/claw`'s `context-engine.ts` (2026-09, opencode
 * plugin task 6b) so `@plur-ai/opencode` can harvest the assistant's own
 * self-report block instead of vendoring a second copy. The caller decides
 * which message to pass (claw passes only the last assistant message) —
 * this function does not filter by role. Behaviour must stay identical to
 * claw's pre-extraction implementation — claw is a shipped package.
 */
export function extractSelfReportedLearnings(message: LearnableMessage): string[] {
  const content = extractMessageText(message)
  // Match the learning section: ---\n🧠 I learned:\n- item\n- item
  const match = content.match(/---\s*\n🧠 I learned:\s*\n([\s\S]*?)(?:\n---|\n\n[^-]|$)/)
  if (!match) return []

  return match[1]
    .split('\n')
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
  // A1 fix: the capturing group used to start AFTER the directive word
  // (`(?:always|never)\s+(.+)`), so only the tail was stored — "never
  // commit the API key" became the standing instruction "commit the API
  // key". `always`/`never` and `don't`/`do not` are polarity-bearing:
  // dropping the word doesn't just lose color, it inverts (or for the
  // positive words, defangs) the instruction. Wrapping the whole match in
  // the capturing group keeps the directive word attached to its tail, so
  // the stored statement is a complete, correctly-signed instruction when
  // rendered under memory-block.ts's "should apply" header.
  //
  // Formal run 2026-09-23 (spec/formal/PlurSpec/ScopeInject.lean §4): the
  // same inversion survived A1 from the LEFT. The pattern was unanchored, so
  // (a) a negation directly before the directive word was cut off — "Don't
  // always rerun the full suite" was stored as "always rerun the full suite" —
  // and (b) the directive word matched inside another word — "Whenever you
  // deploy, run the smoke tests" was stored as "never you deploy, run the
  // smoke tests". The directive word now needs word boundaries, and a
  // directly preceding negation is captured with it.
  { re: /((?:\b(?:don['\u2019]?t|do not|not)\s+)?\b(?:always|never)\b\s+.+)/i, type: 'behavioral' as const, confidence: 0.7 },
  { re: /((?:you should|you must|don't|do not)\s+.+)/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:your purpose is|you are)\s+(.{15,})/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:i want you to)\s+(.+)/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:remember that)\s+(.+)/i, type: 'behavioral' as const, confidence: 0.7 },
]

const CORRECTION_PATTERNS = [
  { re: /(?:no[,.]|actually[,.])\s+(.+)/i, type: 'behavioral' as const, confidence: 0.7 },
  // E1 fix (a third inverting pattern, found after the A1 fix to
  // PREFERENCE_PATTERNS above): this used to be `/(.+?),?\s+not\s+(.+)/i`
  // with an OPTIONAL comma, and — worse — the code below only ever reads
  // `match[1]`, the text BEFORE "not". That combination matched any sentence
  // containing the bare word " not " anywhere, not just a deliberate "X, not
  // Y" contrast, and then stored only the half before "not":
  // "Deploying straight to production is not allowed here" became the
  // standing instruction "Deploying straight to production is" — the exact
  // inversion class the A1 fix was raised to kill, at a HIGHER confidence
  // (0.8) than the patterns A1 fixed, and positioned to run BEFORE them in
  // ALL_PATTERN_GROUPS — so a prohibition shaped like "you should not …" or
  // "… is not …" never reached A1's negation-safe patterns at all; this one
  // claimed the sentence first.
  //
  // This pattern's legitimate job is the corrective "X, not Y" shape — the
  // user naming the right thing against the wrong one ("use pnpm, not
  // npm"). That shape reliably has a comma directly before "not"; a plain
  // prohibition ("is not allowed", "should not commit", "is not a safe
  // place") does not. Requiring the comma is the discriminator: it keeps
  // "The port is 5433, not 5432" and "use pnpm, not npm" (both intentional
  // contrasts) while refusing every prohibition sentence in the audit's
  // table, none of which contain a comma before "not". `isCorrection` below
  // reaches the same "X, not Y" shape via anchored keywords ("use …, not
  // …" / "it's …, not …") with an OPTIONAL comma — that gate only has to
  // decide yes/no, so it can afford to also catch the no-comma phrasing;
  // this pattern also has to decide WHAT TEXT TO STORE, and a bare "not"
  // with no comma gives no reliable place to cut the sentence without
  // risking the same truncation this fix exists to close. Refusing to match
  // is always safe here — extractLearnings simply returns no candidate for
  // that sentence, which beats storing an inverted one.
  //
  // The whole match is captured (one group spanning the full sentence, the
  // same shape as A1's fix to PREFERENCE_PATTERNS), not just the text before
  // "not" — storing "use pnpm" alone drops the very half of the sentence
  // that says npm was wrong. Preserving the full contrast is the safer
  // choice across this whole bug class: a fragment can read as an
  // instruction it was never meant to be, where the full sentence cannot.
  { re: /(.+,\s+not\s+.+)/i, type: 'behavioral' as const, confidence: 0.8 },
]

const IDENTITY_PATTERNS = [
  { re: /(?:you are|you were)\s+((?:Data|inspired|an android|a living|not just).{10,})/i, type: 'terminological' as const, confidence: 0.7 },
  { re: /(?:your name is|call (?:you|yourself))\s+(.+)/i, type: 'terminological' as const, confidence: 0.8 },
  { re: /(?:we are building|we built|I built)\s+(.{15,})/i, type: 'architectural' as const, confidence: 0.7 },
]

// All pattern groups in priority order (most specific first).
//
// E1 fix: PREFERENCE_PATTERNS now runs before CORRECTION_PATTERNS. Every
// polarity-bearing pattern in both groups captures its FULL match (never
// just the tail after a directive word), so which of the two matches first
// no longer changes what gets stored — but PREFERENCE_PATTERNS' keyword
// anchors (`never`, `always`, `you should`, `you must`, `don't`, `do not`)
// are the narrower, more deliberately-reasoned-about shapes, and
// CORRECTION_PATTERNS' comma-based "X, not Y" is the broader net. Trying the
// narrower group first is the structural fix for what let a broad,
// high-confidence pattern preempt a careful one twice: a future pattern
// added to either group inherits "narrow before broad" instead of having to
// remember it.
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
 * gating before extraction runs — claw's `ingest()` and (A3 audit fix)
 * `@plur-ai/opencode`'s `learnFromUserText` both call this before running
 * `extractLearnings`, so a plain preference or decision doesn't get treated
 * as an urgent real-time write. Much tighter than the pattern groups below:
 * it requires an explicit correction shape ("no,", "actually,", "wrong", or
 * an "X, not Y" construction), not just any learning-shaped sentence.
 *
 * Moved from `@plur-ai/claw`'s `learner.ts` (2026-09, opencode plugin task —
 * A3 parity fix) so `@plur-ai/opencode` can share the exact same real-time
 * correction gate instead of running its user-text learning path ungated.
 * `packages/claw/src/learner.ts` re-exports this — behaviour is unchanged,
 * claw is a shipped package.
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
