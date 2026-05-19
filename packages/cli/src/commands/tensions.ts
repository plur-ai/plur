import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import type { LlmFunction } from '@plur-ai/core'

/** Create an OpenAI-compatible LLM function from base URL + key + model. */
function makeHttpLlm(baseUrl: string, apiKey: string, model = 'gpt-4o-mini'): LlmFunction {
  return async (prompt: string): Promise<string> => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    })
    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`)
    }
    const data = (await response.json()) as any
    return data.choices?.[0]?.message?.content ?? ''
  }
}

function getLlmFunction(): LlmFunction | undefined {
  const openrouterKey = process.env.OPENROUTER_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (openrouterKey) return makeHttpLlm('https://openrouter.ai/api/v1', openrouterKey, 'openai/gpt-4o-mini')
  if (openaiKey) return makeHttpLlm('https://api.openai.com/v1', openaiKey, 'gpt-4o-mini')
  return undefined
}

/**
 * plur tensions — scan for or list engram contradictions.
 *
 * Usage:
 *   plur tensions --scan                       # live LLM scan (requires API key)
 *   plur tensions --scan --scope project:plur  # narrow to one scope
 *   plur tensions --scan --domain plur.core    # narrow to one domain
 *   plur tensions --scan --min-confidence 0.8  # stricter threshold
 *   plur tensions --scan --max-pairs 100       # check more pairs
 *   plur tensions --scan --model claude-haiku-... --llm-base-url ... --llm-api-key ...
 *   plur tensions                              # list legacy stored conflicts (usually empty)
 *   plur tensions --json                       # machine-readable output
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let scan = false
  let scope: string | undefined
  let domain: string | undefined
  let minConfidence = 0.7
  let maxPairs = 50
  let llmBaseUrl: string | undefined
  let llmApiKey: string | undefined
  let llmModel: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--scan') { scan = true; i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    else if (arg === '--min-confidence' && i + 1 < args.length) { minConfidence = parseFloat(args[++i]); i++ }
    else if (arg === '--max-pairs' && i + 1 < args.length) { maxPairs = parseInt(args[++i], 10); i++ }
    else if (arg === '--llm-base-url' && i + 1 < args.length) { llmBaseUrl = args[++i]; i++ }
    else if (arg === '--llm-api-key' && i + 1 < args.length) { llmApiKey = args[++i]; i++ }
    else if (arg === '--model' && i + 1 < args.length) { llmModel = args[++i]; i++ }
    else { i++ }
  }

  const plur = createPlur(flags, { readonly: true })
  const engrams = plur.list({ scope, domain })

  if (scan) {
    const llm: LlmFunction | undefined =
      llmBaseUrl
        ? makeHttpLlm(llmBaseUrl, llmApiKey ?? '', llmModel)
        : getLlmFunction()

    if (!llm) {
      exit(
        1,
        'tensions --scan requires an LLM.\n' +
        'Set OPENROUTER_API_KEY or OPENAI_API_KEY, or pass --llm-base-url + --llm-api-key.',
      )
      return
    }

    if (!shouldOutputJson(flags)) {
      outputText(`Scanning ${engrams.length} engrams for contradictions…`)
      if (scope) outputText(`  scope: ${scope}`)
      if (domain) outputText(`  domain: ${domain}`)
      outputText(`  min-confidence: ${minConfidence}  max-pairs: ${maxPairs}`)
      outputText('')
    }

    const { scanForTensions } = await import('@plur-ai/core')
    const result = await scanForTensions(engrams, llm, { min_confidence: minConfidence, max_pairs: maxPairs })

    if (shouldOutputJson(flags)) {
      outputJson({
        pairs_checked: result.pairs_checked,
        count: result.new_tensions,
        tensions: result.tensions.map(t => ({
          engram_a: { id: t.id_a, statement: t.statement_a },
          engram_b: { id: t.id_b, statement: t.statement_b },
          confidence: t.confidence,
          reason: t.reason,
        })),
      })
      return
    }

    outputText(`Checked: ${result.pairs_checked} candidate pairs`)
    outputText(`Found:   ${result.new_tensions} tension${result.new_tensions === 1 ? '' : 's'} (confidence >= ${minConfidence})`)
    outputText('')

    if (result.tensions.length === 0) {
      outputText('No contradictions detected.')
      return
    }

    for (const t of result.tensions) {
      outputText(`── TENSION (confidence: ${t.confidence.toFixed(2)}) ──`)
      outputText(`  A [${t.id_a}]: ${t.statement_a}`)
      outputText(`  B [${t.id_b}]: ${t.statement_b}`)
      outputText(`  Reason: ${t.reason}`)
      outputText('')
    }

    outputText('Next steps:')
    outputText('  Resolve: determine which statement is correct, retire the other via plur forget <id>')
    outputText('  Dismiss: if not a real conflict, both statements can coexist')
    return
  }

  // Non-scan mode: list any legacy stored conflict relations (usually empty after auto-purge)
  const tensions: Array<{
    engram_a: { id: string; statement: string }
    engram_b: { id: string; statement: string }
    detected_at: string
  }> = []

  const seen = new Set<string>()
  for (const engram of engrams) {
    if (!engram.relations?.conflicts?.length) continue
    for (const conflictId of engram.relations.conflicts) {
      const pairKey = [engram.id, conflictId].sort().join(':')
      if (seen.has(pairKey)) continue
      seen.add(pairKey)
      const other = engrams.find(e => e.id === conflictId)
      if (!other) continue
      tensions.push({
        engram_a: { id: engram.id, statement: engram.statement },
        engram_b: { id: other.id, statement: other.statement },
        detected_at: engram.activation.last_accessed,
      })
    }
  }

  if (shouldOutputJson(flags)) {
    outputJson({ tensions, count: tensions.length })
    return
  }

  if (tensions.length === 0) {
    outputText('No stored tensions. Run `plur tensions --scan` to detect live contradictions.')
    return
  }

  outputText(`Stored tensions: ${tensions.length}`)
  outputText('')
  for (const t of tensions) {
    outputText(`  A [${t.engram_a.id}]: ${t.engram_a.statement}`)
    outputText(`  B [${t.engram_b.id}]: ${t.engram_b.statement}`)
    outputText(`  Detected: ${t.detected_at}`)
    outputText('')
  }
}
