import type { AgentMessage, AssembleResult } from './types.js'
import type { InjectionResult } from '@plur-ai/core'
import { getCachedUpdateCheck, renderMemoryBlock } from '@plur-ai/core'

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
  const sections: string[] = [
    renderMemoryBlock({ injection, tokenBudget: params.tokenBudget, usedTokens: messageTokens }),
  ]

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
    injected_ids: injection?.injected_ids,
  }
}

/**
 * Estimate token count for a string (rough approximation).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
