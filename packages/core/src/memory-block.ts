import type { InjectionResult } from './types.js'

/**
 * PLUR memory instructions — injected into every session via systemPromptAddition.
 * Teaches the model how its memory works and how to signal new learnings.
 * This is what every PLUR user gets automatically, no configuration needed.
 *
 * Do not reword: end users read this text.
 */
export const PLUR_MEMORY_INSTRUCTIONS = `[PLUR Memory System]

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
 * Render the shared memory system-prompt section: the PLUR memory instructions
 * (always rendered) plus a "## Your Memories" block of the injected sections.
 * With a `tokenBudget`, each section is appended WHOLE only if it still fits
 * the remaining budget (tokens = ceil(chars / 4)), else dropped whole; the
 * heading must fit too, and constraints/consider need > 100 tokens left. So
 * output never exceeds `tokenBudget - usedTokens` when the instructions fit.
 * Shared by `@plur-ai/claw` and `@plur-ai/opencode` for byte-identical output.
 */
export function renderMemoryBlock(params: {
  injection: InjectionResult | null
  tokenBudget?: number
  usedTokens?: number
}): string {
  const { injection, tokenBudget, usedTokens = 0 } = params
  const sections: string[] = [PLUR_MEMORY_INSTRUCTIONS]

  if (injection && injection.count > 0) {
    const lines: string[] = ['## Your Memories', '']
    const instructionTokens = Math.ceil(PLUR_MEMORY_INSTRUCTIONS.length / 4)
    const remainingBudget = tokenBudget ? tokenBudget - usedTokens - instructionTokens : Infinity
    // Tokens the block costs in the output, including the '\n' that joins it
    // to the instructions.
    const blockTokens = (ls: string[]) => Math.ceil(('\n' + ls.join('\n')).length / 4)
    const fits = (extra: string[]) => blockTokens([...lines, ...extra]) <= remainingBudget

    if (injection.directives && remainingBudget > 0) {
      const add = ['These are things you have learned and should apply:', '', injection.directives, '']
      if (fits(add)) lines.push(...add)
    }

    if (injection.constraints) {
      const usedLineTokens = Math.ceil(lines.join('\n').length / 4)
      if ((remainingBudget - usedLineTokens) > 100) {
        const add = [injection.constraints, '']
        if (fits(add)) lines.push(...add)
      }
    }

    // Only include "consider" section if we have budget for it
    const directiveTokens = Math.ceil(lines.join('\n').length / 4)
    if (injection.consider && (remainingBudget - directiveTokens) > 100) {
      const add = ['These may also be relevant:', '', injection.consider, '']
      if (fits(add)) lines.push(...add)
    }

    if (fits([])) sections.push(lines.join('\n'))
  }

  return sections.join('\n')
}
