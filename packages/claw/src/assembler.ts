import type { AgentMessage, AssembleResult } from './types.js'
import type { InjectionResult } from '@plur-ai/core'

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

  // Estimate tokens for messages
  const messageTokens = messages.reduce(
    (sum, m) => sum + Math.ceil((typeof m.content === 'string' ? m.content.length : 0) / 4),
    0
  )

  // Build system prompt addition from injection
  let systemPromptAddition = ''
  if (injection && injection.count > 0) {
    const lines: string[] = ['[PLUR Memory — relevant knowledge from past sessions]', '']

    if (injection.directives) {
      lines.push('## Directives', '')
      lines.push(injection.directives)
      lines.push('')
    }

    if (injection.consider) {
      lines.push('## Also Consider', '')
      lines.push(injection.consider)
      lines.push('')
    }

    systemPromptAddition = lines.join('\n')
  }

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
