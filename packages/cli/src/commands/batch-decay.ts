import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let contextScope: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--context-scope' && i + 1 < args.length) { contextScope = args[++i]; i++ }
    else { i++ }
  }

  const result = plur.batchDecay({ contextScope })

  if (shouldOutputJson(flags)) {
    outputJson(result)
  } else {
    outputText(`Batch decay complete: ${result.total} engrams processed, ${result.decayed} decayed, ${result.skipped} skipped`)
    if (result.transitions.length > 0) {
      outputText(`${result.transitions.length} status transition(s):`)
      result.transitions.forEach(t => {
        outputText(`  ${t.id}: ${t.old_status} → ${t.new_status} (strength: ${t.old_strength.toFixed(3)} → ${t.new_strength.toFixed(3)})`)
      })
    }
  }
}
