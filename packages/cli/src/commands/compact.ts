import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

/**
 * `plur compact` — physically remove retired engrams from the local store and
 * reclaim the YAML file space they occupy. A thin wrapper over core's
 * compact(): plur_forget only marks an engram status:retired (the row stays on
 * disk), so without an explicit compaction the store grows unbounded. This is
 * the user-invoked, logged maintenance op that shrinks it. Only retired
 * engrams are removed; active engrams are never touched. (#580)
 */
export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const result = plur.compact() // { removed, remaining }

  if (shouldOutputJson(flags)) {
    outputJson(result)
  } else if (result.removed === 0) {
    outputText(`No retired engrams to remove — store unchanged (${result.remaining} active).`)
  } else {
    const s = result.removed === 1 ? '' : 's'
    outputText(`Compacted store: removed ${result.removed} retired engram${s}, ${result.remaining} remaining.`)
  }
}
