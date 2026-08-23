import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo } from '../output.js'

/**
 * Flags this command accepts (#986).
 */
export const FLAGS_WITH_VALUES = ['--scope', '--domain', '--type', '--tags', '--limit']

export const FLAGS = ['--scope', '--domain', '--type', '--tags', '--limit']

/**
 * Shorten a statement to a display WIDTH, never splitting a character.
 *
 * Slicing by code unit cut an emoji in half and printed a replacement
 * character in its place: any astral character landing on the boundary was
 * destroyed. Counting characters fixes that but still misaligns the column,
 * because a Chinese, Japanese or Korean character occupies two terminal cells
 * while a Latin letter occupies one — a tester measured a Latin row at 60 cells
 * and a Japanese one at 85.
 *
 * So: iterate by character, and count wide ones as two.
 */
export function clipToWidth(text: string, maxWidth: number): string {
  const wide = (ch: string) => {
    const cp = ch.codePointAt(0) ?? 0
    return (cp >= 0x1100 && cp <= 0x115f)      // Hangul Jamo
      || (cp >= 0x2e80 && cp <= 0xa4cf)        // CJK radicals through Yi
      || (cp >= 0xac00 && cp <= 0xd7a3)        // Hangul syllables
      || (cp >= 0xf900 && cp <= 0xfaff)        // CJK compatibility
      || (cp >= 0xfe30 && cp <= 0xfe6f)        // CJK compatibility forms
      || (cp >= 0xff00 && cp <= 0xff60)        // Fullwidth forms
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1faff)      // Emoji
      || (cp >= 0x20000 && cp <= 0x3fffd)      // CJK extension B and beyond
  }

  let width = 0
  let out = ''
  for (const ch of text) {
    const w = wide(ch) ? 2 : 1
    if (width + w > maxWidth - 1) return `${out}…`
    width += w
    out += ch
  }
  return out
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  // Pure query — a read-only engine guarantees no lazy write side-effects.
  const plur = createPlur(flags, { readonly: true })

  let domain: string | undefined
  let type: string | undefined
  let scope: string | undefined
  let limit: number | undefined
  let meta = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    else if (arg === '--type' && i + 1 < args.length) { type = args[++i]; i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--limit' && i + 1 < args.length) { limit = parseInt(args[++i], 10); i++ }
    else if (arg === '--meta') { meta = true; i++ }
    else { i++ }
  }

  let engrams = await plur.list({ scope, domain })

  // Post-filter by type
  if (type) {
    engrams = engrams.filter(e => e.type === type)
  }

  // Post-filter by meta (IDs starting with META-)
  if (meta) {
    engrams = engrams.filter(e => e.id.startsWith('META-'))
  }

  // Apply limit
  if (limit !== undefined) {
    engrams = engrams.slice(0, limit)
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      engrams: engrams.map(e => ({
        id: e.id,
        statement: e.statement,
        scope: e.scope,
        type: e.type,
        domain: e.domain ?? null,
        strength: e.activation.retrieval_strength,
      })),
      count: engrams.length,
    })
  } else {
    if (engrams.length === 0) {
      outputText('No engrams found.')
      return
    }
    const MAX_STMT = 60
    outputText(`${'ID'.padEnd(20)} ${'TYPE'.padEnd(14)} ${'SCOPE'.padEnd(20)} STATEMENT`)
    outputText('-'.repeat(100))
    for (const e of engrams) {
      outputText(`${e.id.padEnd(20)} ${e.type.padEnd(14)} ${e.scope.padEnd(20)} ${clipToWidth(e.statement, MAX_STMT)}`)
    }
    outputInfo(`\nTotal: ${engrams.length}`, flags)
  }
}
