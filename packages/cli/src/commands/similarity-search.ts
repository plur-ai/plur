import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let query = ''
  let limit = 10
  let scope: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--limit' && i + 1 < args.length) { limit = parseInt(args[++i], 10); i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (!query) { query = arg; i++ }
    else { i++ }
  }

  if (!query) {
    exit(1, 'Usage: plur similarity-search <query> [--limit <n>] [--scope <scope>]')
  }

  const results = await plur.similaritySearch(query, { limit, scope })

  if (results.length === 0) {
    if (shouldOutputJson(flags)) {
      outputJson({ results: [], count: 0 })
    } else {
      outputText('No results found.')
    }
    exit(2)
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      results: results.map(r => ({
        engram_id: r.engram.id,
        statement: r.engram.statement,
        scope: r.engram.scope,
        cosine_score: r.score,
        type: r.engram.type,
        polarity: r.engram.polarity ?? null,
        tags: r.engram.tags ?? [],
      })),
      count: results.length,
    })
  } else {
    results.forEach((r, idx) => {
      const preview = r.engram.statement.length > 80
        ? r.engram.statement.slice(0, 77) + '...'
        : r.engram.statement
      outputText(`${idx + 1}. [${r.score.toFixed(4)}] ${preview}`)
      outputText(`   ID: ${r.engram.id} | Scope: ${r.engram.scope} | Type: ${r.engram.type}`)
    })
  }
}
