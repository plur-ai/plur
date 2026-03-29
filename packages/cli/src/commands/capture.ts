import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let summary = ''
  let agent = 'cli'
  let session_id: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--agent' && i + 1 < args.length) { agent = args[++i]; i++ }
    else if (arg === '--session' && i + 1 < args.length) { session_id = args[++i]; i++ }
    else if (!summary) { summary = arg; i++ }
    else { i++ }
  }

  // Read from stdin if no positional argument
  if (!summary && !process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    summary = Buffer.concat(chunks).toString('utf-8').trim()
  }

  if (!summary) {
    exit(1, 'Usage: plur capture <summary> [--agent <name>] [--session <id>]')
  }

  const episode = plur.capture(summary, { agent, session_id })

  if (shouldOutputJson(flags)) {
    outputJson({ id: episode.id, summary: episode.summary, timestamp: episode.timestamp })
  } else {
    outputText(`Captured episode: ${episode.id}`)
    outputText(`  Summary: ${episode.summary}`)
    outputText(`  Timestamp: ${episode.timestamp}`)
  }
}
