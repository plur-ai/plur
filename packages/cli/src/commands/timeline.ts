import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let query = ''
  let limit = 20

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--limit' && i + 1 < args.length) { limit = parseInt(args[++i], 10); i++ }
    // `--` ends flag parsing: the next token is the query, verbatim, even when
    // it starts with `-` (decision S4; formal r2 follow-up). Before, `--`
    // itself became the query.
    else if (arg === '--') { if (!query && i + 1 < args.length) query = args[i + 1]; break }
    else if (!query) { query = arg; i++ }
    else { i++ }
  }

  const allEpisodes = plur.timeline(query ? { search: query } : undefined)
  const episodes = allEpisodes.slice(0, limit)

  if (shouldOutputJson(flags)) {
    outputJson({ episodes, count: episodes.length })
  } else {
    if (episodes.length === 0) {
      outputText('No episodes found.')
      return
    }
    episodes.forEach(ep => {
      outputText(`[${ep.timestamp}] ${ep.id}: ${ep.summary}`)
    })
  }
}
