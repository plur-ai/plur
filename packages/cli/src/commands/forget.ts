import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let id = ''
  let reason: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--reason' && i + 1 < args.length) { reason = args[++i]; i++ }
    else if (!id) { id = arg; i++ }
    else { i++ }
  }

  if (!id) {
    exit(1, 'Usage: plur forget <id> [--reason <reason>]')
  }

  plur.forget(id, reason)

  if (shouldOutputJson(flags)) {
    outputJson({ id, status: 'retired', reason: reason ?? null })
  } else {
    outputText(`Retired engram: ${id}${reason ? ` (${reason})` : ''}`)
  }
}
