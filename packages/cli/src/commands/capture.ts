import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputInfo, exit } from '../output.js'

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
    // `--` ends flag parsing: the next token is the summary, verbatim, even when
    // it starts with `-` (decision S4; formal r2 follow-up). Before, `--`
    // itself became the summary.
    else if (arg === '--') { if (!summary && i + 1 < args.length) summary = args[i + 1]; break }
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

  // A remote-only folder captures no timeline (owner decision on #1521).
  plur.bindFolder(process.cwd())
  let episode
  try {
    episode = plur.capture(summary, { agent, session_id })
  } catch (err) {
    exit(1, (err as Error).message)
  }

  if (shouldOutputJson(flags)) {
    outputJson({ id: episode.id, summary: episode.summary, timestamp: episode.timestamp })
  } else {
    outputInfo(`Captured episode: ${episode.id}`, flags)
    outputInfo(`  Summary: ${episode.summary}`, flags)
    outputInfo(`  Timestamp: ${episode.timestamp}`, flags)
  }
}
