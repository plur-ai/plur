import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  const result = plur.compact()

  if (shouldOutputJson(flags)) {
    outputJson(result)
  } else {
    if (result.removed === 0) {
      outputText(`No retired engrams to remove. Store has ${result.remaining} active engrams.`)
    } else {
      outputText(`Compacted: removed ${result.removed} retired engram(s). ${result.remaining} remain.`)
    }
  }
}
