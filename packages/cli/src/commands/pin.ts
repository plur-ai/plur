/** `plur pin <id> [--scope <scope>]` — the owner pins an engram (see pins.ts). */
import type { GlobalFlags } from '../plur.js'
import { runPinToggle, FLAGS as PINS_FLAGS } from './pins.js'

export const FLAGS = PINS_FLAGS.filter(f => f === '--scope')
export const FLAGS_WITH_VALUES = ['--scope']

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  await runPinToggle(true, args, flags)
}
