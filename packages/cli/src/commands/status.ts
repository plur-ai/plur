import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const result = plur.status()

  if (shouldOutputJson(flags)) {
    outputJson(result)
  } else {
    outputText('Plur Status')
    outputText('===========')
    outputText(`  Engrams:      ${result.engram_count}`)
    outputText(`  Episodes:     ${result.episode_count}`)
    outputText(`  Packs:        ${result.pack_count}`)
    outputText(`  Storage root: ${result.storage_root}`)
  }
}
