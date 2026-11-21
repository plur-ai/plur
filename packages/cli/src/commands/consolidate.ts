import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import {
  assertConsolidationPlan,
  ConsolidateError,
  ChangeJournalError,
  CONSOLIDATE_CHANGE_KIND,
  type ConsolidationPlan,
} from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import { resolveLlmOrExit, missingLlmMessage } from '../lib/llm-bridge.js'
import { requirePinPolicyConfirmation, confirmUndoPins } from '../lib/pin-confirm.js'
import { writePrivateFile } from '../lib/private-file.js'

export const FLAGS = [
  '--plan', '--out', '--nightly', '--fresh', '--no-model', '--batch-size', '--sample',
  '--apply', '--limit', '--yes', '--undo',
  '--llm-cmd', '--llm-base-url', '--llm-api-key', '--llm-api-key-env', '--model',
]
export const FLAGS_WITH_VALUES = ['--out', '--batch-size', '--sample', '--apply', '--limit', '--undo', '--llm-cmd', '--llm-base-url', '--llm-api-key', '--llm-api-key-env', '--model']

const USAGE = `Usage:
  plur consolidate --plan [--out <file>] [--nightly] [--fresh] [--no-model]
                   [--llm-cmd "<command>"] [--batch-size N] [--sample N]
  plur consolidate --apply <file> [--limit N] --yes
  plur consolidate --undo <change-id>

  --plan     Find clusters of near-copies (same scope; complete linkage at
             consolidate.threshold, default 0.85) and ask the host model per
             cluster whether to MERGE (into one statement) or SPLIT. Writes a
             proposal file (default <store>/consolidate-plan.json) and changes
             nothing in the store. If the file holds an unfinished plan, it is
             resumed; --fresh starts over.
  --nightly  Only engrams changed since the last nightly run, queued
             near-paraphrases and a sample seeded from today's date; at most
             consolidate.nightly_max_changes clusters.
  --apply    Merge the clusters the model said MERGE: write the merged engram,
             retire the originals (never deleted), one undoable change each.
             Needs consolidate.apply_enabled: true and --yes; the first apply
             of a plan must be --limit 1 (a one-item trial). Clusters holding
             a pinned, locked or prohibition engram need "approved": true in
             the file.
  --undo     Undo one applied cluster by its change id.

  The model: --llm-cmd "<command>" (the prompt goes to its stdin, its stdout
  is the answer, e.g. --llm-cmd "claude -p"), or PLUR_LLM_CMD, or
  --llm-base-url (https)/--llm-api-key-env/--model (OpenAI-compatible). An API key in
  the environment is never used on its own. --no-model plans without one
  (every cluster stays pending).`

function readPlan(path: string): ConsolidationPlan {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    exit(1, `Cannot read the plan file ${path}: ${(err as Error).message}`)
  }
  try {
    assertConsolidationPlan(raw)
  } catch (err) {
    exit(1, `${path}: ${(err as Error).message}`)
  }
  return raw as ConsolidationPlan
}

function savePlan(path: string, plan: ConsolidationPlan): void {
  // S6: owner-only also over an existing wider file, never through a symlink.
  try { writePrivateFile(path, JSON.stringify(plan, null, 2) + '\n') } catch (err) { exit(1, `Cannot write ${path}: ${(err as Error).message}`) }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let plan = false
  let out: string | undefined
  let nightly = false
  let fresh = false
  let noModel = false
  let batchSize: number | undefined
  let sample: number | undefined
  let applyFile: string | undefined
  let limit: number | undefined
  let yes = false
  let undo: string | undefined
  const llmFlags: { llmCmd?: string; llmBaseUrl?: string; llmApiKey?: string; llmApiKeyEnv?: string; model?: string } = {}
  const num = (name: string, v: string | undefined): number => {
    const n = Number(v)
    if (!v || !Number.isInteger(n) || n < 1) exit(1, `${name} needs a whole number of at least 1.\n${USAGE}`)
    return n
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--plan') plan = true
    else if (a === '--out') out = args[++i]
    else if (a === '--nightly') nightly = true
    else if (a === '--fresh') fresh = true
    else if (a === '--no-model') noModel = true
    else if (a === '--batch-size') batchSize = num('--batch-size', args[++i])
    else if (a === '--sample') sample = num('--sample', args[++i])
    else if (a === '--apply') applyFile = args[++i]
    else if (a === '--limit') limit = num('--limit', args[++i])
    else if (a === '--yes') yes = true
    else if (a === '--undo') undo = args[++i]
    else if (a === '--llm-cmd') llmFlags.llmCmd = args[++i]
    else if (a === '--llm-base-url') llmFlags.llmBaseUrl = args[++i]
    else if (a === '--llm-api-key') llmFlags.llmApiKey = args[++i]
    else if (a === '--llm-api-key-env') llmFlags.llmApiKeyEnv = args[++i]
    else if (a === '--model') llmFlags.model = args[++i]
    else exit(1, `Unknown argument: ${a}\n${USAGE}`)
  }
  const modes = [plan || nightly, applyFile !== undefined, undo !== undefined].filter(Boolean).length
  if (modes !== 1) exit(1, USAGE)

  const plur = createPlur(flags)
  const json = shouldOutputJson(flags)

  if (undo !== undefined) {
    if (!undo) exit(1, USAGE)
    const change = plur.getChange(undo)
    if (!change) exit(1, `No change ${undo} in the change journal.`)
    if (change.kind !== CONSOLIDATE_CHANGE_KIND) exit(1, `${undo} is a "${change.kind}" change, not a consolidation; undo it with the command that made it.`)
    // H12: undoing a merge brings pinned originals back into force (S1).
    await confirmUndoPins(plur, change)
    try {
      const record = await plur.undoChange(undo)
      if (json) outputJson({ success: true, undone: undo, undo_change: record.id, restored: record.rows.map(r => r.id) })
      else outputText(`Undone ${undo}: restored ${record.rows.length} engram(s) (${record.rows.map(r => r.id).join(', ')}).`)
    } catch (err) {
      if (err instanceof ChangeJournalError) exit(1, err.message)
      throw err
    }
    return
  }

  if (applyFile !== undefined) {
    if (!applyFile) exit(1, USAGE)
    if (yes) await requirePinPolicyConfirmation(plur, `Apply the consolidation plan ${applyFile}`)
    const path = resolve(applyFile)
    const p = readPlan(path)
    if (!yes) {
      const ready = p.clusters.filter(c => c.decision === 'merge' && (!c.requires_owner_approval || c.approved)).length
      exit(1, `Refusing to apply without --yes. ${ready} cluster(s) in ${path} are ready to merge; review the file, then run:\n  plur consolidate --apply ${applyFile} --limit 1 --yes`)
    }
    let res
    try {
      res = await plur.consolidateApply(p, { limit })
    } catch (err) {
      if (err instanceof ConsolidateError || err instanceof ChangeJournalError) exit(1, err.message)
      throw err
    }
    if (json) {
      outputJson({ success: true, ...res })
      return
    }
    for (const a of res.applied) {
      outputText(`${a.cluster_id}: merged ${a.retired.join(', ')} -> ${a.merged_id} (change ${a.change_id}; undo: plur consolidate --undo ${a.change_id})`)
    }
    const counts = new Map<string, number>()
    for (const s of res.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
    if (res.applied.length === 0) outputText('Nothing was merged.')
    if (counts.size > 0) outputText(`Skipped: ${[...counts.entries()].map(([r, n]) => `${n} ${r.replace(/_/g, ' ')}`).join(', ')}.`)
    return
  }

  // --plan / --nightly
  const outPath = resolve(out ?? join(plur.getStorageRoot(), 'consolidate-plan.json'))
  const model = noModel ? undefined : resolveLlmOrExit({ llmCmd: llmFlags.llmCmd, baseUrl: llmFlags.llmBaseUrl, apiKey: llmFlags.llmApiKey, apiKeyEnv: llmFlags.llmApiKeyEnv, model: llmFlags.model })
  if (!model && !noModel) {
    exit(1, missingLlmMessage('plur consolidate --plan', { extra: '  or --no-model to plan without one (every cluster stays pending and nothing can be applied until it is decided).' }))
  }
  let resumeFrom: ConsolidationPlan | undefined
  if (!fresh && existsSync(outPath)) {
    const prior = readPlan(outPath)
    if (!prior.progress?.complete && prior.clusters.some(c => c.decision === 'pending')) resumeFrom = prior
  }
  const result = await plur.consolidatePlan({
    llm: model?.llm,
    nightly,
    sampleSize: sample,
    batchSize,
    resumeFrom,
    onProgress: p => savePlan(outPath, p),
  })
  savePlan(outPath, result)
  const merge = result.clusters.filter(c => c.decision === 'merge')
  const summary = {
    plan_file: outPath,
    plan_id: result.plan_id,
    resumed: !!resumeFrom,
    mode: result.mode,
    seed: result.seed,
    model: model?.via ?? null,
    clusters: result.clusters.length,
    merge: merge.length,
    split: result.clusters.filter(c => c.decision === 'split').length,
    pending: result.progress.pending,
    needs_approval: merge.filter(c => c.requires_owner_approval && !c.approved).length,
    complete: result.progress.complete,
    ...(result.progress.last_error ? { last_error: result.progress.last_error } : {}),
    stats: result.stats,
  }
  if (json) {
    outputJson(summary)
    return
  }
  outputText(`Plan ${result.plan_id}${resumeFrom ? ' (resumed)' : ''} -> ${outPath}`)
  outputText(`  ${result.stats.eligible} engrams considered, ${result.stats.candidate_pairs} candidate pairs, ${result.clusters.length} cluster(s)`
    + (result.stats.mixed_polarity ? `, ${result.stats.mixed_polarity} left out for mixing a prohibition with a directive` : ''))
  outputText(`  merge ${summary.merge} · split ${summary.split} · pending ${summary.pending}`
    + (summary.needs_approval ? ` · ${summary.needs_approval} need "approved": true (pinned, locked or prohibition)` : ''))
  if (result.progress.last_error) outputText(`  The model stopped answering (${result.progress.last_error}); run the same command again to resume.`)
  if (summary.merge > 0) outputText(`  Review the file, then: plur consolidate --apply ${outPath} --limit 1 --yes`)
}
