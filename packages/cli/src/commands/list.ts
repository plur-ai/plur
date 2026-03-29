import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let domain: string | undefined
  let type: string | undefined
  let scope: string | undefined
  let limit: number | undefined
  let meta = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    else if (arg === '--type' && i + 1 < args.length) { type = args[++i]; i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--limit' && i + 1 < args.length) { limit = parseInt(args[++i], 10); i++ }
    else if (arg === '--meta') { meta = true; i++ }
    else { i++ }
  }

  let engrams = plur.list({ scope, domain })

  // Post-filter by type
  if (type) {
    engrams = engrams.filter(e => e.type === type)
  }

  // Post-filter by meta (IDs starting with META-)
  if (meta) {
    engrams = engrams.filter(e => e.id.startsWith('META-'))
  }

  // Apply limit
  if (limit !== undefined) {
    engrams = engrams.slice(0, limit)
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      engrams: engrams.map(e => ({
        id: e.id,
        statement: e.statement,
        scope: e.scope,
        type: e.type,
        domain: e.domain ?? null,
        strength: e.activation.retrieval_strength,
      })),
      count: engrams.length,
    })
  } else {
    if (engrams.length === 0) {
      outputText('No engrams found.')
      return
    }
    const MAX_STMT = 60
    outputText(`${'ID'.padEnd(20)} ${'TYPE'.padEnd(14)} ${'SCOPE'.padEnd(20)} STATEMENT`)
    outputText('-'.repeat(100))
    for (const e of engrams) {
      const stmt = e.statement.length > MAX_STMT
        ? e.statement.slice(0, MAX_STMT - 1) + '…'
        : e.statement
      outputText(`${e.id.padEnd(20)} ${e.type.padEnd(14)} ${e.scope.padEnd(20)} ${stmt}`)
    }
    outputText(`\nTotal: ${engrams.length}`)
  }
}
