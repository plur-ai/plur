import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

/**
 * Who your memories are attributed to: see it, set it, clear it. It never
 * guesses from the OS account, which would put a real name into shared records
 * without a decision; unset stays unset and memories record `unidentified`.
 */
export const FLAGS = ['--clear']
export const FLAGS_WITH_VALUES: string[] = []

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const clear = args.includes('--clear')
  const value = args.find(a => !a.startsWith('-'))

  if (clear && value) {
    outputText('Pass a value or --clear, not both. Which did you mean?')
    process.exit(2)
  }

  if (clear || value !== undefined) {
    const before = plur.identity()
    const after = plur.setIdentity(clear ? null : (value as string))

    if (shouldOutputJson(flags)) {
      outputJson({ ...after, previous: before.stated ? before.identity : null })
      return
    }
    const lines: string[] = []
    lines.push(after.stated
      ? `Memories written from now on are attributed to ${after.identity}.`
      : 'Identity cleared. Memories written from now on are recorded as "unidentified".')
    // An email address is accepted and warned about here, where the choice
    // is made, rather than discovered at the first empty pack export.
    if (after.warning) {
      lines.push('')
      lines.push(`  Note: ${after.warning}`)
    }
    // Say plainly what this does not do. Somebody clearing an identity is
    // usually trying to un-say something, and this is the moment to be honest
    // that the past is not rewritten.
    if (before.stated) {
      lines.push('')
      lines.push(`  Memories already written keep ${before.identity}. That is the point of`)
      lines.push('  recording it — changing them to match a later decision would be')
      lines.push('  editing history. Use `plur forget` if a memory should not exist.')
    }
    outputText(lines.join('\n'))
    return
  }

  const current = plur.identity()
  if (shouldOutputJson(flags)) {
    outputJson(current)
    return
  }

  if (!current.stated) {
    outputText([
      'No identity is set. Your memories are recorded as "unidentified".',
      '',
      '  That is honest, and for a store nobody else ever sees it is fine. It',
      '  matters when a memory LEAVES — shared, pushed to a team, put in a pack —',
      '  because then somebody has to decide how much to trust it, and "who said',
      '  this" is the first thing they ask.',
      '',
      '  Set one:   plur identity local:yourname',
      '             plur identity did:web:example.org:yourname',
      '',
      '  Any address works. Nothing verifies it — packs are not signed — so this',
      '  is a claim about who is answerable, not proof of it. An email address',
      '  is accepted too, but the pack export privacy scan flags email addresses,',
      '  so memories attributed to one are held back from every pack.',
    ].join('\n'))
    return
  }

  outputText([
    `Memories are attributed to ${current.identity}.`,
    '',
    '  Change it:            plur identity <new-value>',
    '  Stop being named:     plur identity --clear',
    '  Just this once:       plur learn "..." --asserted-by <someone-else>',
    '',
    '  Self-asserted: nothing checks this, and no surface presents it as verified.',
  ].join('\n'))
}
