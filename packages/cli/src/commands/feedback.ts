import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

const VALID_SIGNALS = ['positive', 'negative', 'neutral'] as const
type Signal = (typeof VALID_SIGNALS)[number]

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let id = ''
  let signal = ''

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (!id) { id = arg; i++ }
    else if (!signal) { signal = arg; i++ }
    else { i++ }
  }

  if (!id || !signal) {
    exit(1, 'Usage: plur feedback <id> <signal> (signal: positive|negative|neutral)')
  }

  if (!(VALID_SIGNALS as readonly string[]).includes(signal)) {
    exit(1, `Invalid signal: "${signal}". Must be one of: positive, negative, neutral`)
  }

  plur.feedback(id, signal as Signal)

  if (shouldOutputJson(flags)) {
    outputJson({ id, signal, status: 'recorded' })
  } else {
    outputText(`Feedback recorded: ${signal} for ${id}`)
  }
}
