import { createPlur, type GlobalFlags } from '../plur.js'
import { remoteOnlyCommandRefusal } from '../lib/folder-gate.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import { emitPlan, readPlan, parseLimit, undoCommand } from '../lib/journal-cli.js'
import { resolveLlmOrExit, missingLlmMessage } from '../lib/llm-bridge.js'
import { requirePinPolicyConfirmation } from '../lib/pin-confirm.js'
import type { EnrichPlan } from '@plur-ai/core'

const USAGE =
  'Usage: plur enrich --plan [--out <file>] [--limit N] [--batch-size N] [--llm-cmd <cmd>] [--model <name>]\n' +
  '       plur enrich --apply <file> [--limit N] --yes\n' +
  '       plur enrich --undo <change-id>\n' +
  '  Labels each memory with its kind (rule, tool, fact, preference, experience,\n' +
  '  failure_lesson), task family, stated outcome and when it applies, stored in\n' +
  '  structured_data.enrichment, and re-judges memory_class from the kind\n' +
  '  (experiences and failure lessons become episodic). Statements are never\n' +
  '  changed; already-enriched memories are skipped, so a second run changes\n' +
  '  nothing.\n' +
  '  --plan        ask the model and write a plan (to --out, or stdout). Changes nothing.\n' +
  '  --apply       apply a plan as one undoable change. --limit N stops after N\n' +
  '                (try one first); without --yes it only previews.\n' +
  '  --undo        restore every memory an --apply changed, exactly.\n' +
  '  Model: --llm-cmd / PLUR_LLM_CMD runs a command with the prompt on stdin and\n' +
  '  reads the reply from stdout (e.g. "claude -p --model opus");\n' +
  '  --model / PLUR_LLM_MODEL names the model recorded on each label. Otherwise\n' +
  '  --llm-base-url (https) + --llm-api-key-env <VAR>. An API key in the environment is never used on its own.'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let plan = false
  let out: string | undefined
  let applyFile: string | undefined
  let undoId: string | undefined
  let limit: number | undefined
  let batchSize: number | undefined
  let yes = false
  let llmCmd: string | undefined
  let model: string | undefined
  let baseUrl: string | undefined
  let apiKey: string | undefined
  let apiKeyEnv: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--plan') plan = true
    else if (a === '--out') out = args[++i]
    else if (a === '--apply') applyFile = args[++i]
    else if (a === '--undo') undoId = args[++i]
    else if (a === '--limit') limit = parseLimit(args[++i])
    else if (a === '--batch-size') batchSize = parseLimit(args[++i])
    else if (a === '--yes') yes = true
    else if (a === '--llm-cmd') llmCmd = args[++i]
    else if (a === '--model') model = args[++i]
    else if (a === '--llm-base-url') baseUrl = args[++i]
    else if (a === '--llm-api-key') apiKey = args[++i]
    else if (a === '--llm-api-key-env') apiKeyEnv = args[++i]
    else exit(1, `Unknown argument: ${a}\n${USAGE}`)
  }
  const modes = [plan, applyFile !== undefined, undoId !== undefined].filter(Boolean).length
  if (modes !== 1) exit(1, USAGE)

  const plur = createPlur(flags)
  if (undoId !== undefined) {
    if (!undoId) exit(1, `--undo needs a change id.\n${USAGE}`)
    return await undoCommand(plur, undoId, 'enrich.apply', flags)
  }

  if (applyFile !== undefined) {
    if (!applyFile) exit(1, `--apply needs a plan file.\n${USAGE}`)
    if (yes) await requirePinPolicyConfirmation(plur, `Apply the enrichment plan ${applyFile}`)
    const p = readPlan<EnrichPlan>(applyFile, 'plur.enrich-plan')
    if (!yes) {
      outputText(
        `Would enrich up to ${Math.min(limit ?? p.items.length, p.items.length)} memory(ies) from ${applyFile} `
        + `(labels by ${p.enricher?.model ?? 'unknown'}) as one undoable change.\n`
        + `Nothing changed. Re-run with --yes to apply${limit === undefined ? ' (try --limit 1 first)' : ''}.`,
      )
      process.exit(1)
    }
    try {
      const r = await plur.applyEnrichmentPlan(p, limit !== undefined ? { limit } : {})
      if (shouldOutputJson(flags)) {
        outputJson({ change_id: r.change?.id ?? null, applied: r.applied, skipped: r.skipped })
      } else {
        const kinds = new Map<string, number>()
        for (const a of r.applied) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1)
        outputText(r.change
          ? `Enriched ${r.applied.length} memory(ies) as change ${r.change.id} (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}). `
            + `${r.skipped.length} skipped. Undo with: plur enrich --undo ${r.change.id}`
          : `Nothing to enrich: ${r.skipped.length} skipped (already enriched, changed or gone). No change recorded.`)
      }
    } catch (err) {
      exit(1, `Error: ${(err as Error).message}`)
    }
    return
  }

  // --plan: memory text goes to a model.
  const refused = remoteOnlyCommandRefusal(flags, 'Enrichment sends memories to a model, which is not the team server')
  if (refused) exit(1, refused)
  const bridge = resolveLlmOrExit({ llmCmd, model, baseUrl, apiKey, apiKeyEnv })
  if (!bridge) exit(1, missingLlmMessage('plur enrich --plan'))
  process.stderr.write(`Labelling with ${bridge.model} via ${bridge.via}...\n`)
  try {
    const result = await plur.planEnrichment({
      llm: bridge.llm,
      model: bridge.model,
      ...(limit !== undefined ? { limit } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
      onBatch: (done, total) => process.stderr.write(`  ${done}/${total}\n`),
    })
    emitPlan(result, out)
    const kinds = new Map<string, number>()
    for (const i of result.items) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1)
    const summary = `Enrichment plan: ${result.items.length} labelled (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}), `
      + `${result.skipped.unlabelled} unlabelled, ${result.skipped.already_enriched} already enriched.`
      + (out ? ` Written to ${out}. Review it, then: plur enrich --apply ${out} --limit 1 --yes` : '')
    if (!out) process.stderr.write(summary + '\n')
    else if (shouldOutputJson(flags)) outputJson({ out, labelled: result.items.length, ...result.skipped, enricher: result.enricher })
    else outputText(summary)
  } catch (err) {
    exit(1, `Error: ${(err as Error).message}`)
  }
}
