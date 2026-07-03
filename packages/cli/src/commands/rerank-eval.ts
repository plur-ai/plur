import { RERANKER_NAMES, type RerankerName } from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { outputText, outputJson, shouldOutputJson, exit } from '../output.js'

/**
 * plur rerank-eval — per-store reranker self-eval gate (#451, final task).
 *
 * Samples this store's own engrams, synthesizes probe queries from their
 * statements, and compares the cross-encoder's ordering against RRF-only.
 * Cross-encoders can be net-negative out-of-domain; this is the quick
 * self-check to run before enabling PLUR_RERANKER on a store.
 *
 * The verdict is cached in `<store>/.reranker-eval.json` (staleness bound:
 * 7 days or >20% store-size drift) and surfaced by plur_doctor plus a
 * loud-once advisory on the reranker-enable path. ADVISORY only — a harmful
 * verdict never auto-disables reranking; it exits 1 so scripts can gate on it.
 *
 * Usage:
 *   plur rerank-eval [--reranker <name>] [--sample N] [--seed N] [--force]
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let reranker: string | undefined
  let sample: number | undefined
  let seed: number | undefined
  let force = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--reranker' && i + 1 < args.length) { reranker = args[++i] }
    else if (arg === '--sample' && i + 1 < args.length) { sample = Number.parseInt(args[++i], 10) }
    else if (arg === '--seed' && i + 1 < args.length) { seed = Number.parseInt(args[++i], 10) }
    else if (arg === '--force') { force = true }
    else { exit(1, `Unknown argument: ${arg}\nUsage: plur rerank-eval [--reranker <name>] [--sample N] [--seed N] [--force]`) }
  }

  if (reranker !== undefined && (!RERANKER_NAMES.includes(reranker as RerankerName) || reranker === 'off')) {
    const usable = RERANKER_NAMES.filter(n => n !== 'off')
    exit(1, `Unknown reranker "${reranker}". Known: ${usable.join(', ')}`)
  }
  if (sample !== undefined && (!Number.isFinite(sample) || sample < 1)) {
    exit(1, '--sample must be a positive integer')
  }

  const plur = createPlur(flags)
  let outcome: Awaited<ReturnType<typeof plur.rerankerSelfEval>>
  try {
    outcome = await plur.rerankerSelfEval({
      reranker: reranker as RerankerName | undefined,
      sample,
      seed,
      force,
    })
  } catch (err) {
    exit(1, `rerank-eval failed: ${(err as Error).message}`)
  }

  const { result, cached } = outcome
  if (shouldOutputJson(flags)) {
    outputJson({ ...result, cached })
  } else {
    const sign = result.delta_mrr >= 0 ? '+' : ''
    outputText(`plur rerank-eval — per-store reranker self-eval (#451)${cached ? ' [cached]' : ''}`)
    outputText('')
    outputText(`  Reranker:   ${result.reranker} (${result.model_id})`)
    outputText(`  Evaluated:  ${result.evaluated_at}`)
    outputText(`  Store:      ${result.engram_count} active engrams, ${result.eligible_count} probe-eligible`)
    outputText(`  Probes:     ${result.scored_probes}/${result.sample_size} scored (top-${result.top_k} pool, seed ${result.seed})`)
    outputText(`  MRR:        RRF-only ${result.rrf_mrr.toFixed(3)} → reranked ${result.rerank_mrr.toFixed(3)} (Δ ${sign}${result.delta_mrr.toFixed(3)})`)
    outputText(`  Hit@1:      ${(result.rrf_hit1 * 100).toFixed(0)}% → ${(result.rerank_hit1 * 100).toFixed(0)}%`)
    outputText(`  Moves:      ${result.promotions} promoted, ${result.demotions} demoted`)
    outputText(`  Latency:    ~${result.mean_rerank_ms.toFixed(0)}ms cross-encoder time per probe`)
    outputText('')
    outputText(`  Verdict:    ${result.verdict.toUpperCase()}`)
    if (result.verdict === 'harmful') {
      outputText('')
      outputText('  ⚠  The reranker demotes known-relevant engrams on THIS store (out-of-domain).')
      outputText('     Advisory only — reranking stays enabled. Consider unsetting PLUR_RERANKER.')
    } else if (result.verdict === 'insufficient-data') {
      outputText('')
      outputText('  ○  Too few probe-eligible engrams for a verdict — grow the store and re-run.')
    }
  }

  process.exit(result.verdict === 'harmful' ? 1 : 0)
}
