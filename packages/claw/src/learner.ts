import type { AgentMessage } from './types.js'

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

// Patterns that indicate corrections or preferences.
// Applied per-sentence (not per-message) to handle long conversational messages.

const DECISION_PATTERNS = [
  { re: /(?:we decided|the decision is|let'?s go with|agreed to)\s+(.+)/i, type: 'architectural' as const, confidence: 0.8 },
  { re: /(?:the convention is|the rule is|the pattern is|the standard is)\s+(.+)/i, type: 'procedural' as const, confidence: 0.7 },
]

const PREFERENCE_PATTERNS = [
  { re: /(?:i prefer|i like)\s+(.+?)(?:\s+(?:for|over|instead|rather)\s+.+)?$/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:always|never)\s+(.+)/i, type: 'behavioral' as const, confidence: 0.7 },
  { re: /(?:you should|you must|don't|do not)\s+(.+)/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:your purpose is|you are)\s+(.{15,})/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:i want you to)\s+(.+)/i, type: 'behavioral' as const, confidence: 0.6 },
  { re: /(?:remember that)\s+(.+)/i, type: 'behavioral' as const, confidence: 0.7 },
]

const CORRECTION_PATTERNS = [
  { re: /(?:no[,.]|actually[,.])\s+(.+)/i, type: 'behavioral' as const, confidence: 0.7 },
  { re: /(.+?),?\s+not\s+(.+)/i, type: 'behavioral' as const, confidence: 0.8 },
]

const IDENTITY_PATTERNS = [
  { re: /(?:you are|you were)\s+((?:Data|inspired|an android|a living|not just).{10,})/i, type: 'terminological' as const, confidence: 0.7 },
  { re: /(?:your name is|call (?:you|yourself))\s+(.+)/i, type: 'terminological' as const, confidence: 0.8 },
  { re: /(?:we are building|we built|I built)\s+(.{15,})/i, type: 'architectural' as const, confidence: 0.7 },
]

// All pattern groups in priority order (most specific first)
const ALL_PATTERN_GROUPS = [IDENTITY_PATTERNS, DECISION_PATTERNS, CORRECTION_PATTERNS, PREFERENCE_PATTERNS]

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
 * Extract learning candidates from messages.
 * Only processes user messages (role === 'user').
 * Splits long messages into sentences for per-sentence pattern matching.
 * Returns candidates — the caller decides whether to persist them.
 */
export function extractLearnings(messages: AgentMessage[]): LearnCandidate[] {
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

/**
 * Check if a single message contains a correction.
 * Used during ingest() for real-time learning.
 * Checks per-sentence for long messages.
 */
export function isCorrection(message: AgentMessage): boolean {
  if (message.role !== 'user') return false
  const content = extractText(message.content)

  // Check per-sentence for multi-paragraph messages
  const sentences = content.length > 200 ? splitSentences(content) : [content]

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase().trim()
    if (
      lower.startsWith('no,') ||
      lower.startsWith('no.') ||
      lower.startsWith('actually,') ||
      lower.startsWith('actually ') ||
      lower.includes(' not ') ||
      lower.startsWith('wrong') ||
      lower.startsWith("that's wrong") ||
      lower.startsWith("that's incorrect")
    ) {
      return true
    }
  }
  return false
}
