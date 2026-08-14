/**
 * The memory block and its per-agent cache.
 *
 * This is the thesis of the plugin. The block becomes a `ctx.systemPrompt`
 * section that dsh re-renders on every assembly, so the memories themselves are
 * in front of the model with no tool call — and, because a prompt section is
 * rendered rather than logged as a message, nothing accretes.
 *
 * @module
 */
import { createHash } from 'node:crypto'

/** The engram fields the rendered block uses. */
export interface EngramLike {
  readonly id: string
  readonly statement: string
  readonly domain?: string
  readonly confidence?: number
}

/** Engrams at or above this confidence render as directives. */
const DIRECTIVE_CONFIDENCE = 0.5

/**
 * Conservative chars-per-token divisor for budget trimming.
 *
 * Deliberately an estimate rather than a tokenizer call: this runs on the
 * request path and must stay synchronous and cheap. Under-estimating tokens
 * would overshoot the budget, so the divisor errs small.
 */
const CHARS_PER_TOKEN = 4

/**
 * Render the memory block for the `plur:memory` system-prompt section.
 *
 * The format matches `@plur-ai/claw`'s assembler and the MCP session-start
 * block — identical output across hosts is a PLUR principle, enforced by the
 * format-parity test. Returns `''` for an empty set so the section contributes
 * nothing rather than a bare heading.
 *
 * @param engrams - selected engrams, already ranked by the caller.
 * @param budgetTokens - approximate token ceiling for the whole block.
 * @returns the rendered block, or `''` when there is nothing to say.
 */
export function renderBlock(engrams: readonly EngramLike[], budgetTokens: number): string {
  if (engrams.length === 0) return ''
  const budgetChars = Math.max(0, budgetTokens) * CHARS_PER_TOKEN
  if (budgetChars === 0) return ''

  const directives: string[] = []
  const also: string[] = []
  let used = 0

  for (const engram of engrams) {
    const confidence = engram.confidence ?? 0
    const isDirective = confidence >= DIRECTIVE_CONFIDENCE
    const line = isDirective && engram.domain
      ? `[${engram.id}] ${engram.statement}\n  Domain: ${engram.domain}`
      : `[${engram.id}] ${engram.statement}`
    if (used + line.length > budgetChars) break
    used += line.length
    ;(isDirective ? directives : also).push(line)
  }

  const sections: string[] = []
  if (directives.length > 0) sections.push(`## DIRECTIVES\n\n${directives.join('\n\n')}`)
  if (also.length > 0) sections.push(`## ALSO CONSIDER\n\n${also.join('\n')}`)
  return sections.join('\n\n')
}

/**
 * Stable digest of a rendered block, for change detection.
 *
 * @param block - the rendered block.
 * @returns a hex SHA-256 digest.
 */
export function blockHash(block: string): string {
  return createHash('sha256').update(block).digest('hex')
}

/** Per-agent rendered-block store, read synchronously by the prompt section. */
export interface MemoryCache {
  /** The current block for an agent, or `''` when there is none. Never throws. */
  read(agentId: string): string
  /** Store a block. Returns `false` when it is byte-identical to the cached one. */
  write(agentId: string, block: string): boolean
  /** Drop an agent's block when its session ends. */
  clear(agentId: string): void
}

/**
 * Create the cache backing the prompt section.
 *
 * `write` is hash-gated because an unchanged memory set must not rewrite the
 * system prompt: the prompt sits at the front of the request, so rewriting it
 * invalidates the provider's KV-cache prefix for no benefit. The returned
 * boolean lets the caller record whether anything actually moved.
 *
 * @returns a fresh, empty cache.
 */
export function createMemoryCache(): MemoryCache {
  const blocks = new Map<string, string>()
  const hashes = new Map<string, string>()
  return {
    read: agentId => blocks.get(agentId) ?? '',
    write: (agentId, block) => {
      const hash = blockHash(block)
      if (hashes.get(agentId) === hash) return false
      hashes.set(agentId, hash)
      blocks.set(agentId, block)
      return true
    },
    clear: agentId => {
      blocks.delete(agentId)
      hashes.delete(agentId)
    },
  }
}
