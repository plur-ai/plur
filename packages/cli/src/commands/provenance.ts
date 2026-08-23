import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import { summariseProvenance, renderProvenanceSummary } from '@plur-ai/core'

/**
 * Where a memory came from (#980).
 *
 * Follows `plur receipt`: readable prose by default, `--json` for machines, and
 * never a blank where something was simply not recorded. A blank reads as zero;
 * an explicit "not recorded" reads as the truth.
 */
/** Flags this command accepts (#986). */
export const FLAGS = ['--record', '--write']

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const query = args.find(a => !a.startsWith('-'))
  // --json is the repo-wide "machine output" flag. --record asks for the
  // JSON-LD document itself, which is a different thing.
  const wantsRecord = args.includes('--record')
  const write = args.includes('--write')

  /** Report a failure the way the caller asked, and exit non-zero. */
  const fail = (message: string, extra: Record<string, unknown> = {}): never => {
    if (shouldOutputJson(flags)) outputJson({ found: false, error: message, ...extra })
    else outputText(message)
    process.exit(1)
  }

  if (!query) {
    outputText(
      'Usage: plur provenance <id-or-search> [--json] [--record] [--write]\n\n' +
      '  Shows where a memory came from: who asserted it, whether a person\n' +
      '  stated it or a model worked it out, when, what it came from, and\n' +
      '  whether you may reuse it.\n\n' +
      '  --json    machine-readable output\n' +
      '  --record  the provenance record itself, as JSON-LD\n' +
      '  --write   also save the record, and print where it went',
    )
    process.exit(2)
  }

  const plur = createPlur(flags)

  // An identifier, or words from the statement. Nobody remembers identifiers.
  let id = /^(ENG|ABS|META)-/.test(query) ? query : undefined
  let alternatives: Array<{ id: string; statement: string }> = []
  let matchCount = 0
  let matched: string | undefined
  if (!id) {
    // Ask for more than we list, so the count reported is the true one.
    const matches = await plur.recall(query, { limit: 25 })
    if (!matches.length) {
      fail(`Nothing matched "${query}". Try different words, or pass an exact id.`, { query })
    }
    id = matches[0].id
    matchCount = matches.length
    matched = matches[0].statement
    alternatives = matches.slice(1, 4).map((m: { id: string; statement: string }) =>
      ({ id: m.id, statement: m.statement.slice(0, 70) }))
  }

  const record = await plur.provenanceFor(id, { mode: 'portable' })
  if (!record) {
    fail(`No engram with id ${id}.`, { engram_id: id })
  }

  const summary = summariseProvenance(record as any)
  const saved = write ? await plur.writeProvenance(id) : undefined

  if (shouldOutputJson(flags) || wantsRecord) {
    // Structured values, never the padded display lines. A consumer must not
    // have to split on whitespace to recover a licence.
    outputJson({
      found: true,
      engram_id: id,
      ...summary.fields,
      ...(matchCount > 1 ? { match_count: matchCount, matched, other_matches: alternatives } : {}),
      not_recorded: summary.missing,
      complete: summary.complete,
      ...(wantsRecord ? { record } : {}),
      ...(saved ? { saved_to: saved } : {}),
    })
    return
  }

  const lines = [renderProvenanceSummary(summary)]
  if (matchCount > 1) {
    lines.push('')
    // Name the one that was picked. Quoting only the rejected candidates lets a
    // reader assume the right memory was found when it was not.
    lines.push(`  ${matchCount} engrams matched "${query}". This one:`)
    lines.push(`    ${id}  ${String(matched ?? '').slice(0, 70)}`)
    lines.push('  Others:')
    for (const alt of alternatives) lines.push(`    ${alt.id}  ${alt.statement}`)
    const hidden = matchCount - 1 - alternatives.length
    if (hidden > 0) lines.push(`    … and ${hidden} more not shown`)
  }
  if (saved) {
    lines.push('')
    lines.push(`  Record saved to ${saved}`)
  }
  outputText(lines.join('\n'))
}
