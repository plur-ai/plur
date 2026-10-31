/**
 * The memory block and its per-agent cache — the thesis of the plugin: a `ctx.systemPrompt` section re-rendered on
 * every assembly, so memories reach the model with no tool call and nothing accretes.
 * Built from core's pre-rendered `InjectionResult` strings with the SAME construction as `@plur-ai/mcp`'s
 * session-start output, so format parity holds by construction.
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
 * Sections are dropped whole, never truncated mid-engram (a half engram reads as complete). Under budget pressure
 * `consider` goes first, then `directives`; `constraints` never.
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
  //
  // CONSTRAINTS FIRST, and CONSTRAINTS LAST TO GO. Both are deliberate.
  // Prohibitions — what the agent may never say or do — outrank process
  // hygiene at every budget. Consumers often read only the head of a long
  // block, so a CONSTRAINTS section placed after large DIRECTIVES may never be
  // read at all.
  const assemble = (withDirectives: boolean, withConsider: boolean): string => {
    const lines: string[] = []
    if (injection.constraints) lines.push('## CONSTRAINTS\n', flatten(injection.constraints))
    if (withDirectives && injection.directives) lines.push('\n## DIRECTIVES\n', flatten(injection.directives))
    if (withConsider && injection.consider) lines.push('\n## ALSO CONSIDER\n', flatten(injection.consider))
    return lines.join('\n')
  }

  for (const [directives, consider] of [[true, true], [true, false], [false, false]] as const) {
    const block = assemble(directives, consider)
    if (estimateTokens(block) <= budget) return block
  }

  // Constraints alone overflow the budget: emit a short WITHHELD notice plus the directives, so prohibitions are
  // never dropped in silence ("no rules" vs "rules did not fit") yet the store still gets memory. Reached only after
  // every rung that keeps constraints has failed.
  if (injection.constraints) {
    const notice = '## CONSTRAINTS\nWITHHELD — the prohibitions for this session did not fit the '
      + 'memory budget. Treat them as UNREAD, not as absent: do not assume an action is permitted '
      + 'because no rule against it appears here.'
    for (const withDirectives of [true, false] as const) {
      const block = withDirectives && injection.directives
        ? [notice, '\n## DIRECTIVES\n', flatten(injection.directives)].join('\n')
        : notice
      if (estimateTokens(block) <= budget) return block
    }
  }

  // Not even the notice fits. Emit nothing rather than a truncated engram.
  return ''
}

/**
 * Strip structure-forging characters from engram text. Statements are attacker-influenceable and are promoted here
 * to SYSTEM-PROMPT authority; without this one engram could forge `## DIRECTIVES`/`## CONSTRAINTS` headings or
 * close a `<system>` tag. An engram is one line by nature, so newlines collapse and a leading `#` is neutralised.
 * Angle brackets stay: without a newline a pseudo-tag cannot restructure the prompt.
 *
 * @param text - one pre-rendered group from core.
 * @returns the same content, one engram per line, unable to forge structure.
 */
function flatten(text: string): string {
  return String(text)
    // Split ONLY on an engram boundary — core renders one per line as
    // `[ID] statement` — so engrams stay separate while everything inside one
    // is collapsed.
    .split(/\n(?=\[)/)
    .map(entry => entry
      // Invisibles first: JS `\s` covers \t, NBSP and BOM but NOT U+200B,
      // U+200C, U+200F, U+2060 or the soft hyphen, so `\u200b# FORGED` would
      // slip past the heading strip and render as a heading.
      .replace(INVISIBLE, '')
      // Every line terminator, not just \r?\n. A lone \r is a line break to
      // every renderer, and U+2028/U+2029/U+0085 are too, so `\r## DIRECTIVES`
      // would otherwise forge a heading. Collapsing to a space also kills setext
      // underlining, because `======` can no longer reach a line of its own.
      .replace(LINE_BREAKS, ' ')
      .replace(/^\s*#+\s*/, '')
      .replace(/\s{2,}/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n')
}

/** Zero-width and formatting characters that `\s` does not cover. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g

/** Every character a renderer treats as a line break. */
const LINE_BREAKS = /[\r\n\u2028\u2029\u0085\u000b\u000c\u001c-\u001f]+/g

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
