import type { AgentMessage } from './types.js'

// `extractLearnings` and `LearnCandidate` moved to `@plur-ai/core` (2026-09,
// opencode plugin task 6a) so `@plur-ai/opencode` shares the exact same
// learning-extraction heuristics instead of vendoring a second copy.
// Re-exported here so existing imports of `./learner.js` keep working.
export { extractLearnings, type LearnCandidate } from '@plur-ai/core'

/**
 * Extract text from message content, handling both string and array-of-blocks formats.
 * OpenClaw wraps messages as [{type: "text", text: "..."}] with metadata prepended.
 *
 * Kept local (not moved to core): only `isCorrection` below still needs it,
 * and `isCorrection` itself did not move — `extractLearnings` does not
 * depend on it.
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
 * Check if a single message contains a correction.
 * Used during ingest() for real-time learning.
 * Checks per-sentence for long messages.
 */
export function isCorrection(message: AgentMessage): boolean {
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
