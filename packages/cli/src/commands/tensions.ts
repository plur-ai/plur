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
 * plur tensions — scan for contradictions, manage the tension lifecycle (#181).
 *
 * Usage:
 *   plur tensions                              # list persisted tensions (unresolved)
 *   plur tensions --status all                 # include dismissed/resolved
 *   plur tensions --scan                       # LLM scan; NEW detections are persisted
 *   plur tensions --scan --no-persist          # dry-run scan (no records, no suppress-list)
 *   plur tensions --scan --scope project:plur  # narrow to one scope
 *   plur tensions --scan --domain plur.core    # narrow to one domain
 *   plur tensions --scan --min-confidence 0.8  # stricter threshold
 *   plur tensions --scan --max-pairs 100       # check more pairs
 *   plur tensions --scan --batch-size 1        # sequential single-pair judging (no batching)
 *   plur tensions --scan --temporal-discount   # days-apart confidence discount (#240, default off)
 *   plur tensions --scan --model claude-haiku-... --llm-base-url ... --llm-api-key ...
 *   plur tensions confirm T-2026-0703-001      # mark a detection as a real conflict
 *   plur tensions dismiss T-2026-0703-001      # false positive — suppress the pair
 *   plur tensions resolve T-2026-0703-001 --winner ENG-...   # keep winner, retire loser
 *   plur tensions --json                       # machine-readable output
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let scan = false
  let persist = true
  let scope: string | undefined
  let domain: string | undefined
  let minConfidence = 0.7
  let maxPairs = 50
  let batchSize = 5
  // #240: undefined → fall back to config (tensions.temporal_discount)
  let temporalDiscount: boolean | undefined
  let statusFilter: string | undefined
  let action: 'confirm' | 'dismiss' | 'resolve' | undefined
  let tensionId: string | undefined
  let winner: string | undefined
  let llmBaseUrl: string | undefined
  let llmApiKey: string | undefined
  let llmModel: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--scan') { scan = true; i++ }
    else if (arg === '--no-persist') { persist = false; i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    else if (arg === '--min-confidence' && i + 1 < args.length) { minConfidence = parseFloat(args[++i]); i++ }
    else if (arg === '--max-pairs' && i + 1 < args.length) { maxPairs = parseInt(args[++i], 10); i++ }
    else if (arg === '--batch-size' && i + 1 < args.length) { batchSize = parseInt(args[++i], 10); i++ }
    else if (arg === '--temporal-discount') { temporalDiscount = true; i++ }
    else if (arg === '--no-temporal-discount') { temporalDiscount = false; i++ }
    else if (arg === '--status' && i + 1 < args.length) { statusFilter = args[++i]; i++ }
    else if (arg === '--winner' && i + 1 < args.length) { winner = args[++i]; i++ }
    else if (arg === '--llm-base-url' && i + 1 < args.length) { llmBaseUrl = args[++i]; i++ }
    else if (arg === '--llm-api-key' && i + 1 < args.length) { llmApiKey = args[++i]; i++ }
    else if (arg === '--model' && i + 1 < args.length) { llmModel = args[++i]; i++ }
    else if ((arg === 'confirm' || arg === 'dismiss' || arg === 'resolve') && !action) { action = arg; i++ }
    else if (action && !tensionId && arg.startsWith('T-')) { tensionId = arg; i++ }
    else { i++ }
  }

  const plur = createPlur(flags, { readonly: true })

  // --- Lifecycle actions (#181) ---
  if (action) {
    if (!tensionId) {
      exit(1, `Usage: plur tensions ${action} <T-YYYY-MMDD-NNN>${action === 'resolve' ? ' --winner <engram-id>' : ''}`)
      return
    }
    try {
      if (action === 'confirm') {
        const record = plur.confirmTension(tensionId)
        if (shouldOutputJson(flags)) { outputJson({ record }) } else {
          outputText(`Confirmed ${record.id} as a real conflict.`)
          outputText(`Resolve it with: plur tensions resolve ${record.id} --winner <engram-id>`)
        }
      } else if (action === 'dismiss') {
        const record = plur.dismissTension(tensionId)
        if (shouldOutputJson(flags)) { outputJson({ record }) } else {
          outputText(`Dismissed ${record.id} — the pair is suppressed from future scans.`)
        }
      } else {
        if (!winner) {
          exit(1, `Usage: plur tensions resolve ${tensionId} --winner <engram-id>`)
          return
        }
        const { record, retired_id } = plur.resolveTension(tensionId, winner)
        if (shouldOutputJson(flags)) { outputJson({ record, retired: retired_id }) } else {
          outputText(`Resolved ${record.id}: ${winner} wins, ${retired_id} retired.`)
        }
      }
    } catch (err) {
      exit(1, `Error: ${(err as Error).message}`)
    }
    return
  }

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
      outputText(`  min-confidence: ${minConfidence}  max-pairs: ${maxPairs}  batch-size: ${batchSize}`)
      outputText('')
    }

    const { scanForTensions } = await import('@plur-ai/core')
    // #240: config.yaml `tensions:` block supplies temporal defaults
    // (temporal_domains, snapshot_pairs, temporal_discount); an explicit
    // --temporal-discount / --no-temporal-discount flag overrides.
    const tensionsConfig = plur.getTensionsConfig()
    // #181: recorded pairs are excluded (suppress-list) and new detections
    // persisted, unless --no-persist (dry run).
    const result = await scanForTensions(engrams, llm, {
      min_confidence: minConfidence,
      max_pairs: maxPairs,
      batch_size: batchSize,
      temporal_domains: tensionsConfig.temporal_domains,
      snapshot_pairs: tensionsConfig.snapshot_pairs,
      temporal_discount: temporalDiscount ?? tensionsConfig.temporal_discount,
      ...(persist ? { exclude_pairs: new Set(plur.suppressedTensionPairKeys()) } : {}),
    })
    const persisted = persist && result.tensions.length > 0 ? plur.recordTensions(result.tensions) : undefined

    if (shouldOutputJson(flags)) {
      outputJson({
        pairs_checked: result.pairs_checked,
        count: result.new_tensions,
        ...(persisted ? { persisted_new: persisted.new_count } : {}),
        tensions: result.tensions.map((t, idx) => ({
          ...(persisted ? { tension_id: persisted.records[idx].id, category: persisted.records[idx].category } : {}),
          engram_a: { id: t.id_a, statement: t.statement_a },
          engram_b: { id: t.id_b, statement: t.statement_b },
          confidence: t.confidence,
          reason: t.reason,
          ...(t.days_apart !== undefined ? { days_apart: t.days_apart } : {}),
          ...(t.raw_confidence !== undefined ? { raw_confidence: t.raw_confidence } : {}),
        })),
      })
      return
    }

    outputText(`Checked: ${result.pairs_checked} candidate pairs`)
    outputText(`Found:   ${result.new_tensions} tension${result.new_tensions === 1 ? '' : 's'} (confidence >= ${minConfidence})`)
    if (persisted) outputText(`Persisted: ${persisted.new_count} new record${persisted.new_count === 1 ? '' : 's'}`)
    outputText('')

    if (result.tensions.length === 0) {
      outputText('No contradictions detected.')
      return
    }

    result.tensions.forEach((t, idx) => {
      const rid = persisted ? ` ${persisted.records[idx].id} (${persisted.records[idx].category})` : ''
      const tempNote = t.days_apart !== undefined ? `, ${t.days_apart} day${t.days_apart === 1 ? '' : 's'} apart` : ''
      const rawNote = t.raw_confidence !== undefined ? `, raw: ${t.raw_confidence.toFixed(2)}` : ''
      outputText(`── TENSION${rid} (confidence: ${t.confidence.toFixed(2)}${rawNote}${tempNote}) ──`)
      outputText(`  A [${t.id_a}]: ${t.statement_a}`)
      outputText(`  B [${t.id_b}]: ${t.statement_b}`)
      outputText(`  Reason: ${t.reason}`)
      outputText('')
    })

    outputText('Next steps:')
    outputText('  plur tensions confirm <T-id>                       # real conflict')
    outputText('  plur tensions dismiss <T-id>                       # false positive, suppress')
    outputText('  plur tensions resolve <T-id> --winner <engram-id>  # keep winner, retire loser')
    return
  }

  // --- List mode (#181): persisted tension records ---
  const records = statusFilter === 'all'
    ? plur.listTensions()
    : plur.listTensions({ status: statusFilter ? [statusFilter as any] : ['detected', 'confirmed'] })

  // Legacy relations.conflicts pairs (unvalidated importer heuristics) shown separately.
  const legacy: Array<{
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
      legacy.push({
        engram_a: { id: engram.id, statement: engram.statement },
        engram_b: { id: other.id, statement: other.statement },
        detected_at: engram.activation.last_accessed,
      })
    }
  }

  if (shouldOutputJson(flags)) {
    outputJson({ tensions: records, count: records.length, ...(legacy.length > 0 ? { legacy_conflicts: legacy } : {}) })
    return
  }

  if (records.length === 0 && legacy.length === 0) {
    outputText('No persisted tensions. Run `plur tensions --scan` to detect contradictions.')
    return
  }

  if (records.length > 0) {
    outputText(`Tensions: ${records.length}`)
    outputText('')
    for (const r of records) {
      outputText(`── ${r.id} [${r.status}, ${r.category}] (confidence: ${r.confidence.toFixed(2)}) ──`)
      outputText(`  A [${r.engram_a}]: ${r.statement_a}`)
      outputText(`  B [${r.engram_b}]: ${r.statement_b}`)
      outputText(`  Reason: ${r.reason}`)
      if (r.status === 'resolved') outputText(`  Resolved: ${r.resolved_by} won (${r.resolved_at})`)
      outputText('')
    }
  }

  if (legacy.length > 0) {
    outputText(`Legacy conflict refs (unvalidated heuristics): ${legacy.length}`)
    outputText('  Run `plur tensions --scan` to judge them, or purge via the plur_tensions_purge MCP tool.')
    outputText('')
    for (const t of legacy) {
      outputText(`  A [${t.engram_a.id}]: ${t.engram_a.statement}`)
      outputText(`  B [${t.engram_b.id}]: ${t.engram_b.statement}`)
      outputText('')
    }
  }
}
