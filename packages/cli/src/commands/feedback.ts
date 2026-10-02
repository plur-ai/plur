import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputInfo, outputText, outputError, exit } from '../output.js'

/**
 * Flags this command accepts (#986): anything else is refused rather than
 * silently dropped. `--scope` names the store holding the engram (0.21.1).
 */
export const FLAGS_WITH_VALUES = ['--scope', '--batch']

export const FLAGS = ['--scope', '--batch']

const USAGE = 'Usage: plur feedback <id> <positive|negative|neutral> [--scope primary|<remote scope>]\n' +
  '       plur feedback --batch \'[{"id":"ENG-1","signal":"positive","scope":"primary"}]\' [--scope <scope>]'

const VALID_SIGNALS = ['positive', 'negative', 'neutral'] as const
type Signal = (typeof VALID_SIGNALS)[number]

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  // Batch mode: plur feedback --batch '[{"id":"ENG-1","signal":"positive"},...]' [--scope <scope>]
  //
  // `--scope` applies to every item that does not carry its own `scope`
  // (#1532 review F4). It used to be dropped without a word, so a batch could
  // not rate a local engram whose id also exists on a team store.
  const batchIdx = args.indexOf('--batch')
  if (batchIdx >= 0 && batchIdx + 1 < args.length) {
    const batchJson = args[batchIdx + 1]
    let batchScope: string | undefined
    for (let j = 0; j < args.length; j++) {
      if (j === batchIdx || j === batchIdx + 1) continue
      if (args[j] === '--scope') {
        const v = args[j + 1]
        if (v === undefined || v.trim() === '' || /^--[A-Za-z]/.test(v)) exit(1, `--scope requires a value\n${USAGE}`)
        batchScope = v; j++
        continue
      }
      exit(1, `Unexpected argument "${args[j]}" with --batch.\n${USAGE}`)
    }
    let items: Array<{ id: string; signal: string; scope?: string }>
    try {
      items = JSON.parse(batchJson)
    } catch {
      exit(1, 'Invalid --batch JSON. Expected: [{"id":"ENG-1","signal":"positive","scope":"primary"},...]')
      return
    }

    const results: Array<{ id: string; signal: string; success: boolean; error?: string; scope?: string; warnings?: string[] }> = []
    const summary = { positive: 0, negative: 0, neutral: 0 }
    for (const item of items) {
      if (!(VALID_SIGNALS as readonly string[]).includes(item.signal)) {
        results.push({ id: item.id, signal: item.signal, success: false, error: `Invalid signal: ${item.signal}` })
        continue
      }
      try {
        const itemScope = typeof item.scope === 'string' && item.scope.trim() !== '' ? item.scope : batchScope
        const { warnings } = await plur.feedback(item.id, item.signal as Signal, itemScope)
        results.push({ id: item.id, signal: item.signal, success: true, ...(itemScope ? { scope: itemScope } : {}), ...(warnings.length > 0 ? { warnings } : {}) })
        summary[item.signal as Signal]++
      } catch (err: any) {
        results.push({ id: item.id, signal: item.signal, success: false, error: err.message })
      }
    }

    // Exit 0 iff every requested feedback was recorded — the rule
    // `plur rescope` already follows (success = no item errored), in both
    // output modes. A batch whose items ALL failed used to exit 0 (formal
    // Adapters #5, cli#5).
    const failed = results.filter(r => !r.success)
    if (shouldOutputJson(flags)) {
      outputJson({ mode: 'batch', success: failed.length === 0, results, summary })
    } else {
      outputInfo(`Batch feedback: ${summary.positive} positive, ${summary.negative} negative, ${summary.neutral} neutral`, flags)
      for (const f of failed) outputError(`  failed: ${f.id} (${f.signal}) — ${f.error}`)
    }
    if (failed.length > 0) process.exitCode = 1
    return
  }

  // Single mode: plur feedback <id> <signal> [--scope <scope>]
  //
  // `--scope` (0.21.1): ids are minted per store, so a bare id can name a local
  // engram and an unrelated remote one, and an ambiguous id is refused. Without
  // the flag a colliding LOCAL engram could not be rated from the CLI at all.
  // `primary` = the local engram; a remote store's scope = that store's.
  // An extra argument used to be dropped without a word; it is now refused.
  let id = ''
  let signal = ''
  let scope: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--scope') {
      if (i + 1 >= args.length || args[i + 1].trim() === '' || /^--[A-Za-z]/.test(args[i + 1])) {
        exit(1, `--scope requires a value\n${USAGE}`)
      }
      scope = args[++i]; i++
    }
    else if (!id) { id = arg; i++ }
    else if (!signal) { signal = arg; i++ }
    else exit(1, `Unexpected argument "${arg}".\n${USAGE}`)
  }

  if (!id || !signal) {
    exit(1, USAGE)
  }

  if (!(VALID_SIGNALS as readonly string[]).includes(signal)) {
    exit(1, `Invalid signal: "${signal}". Must be one of: positive, negative, neutral`)
  }

  const { warnings } = await plur.feedback(id, signal as Signal, scope)

  if (shouldOutputJson(flags)) {
    outputJson({ id, signal, status: 'recorded', ...(scope ? { scope } : {}), ...(warnings.length > 0 ? { warnings } : {}) })
  } else {
    outputInfo(`Feedback recorded: ${signal} for ${id}${scope ? ` (scope: ${scope})` : ''}`, flags)
    for (const w of warnings) outputText(`  Warning: ${w}`)
  }
}
