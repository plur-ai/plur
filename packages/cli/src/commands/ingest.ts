import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let content: string | undefined
  let source: string | undefined
  let scope: string | undefined
  let domain: string | undefined
  let extractOnly = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--source' && i + 1 < args.length) { source = args[++i]; i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    else if (arg === '--extract-only') { extractOnly = true; i++ }
    else if (!content) { content = arg; i++ }
    else { i++ }
  }

  // If no positional content, read from stdin
  if (!content) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk)
    }
    content = Buffer.concat(chunks).toString('utf8').trim()
  }

  if (!content) {
    exit(1, 'Usage: plur ingest <content> [--source <src>] [--scope <scope>] [--domain <domain>] [--extract-only]')
  }

  const candidates = plur.ingest(content, { source, extract_only: extractOnly, scope, domain })

  if (shouldOutputJson(flags)) {
    outputJson({ candidates, count: candidates.length, saved: !extractOnly })
  } else {
    if (candidates.length === 0) {
      outputText('No engram candidates found in content.')
      return
    }
    outputText(`${extractOnly ? 'Extracted' : 'Ingested'} ${candidates.length} engram(s):`)
    candidates.forEach(c => outputText(`  [${c.type}] ${c.statement}`))
  }
}
