import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let task = ''
  let budget = 2000

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--budget' && i + 1 < args.length) { budget = parseInt(args[++i], 10); i++ }
    else if (!task) { task = arg; i++ }
    else { i++ }
  }

  if (!task) {
    exit(1, 'Usage: plur inject <task> [--budget <n>]')
  }

  const result = flags.fast
    ? plur.inject(task, { budget })
    : await plur.injectHybrid(task, { budget })

  if (shouldOutputJson(flags)) {
    outputJson({
      directives: result.directives,
      constraints: result.constraints,
      consider: result.consider,
      count: result.count,
      tokens_used: result.tokens_used,
    })
  } else {
    if (result.directives) {
      outputText('## DIRECTIVES')
      outputText(result.directives)
    }
    if (result.constraints) {
      outputText('## CONSTRAINTS')
      outputText(result.constraints)
    }
    if (result.consider) {
      outputText('## ALSO CONSIDER')
      outputText(result.consider)
    }
    outputText(`\nInjected ${result.count} engrams (${result.tokens_used} tokens)`)
  }
}
