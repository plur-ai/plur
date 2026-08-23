/**
 * Refuse a flag the command does not understand (#986).
 *
 * Every command's parser ends in `else { i++ }`, so an argument it did not
 * recognise was skipped in silence and the command succeeded. Four testers were
 * misled by this. The worst case: `plur packs install <dir> --dry-run` — that
 * command has no `--dry-run`, so the flag was swallowed and the pack was
 * installed by somebody who believed they were previewing it.
 *
 * For a feature whose whole purpose is recording where something came from, a
 * dropped `--license` or `--asserted-by` produces a clean-looking success with
 * the fields that mattered missing. As a tester put it: worse than not having
 * the feature.
 *
 * **Opt-in by command.** A command declares what it accepts by exporting
 * `FLAGS`; the dispatcher checks against it. A command that exports nothing
 * behaves exactly as before, so this can be adopted one command at a time
 * without a flag day, and without this file needing to know about all forty.
 */

/** Global flags every command accepts, stripped before a command ever sees them. */
const GLOBAL = ['--json', '--quiet', '--fast', '--path', '--help', '--version']

/** How many single-character edits turn `a` into `b`. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1])
    }
  }
  return rows[a.length][b.length]
}

/**
 * The known flag closest to what was typed, when one is close enough to be
 * worth suggesting. `--licence` for `--license` is the case worth catching:
 * it is a spelling most of the world uses and it currently fails in silence.
 */
function nearest(flag: string, known: string[]): string | undefined {
  let best: string | undefined
  let bestScore = Infinity
  for (const candidate of known) {
    const d = distance(flag, candidate)
    if (d < bestScore) { bestScore = d; best = candidate }
  }
  // Two edits on a short flag is already a stretch; beyond that a suggestion
  // is noise that sends people down the wrong path.
  return bestScore <= 2 ? best : undefined
}

/**
 * Check the arguments a command was given against the flags it declares.
 *
 * Returns a message to print, or undefined when everything is recognised.
 * Everything after a bare `--` is left alone: that is the conventional marker
 * for "stop interpreting, these are values".
 */
export function unknownFlagMessage(
  args: string[],
  declared: string[],
  takesValue: string[] = [],
): string | undefined {
  const known = [...declared, ...GLOBAL]
  const offenders: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    // Short flags count too: `-x` bypassed this entirely. A negative number
    // is a value, not a flag, so a digit after the dash is left alone.
    if (!/^-{1,2}[A-Za-z]/.test(arg)) continue
    if (!known.includes(arg)) { offenders.push(arg); continue }

    // A flag that needs a value must have one. `learn "x" --scope --type
    // behavioral` stored the literal string "--type" as the scope, and
    // `--type` at the end of the line was dropped in silence — both writing
    // an engram, both exit 0. Whatever the operator meant, it was not that.
    if (takesValue.includes(arg)) {
      const next = args[i + 1]
      if (next === undefined || /^-{1,2}[A-Za-z]/.test(next)) {
        return `${arg} needs a value, but the next argument was ${next ?? '(nothing)'}.`
      }
      i++
    }
  }
  if (!offenders.length) return undefined

  const lines = offenders.map(f => {
    const near = nearest(f, known)
    return near ? `  ${f}  — did you mean ${near}?` : `  ${f}`
  })
  const label = offenders.length === 1 ? 'flag' : 'flags'
  return `Unrecognised ${label}:\n${lines.join('\n')}\n\n`
    + `Accepted here: ${declared.join(', ') || '(none beyond the global flags)'}\n`
    + `Global: ${GLOBAL.join(', ')}`
}
