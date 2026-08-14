/**
 * The memory block and its per-agent cache.
 *
 * This is the thesis of the plugin. The block becomes a `ctx.systemPrompt`
 * section that dsh re-renders on every assembly, so the memories themselves are
 * in front of the model with no tool call — and, because a prompt section is
 * rendered rather than logged as a message, nothing accretes.
 *
 * The block is assembled from `@plur-ai/core`'s pre-rendered `InjectionResult`
 * strings using the SAME construction as `@plur-ai/mcp`'s session-start output,
 * so cross-host format parity holds by construction rather than by a snapshot
 * test that can drift.
 *
 * @module
 */
import { createHash } from 'node:crypto'

/** The `InjectionResult` fields this module renders. */
export interface InjectionLike {
  /** Pre-rendered high-confidence engrams. */
  readonly directives?: string
  /** Pre-rendered constraint engrams. */
  readonly constraints?: string
  /** Pre-rendered lower-confidence engrams. */
  readonly consider?: string
  /** How many engrams were selected. */
  readonly count?: number
}

/**
 * Conservative chars-per-token divisor, matching `@plur-ai/claw`'s
 * `estimateTokens`. Deliberately an estimate rather than a tokenizer call:
 * this runs on the request path and must stay synchronous and cheap.
 */
const CHARS_PER_TOKEN = 4

/**
 * Render the memory block for the `plur:memory` system-prompt section.
 *
 * Sections are dropped whole, least important first (`consider`, then
 * `constraints`), rather than truncating mid-engram — a half-rendered engram is
 * worse than an absent one, because the model reads it as a complete statement.
 *
 * @param injection - the result of a PLUR injection call.
 * @param budgetTokens - approximate token ceiling for the whole block.
 * @returns the rendered block, or `''` when there is nothing to say.
 */
export function renderBlock(injection: InjectionLike | undefined, budgetTokens: number): string {
  if (!injection || (injection.count ?? 0) === 0) return ''
  const budgetChars = Math.max(0, budgetTokens) * CHARS_PER_TOKEN
  if (budgetChars === 0) return ''

  // Same construction as @plur-ai/mcp's session-start block.
  const assemble = (withConstraints: boolean, withConsider: boolean): string => {
    const lines: string[] = []
    if (injection.directives) lines.push('## DIRECTIVES\n', injection.directives)
    if (withConstraints && injection.constraints) lines.push('\n## CONSTRAINTS\n', injection.constraints)
    if (withConsider && injection.consider) lines.push('\n## ALSO CONSIDER\n', injection.consider)
    return lines.join('\n')
  }

  for (const [constraints, consider] of [[true, true], [true, false], [false, false]] as const) {
    const block = assemble(constraints, consider)
    if (block.length <= budgetChars) return block
  }

  // Even directives alone overflow: emit nothing rather than a truncated engram.
  return ''
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
