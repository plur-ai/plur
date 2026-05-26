import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

const DEFAULT_PROTOCOL = `## Learning Protocol
Each response must end with a 🧠 I learned block recording reusable insights, unless the response is [ACK] or pure tool output.
---
🧠 I learned:
- <insight (min 10 chars)>
- <insight>
---
Supersedes rule: if this 🧠 corrects a previous engram, call: plur_learn(statement="...", supersedes=["ENG-xxx"], source="<bot_name>")
Skip the block only when truly nothing new was discovered.`

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let task = ''
  let budget = 2000
  let withProtocol = flags['with-default-protocol'] !== false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--budget' && i + 1 < args.length) { budget = parseInt(args[++i], 10); i++ }
    else if (arg === '--no-with-default-protocol') { withProtocol = false; i++ }
    else if (!task) { task = arg; i++ }
    else { i++ }
  }

  if (!task) {
    exit(1, 'Usage: plur inject <task> [--budget <n>] [--no-with-default-protocol]')
  }

  const result = flags.fast
    ? plur.inject(task, { budget })
    : await plur.injectHybrid(task, { budget })

  // Append default learning protocol to directives (opt-out via --no-with-default-protocol)
  let directives = result.directives || ''
  if (withProtocol) {
    directives = directives ? `${directives}\n\n${DEFAULT_PROTOCOL}` : DEFAULT_PROTOCOL
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      directives,
      constraints: result.constraints,
      consider: result.consider,
      count: result.count,
      tokens_used: result.tokens_used,
    })
  } else {
    if (directives) {
      outputText('## DIRECTIVES')
      outputText(directives)
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
