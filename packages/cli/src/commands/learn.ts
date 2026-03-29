import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let statement = ''
  let scope = 'global'
  let type: 'behavioral' | 'terminological' | 'procedural' | 'architectural' = 'behavioral'
  let domain: string | undefined
  let source: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--type' && i + 1 < args.length) { type = args[++i] as typeof type; i++ }
    else if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    else if (arg === '--source' && i + 1 < args.length) { source = args[++i]; i++ }
    else if (!statement) { statement = arg; i++ }
    else { i++ }
  }

  // Read from stdin if no positional argument
  if (!statement && !process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    statement = Buffer.concat(chunks).toString('utf-8').trim()
  }

  if (!statement) {
    exit(1, 'Usage: plur learn <statement> [--scope <scope>] [--type <type>] [--domain <domain>]')
  }

  const engram = plur.learn(statement, { scope, type, domain, source })

  if (shouldOutputJson(flags)) {
    outputJson({
      id: engram.id,
      statement: engram.statement,
      scope: engram.scope,
      type: engram.type,
      domain: engram.domain ?? null,
    })
  } else {
    outputText(`Learned: "${engram.statement}"`)
    outputText(`  ID: ${engram.id} | Scope: ${engram.scope} | Type: ${engram.type}${engram.domain ? ` | Domain: ${engram.domain}` : ''}`)
  }
}
