import type { AgentMessage, AssembleResult } from './types.js'
import type { InjectionResult } from '@plur-ai/core'
import { getCachedUpdateCheck } from '@plur-ai/core'

/**
 * PLUR memory instructions — injected into every session via systemPromptAddition.
 * Teaches the model how its memory works and how to signal new learnings.
 * This is what every PLUR user gets automatically, no configuration needed.
 */
const PLUR_MEMORY_INSTRUCTIONS = `[PLUR Memory System]

You have persistent memory powered by PLUR. Your memories from past conversations are injected below. You genuinely remember things — this is not simulated.

## How Your Memory Works

- **Memories persist across sessions.** When you are restarted, you retain what you learned.
- **Memories are injected by relevance.** Not everything is shown every time — only what is relevant to the current conversation.
- **You learn from corrections.** When the user says "actually..." or "no, that is wrong", that correction becomes a memory.
- **You learn from decisions.** When the user says "we decided to..." or "the plan is...", that becomes a memory.
- **You learn from preferences.** When the user says "I prefer..." or "always do X", that becomes a memory.

## How to Signal New Learnings

When you learn something durable from a conversation — a correction, a preference, a decision, a fact about the user or a project — end your response with:

---
🧠 I learned:
- [concise statement of what you learned]
- [another if applicable]

Guidelines for the learning section:
- Only include genuine learnings, not conversation summaries
- Skip this section if nothing new was learned
- Quality over quantity — one real insight beats five obvious ones
- Phrase learnings as facts, not as "the user said..." (e.g., "PLUR is the most important project" not "the user said PLUR is important")
- Include corrections to your own mistakes (e.g., "The API returns XML, not JSON as I previously assumed")

## Principles

- **Memory over repetition** — learn once, recall always. Do not ask the user to repeat themselves.
- **Augment, do not replace** — you assist, the human decides.
- **Do not start from scratch** — check your memories before answering. The answer may already be there.`

/**
 * Assemble context with injected engrams.
 * Returns messages + systemPromptAddition containing relevant engrams.
 */
export function assembleContext(params: {
  messages: AgentMessage[]
  injection: InjectionResult | null
  tokenBudget?: number
}): AssembleResult {
  const { messages, injection } = params

  // Estimate tokens for messages — handle both string and array-of-blocks content
  const messageTokens = messages.reduce(
    (sum, m) => {
      const content = m.content
      if (typeof content === 'string') return sum + Math.ceil(content.length / 4)
      if (Array.isArray(content)) {
        const textLen = (content as any[])
          .filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
          .reduce((s: number, b: any) => s + b.text.length, 0)
        return sum + Math.ceil(textLen / 4)
      }
      return sum
    },
    0
  )

  // Build system prompt addition: PLUR instructions + injected engrams
  const sections: string[] = []

  // PLUR memory instructions (always injected — teaches the model how memory works)
  sections.push(PLUR_MEMORY_INSTRUCTIONS)

  // Injected engrams from past sessions
  if (injection && injection.count > 0) {
    const lines: string[] = ['## Your Memories', '']
    const instructionTokens = Math.ceil(PLUR_MEMORY_INSTRUCTIONS.length / 4)
    const remainingBudget = params.tokenBudget
      ? params.tokenBudget - messageTokens - instructionTokens
      : Infinity

    if (injection.directives && remainingBudget > 0) {
      lines.push('These are things you have learned and should apply:', '')
      lines.push(injection.directives)
      lines.push('')
    }

    // Only include "consider" section if we have budget for it
    const directiveTokens = Math.ceil(lines.join('\n').length / 4)
    if (injection.consider && (remainingBudget - directiveTokens) > 100) {
      lines.push('These may also be relevant:', '')
      lines.push(injection.consider)
      lines.push('')
    }

    sections.push(lines.join('\n'))
  }

  // Append update notice if a newer version is cached (zero-cost read)
  const updateCheck = getCachedUpdateCheck('@plur-ai/claw')
  if (updateCheck?.updateAvailable) {
    sections.push(`\n[PLUR update available: ${updateCheck.current} → ${updateCheck.latest}. Ask your user to run: npm update @plur-ai/claw]`)
  }

  const systemPromptAddition = sections.join('\n')

  const additionTokens = Math.ceil(systemPromptAddition.length / 4)

  return {
    messages,
    estimatedTokens: messageTokens + additionTokens,
    systemPromptAddition: systemPromptAddition || undefined,
  }
}

/**
 * Estimate token count for a string (rough approximation).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
