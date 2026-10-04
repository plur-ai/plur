import type { InjectionResult } from './types.js'

/**
 * PLUR memory instructions — injected into every session via systemPromptAddition.
 * Teaches the model how its memory works and how to signal new learnings.
 * This is what every PLUR user gets automatically, no configuration needed.
 *
 * Copied verbatim from packages/claw/src/assembler.ts (do not reword — the
 * wording is product surface end users read).
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
 * Render the shared memory system-prompt section: the PLUR memory
 * instructions, plus a "## Your Memories" block with the injected sections
 * (directives, constraints, consider) that fit the token budget.
 *
 * Budget (owner decision I2, formal run 2026-09-26): with a `tokenBudget`, the
 * room left after `usedTokens` and the fixed instructions is `remaining`. Each
 * section is appended WHOLE only if the block with it still fits `remaining`
 * (tokens = ceil(chars / 4), the same estimate as the rest of this function);
 * a section that does not fit is dropped whole, and a later, smaller one may
 * still be appended. The heading is emitted only if it fits too. So the
 * returned text never exceeds `tokenBudget - usedTokens` tokens whenever the
 * instructions alone fit; the instructions are always rendered. Previously a
 * section was appended whenever SOME budget remained, whatever its size
 * (replayed: budget 499 → 5469 tokens rendered). The existing slack gates
 * (constraints and consider need > 100 tokens left before them) still apply.
 * Without a `tokenBudget`, every present section is rendered, as before.
 *
 * Extracted from `@plur-ai/claw`'s `assembleContext` so `@plur-ai/opencode`
 * can render byte-identical output instead of vendoring a second copy of
 * this logic. claw and opencode both call this function, so they share the
 * budget rule by construction.
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
