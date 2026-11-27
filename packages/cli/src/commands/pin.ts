/**
 * `plur pin <id> [--scope <scope>]` — the owner pins an engram (see pins.ts).
 * `plur pin` with no id, or `plur pin list|priority|review|audit|apply|undo`,
 * runs the pinned-set commands that 0.24 previews also offered as `plur pins`.
 */
import type { GlobalFlags } from '../plur.js'
import { exit } from '../output.js'
import { runPinToggle, run as runPins, FLAGS as PINS_FLAGS, FLAGS_WITH_VALUES as PINS_FLAGS_WITH_VALUES } from './pins.js'

export const FLAGS = PINS_FLAGS
export const FLAGS_WITH_VALUES = PINS_FLAGS_WITH_VALUES

const SUBCOMMANDS = new Set(['list', 'priority', 'review', 'audit', 'apply', 'undo'])

/** The words that are not flags or flag values, in order. */
function positionals(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (FLAGS_WITH_VALUES.includes(args[i])) { i++; continue }
    if (!args[i].startsWith('-')) out.push(args[i])
  }
  return out
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const [first] = positionals(args)
  if (first === undefined || SUBCOMMANDS.has(first)) return runPins(args, flags)
  // Pinning one engram takes --scope only, as before the fold.
  const extra = args.find(a => a.startsWith('--') && a !== '--scope')
  if (extra) exit(1, `Unknown flag for plur pin <id>: ${extra}\nUsage: plur pin <id> [--scope <scope>]`)
  await runPinToggle(true, args, flags)
}
