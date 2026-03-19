import type { AgentMessage } from './types.js'

export interface LearnCandidate {
  statement: string
  type: 'behavioral' | 'terminological' | 'procedural' | 'architectural'
  confidence: number // 0-1, how confident we are this is a real learning
}

// Patterns that indicate corrections or preferences.
// Listed from most-specific to least-specific — first match per message wins.

const DECISION_PATTERNS = [
  // "We decided to X", "The decision is X", "Let's go with X"
  { re: /(?:we decided|the decision is|let'?s go with|agreed to)\s+(.+)$/i, type: 'architectural' as const, confidence: 0.8 },
  // "The convention/rule/pattern is X"
  { re: /(?:the convention is|the rule is|the pattern is|the standard is)\s+(.+)$/i, type: 'procedural' as const, confidence: 0.7 },
]

const PREFERENCE_PATTERNS = [
  // "I prefer X", "I like X"
  { re: /(?:i prefer|i like)\s+(.+?)(?:\s+(?:for|over|instead|rather)\s+.+)?$/i, type: 'behavioral' as const, confidence: 0.6 },
  // "always/never X"
  { re: /^(?:always|never)\s+(.+)$/i, type: 'behavioral' as const, confidence: 0.7 },
  // "should/must/don't X"
  { re: /(?:you should|you must|don't|do not)\s+(.+)$/i, type: 'behavioral' as const, confidence: 0.6 },
]

const CORRECTION_PATTERNS = [
  // "No, ...", "Actually, ..." — require the correction prefix to be present
  { re: /^(?:no[,.]|actually[,.])\s+(.+)$/i, type: 'behavioral' as const, confidence: 0.7 },
  // "X, not Y" pattern — require explicit "not" contrast
  { re: /^(.+?),?\s+not\s+(.+)$/i, type: 'behavioral' as const, confidence: 0.8 },
]

// All pattern groups in priority order (most specific first)
const ALL_PATTERN_GROUPS = [DECISION_PATTERNS, PREFERENCE_PATTERNS, CORRECTION_PATTERNS]

/**
 * Extract learning candidates from messages.
 * Only processes user messages (role === 'user').
 * Returns candidates — the caller decides whether to persist them.
 * Each message produces at most one candidate (first matching pattern wins).
 */
export function extractLearnings(messages: AgentMessage[]): LearnCandidate[] {
  const candidates: LearnCandidate[] = []
  const seenStatements = new Set<string>()

  for (const msg of messages) {
    if (msg.role !== 'user') continue
    const content = typeof msg.content === 'string' ? msg.content : ''
    if (content.length < 10 || content.length > 500) continue // too short or too long

    // Try each pattern group in priority order; take the first match per message
    let matched = false
    for (const patterns of ALL_PATTERN_GROUPS) {
      if (matched) break
      for (const { re, type, confidence } of patterns) {
        const match = content.match(re)
        if (match && match[1]) {
          const statement = match[1].trim()
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

  return candidates
}

/**
 * Check if a single message contains a correction.
 * Used during ingest() for real-time learning.
 */
export function isCorrection(message: AgentMessage): boolean {
  if (message.role !== 'user') return false
  const content = typeof message.content === 'string' ? message.content : ''
  const lowerContent = content.toLowerCase().trim()
  return (
    lowerContent.startsWith('no,') ||
    lowerContent.startsWith('no ') ||
    lowerContent.startsWith('actually,') ||
    lowerContent.startsWith('actually ') ||
    lowerContent.includes(' not ') ||
    lowerContent.startsWith('wrong') ||
    lowerContent.startsWith("that's wrong") ||
    lowerContent.startsWith("that's incorrect")
  )
}
