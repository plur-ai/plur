import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let query = ''
  let limit = 10

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--limit' && i + 1 < args.length) { limit = parseInt(args[++i], 10); i++ }
    else if (!query) { query = arg; i++ }
    else { i++ }
  }

  if (!query) {
    exit(1, 'Usage: plur recall <query> [--limit <n>]')
  }

  const engrams = flags.fast
    ? await plur.recall(query, { limit })
    : await plur.recallHybrid(query, { limit })

  if (engrams.length === 0) {
    if (shouldOutputJson(flags)) {
      outputJson({ results: [], count: 0 })
    } else {
      outputText('No results found.')
    }
    exit(2)
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      results: engrams.map(e => ({
        id: (e as any)._originalId ?? e.id.replace(/^(ENG|ABS|META)-[A-Z]{2,4}-(?=\d{4}-|[A-Za-z0-9])/, '$1-'),
        statement: e.statement,
        scope: e.scope,
        type: e.type,
        domain: e.domain ?? null,
        strength: e.activation.retrieval_strength,
      })),
      count: engrams.length,
    })
  } else {
    engrams.forEach((e, idx) => {
      const displayId = (e as any)._originalId ?? e.id.replace(/^(ENG|ABS|META)-[A-Z]{2,4}-(?=\d{4}-|[A-Za-z0-9])/, '$1-')
      outputText(`${idx + 1}. [${displayId}] ${e.statement}`)
      outputText(`   Scope: ${e.scope} | Type: ${e.type}${e.domain ? ` | Domain: ${e.domain}` : ''} | Strength: ${e.activation.retrieval_strength.toFixed(3)}`)
    })
  }
}
