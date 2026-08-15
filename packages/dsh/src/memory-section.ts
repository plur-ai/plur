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
 * Latin chars per token, matching `@plur-ai/claw`'s `estimateTokens`.
 * Deliberately an estimate rather than a tokenizer call: this runs on the
 * request path and must stay synchronous and cheap.
 */
const CHARS_PER_TOKEN = 4

/**
 * CJK and full-width characters, which tokenize at roughly ONE token each
 * rather than four-to-one.
 *
 * A flat `length / 4` under-counts Chinese text by about 4x, so a block that
 * looks like 500 tokens can really be 2000. The DeepSeek Harness ecosystem is
 * substantially Chinese-language, which makes that the common case here rather
 * than an edge case.
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/gu

/**
 * Estimate the token cost of a string, counting CJK at one token per character.
 *
 * @param text - the text to measure.
 * @returns an approximate token count, biased to over-estimate.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / CHARS_PER_TOKEN)
}

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
  const budget = Math.max(0, budgetTokens)
  if (budget === 0) return ''

  // Same construction as @plur-ai/mcp's session-start block.
  const assemble = (withConstraints: boolean, withConsider: boolean): string => {
    const lines: string[] = []
    if (injection.directives) lines.push('## DIRECTIVES\n', flatten(injection.directives))
    if (withConstraints && injection.constraints) lines.push('\n## CONSTRAINTS\n', flatten(injection.constraints))
    if (withConsider && injection.consider) lines.push('\n## ALSO CONSIDER\n', flatten(injection.consider))
    return lines.join('\n')
  }

  for (const [constraints, consider] of [[true, true], [true, false], [false, false]] as const) {
    const block = assemble(constraints, consider)
    if (estimateTokens(block) <= budget) return block
  }

  // Even directives alone overflow: emit nothing rather than a truncated engram.
  return ''
}

/**
 * Strip structure-forging characters from engram text.
 *
 * Statements are attacker-influenceable — packs are shared, and a user can be
 * talked into learning something — and this plugin promotes them from
 * tool-result trust to SYSTEM-PROMPT authority. Verified against a real
 * assembly, one engram could open its own `## DIRECTIVES` heading, fabricate
 * `## CONSTRAINTS` / `## ALSO CONSIDER` boundaries the model reads as ours,
 * and close and reopen a `<system>` tag.
 *
 * An engram is one assertion, so it is a single line by nature: collapsing
 * newlines removes the ability to forge a block without costing anything
 * legitimate. Leading `#` is neutralised for the same reason — a statement
 * cannot be allowed to look like a heading this plugin wrote. Angle brackets
 * are left alone; they are ordinary in technical notes, and a pseudo-tag with
 * no newline cannot restructure the prompt.
 *
 * @param text - one pre-rendered group from core.
 * @returns the same content, one engram per line, unable to forge structure.
 */
function flatten(text: string): string {
  return String(text)
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*#+\s*/, '').trim())
    .filter(Boolean)
    .join('\n')
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
