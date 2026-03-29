import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let remote: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (!remote && !arg.startsWith('--')) { remote = arg; i++ }
    else { i++ }
  }

  const result = plur.sync(remote)

  if (shouldOutputJson(flags)) {
    outputJson(result)
  } else {
    outputText(`Sync: ${result.action}`)
    if (result.message) outputText(`  ${result.message}`)
    if (result.files_changed > 0) outputText(`  Files changed: ${result.files_changed}`)
  }
}
